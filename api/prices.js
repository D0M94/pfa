// api/prices.js — serverless price proxy for PFA (Yahoo Finance source)
// ---------------------------------------------------------------------------
// Resolves each holding (by ISIN when available, else ticker) to the right
// Yahoo listing, fetches the quote, and converts the price into the holding's
// own currency (handles GBp/pence and other listing currencies via the ECB).
// No API key needed. Results are cached in-memory so a warm instance serves
// many users with very few upstream calls.
//
// SETUP: place next to your api/chat handler. No env vars required.
//        (Optional: PRICE_TTL_MS to change the price cache lifetime, default 6h.)
//
// PRIMARY REQUEST (used by the app):
//   POST /api/prices   body: { items: [ { ticker, isin, currency } ], force? }
//   -> { prices: { "<ticker>": <number in that holding's currency> },
//        meta:   { "<ticker>": { symbol, srcPrice, srcCurrency } },
//        missing: [ ... ] }
//
// DIAGNOSTIC (browser-friendly):
//   GET /api/prices?symbols=AAPL,CSPX.L   -> { prices, missing } (no conversion)
// ---------------------------------------------------------------------------

const PRICE_TTL = Number(process.env.PRICE_TTL_MS) || 6 * 60 * 60 * 1000; // 6h
const FX_TTL = 12 * 60 * 60 * 1000; // 12h
const RES_TTL = 7 * 24 * 60 * 60 * 1000; // resolution rarely changes — 7 days

const RESOLVE = new Map(); // "isin|ticker" -> { symbol, ts }
const QUOTE = new Map();   // yahooSymbol  -> { price, currency, ts }
const FX = new Map();      // "EUR>HUF"    -> { rate, ts }

const UA = "Mozilla/5.0 (compatible; PFA/1.0)";
const isISIN = s => /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(String(s || "").toUpperCase());

async function yahooResolve(ticker, isin) {
  const cacheKey = `${isin || ""}|${ticker || ""}`;
  const hit = RESOLVE.get(cacheKey);
  if (hit && Date.now() - hit.ts < RES_TTL) return hit.symbol;
  const q = isISIN(isin) ? isin : ticker;
  if (!q) return null;
  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0`;
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    const j = await r.json();
    const quotes = (j && j.quotes) || [];
    const eligible = quotes.filter(x => x.symbol && (x.quoteType === "EQUITY" || x.quoteType === "ETF"));
    // Prefer an exact ticker match, then a recognised European venue, else first.
    const venuePref = [".L", ".DE", ".AS", ".PA", ".MI", ".SW", ".CO", ".VI", ".BR", ".MC", ".IR"];
    const score = x => {
      let s = 0;
      const base = String(x.symbol).split(".")[0].toUpperCase();
      if (ticker && base === String(ticker).toUpperCase()) s += 10;
      const suf = x.symbol.includes(".") ? "." + x.symbol.split(".").pop() : "";
      const vi = venuePref.indexOf(suf);
      if (vi >= 0) s += (venuePref.length - vi); // earlier in list = higher
      else if (!suf) s += 2; // US listing (no suffix)
      return s;
    };
    const best = eligible.sort((a, b) => score(b) - score(a))[0];
    const symbol = best ? best.symbol : null;
    if (symbol) RESOLVE.set(cacheKey, { symbol, ts: Date.now() });
    return symbol;
  } catch { return null; }
}

async function yahooQuote(symbol, force) {
  const hit = QUOTE.get(symbol);
  if (!force && hit && Date.now() - hit.ts < PRICE_TTL) return hit;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    const j = await r.json();
    const meta = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
    if (!meta || meta.regularMarketPrice == null) return null;
    let price = Number(meta.regularMarketPrice);
    let currency = String(meta.currency || "").toUpperCase();
    if (currency === "GBP" && /\.L$/.test(symbol) && price > 1000) { /* some feeds give pence under GBP */ }
    if (currency === "GBX" || currency === "GBP" + "p" || currency === "GBPENCE") { price = price / 100; currency = "GBP"; }
    const out = { price, currency, ts: Date.now() };
    QUOTE.set(symbol, out);
    return out;
  } catch { return null; }
}

async function fxRate(from, to) {
  from = (from || "").toUpperCase(); to = (to || "").toUpperCase();
  if (!from || !to || from === to) return 1;
  const key = `${from}>${to}`;
  const hit = FX.get(key);
  if (hit && Date.now() - hit.ts < FX_TTL) return hit.rate;
  try {
    const r = await fetch(`https://api.frankfurter.app/latest?from=${from}&to=${to}`, { headers: { "User-Agent": UA } });
    const j = await r.json();
    const rate = j && j.rates && j.rates[to];
    if (rate) { FX.set(key, { rate, ts: Date.now() }); return rate; }
  } catch {}
  return null;
}

export default async function handler(req, res) {
  try {
    // ── Diagnostic GET: raw quotes, no currency conversion ──
    if (req.method === "GET") {
      const raw = String((req.query && req.query.symbols) || "").trim();
      if (!raw) return res.status(400).json({ error: "missing ?symbols= (or POST with items)" });
      const force = String((req.query && req.query.force) || "") === "1";
      const syms = [...new Set(raw.split(",").map(s => s.trim()).filter(Boolean))].slice(0, 50);
      const prices = {}, missing = [];
      for (const s of syms) {
        const sym = s.includes(".") || isISIN(s) ? s : (await yahooResolve(s, s)) || s;
        const q = await yahooQuote(sym, force);
        if (q) prices[s] = q.price; else missing.push(s);
      }
      return res.status(200).json({ prices, missing });
    }

    // ── Primary POST: resolve + price + convert to each holding's currency ──
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    const items = (body && body.items) || [];
    const force = !!(body && body.force);
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "missing items[]" });

    const prices = {}, meta = {}, missing = [];
    for (const it of items.slice(0, 60)) {
      const ticker = String(it.ticker || "").trim();
      if (!ticker) continue;
      const symbol = await yahooResolve(ticker, it.isin);
      if (!symbol) { missing.push(ticker); continue; }
      const q = await yahooQuote(symbol, force);
      if (!q) { missing.push(ticker); continue; }
      let price = q.price;
      const want = String(it.currency || "").toUpperCase();
      if (want && q.currency && want !== q.currency) {
        const rate = await fxRate(q.currency, want);
        if (rate) price = price * rate; // converted into the holding's currency
      }
      prices[ticker] = price;
      meta[ticker] = { symbol, srcPrice: q.price, srcCurrency: q.currency };
    }
    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=86400");
    return res.status(200).json({ prices, meta, missing });
  } catch (e) {
    return res.status(502).json({ error: "price fetch failed", detail: String((e && e.message) || e) });
  }
}
