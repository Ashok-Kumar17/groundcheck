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
