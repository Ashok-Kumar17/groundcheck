// On-device LLM via WebLLM (WebGPU). Nothing is sent to a model server: weights are cached in the browser.
import { CreateMLCEngine } from "https://esm.run/@mlc-ai/web-llm@0.2.89";

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
      if (!engine) engine = await CreateMLCEngine(modelId, { initProgressCallback: onProgress });
      else if (current !== modelId) await engine.reload(modelId);
      current = modelId;
      stats.loadMs = performance.now() - t0;
    },
    async json(messages, schema, maxTokens = 256) {
      const t0 = performance.now();
      const attempt = (useSchema) => engine.chat.completions.create({
        messages, temperature: 0, max_tokens: maxTokens,
        response_format: useSchema ? { type: "json_object", schema: JSON.stringify(schema) } : { type: "json_object" },
      });
      let r;
      try { r = await attempt(true); }
      catch (e1) {
        // Known WebLLM issue: a disposed GrammarMatcher kills schema mode. Retry once, then fall back to plain JSON mode.
        try { r = await attempt(true); } catch (e2) { r = await attempt(false); }
      }
      const ms = performance.now() - t0;
      const u = r.usage || {}, x = u.extra || {};
      stats.calls++; stats.llmMs += ms;
      stats.promptTokens += u.prompt_tokens || 0; stats.outTokens += u.completion_tokens || 0;
      if (x.time_to_first_token_s) stats.ttft.push(x.time_to_first_token_s * 1000);
      if (x.decode_tokens_per_s) stats.decode.push(x.decode_tokens_per_s);
      if (x.prefill_tokens_per_s) stats.prefill.push(x.prefill_tokens_per_s);
      let data = null;
      const raw = r.choices[0].message.content || "";
      try { data = JSON.parse(raw); } catch {
        const m = raw.match(/\{[\s\S]*\}/); // fallback mode can add stray text around the JSON
        if (m) { try { data = JSON.parse(m[0]); } catch {} }
      }
      return { data, usage: { ...u, ms } };
    },
    resetStats() { Object.assign(stats, { calls: 0, promptTokens: 0, outTokens: 0, ttft: [], decode: [], prefill: [], llmMs: 0 }); },
  };
}
