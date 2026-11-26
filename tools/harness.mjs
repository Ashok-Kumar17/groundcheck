// Node harness mirroring the BROWSER path exactly: plain JSON mode (no grammar schema), key hint,
// defensive brace-balanced parse. Model served by llama.cpp (Qwen2.5-1.5B Q4_K_M) as a CPU reference.
import { createEdgepedia } from "../js/edgepedia.js";
import { runGroundcheck, checkClaim } from "../js/pipeline.js";
import { EVALSET, scoreEval } from "../js/evalset.js";
import { parseJSON } from "./parse.mjs";
import fs from "node:fs";

const llm = {
  async json(messages, schema, max_tokens) {
    const keys = Object.keys(schema?.properties || {});
    const hint = keys.length ? `\nRespond with ONLY one minified JSON object, no prose, no code fence. Keys: ${keys.join(", ")}.` : "";
    const msgs = messages.map((m, i) => i === 0 && m.role === "system" ? { ...m, content: m.content + hint } : m);
    const r = await fetch("http://127.0.0.1:8765", { method: "POST", body: JSON.stringify({ messages: msgs, schema, max_tokens, plain: true }) }).then(r => r.json());
    return { data: parseJSON(r.content), usage: { ...r.usage, s: r.s } };
  },
};
const ep = createEdgepedia();
const [mode, ...rest] = process.argv.slice(2);

if (mode === "eval") {
  const limit = rest.includes("--limit") ? +rest[rest.indexOf("--limit") + 1] : EVALSET.length;
  const rows = [];
  for (const e of EVALSET.slice(0, limit)) {
    const r = await checkClaim(e.claim, e.entities, { llm, ep });
    rows.push({ ...e, status: r.status, rawVerdict: r.verdict, guard: r.guard, quote: r.quote, reason: r.reason });
    console.log(`${e.label ? "T" : "F"} ${r.status.padEnd(12)} ${r.guard ? "[g] " : ""}${e.claim}`);
  }
  const m = scoreEval(rows);
  const rawRows = rows.map(r => ({ ...r, status: r.rawVerdict === "NOT_FOUND" ? "UNVERIFIED" : r.rawVerdict, guard: null }));
  console.log("\nWITH GUARDS", JSON.stringify(m));
  console.log("RAW MODEL  ", JSON.stringify(scoreEval(rawRows)));
  fs.writeFileSync(new URL("../data/benchmark.json", import.meta.url), JSON.stringify({ model: "Qwen2.5-1.5B-Instruct Q4 (CPU reference, plain-JSON mode)", gpu: "llama.cpp CPU reference", date: new Date().toISOString(), metrics: m, rawMetrics: scoreEval(rawRows), rows, note: "Reference run of the deployed pipeline on a CPU build of the same model. Use the button above to rerun live on your own GPU." }, null, 1));
} else {
  const text = rest.join(" ");
  const res = await runGroundcheck(text, { llm, ep, onEvent: (e) => { if (e.type === "result") console.log(" ->", e.claim.result.status, "|", (e.claim.result.quote || "").slice(0, 80)); } });
  console.log(res.summary);
}
