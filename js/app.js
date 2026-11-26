import { createLLM, MODELS, gpuInfo } from "./llm.js?v=13";
import { createEdgepedia } from "./edgepedia.js?v=13";
import { runGroundcheck, checkClaim, splitSentences, norm } from "./pipeline.js?v=13";
import { slopScore } from "./slop.js?v=13";
import { SAMPLES } from "./samples.js?v=13";
import { EVALSET, scoreEval } from "./evalset.js?v=13";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const STATUS = { SUPPORTED: ["ok", "Supported"], CONTRADICTED: ["bad", "Contradicted"], UNVERIFIED: ["unk", "Couldn't verify"] };
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

const llm = new URLSearchParams(location.search).has("mock") ? mockLLM() : createLLM();
// Test double used only with ?mock (UI testing without a GPU).
function mockLLM() {
  const stats = { loadMs: 1, calls: 0, promptTokens: 0, outTokens: 0, ttft: [], decode: [], prefill: [], llmMs: 0 };
  return { stats, model: "mock", async load() {}, resetStats() {},
    async json(messages, schema) {
      await new Promise(r => setTimeout(r, 120)); stats.calls++;
      const u = messages[1].content;
      if (schema.properties.claims) {
        const s = u.split("Sentence: ")[1];
        const ents = (s.match(/\b[A-Z][\w-]+(?: [A-Z][\w-]+)*/g) || []).filter(w => !/^(In|The|Moreover|Meanwhile|Whether)$/.test(w));
        return { data: { claims: ents.length ? [{ claim: s, entities: ents.slice(0, 2) }] : [] }, usage: { prompt_tokens: 90, completion_tokens: 30, ms: 120 } };
      }
      const p1 = (u.split("[1] ")[1] || "").replace(/^\([^)]*\) /, "");
      const q = (p1.match(/[^.]+\./) || [""])[0];
      return { data: { quote: q, passage: 1, checks: [], verdict: Math.random() < .5 ? "SUPPORTED" : "CONTRADICTED" }, usage: { prompt_tokens: 900, completion_tokens: 60, ms: 120 } };
    } };
}
let gpu = { ok: false }, busy = false, lastRun = null;

// ---------- setup ----------
for (const m of MODELS) $("#modelSel").insertAdjacentHTML("beforeend", `<option value="${m.id}">${esc(m.label)} (${m.size})</option>`);
if ((navigator.deviceMemory || 16) <= 8) { $("#modelSel").value = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC"; } // shared-memory iGPU: start light
SAMPLES.forEach((s, i) => $("#sampleBtns").insertAdjacentHTML("beforeend", `<button class="chip" data-i="${i}">${esc(s.title)}<small>${esc(s.note)}</small></button>`));
$("#input").value = SAMPLES[0].text;

document.querySelectorAll(".tab").forEach(t => t.onclick = () => {
  document.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x === t));
  document.querySelectorAll(".pane").forEach(p => p.classList.toggle("active", p.id === "tab-" + t.dataset.tab));
});
$("#sampleBtns").onclick = (e) => { const b = e.target.closest(".chip"); if (!b || busy) return; showEditor(); $("#input").value = SAMPLES[+b.dataset.i].text; };
$("#editBtn").onclick = showEditor;
$("#loadBtn").onclick = loadModel;
$("#runBtn").onclick = () => run($("#input").value);
$("#replayBtn").onclick = replay;
$("#benchBtn").onclick = bench;
renderFlow();
window.gcDebug = { llm, mkEp: createEdgepedia }; // console debugging
loadBenchFile();

if (llm.model === "mock") { $("#runBtn").disabled = false; $("#benchBtn").disabled = false; }
gpuInfo().then(g => {
  gpu = g;
  const p = $("#gpuPill");
  if (g.ok) { p.textContent = "WebGPU · " + g.name.slice(0, 28); p.className = "pill ok"; }
  else {
    p.textContent = "No WebGPU"; p.className = "pill bad";
    banner(`${esc(g.why)} The model needs WebGPU (Chrome or Edge on a recent laptop). You can still <b>replay a recorded run</b> to see exactly what it does.`);
    $("#loadBtn").disabled = true;
  }
});

function banner(html) { const b = $("#banner"); b.innerHTML = html; b.hidden = !html; }
function progress(frac, text) {
  const p = $("#progress"); p.hidden = frac == null;
  if (frac != null) { p.querySelector("i").style.width = Math.round(frac * 100) + "%"; p.querySelector("span").textContent = text; }
}

async function loadModel() {
  const id = $("#modelSel").value;
  $("#loadBtn").disabled = true; $("#loadBtn").textContent = "Loading…";
  try {
    await llm.load(id, (r) => progress(r.progress, r.text.replace(/\s+/g, " ").slice(0, 90)));
    progress(null);
    $("#loadBtn").textContent = "Loaded ✓";
    $("#runBtn").disabled = false; $("#benchBtn").disabled = false;
    banner("");
    trace("sys", `model ${id} ready in ${(llm.stats.loadMs / 1000).toFixed(1)} s (weights cached in this browser for next time)`);
    renderMetrics();
  } catch (e) {
    progress(null); $("#loadBtn").disabled = false; $("#loadBtn").textContent = "Load model";
    banner(`Couldn't load the model: ${esc(e.message)}. Try the 0.5B model, close other GPU-heavy tabs, or replay a recorded run.`);
  }
}
$("#modelSel").onchange = () => { if (llm.model && llm.model !== $("#modelSel").value) { $("#loadBtn").disabled = false; $("#loadBtn").textContent = "Switch model"; } };

// ---------- trace / metrics ----------
const t0 = performance.now();
function trace(kind, msg) {
  const el = $("#trace"); if (el.querySelector("p")) el.innerHTML = "";
  el.insertAdjacentHTML("beforeend", `<div class="${kind}"><span class="t">${((performance.now() - t0) / 1000).toFixed(1).padStart(6)}s</span>${esc(msg)}</div>`);
  el.scrollTop = el.scrollHeight;
}
function renderMetrics(ep, docChars, summary) {
  const s = llm.stats;
  const m = [
    [llm.model ? llm.model.replace("-q4f16_1-MLC", "") : "—", "model on this device", "wide"],
    [gpu.ok ? gpu.name : "—", "GPU", "wide"],
    [s.loadMs ? (s.loadMs / 1000).toFixed(1) + " s" : "—", "model load"],
    [s.ttft.length ? Math.round(avg(s.ttft)) + " ms" : "—", "avg time to first token"],
    [s.prefill.length ? Math.round(avg(s.prefill)) : "—", "prefill tokens/s"],
    [s.decode.length ? avg(s.decode).toFixed(1) : "—", "decode tokens/s"],
    [s.calls || "—", "LLM calls"],
    [s.calls ? (s.llmMs / 1000).toFixed(1) + " s" : "—", "total time in the model"],
  ];
  if (ep) m.push(
    [ep.stats.requests, `Edgepedia requests (+${ep.stats.cacheHits} cached)`],
    [Math.round(ep.stats.ms / Math.max(1, ep.stats.requests)) + " ms", "avg Edgepedia latency"],
    [`${ep.stats.bytesSent} B`, `sent off device, vs ${docChars} B of your text`],
  );
  if (summary) m.push([(summary.ms / 1000).toFixed(1) + " s", "end-to-end check"], [summary.guardCatches, "verdicts overruled by guards"]);
  $("#metrics").innerHTML = m.map(([b, span, cls]) => `<div class="metric ${cls || ""}"><b>${esc(b)}</b><span>${esc(span)}</span></div>`).join("");
}

// ---------- check ----------
function showEditor() { $("#input").hidden = false; $("#annotated").hidden = true; $("#editBtn").hidden = true; }

function renderAnnotated(text, sentences, claims, slop) {
  const cls = (i) => {
    const cs = claims.filter(c => c.sentence === i);
    if (!cs.length) return "";
    if (cs.some(c => !c.result)) return "pending";
    const st = cs.map(c => c.result.status);
    if (st.includes("CONTRADICTED")) return st.every(x => x === "CONTRADICTED") ? "bad" : "mixed";
    if (st.every(x => x === "SUPPORTED")) return "ok";
    return "unk";
  };
  let html = "", pos = 0;
  const slopIn = (a, b) => slop.hits.filter(h => h.kind !== "dash" && h.start >= a && h.end <= b);
  const paint = (a, b) => {
    let out = "", p = a;
    for (const h of slopIn(a, b).sort((x, y) => x.start - y.start)) {
      if (h.start < p) continue;
      out += esc(text.slice(p, h.start)) + `<span class="slop" title="AI-style wording">${esc(text.slice(h.start, h.end))}</span>`; p = h.end;
    }
    return out + esc(text.slice(p, b));
  };
  sentences.forEach((s, i) => {
    html += paint(pos, s.start);
    html += `<span class="s ${cls(i)}" data-s="${i}">${paint(s.start, s.end)}</span>`;
    pos = s.end;
  });
  html += paint(pos, text.length);
  const a = $("#annotated"); a.innerHTML = html.replace(/\n/g, "<br>");
  a.onclick = (e) => { const s = e.target.closest(".s"); if (!s) return; const c = document.querySelector(`.card[data-s="${s.dataset.s}"]`); c?.scrollIntoView({ behavior: "smooth", block: "center" }); };
}

function highlightQuote(passage, quote) {
  const t = esc(passage);
  if (!quote) return t;
  const q = esc(quote.trim()); const i = t.toLowerCase().indexOf(q.toLowerCase());
  return i >= 0 ? t.slice(0, i) + "<mark>" + t.slice(i, i + q.length) + "</mark>" + t.slice(i + q.length) : t;
}

function cardHTML(c) {
  if (!c.result) return `<div class="card wait" data-s="${c.sentence}" data-id="${c.id}"><div class="head"><div class="claim">${esc(c.claim)}</div><span class="tag wait">checking</span></div></div>`;
  const r = c.result, [k, label] = STATUS[r.status];
  const ev = r.evidenceIndex != null ? c.passages[r.evidenceIndex] : null;
  const arts = (c.articles || []).map(a => `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>`).join(", ");
  return `<div class="card ${k}" data-s="${c.sentence}" data-id="${c.id}">
    <div class="head"><div class="claim">${esc(c.claim)}</div><span class="tag ${k}">${label}</span></div>
    <p class="reason">${esc(r.reason || "")}</p>
    ${ev ? `<blockquote>${highlightQuote(ev.text, r.quote)}</blockquote>
      <div class="src">Source: <a href="${esc(ev.url)}" target="_blank" rel="noopener">${esc(ev.title)}, Edgepedia ↗</a> · Edgepedia Community License 1.0</div>` : ""}
    ${r.guard ? `<div class="guard">${esc(r.guard)}</div>` : ""}
    <details><summary>What the model saw (${(c.passages || []).length} passages${arts ? " from " + arts : ""})</summary>
      ${(c.passages || []).map((p, i) => `<p><b>[${i + 1}] ${esc(p.title)}</b>: ${esc(p.text.slice(0, 320))}${p.text.length > 320 ? "…" : ""}</p>`).join("")}
      ${r.checks?.length ? `<p><b>Details compared:</b> ${r.checks.map(x => `claim "${esc(x.claim_says)}" vs source "${esc(x.source_says)}"`).join("; ")}</p>` : ""}
      <p><b>Model's own verdict:</b> ${esc(r.verdict)}${r.decidedBy === "code" ? " (final call made in code, not by the model)" : ""}</p>
    </details></div>`;
}

function renderSummary(claims, slop) {
  const n = (s) => claims.filter(c => c.result?.status === s).length;
  $("#summary").hidden = false;
  $("#summary").innerHTML = `
    <div class="stat ok"><b>${n("SUPPORTED")}</b><span>supported</span></div>
    <div class="stat bad"><b>${n("CONTRADICTED")}</b><span>contradicted</span></div>
    <div class="stat unk"><b>${n("UNVERIFIED")}</b><span>couldn't verify</span></div>
    <div class="stat slop" title="${esc(slop.reasons.join(" · "))}"><b>${slop.score}</b><span>AI-style score: ${esc(slop.label)}</span></div>`;
}

async function run(text, recorded) {
  if (busy || !text.trim()) return;
  busy = true; $("#runBtn").disabled = true;
  const slop = slopScore(text);
  const ep = createEdgepedia();
  llm.resetStats();
  $("#input").hidden = true; $("#annotated").hidden = false; $("#editBtn").hidden = false;
  $("#cards").innerHTML = ""; $("#summary").hidden = true; $("#trace").innerHTML = "";
  let sentences = splitSentences(text), claims = [];
  renderAnnotated(text, sentences, claims, slop);
  trace("sys", `${text.length} characters, ${sentences.length} sentences, AI-style score ${slop.score}`);
  const upsert = (c) => {
    const old = document.querySelector(`.card[data-id="${c.id}"]`);
    if (old) old.outerHTML = cardHTML(c); else $("#cards").insertAdjacentHTML("beforeend", cardHTML(c));
  };
  const onEvent = (e) => {
    if (e.type === "stage") $("#runStatus").textContent = e.stage === "extract" ? `Finding claims · sentence ${e.i + 1}/${e.n}` : e.stage === "link" ? "Linking names to Edgepedia…" : `Checking claim ${e.i + 1}/${e.n}`;
    if (e.type === "llm") trace("llm", `LLM ${e.stage}: ${e.usage.prompt_tokens ?? "?"} in → ${e.usage.completion_tokens ?? "?"} out tokens, ${Math.round(e.usage.ms || 0)} ms`);
    if (e.type === "claim") { claims.push(e.claim); upsert(e.claim); renderAnnotated(text, sentences, claims, slop); trace("res", `claim: ${e.claim.claim}  [${e.claim.entities.join(", ")}]`); }
    if (e.type === "result") {
      upsert(e.claim); renderAnnotated(text, sentences, claims, slop);
      for (const l of ep.stats.log.splice(0)) trace("net", `Edgepedia ${l.path}  ${l.ms} ms, ${l.sent} B sent`);
      trace("res", `→ ${e.claim.result.status}${e.claim.result.guard ? "  (guard: " + e.claim.result.guard + ")" : ""}`);
      renderMetrics(ep, text.length);
    }
    if (e.type === "done") {
      renderSummary(claims, slop);
      $("#runStatus").textContent = `Done in ${(e.summary.ms / 1000).toFixed(1)} s`;
      renderMetrics(ep, text.length, e.summary);
    }
  };
  try {
    const res = recorded ? await playback(recorded, onEvent) : await runGroundcheck(text, { llm, ep, onEvent });
    lastRun = { text, model: llm.model, gpu: gpu.name, date: new Date().toISOString(), claims: res.claims, summary: res.summary, ep: ep.stats, llm: { ...llm.stats } };
    window.groundcheckLastRun = lastRun; // for export
  } catch (e) {
    $("#runStatus").textContent = "Error: " + e.message; trace("sys", "error: " + e.message);
  } finally { busy = false; $("#runBtn").disabled = !llm.model; }
}

// ---------- recorded runs (for browsers without WebGPU) ----------
async function playback(rec, onEvent) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  trace("sys", `replaying a run recorded on: ${rec.gpu || rec.model} (${rec.model})`);
  for (const c of rec.claims) { onEvent({ type: "claim", claim: { ...c, result: undefined } }); await sleep(250); }
  for (const c of rec.claims) { await sleep(450); onEvent({ type: "result", claim: c }); }
  Object.assign(llm.stats, rec.llm || {});
  onEvent({ type: "done", summary: rec.summary });
  return rec;
}
async function replay() {
  try {
    const rec = await fetch("data/recorded-run.json").then(r => r.json());
    showEditor(); $("#input").value = rec.text;
    await run(rec.text, rec);
  } catch { banner("No recorded run is available yet."); }
}

// ---------- benchmark ----------
function benchHTML(m, title, rows) {
  const bar = (label, v, color) => `<div class="barrow"><span>${label}</span><div class="b"><i style="width:${v}%;background:${color}"></i></div><b>${v}%</b></div>`;
  return `<div class="cmpbox"><h4>${esc(title)}</h4>
    ${bar("Overall accuracy", m.accuracy, "var(--brand)")}
    ${bar("False claims caught", m.falseCaughtPct, "var(--ok)")}
    ${bar("False claims shown green", m.dangerousPct, "var(--bad)")}
    ${bar("True claims confirmed", m.trueSupportedPct, "var(--ok)")}
    <p class="muted small">${m.n} claims · ${m.falseUnverified} false and ${m.trueUnverified} true marked "couldn't verify" · ${m.guardCatches} verdicts overruled by guards${rows ? "" : ""}</p></div>`;
}
function rowsTable(rows) {
  return `<table><tr><th>#</th><th>Claim</th><th>Truth</th><th>Groundcheck</th><th>Raw model</th><th>Why</th></tr>${rows.map(r => {
    const wrong = (r.label && r.status === "CONTRADICTED") || (!r.label && r.status === "SUPPORTED");
    return `<tr class="${wrong ? "wrong" : ""}"><td>${r.id + 1}</td><td>${esc(r.claim)}</td><td>${r.label ? "true" : "false"}</td><td class="s-${r.status}">${r.status}</td><td>${esc(r.rawVerdict || "")}</td><td>${esc(r.guard || r.reason || "")}</td></tr>`;
  }).join("")}</table>`;
}
let benchFile = null;
async function loadBenchFile() {
  try { benchFile = await fetch("data/benchmark.json").then(r => r.ok ? r.json() : null); } catch {}
  renderBench();
}
function renderBench(live) {
  let html = "";
  const src = live || benchFile;
  if (src) {
    html += `<p class="muted small">${live ? "Live run on this device" : "Recorded run"}: ${esc(src.model)}${src.gpu ? " on " + esc(src.gpu) : ""}${src.date ? " · " + esc(src.date.slice(0, 16).replace("T", " ")) : ""}</p>`;
    html += `<div class="cmp">${benchHTML(src.metrics, "Groundcheck (quote + detail guards)")}${benchHTML(src.rawMetrics, "Same model asked directly, no guards")}</div>`;
    html += rowsTable(src.rows);
  } else html = `<p class="muted">Load a model and run the benchmark. It takes about 1–3 minutes on a laptop GPU.</p>`;
  $("#benchOut").innerHTML = html;
}
async function bench() {
  if (busy) return; busy = true; $("#benchBtn").disabled = true;
  const ep = createEdgepedia(); const rows = [];
  for (const e of EVALSET) {
    $("#benchBtn").textContent = `Running ${rows.length + 1}/${EVALSET.length}…`;
    try {
      const r = await checkClaim(e.claim, e.entities, { llm, ep });
      rows.push({ ...e, status: r.status, rawVerdict: r.verdict, guard: r.guard, reason: r.reason, quote: r.quote });
    } catch (err) { rows.push({ ...e, status: "UNVERIFIED", rawVerdict: "ERROR", reason: err.message }); }
    const rawRows = rows.map(r => ({ ...r, status: r.rawVerdict === "NOT_FOUND" || r.rawVerdict === "ERROR" ? "UNVERIFIED" : r.rawVerdict, guard: null }));
    renderBench({ model: llm.model, gpu: gpu.name, date: new Date().toISOString(), metrics: scoreEval(rows), rawMetrics: scoreEval(rawRows), rows });
  }
  const rawRows = rows.map(r => ({ ...r, status: r.rawVerdict === "NOT_FOUND" || r.rawVerdict === "ERROR" ? "UNVERIFIED" : r.rawVerdict, guard: null }));
  window.groundcheckBench = { model: llm.model, gpu: gpu.name, date: new Date().toISOString(), metrics: scoreEval(rows), rawMetrics: scoreEval(rawRows), rows };
  $("#benchBtn").textContent = "Run again"; $("#benchBtn").disabled = false; busy = false;
}

// ---------- how it works ----------
function renderFlow() {
  const steps = [
    ["on device", "Split", "Text → sentences. Instant AI-style wording score."],
    ["on device · LLM", "Extract claims", "One sentence at a time → short self-contained claims + the names they mention."],
    ["network · names only", "Link", "One batched Edgepedia /resolve call maps names to articles."],
    ["network · keywords", "Retrieve", "Edgepedia returns the best-matching paragraphs per article; re-ranked locally."],
    ["on device · LLM", "Quote & compare", "Model quotes one sentence and lists claim detail vs source detail (JSON schema)."],
    ["on device · code", "Guards", "Quote must exist in the source. Details compared in code. Numbers and names must match."],
  ];
  $("#flow").innerHTML = steps.map(([e, b, s]) => `<div class="step ${e.startsWith("network") ? "net" : e.includes("code") ? "code" : ""}"><em>${e}</em><b>${b}</b><span>${s}</span></div>`).join("");
}
