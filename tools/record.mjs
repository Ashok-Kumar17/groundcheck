// Produce data/recorded-run.json in the exact shape the UI's "Replay a recorded run" expects.
// Run against the local llama.cpp server (CPU reference of the same model family the browser uses).
import { createEdgepedia } from "../js/edgepedia.js";
import { runGroundcheck } from "../js/pipeline.js";
import { SAMPLES } from "../js/samples.js";
import fs from "node:fs";

const stats = { loadMs: 0, calls: 0, promptTokens: 0, outTokens: 0, ttft: [], decode: [], prefill: [], llmMs: 0 };
const llm = {
  async json(messages, schema, max_tokens) {
    const r = await fetch("http://127.0.0.1:8765", { method: "POST", body: JSON.stringify({ messages, schema, max_tokens }) }).then(r => r.json());
    stats.calls++; stats.llmMs += r.s * 1000;
    stats.promptTokens += r.usage?.prompt_tokens || 0; stats.outTokens += r.usage?.completion_tokens || 0;
    let data = null; try { data = JSON.parse(r.content); } catch {}
    return { data, usage: { ...r.usage, ms: r.s * 1000 } };
  },
};
const ep = createEdgepedia();
const sample = SAMPLES[+(process.argv[2] ?? 1)];
const res = await runGroundcheck(sample.text, { llm, ep, onEvent: (e) => { if (e.type === "result") console.log(e.claim.result.status, "|", e.claim.claim); } });
const rec = {
  text: sample.text,
  model: "Qwen2.5-1.5B-Instruct Q4 (recorded on a CPU reference build, llama.cpp)",
  gpu: "llama.cpp CPU reference",
  date: new Date().toISOString(),
  claims: res.claims, summary: res.summary, ep: ep.stats, llm: stats,
};
fs.writeFileSync(new URL("../data/recorded-run.json", import.meta.url), JSON.stringify(rec));
console.log("saved", res.summary);
