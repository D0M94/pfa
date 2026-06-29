// api/prices.js — serverless price proxy for PFA
// ---------------------------------------------------------------------------
// Holds the Twelve Data API key SERVER-SIDE so it is never exposed in the
// browser, and caches results so one shared free key serves all your users
// with roughly one upstream call per ticker per day.
//
// SETUP
//   1. Place this file next to your existing `api/chat` handler (same /api dir).
//   2. Add an environment variable on your host:  TWELVEDATA_KEY = <your key>
//      (get a free key at https://twelvedata.com — free tier: 800 calls/day).
//   3. (optional) PRICE_TTL_MS to change the in-memory cache lifetime (default 12h).
//
// REQUEST   GET /api/prices?symbols=NVDA,CSPX:LSE,IMAE:XETR[&force=1]
// RESPONSE  { "prices": { "NVDA": 178.9, "CSPX:LSE": 712.4 }, "missing": [] }
//
// This is a Vercel / Next.js style handler (Node 18+, global fetch). If your
// `api/chat` uses Express, wrap the body in app.get("/api/prices", ...) and use
// req.query / res.json the same way.
// ---------------------------------------------------------------------------

const CACHE = new Map(); // symbol -> { price, ts } (per warm instance)
const TTL = Number(process.env.PRICE_TTL_MS) || 12 * 60 * 60 * 1000; // 12 hours

export default async function handler(req, res) {
  try {
    const key = process.env.TWELVEDATA_KEY;
    if (!key) return res.status(500).json({ error: "TWELVEDATA_KEY not configured" });

    const raw = String((req.query && req.query.symbols) || "").trim();
    const force = String((req.query && req.query.force) || "") === "1";
    if (!raw) return res.status(400).json({ error: "missing ?symbols=" });

    // De-dupe and cap the batch (free tier returns up to ~120 symbols per call).
    const symbols = [...new Set(raw.split(",").map(s => s.trim()).filter(Boolean))].slice(0, 120);
    const now = Date.now();
    const prices = {};
    const need = [];
    for (const s of symbols) {
      const hit = CACHE.get(s);
      if (!force && hit && now - hit.ts < TTL) prices[s] = hit.price;
      else need.push(s);
    }

    if (need.length) {
      const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(need.join(","))}&apikey=${encodeURIComponent(key)}`;
      const r = await fetch(url);
      const j = await r.json();
      const read = (sym, node) => {
        const p = node && node.price != null ? parseFloat(node.price) : NaN;
        if (!isNaN(p)) { prices[sym] = p; CACHE.set(sym, { price: p, ts: now }); }
      };
      // Twelve Data returns a flat object for a single symbol, keyed-by-symbol for many.
      if (need.length === 1) read(need[0], j);
      else for (const s of need) read(s, j[s]);
    }

    const missing = symbols.filter(s => prices[s] == null);
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json({ prices, missing });
  } catch (e) {
    return res.status(502).json({ error: "price fetch failed", detail: String((e && e.message) || e) });
  }
}
