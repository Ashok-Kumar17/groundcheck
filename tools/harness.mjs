// Node harness: same pipeline, model served by llama.cpp on CPU (Qwen2.5-1.5B-Instruct Q4_K_M).
// usage: node tools/harness.mjs eval [--raw] [--limit N]   |   node tools/harness.mjs text "<paragraph>"
import { createEdgepedia } from "../js/edgepedia.js";
import { runGroundcheck, checkClaim } from "../js/pipeline.js";
import { EVALSET, scoreEval } from "../js/evalset.js";
import fs from "node:fs";

const llm = {
  async json(messages, schema, max_tokens) {
    const r = await fetch("http://127.0.0.1:8765", { method: "POST", body: JSON.stringify({ messages, schema, max_tokens }) }).then(r => r.json());
    let data = null; try { data = JSON.parse(r.content); } catch {}
    return { data, usage: { ...r.usage, s: r.s } };
  },
};
const ep = createEdgepedia();
const [mode, ...rest] = process.argv.slice(2);

if (mode === "eval") {
  const limit = rest.includes("--limit") ? +rest[rest.indexOf("--limit") + 1] : EVALSET.length;
  const rows = [];
  for (const e of EVALSET.slice(0, limit)) {
    const r = await checkClaim(e.claim, e.entities, { llm, ep });
    rows.push({ ...e, status: r.status, rawVerdict: r.rawVerdict, guard: r.guard, quote: r.quote, reason: r.reason, s: r.usage?.s });
    console.log(`${e.label ? "T" : "F"} ${r.status.padEnd(12)} raw=${(r.rawVerdict || "").padEnd(12)} ${r.guard ? "[guard] " : ""}${e.claim}`);
  }
  const m = scoreEval(rows);
  // what the raw model would have scored without guards
  const rawRows = rows.map(r => ({ ...r, status: r.rawVerdict === "NOT_FOUND" ? "UNVERIFIED" : r.rawVerdict, guard: null }));
  const mr = scoreEval(rawRows);
  console.log("\nWITH GUARDS", JSON.stringify(m));
  console.log("RAW MODEL  ", JSON.stringify(mr));
  fs.writeFileSync(new URL("../data/eval-cpu-qwen1.5b.json", import.meta.url), JSON.stringify({ model: "Qwen2.5-1.5B-Instruct (Q4_K_M, llama.cpp CPU)", date: new Date().toISOString(), metrics: m, rawMetrics: mr, rows }, null, 1));
} else {
  const text = rest.join(" ");
  const res = await runGroundcheck(text, { llm, ep, onEvent: (e) => {
    if (e.type === "claim") console.log("CLAIM", e.claim.claim, e.claim.entities);
    if (e.type === "result") console.log(" ->", e.claim.result.status, "|", e.claim.result.quote?.slice(0, 120), "|", e.claim.result.guard || "");
  } });
  console.log(res.summary, ep.stats.requests, "requests", ep.stats.bytesSent, "bytes sent");
  fs.writeFileSync(new URL("../data/last-run.json", import.meta.url), JSON.stringify({ text, ...res, ep: ep.stats }, null, 1));
}
