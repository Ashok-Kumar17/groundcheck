// On-device LLM via WebLLM (WebGPU). Nothing is sent to a model server: weights are cached in the browser.
import { CreateMLCEngine } from "https://esm.run/@mlc-ai/web-llm@0.2.89";

// Pull the first balanced {...} out of free-form model text, then parse it. Tolerates code fences,
// prose, and trailing commas that small models sometimes emit.
export function parseJSON(raw) {
  if (!raw) return null;
  let s = raw.replace(/```(?:json)?/gi, "");
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { if (--depth === 0) { end = i; break; } }
  }
  const blob = end > 0 ? s.slice(start, end + 1) : s.slice(start);
  for (const t of [blob, blob.replace(/,\s*([}\]])/g, "$1")]) {
    try { return JSON.parse(t); } catch {}
  }
  return null;
}

export const MODELS = [
  { id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", label: "Qwen2.5 1.5B · balanced", size: "≈1.1 GB", vram: 1630 },
  { id: "Qwen2.5-3B-Instruct-q4f16_1-MLC", label: "Qwen2.5 3B · most accurate", size: "≈2.0 GB", vram: 2505 },
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", label: "Llama 3.2 3B", size: "≈1.9 GB", vram: 2264 },
  { id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", label: "Qwen2.5 0.5B · fastest", size: "≈0.4 GB", vram: 945 },
];

export async function gpuInfo() {
  if (!("gpu" in navigator)) return { ok: false, why: "This browser has no WebGPU." };
  try {
    const a = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!a) return { ok: false, why: "WebGPU is present but no GPU adapter was found." };
    const i = a.info || {};
    return { ok: true, name: [i.vendor, i.architecture, i.description].filter(Boolean).join(" ") || "GPU" };
  } catch (e) { return { ok: false, why: e.message }; }
}

export function createLLM() {
  let engine = null, current = null;
  const stats = { loadMs: 0, calls: 0, promptTokens: 0, outTokens: 0, ttft: [], decode: [], prefill: [], llmMs: 0 };

  return {
    stats,
    get model() { return current; },
    async load(modelId, onProgress) {
      const t0 = performance.now();
      // Small prefill chunks keep every GPU dispatch short, so Windows' GPU watchdog (TDR) doesn't
      // kill the device mid-prefill on integrated GPUs — the failure mode on 8 GB laptops.
      const opts = { context_window_size: 4096, prefill_chunk_size: 512 };
      if (!engine) engine = await CreateMLCEngine(modelId, { initProgressCallback: onProgress }, opts);
      else await engine.reload(modelId, opts);
      current = modelId;
      stats.loadMs = performance.now() - t0;
    },
    async recover(onProgress) {
      engine = await CreateMLCEngine(current, { initProgressCallback: onProgress }, { context_window_size: 4096, prefill_chunk_size: 512 });
    },
    async json(messages, schema, maxTokens = 256) {
      const t0 = performance.now();
      // No response_format: WebLLM 0.2.89's xgrammar GrammarMatcher disposes engine GPU state after
      // a few schema-constrained calls on shared-memory iGPUs (seen as "already disposed" /
      // DEVICE_REMOVED). Free generation + a key hint + defensive parsing is far more stable, and
      // Qwen2.5-Instruct emits clean JSON for these small shapes at temperature 0.
      const keys = Object.keys(schema?.properties || {});
      const hint = keys.length ? `\nRespond with ONLY one minified JSON object, no prose, no code fence. Keys: ${keys.join(", ")}.` : "";
      const msgs = hint
        ? messages.map((m, i) => i === 0 && m.role === "system" ? { ...m, content: m.content + hint } : m)
        : messages;
      const run = () => engine.chat.completions.create({ messages: msgs, temperature: 0, max_tokens: maxTokens });
      let r;
      try { r = await run(); }
      catch (e1) {
        if (/device|lost|disposed|removed/i.test(String(e1?.message || e1))) await this.recover();
        r = await run();
      }
      const ms = performance.now() - t0;
      const u = r.usage || {}, x = u.extra || {};
      stats.calls++; stats.llmMs += ms;
      stats.promptTokens += u.prompt_tokens || 0; stats.outTokens += u.completion_tokens || 0;
      if (x.time_to_first_token_s) stats.ttft.push(x.time_to_first_token_s * 1000);
      if (x.decode_tokens_per_s) stats.decode.push(x.decode_tokens_per_s);
      if (x.prefill_tokens_per_s) stats.prefill.push(x.prefill_tokens_per_s);
      return { data: parseJSON(r.choices?.[0]?.message?.content || ""), usage: { ...u, ms } };
    },
    resetStats() { Object.assign(stats, { calls: 0, promptTokens: 0, outTokens: 0, ttft: [], decode: [], prefill: [], llmMs: 0 }); },
  };
}
