// Thin client for the public Edgepedia API (https://www.edgepedia.org/developers).
// No key, CORS open. Everything is cached, and every byte that leaves the device is counted.

const BASE = "https://www.edgepedia.org/api/v1";

export function createEdgepedia(fetchImpl = globalThis.fetch) {
  const cache = new Map();
  const stats = { requests: 0, cacheHits: 0, bytesSent: 0, ms: 0, log: [] };

  async function call(path, body) {
    const key = path + (body ? JSON.stringify(body) : "");
    if (cache.has(key)) { stats.cacheHits++; return cache.get(key); }
    const t0 = performance.now();
    const opts = body
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {};
    const p = fetchImpl(BASE + path, opts).then(async r => {
      if (!r.ok && r.status !== 404) throw new Error(`Edgepedia ${r.status} on ${path}`);
      return r.status === 404 ? null : r.json();
    });
    cache.set(key, p);
    try {
      const data = await p;
      const ms = performance.now() - t0;
      stats.requests++;
      stats.ms += ms;
      const sent = (BASE + path).length + (body ? JSON.stringify(body).length : 0);
      stats.bytesSent += sent;
      stats.log.push({ path: path.split("?")[0], ms: Math.round(ms), sent });
      return data;
    } catch (e) { cache.delete(key); throw e; }
  }

  return {
    stats,
    // Batch entity linking: only short names + the claim leave the device, never the whole document.
    resolve: (queries) => call("/resolve", { queries: queries.map(q => ({ name: q.name, context: q.context, limit: 3 })) }),
    passages: (slug, q, k = 3) =>
      call(`/articles/${encodeURIComponent(slug)}?q=${encodeURIComponent(q)}&k=${k}&citations=false&fields=title,url,passages,credit`),
    search: (q, limit = 2) => call(`/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  };
}
