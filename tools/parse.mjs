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
  let blob = end > 0 ? s.slice(start, end + 1) : s.slice(start);
  const cands = [blob, blob.replace(/,\s*([}\]])/g, "$1")];
  if (end < 0) { // truncated: close whatever is still open
    let d = 0, inS = false, es = false, closers = "";
    for (const c of blob) {
      if (inS) { if (es) es = false; else if (c === "\\") es = true; else if (c === '"') inS = false; continue; }
      if (c === '"') inS = true; else if (c === "{") { d++; closers = "}" + closers; }
      else if (c === "[") { d++; closers = "]" + closers; }
      else if (c === "}" || c === "]") { d--; closers = closers.slice(1); }
    }
    let rep = blob.replace(/,\s*$/, "");
    if (inS) rep += '"';
    cands.push(rep + closers);
  }
  for (const t of cands) { try { return JSON.parse(t); } catch {} }
  return null;
}
