// Groundcheck pipeline. Model-agnostic: `llm.json(messages, schema, maxTokens)` must return { data, usage }.
// The same file runs in the browser (WebLLM on WebGPU) and in Node (eval harness).
//
//  text ─► sentences ─► [LLM] atomic claims + entities ─► [Edgepedia] resolve ─► [Edgepedia] passages
//       ─► [LLM] quote + verdict ─► [guards] quote must exist in source, numbers must match ─► report

const STOP = new Set("a an the of in on at to for from by with and or but is are was were be been being it its this that these those as into than then also which who whom whose has have had do does did not no can could will would should may might about over under after before during between more most less very".split(" "));

export const VERDICTS = ["SUPPORTED", "CONTRADICTED", "NOT_FOUND"];

export function splitSentences(text) {
  const out = [];
  const re = /[^.!?\n]+(?:[.!?]+(?=\s|$)|$)/g; // keeps "U.S." mostly intact unless followed by space+Capital
  let m, buf = "", bufStart = -1;
  while ((m = re.exec(text))) {
    const s = m[0];
    if (!s.trim()) continue;
    if (bufStart < 0) bufStart = m.index;
    buf += s;
    // don't break after common abbreviations / initials
    if (/\b(?:St|Dr|Mr|Mrs|Ms|Jr|Sr|vs|etc|e\.g|i\.e|No|approx|U\.S|[A-Z])\.$/.test(buf.trim())) continue;
    const lead = buf.length - buf.trimStart().length;
    out.push({ text: buf.trim(), start: bufStart + lead, end: bufStart + lead + buf.trim().length });
    buf = ""; bufStart = -1;
  }
  if (buf.trim()) { const lead = buf.length - buf.trimStart().length; out.push({ text: buf.trim(), start: bufStart + lead, end: bufStart + lead + buf.trim().length }); }
  return out;
}

export const norm = (s) => (s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/(\d),(?=\d{3}\b)/g, "$1").replace(/[^a-z0-9.]+/g, " ").replace(/\.(?!\d)/g, " ").replace(/\s+/g, " ").trim();
const tokens = (s) => norm(s).split(" ").filter(Boolean);
export const keywords = (s, max = 8) => [...new Set(tokens(s).filter(w => !STOP.has(w) && w.length > 1))].slice(0, max).join(" ");
export const numbersIn = (s) => [...new Set((norm(s).match(/\b\d+(?:\.\d+)?\b/g) || []).filter(n => n.length > 0))];
const cleanMd = (s) => (s || "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*/g, "").replace(/\[\d+\]/g, "").replace(/\s+/g, " ").trim();

// ---------- prompts ----------
const EXTRACT_SYS = `You turn ONE sentence into short, self-contained factual claims that can be checked in an encyclopedia.
Rules:
- Use only what the sentence says. Never add facts.
- Replace pronouns and vague references ("it", "he", "the tower", "the city") with the full name, using the context.
- One fact per claim. Copy numbers, dates and names exactly as written.
- Skip opinions, advice, feelings and vague praise. If nothing is checkable, return an empty list.
- entities: the specific named things the claim is about (people, places, organisations, events, objects, works). Most important first.`;

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: { claim: { type: "string" }, entities: { type: "array", items: { type: "string" } } },
        required: ["claim", "entities"],
      },
    },
  },
  required: ["claims"],
};

const VERIFY_SYS = `You are a careful fact-checker. You get a CLAIM and numbered PASSAGES from an encyclopedia.
Fill in, in this order:
1. quote: copy WORD FOR WORD the one sentence from the passages that is about the same fact as the claim. If none is, write "".
2. passage: the number of that passage (0 if none).
3. checks: for each key detail of the claim (a name, number, date, place, rank or order), write
   claim_says: that detail as the claim states it, 1 to 4 words only,
   source_says: what the quote states for the SAME detail, 1 to 4 words copied from the quote ("" if not mentioned).
   Example: claim "The bridge opened in 1932 in Sydney" → [{"claim_says":"1932","source_says":"1932"},{"claim_says":"Sydney","source_says":"Sydney"}].
4. verdict: SUPPORTED if every detail matches, CONTRADICTED if any detail differs, NOT_FOUND if the passages do not say.
Use only the passages, never your own memory. Be suspicious: the claim may contain a small planted error.`;

const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    quote: { type: "string" },
    passage: { type: "integer" },
    checks: {
      type: "array",
      items: { type: "object", properties: { claim_says: { type: "string" }, source_says: { type: "string" } }, required: ["claim_says", "source_says"] },
    },
    verdict: { type: "string", enum: VERDICTS },
  },
  required: ["quote", "passage", "checks", "verdict"],
};

// ---------- guards ----------
// A verdict is only allowed to stand if the model can point at the exact evidence.
export function quoteFound(quote, passages) {
  const q = norm(quote);
  if (q.split(" ").length < 4) return null;
  for (let i = 0; i < passages.length; i++) {
    const p = norm(passages[i].text);
    if (p.includes(q)) return { index: i, exact: true };
  }
  // tolerate tiny copy slips: ≥90% of quote tokens appear in order-insensitive bag of one passage
  const qt = tokens(quote);
  let best = { index: -1, score: 0 };
  passages.forEach((p, i) => {
    const bag = new Set(tokens(p.text));
    const s = qt.filter(t => bag.has(t)).length / qt.length;
    if (s > best.score) best = { index: i, score: s };
  });
  return best.score >= 0.9 ? { index: best.index, exact: false } : null;
}

const ORD = "first second third fourth fifth sixth seventh eighth ninth tenth".split(" ");
const contains = (hay, needle, thr = 1) => {
  const nt = tokens(needle).filter(t => !STOP.has(t)); if (!nt.length) return false;
  const h = new Set(tokens(hay)); return nt.filter(t => h.has(t)).length / nt.length >= thr;
};
// Proper nouns, numbers and ordinals the claim asserts. A "supported" verdict must find each of them in the evidence.
export function hardDetails(claim) {
  const words = claim.replace(/[.,;:!?]/g, " ").split(/\s+/).filter(Boolean);
  const caps = words.filter((w, i) => i > 0 && /^[A-Z][a-z]/.test(w) && !STOP.has(w.toLowerCase()));
  const ords = tokens(claim).filter(t => ORD.includes(t));
  return [...new Set([...numbersIn(claim), ...ords, ...caps.map(c => norm(c))])];
}

const YEAR = /\b(1[0-9]{3}|20[0-9]{2})\b/g;
const short = (x) => tokens(x).length > 0 && tokens(x).length <= 6;
const hasTok = (text, d) => new RegExp(`\\b${d.replace(/\./g, "\\.")}\\b`).test(norm(text));

// Fallback when the model finds no quote: look for the source sentence about the same fact ourselves.
// Only fires on a typed conflict (year or ordinal) in a sentence sharing most of the claim's other words.
export function codeConflict(claim, passages) {
  const hard = hardDetails(claim);
  const allText = passages.map(p => p.text).join(" ");
  const bad = hard.filter(d => !hasTok(allText, d)).find(d => /^(1[0-9]{3}|20[0-9]{2})$/.test(d) || ORD.includes(d));
  if (!bad) return null;
  const isYear = /^\d{4}$/.test(bad);
  const kw = tokens(keywords(claim, 20)).filter(t => t !== bad && !/^\d+$/.test(t));
  let best = null;
  passages.forEach((p, pi) => {
    for (const sent of p.text.split(/(?<=[.!?])\s+/)) {
      const st = new Set(tokens(sent));
      const cover = kw.filter(t => st.has(t)).length / Math.max(1, kw.length);
      const other = isYear ? (norm(sent).match(YEAR) || []) : tokens(sent).filter(t => ORD.includes(t));
      if (other.length && cover >= 0.6 && (!best || cover > best.cover)) best = { cover, sent, pi, other };
    }
  });
  if (!best) return null;
  return { status: "CONTRADICTED", decidedBy: "code", evidenceIndex: best.pi, quote: best.sent,
    reason: `Claim says ${isYear ? bad : `"${bad}"`}; the source says ${[...new Set(best.other)].join(" / ")}.` };
}

export function applyGuards(claim, raw, passages) {
  const out = { ...raw, status: "UNVERIFIED", guard: null, decidedBy: "model" };
  const allText = passages.map(p => p.text).join(" ");
  if (!raw.quote) {
    const fb = codeConflict(claim, passages);
    if (fb) return { ...out, ...fb };
    out.reason = "The sources found don't cover this claim."; return out;
  }
  const hit = quoteFound(raw.quote, passages);
  if (!hit) {
    out.guard = "The model's quote is not in the source (invented evidence), so its verdict was discarded.";
    out.reason = "No reliable evidence."; return out;
  }
  out.evidenceIndex = hit.index;
  const quote = raw.quote, ev = passages[hit.index].text;
  const hard = hardDetails(claim);
  const missingEv = hard.filter(d => !hasTok(ev, d));
  const missingAll = hard.filter(d => !hasTok(allText, d));

  // 1) Typed conflicts, decided in code: a year or ordinal the claim states that appears nowhere in the
  //    sources, while the quoted sentence states a different one.
  const qYears = [...new Set(norm(quote).match(YEAR) || [])];
  const badYear = missingAll.find(d => /^(1[0-9]{3}|20[0-9]{2})$/.test(d));
  if (badYear && qYears.length) {
    return { ...out, status: "CONTRADICTED", decidedBy: "code", reason: `Claim says ${badYear}; the source says ${qYears.join(" / ")}.` };
  }
  const qOrd = tokens(quote).filter(t => ORD.includes(t));
  const badOrd = missingAll.find(d => ORD.includes(d));
  if (badOrd && qOrd.length) {
    return { ...out, status: "CONTRADICTED", decidedBy: "code", reason: `Claim says "${badOrd}"; the source says "${qOrd[0]}".` };
  }

  // 2) Short slot comparison (the model extracts, code compares).
  let mismatch = null, matched = 0, usable = 0;
  for (const c of raw.checks || []) {
    const cs = (c.claim_says || "").trim(), ss = (c.source_says || "").trim();
    if (!short(cs) || !short(ss) || !contains(quote, ss, 0.8)) continue;
    usable++;
    if (contains(ev, cs, 1) || norm(cs) === norm(ss)) matched++;
    else if (!contains(cs, ss, 1) && !contains(ss, cs, 1)) mismatch = mismatch || { claim: cs, source: ss };
  }
  if (mismatch && missingEv.length) {
    return { ...out, status: "CONTRADICTED", decidedBy: "code", reason: `Claim says "${mismatch.claim}"; the source says "${mismatch.source}".` };
  }
  if (raw.verdict === "CONTRADICTED" && missingEv.length) {
    return { ...out, status: "CONTRADICTED", reason: `The source states this differently (${missingEv.map(d => `"${d}"`).join(", ")} not in it).` };
  }
  // 3) Supported only if every number, ordinal and name in the claim is in the quoted passage.
  if (raw.verdict === "SUPPORTED" || (usable && matched === usable) || raw.verdict === "CONTRADICTED") {
    if (missingEv.length) {
      return { ...out, guard: `"${missingEv.join('", "')}" from the claim is not in the evidence, so the model's verdict was not trusted.`, reason: "Evidence doesn't confirm every detail." };
    }
    if (raw.verdict === "CONTRADICTED") return { ...out, status: "CONTRADICTED", reason: "The source states this differently." };
    return { ...out, status: "SUPPORTED", reason: "The source states the same fact." + (raw.verdict !== "SUPPORTED" ? " (all details matched in code)" : ""), decidedBy: raw.verdict === "SUPPORTED" ? "model" : "code" };
  }
  out.reason = missingEv.length ? `Not settled by the sources (${missingEv.map(d => `"${d}"`).join(", ")} not found).` : "Not settled by the sources.";
  return out;
}

// ---------- retrieval ----------
function rankPassages(claim, passages, max) {
  const kw = new Set(tokens(keywords(claim, 20)));
  const nums = numbersIn(claim);
  const scored = passages.map(p => {
    const t = new Set(tokens(p.text));
    let s = [...kw].filter(w => t.has(w)).length + (p.lead ? 1.5 : 0) + (p.score || 0) * 0.3;
    s += nums.filter(n => t.has(n)).length;
    return { ...p, rank: s };
  });
  const seen = new Set();
  return scored.sort((a, b) => b.rank - a.rank).filter(p => { const k = norm(p.text).slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, max);
}

async function retrieve(ep, claim, entities, resolved, opts) {
  const kw = keywords(claim);
  const arts = [];
  for (const e of entities.slice(0, 3)) {
    const r = resolved.get(e.toLowerCase());
    if (r && !arts.find(a => a.slug === r.slug)) arts.push(r);
    if (arts.length >= opts.maxArticles) break;
  }
  if (!arts.length && kw) {
    const s = await ep.search(kw, 2).catch(() => null);
    for (const r of (s?.results || []).slice(0, opts.maxArticles)) arts.push({ slug: r.slug, title: r.title, url: r.url, excerpt: r.excerpt });
  }
  const all = [];
  await Promise.all(arts.map(async (a) => {
    if (a.excerpt) all.push({ text: cleanMd(a.excerpt), title: a.title, url: a.url, lead: true });
    const d = await ep.passages(a.slug, kw || a.title, opts.k).catch(() => null);
    for (const p of d?.passages || []) all.push({ text: cleanMd(p.text), title: d.title || a.title, url: p.cite_url || a.url, score: p.score, credit: d.credit });
    a.credit = d?.credit;
  }));
  return { articles: arts, passages: rankPassages(claim, all, opts.maxPassages) };
}

// ---------- main ----------
export async function runGroundcheck(text, { llm, ep, onEvent = () => {}, opts = {} }) {
  opts = { k: 3, maxArticles: 2, maxPassages: 5, maxClaims: 12, ...opts };
  const t0 = performance.now();
  const sentences = splitSentences(text);
  const claims = [];
  onEvent({ type: "sentences", sentences });

  // 1) extract claims, sentence by sentence (small models do better with one sentence at a time)
  for (let i = 0; i < sentences.length && claims.length < opts.maxClaims; i++) {
    const s = sentences[i];
    const ctx = sentences.slice(Math.max(0, i - 2), i).map(x => x.text).join(" ") || "(start of text)";
    onEvent({ type: "stage", stage: "extract", i, n: sentences.length });
    let data = null, usage = {};
    try { ({ data, usage } = await llm.json([
      { role: "system", content: EXTRACT_SYS },
      { role: "user", content: `Context: ${ctx}\nSentence: ${s.text}` },
    ], EXTRACT_SCHEMA, 220)); } catch (e) { usage = { error: String(e.message || e).slice(0, 90) }; }
    onEvent({ type: "llm", stage: "extract", usage });
    for (const c of (data?.claims || []).slice(0, 4)) {
      if (!c.claim || c.claim.split(" ").length < 3) continue;
      const item = { id: claims.length, sentence: i, span: [s.start, s.end], claim: c.claim.trim(), entities: (c.entities || []).filter(Boolean).slice(0, 3) };
      claims.push(item);
      onEvent({ type: "claim", claim: item });
    }
  }

  // 2) link entities in one batched call (names + claim only — the document never leaves the device)
  onEvent({ type: "stage", stage: "link" });
  const resolved = new Map();
  const queries = [];
  for (const c of claims) for (const e of c.entities) if (!queries.find(q => q.name.toLowerCase() === e.toLowerCase())) queries.push({ name: e, context: c.claim });
  for (let i = 0; i < queries.length; i += 50) {
    const r = await ep.resolve(queries.slice(i, i + 50)).catch(() => null);
    (r?.results || []).forEach((x, j) => {
      if (x?.result && (x.confidence ?? 0) >= 0.5) resolved.set(queries[i + j].name.toLowerCase(), { ...x.result, confidence: x.confidence });
    });
  }

  // 3) retrieve + 4) verify + 5) guard, claim by claim
  for (const c of claims) {
    onEvent({ type: "stage", stage: "verify", i: c.id, n: claims.length });
    const { articles, passages } = await retrieve(ep, c.claim, c.entities, resolved, opts);
    c.articles = articles; c.passages = passages;
    if (!passages.length) {
      c.result = { status: "UNVERIFIED", verdict: "NOT_FOUND", quote: "", reason: "Edgepedia has no article on this.", guard: null };
      onEvent({ type: "result", claim: c });
      continue;
    }
    const ctx = passages.map((p, i) => `[${i + 1}] (${p.title}) ${p.text}`).join("\n");
    let data = null, usage = {};
    try { ({ data, usage } = await llm.json([
      { role: "system", content: VERIFY_SYS },
      { role: "user", content: `CLAIM: ${c.claim}\n\nPASSAGES:\n${ctx}` },
    ], VERIFY_SCHEMA, 260)); } catch (e) { usage = { error: String(e.message || e).slice(0, 90) }; }
    onEvent({ type: "llm", stage: "verify", usage });
    const raw = data && VERDICTS.includes(data.verdict) ? data : { quote: "", passage: 0, checks: [], verdict: "NOT_FOUND" };
    c.result = applyGuards(c.claim, raw, passages);
    onEvent({ type: "result", claim: c });
  }

  const summary = { total: claims.length, ms: Math.round(performance.now() - t0) };
  for (const s of ["SUPPORTED", "CONTRADICTED", "UNVERIFIED"]) summary[s] = claims.filter(c => c.result?.status === s).length;
  summary.guardCatches = claims.filter(c => c.result?.guard).length;
  onEvent({ type: "done", summary });
  return { sentences, claims, summary };
}

// Verify one ready-made claim (used by the eval harness: skips extraction, keeps everything else identical).
export async function checkClaim(claim, entities, { llm, ep, opts = {} }) {
  opts = { k: 3, maxArticles: 2, maxPassages: 5, ...opts };
  const resolved = new Map();
  const r = await ep.resolve(entities.map(e => ({ name: e, context: claim }))).catch(() => null);
  (r?.results || []).forEach((x, j) => { if (x?.result && (x.confidence ?? 0) >= 0.5) resolved.set(entities[j].toLowerCase(), { ...x.result }); });
  const { passages } = await retrieve(ep, claim, entities, resolved, opts);
  if (!passages.length) return { status: "UNVERIFIED", verdict: "NOT_FOUND", quote: "", reason: "no article", passages };
  const ctx = passages.map((p, i) => `[${i + 1}] (${p.title}) ${p.text}`).join("\n");
  const { data, usage } = await llm.json([
    { role: "system", content: VERIFY_SYS },
    { role: "user", content: `CLAIM: ${claim}\n\nPASSAGES:\n${ctx}` },
  ], VERIFY_SCHEMA, 260);
  const raw = data && VERDICTS.includes(data.verdict) ? data : { quote: "", passage: 0, checks: [], verdict: "NOT_FOUND" };
  return { ...applyGuards(claim, raw, passages), rawVerdict: raw.verdict, passages, usage };
}
