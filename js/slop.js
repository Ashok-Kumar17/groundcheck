// Deterministic "sounds like AI" signals. Instant, no model needed.
// Complements the fact check: slop tells you HOW it was written, Groundcheck tells you WHETHER it's true.

const WORDS = [
  "delve", "delves", "delving", "tapestry", "testament", "intricate", "intricacies", "pivotal", "seamless",
  "seamlessly", "robust", "leverage", "leveraging", "realm", "landscape", "multifaceted", "nuanced",
  "underscore", "underscores", "showcase", "showcases", "boasts", "vibrant", "bustling", "meticulous",
  "meticulously", "embark", "unwavering", "paramount", "commendable", "furthermore", "moreover",
  "additionally", "notably", "crucial", "foster", "fostering", "elevate", "unlock", "harness", "navigate",
  "ever-evolving", "game-changer", "cutting-edge", "holistic", "synergy", "beacon", "enduring",
];
const PHRASES = [
  /\bit(?:'s| is) (?:important|worth) (?:to note|noting)\b/gi,
  /\bin today's (?:fast-paced|digital|modern) (?:world|age|landscape)\b/gi,
  /\bstands as a (?:testament|symbol|beacon)\b/gi,
  /\bnot (?:just|only|merely) [^.,;]{1,40}?,? but (?:also )?/gi,
  /\bplays? a (?:crucial|pivotal|vital|key|significant) role\b/gi,
  /\b(?:rich|storied) (?:history|heritage|tapestry)\b/gi,
  /\bin conclusion\b|\bin summary\b|\boverall,/gi,
  /\b(?:a|an) (?:true|remarkable|enduring) (?:marvel|symbol|testament)\b/gi,
  /\bwhether you're\b/gi,
];

export function slopScore(text) {
  const hits = [];
  const words = text.split(/\s+/).filter(Boolean).length || 1;
  const wre = new RegExp(`\\b(${WORDS.join("|")})\\b`, "gi");
  for (const m of text.matchAll(wre)) hits.push({ start: m.index, end: m.index + m[0].length, kind: "word", text: m[0] });
  for (const re of PHRASES) for (const m of text.matchAll(re)) hits.push({ start: m.index, end: m.index + m[0].length, kind: "phrase", text: m[0] });
  const dashes = (text.match(/—/g) || []).length;
  for (const m of text.matchAll(/—/g)) hits.push({ start: m.index, end: m.index + 1, kind: "dash", text: "—" });
  // "X, Y, and Z" triads are a classic tell when they stack up
  const triads = (text.match(/\b\w+(?: \w+)?, \w+(?: \w+)?,? and \w+/g) || []).length;

  const per100 = (n) => (n / words) * 100;
  const raw = per100(hits.filter(h => h.kind !== "dash").length) * 9 + per100(dashes) * 6 + per100(triads) * 5;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const reasons = [];
  const uniq = [...new Set(hits.filter(h => h.kind !== "dash").map(h => h.text.toLowerCase()))];
  if (uniq.length) reasons.push(`AI-favoured wording: ${uniq.slice(0, 6).map(s => `"${s.trim()}"`).join(", ")}`);
  if (dashes >= 2) reasons.push(`${dashes} em dashes`);
  if (triads >= 2) reasons.push(`${triads} "X, Y and Z" lists`);
  return { score, label: score >= 45 ? "Very AI-like" : score >= 20 ? "Some AI tells" : "Reads human", reasons, hits };
}
