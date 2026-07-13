import React, { useState, useEffect, useRef, Component } from "react";
import { createClient } from "@supabase/supabase-js";
import {
  BarChart, Bar, PieChart, Pie, Cell,
  AreaChart, Area,
  ComposedChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, ReferenceLine, LabelList
} from "recharts";

// ─── Supabase ─────────────────────────────────────────────────────────────────
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);
const DEMO_ID = import.meta.env.VITE_DEMO_HOUSEHOLD_ID;

// ─── Constants ────────────────────────────────────────────────────────────────
// Currency layer. All internal math is done in HUF (the base currency).
// RATES = HUF per 1 unit of the given currency. Updated at runtime from the ECB
// (frankfurter.app, free + no key + CORS) and cached daily in localStorage.
// DISPLAY.cur is the currency the user has chosen for all formatted figures.
const RATES = { EUR: 358, USD: 310, HUF: 1 }; // fallbacks until live rates load
const DISPLAY = { cur: "HUF" };

// Fetch live ECB rates once per day, cache in localStorage. Returns
// { date, EUR, USD, EURUSD } where EUR/USD are HUF-per-unit, or null on failure.
async function fetchFXRates() {
  const today = new Date().toISOString().slice(0, 10);
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem("pfa_fx_v1") || "null"); } catch { cached = null; }
  if (cached && cached.date === today && cached.EUR && cached.USD) return cached;
  try {
    const res = await fetch("https://api.frankfurter.app/latest?from=EUR&to=HUF,USD");
    const j = await res.json();
    const hufPerEur = j.rates?.HUF, usdPerEur = j.rates?.USD;
    if (!hufPerEur || !usdPerEur) return cached;
    const out = { date: today, EUR: hufPerEur, USD: hufPerEur / usdPerEur, EURUSD: usdPerEur };
    try { localStorage.setItem("pfa_fx_v1", JSON.stringify(out)); } catch {}
    return out;
  } catch { return cached; }
}

const DARK_C = {
  bg: "#0f0f11", surface: "#18181c", surfaceHigh: "#222228", border: "#2a2a32",
  accent: "#e8c547", red: "#f05a5a", green: "#4fc98a", blue: "#5a9cf0",
  purple: "#a07cf0", orange: "#f09a5a", muted: "#9898bc", text: "#e8e8f0", textSoft: "#b8b8d0",
};
const LIGHT_C = {
  bg: "#f2f3f7", surface: "#ffffff", surfaceHigh: "#e8eaf2", border: "#d0d4e8",
  accent: "#b8950a", red: "#c93030", green: "#2a8a55", blue: "#2a5cb5",
  purple: "#6030b0", orange: "#c06010", muted: "#404070", text: "#13131e", textSoft: "#38386a",
};
let C = { ...DARK_C };

function useIsMobile() {
  const [m, setM] = useState(() => typeof window !== "undefined" && window.innerWidth <= 680);
  useEffect(() => {
    const h = () => setM(window.innerWidth <= 680);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return m;
}

const CATEGORIES = ["Housing","Food","Transport","Utilities","Health","Education","Entertainment","Clothing","Garden","Savings","Income","Transfer","Uncategorized","Other"];
const PIE_COLORS = [C.blue, C.green, C.accent, C.purple, C.orange, C.red, C.muted, C.textSoft, "#e87ca0", "#7acc7a", C.blue, C.orange, C.muted];

function toHUF(amount, currency) {
  if (currency === "EUR") return amount * RATES.EUR;
  if (currency === "USD") return amount * RATES.USD;
  return amount;
}
// Convert an HUF amount back into another currency.
function fromHUF(nHUF, cur) {
  if (cur === "EUR") return nHUF / RATES.EUR;
  if (cur === "USD") return nHUF / RATES.USD;
  return nHUF;
}
// Format an HUF-denominated amount in the user's chosen display currency.
// Kept named fmtHUF so all existing call sites convert automatically.
function fmtHUF(n) {
  const cur = DISPLAY.cur || "HUF";
  const v = fromHUF(Number(n) || 0, cur);
  if (cur === "HUF") return Math.round(v).toLocaleString("hu-HU") + " Ft";
  const dec = Math.abs(v) >= 100000 ? 0 : 2; // drop cents on large sums for readability
  const s = v.toLocaleString(cur === "EUR" ? "en-IE" : "en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return (cur === "EUR" ? "€" : "$") + s;
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function addMonthsISO(iso, n) {
  const d = new Date((iso || todayStr()) + "T00:00:00");
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

// ─── Live asset prices (Twelve Data — free tier, CORS-friendly) ───────────────
// Data-efficient: one batched request for all tickers, results cached for the day
// in localStorage so re-opening the app or switching tabs costs no API calls.
// Prices come from YOUR backend proxy at /api/prices (see api/prices.js), which
// resolves each holding by ISIN/ticker to the right listing, fetches the quote,
// and converts it into the holding's own currency. `items` is [{ticker,isin,currency}].
// If the endpoint is not deployed the app simply keeps manually entered prices.
async function fetchLivePrices(items, { force = false } = {}) {
  const list = (items || []).filter(it => it && it.ticker);
  const seen = new Set(), uniq = [];
  for (const it of list) { if (!seen.has(it.ticker)) { seen.add(it.ticker); uniq.push(it); } }
  if (!uniq.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  let cache = {};
  try { const c = JSON.parse(localStorage.getItem("pfa_prices_v1") || "null"); if (c && c.date === today && !force) cache = c.prices || {}; } catch {}
  const need = uniq.filter(it => cache[it.ticker] == null);
  if (need.length) {
    try {
      const res = await fetch("/api/prices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: need, force }) });
      const j = await res.json();
      const got = (j && j.prices) || {};
      for (const it of need) { const v = got[it.ticker]; if (v != null && !isNaN(parseFloat(v))) cache[it.ticker] = parseFloat(v); }
      try { localStorage.setItem("pfa_prices_v1", JSON.stringify({ date: today, prices: cache })); } catch {}
    } catch { /* endpoint/network error — keep whatever is cached */ }
  }
  const prices = {}, missing = [];
  for (const it of uniq) { if (cache[it.ticker] != null && !isNaN(cache[it.ticker])) prices[it.ticker] = cache[it.ticker]; else missing.push(it.ticker); }
  return { prices, missing, fetched: Object.keys(prices) };
}

// ─── SheetJS loader (lazy, only when a spreadsheet is attached) ───────────────
let xlsxReady = false;
function loadXLSX() {
  return new Promise((resolve) => {
    if (xlsxReady || window.XLSX) { xlsxReady = true; return resolve(); }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = () => { xlsxReady = true; resolve(); };
    document.head.appendChild(s);
  });
}

// ─── Adaptive categorization ──────────────────────────────────────────────────
// Build keyword→category map from saved rules + existing transaction history
function buildLearnedRules(transactions, merchantRules) {
  const rules = {};
  // Explicit saved rules take priority
  for (const r of (merchantRules || [])) {
    if (r.keyword && r.category) rules[r.keyword.toLowerCase()] = r.category;
  }
  // Learn from existing transactions (most frequent category per keyword)
  const freq = {};
  for (const t of (transactions || [])) {
    const words = (t.desc || "").toLowerCase().split(/[\s,.\-/]+/).filter(w => w.length >= 4);
    for (const w of words) {
      if (!freq[w]) freq[w] = {};
      freq[w][t.category] = (freq[w][t.category] || 0) + 1;
    }
  }
  for (const [word, cats] of Object.entries(freq)) {
    if (!rules[word]) rules[word] = Object.entries(cats).sort((a, b) => b[1] - a[1])[0][0];
  }
  return rules;
}

function inferCategory(desc, learnedRules) {
  const words = (desc || "").toLowerCase().split(/[\s,.\-/]+/).filter(w => w.length >= 4);
  for (const w of words) { if (learnedRules[w]) return learnedRules[w]; }
  return null;
}

// ─── Shared hardcoded keyword→category fallback (Hungarian + English) ────────
// Used by every deterministic transaction/cost parser (Revolut, Erste, the
// generic heuristic path, and cost-list imports) as the last guess before
// something lands in "Uncategorized". Kept as ASCII-friendly patterns since
// encoding corruption tends to preserve plain ASCII merchant names. Returns a
// category string, or null if nothing matched (caller decides the final
// fallback — usually "Income"/"Transfer" by sign/context, else "Uncategorized").
function guessCategoryByKeyword(desc) {
  const d = String(desc || "").toLowerCase();
  if (!d) return null;
  if (/lidl|spar|aldi|tesco|penny|cba|\bdm\b|yolo food|cityfood|vegafutar|obstermann|flekken|kebab|bisztro|pizza|kurtoskalacs|cukraszda|bundiner|kifli|balena|ichigo|burger|restau|wolt|foodora|mcdonald|kfc|subway|auchan|interspar|chio|gyros|shawarma|sushi|market|grocery|supermar|etel|elelmis|hentesbolt|pekseg|bakery|food|lunch|dinner/i.test(d)) return "Food";
  if (/patika|pharmy|pharmacy|pingvin|gyogyszer|benu|fogaszat|fogorvos|optika|szemeszet|rendelo|korhaz|orvos|doktor|klinika|laborat|rhone|gyogyito|vitamin|docler|semmelweis/i.test(d)) return "Health";
  if (/mvm|dijnet|e\.on|nmhh|telenor|yettel|vodafone|\bupc\b|digi|telekom|telekomfelt|biztosit|allianz|generali|aegon|\bnn\b|union bizt|aon|internet|mobilnet|foldgaz|gazszolg|arviz|vizmuvek|szemet|kukasszolg/i.test(d)) return "Utilities";
  if (/omv|\bmol\b|shell|bkk|vonat|mav|parking|bolt taxi|uber|e-matrica|autopalya|wizzair|ryanair|flixbus|buszjegy|taxi|interrail|airport|repter|repjegy|benzin|diesel|car wash/i.test(d)) return "Transport";
  if (/netflix|spotify|tv2|arena|steam|mozi|cinema|simplep\*kaki|hbo|disney|apple\.com|youtube|prime video|twitch|jegy|billett|koncert|theater|szinhaz|museum|muzeum|kindle|audible/i.test(d)) return "Entertainment";
  if (/zara|h&m|sinsay|pepco|reserved|vinted|deichmann|tshirt|nike|adidas|decathlon|\bc&a\b|pull.bear|mango|uniqlo|\bkik\b|primark|about you|answear|sportisimo|hervis/i.test(d)) return "Clothing";
  if (/hornbach|obi|bauhaus|leroy|kerteszet|garden|ikea|kika|jysk|depot|mr bricolage|praktiker|lezser|furdo|homedepo/i.test(d)) return "Garden";
  if (/temu|emag|alza|zooplus|tchibo|aliexpress|amazon|ebay/i.test(d)) return "Other";
  if (/revolut|atm|kesz|cash kivét|bankkiol/i.test(d)) return "Transfer";
  return null;
}

// ─── Revolut CSV parser (client-side, no token limits) ────────────────────────
function tryParseRevolutCSV(text, learnedRules = {}) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return null;

  function parseCSVLine(line) {
    const cols = []; let cur = '', inQuote = false;
    for (let j = 0; j < line.length; j++) {
      if (line[j] === '"') inQuote = !inQuote;
      else if (line[j] === ',' && !inQuote) { cols.push(cur.trim()); cur = ''; }
      else cur += line[j];
    }
    cols.push(cur.trim()); return cols;
  }

  const headerStr = parseCSVLine(lines[0]).join(',').toLowerCase();
  // Detection: "state" and "egyenleg" are ASCII and survive encoding corruption
  if (!headerStr.includes('state') || !headerStr.includes('egyenleg')) return null;
  if (!text.includes(',HUF,') && !text.includes(',EUR,') && !text.includes(',USD,')) return null;

  // Columns: 0=type 1=product 2=start 3=completion 4=desc 5=amount 6=fee 7=currency 8=state 9=balance
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i].trim());
    if (cols.length < 8) continue;
    const txType = (cols[0] || '').toLowerCase();
    const date = (cols[3] || cols[2] || '').split(' ')[0];
    const desc = cols[4] || '';
    const amount = parseFloat((cols[5] || '0').replace(',', '.'));
    const currency = cols[7] || 'HUF';
    const state = (cols[8] || '').toLowerCase();

    if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) continue;
    if (isNaN(amount) || amount === 0) continue;
    // Only completed: state contains 'elv' (elvégezve) or 'complet'
    if (state && !state.includes('elv') && !state.includes('complet')) continue;

    const isIncome = amount > 0;
    const entryType = isIncome ? 'income' : 'expense';
    const d = desc.toLowerCase();

    // 1. Learned rules first
    let category = inferCategory(desc, learnedRules);
    // 2. Hard-coded keyword fallback (shared across all parsers)
    if (!category) category = guessCategoryByKeyword(d);
    // 3. Type-column / income-sign fallback
    if (!category) {
      // Transfer detection via type column ('tual' survives from 'átutalás')
      if (/tual|transfer/i.test(txType)) category = isIncome ? 'Income' : 'Transfer';
      else if (isIncome) category = 'Income';
      else category = 'Uncategorized';
    }

    rows.push({ date, desc, amount, currency, category, type: entryType, account: 'Revolut' });
  }
  return rows.length > 0 ? rows : null;
}

// ─── Lightyear CSV parser (client-side) ──────────────────────────────────────
// Lightyear exports a transaction LOG (Buy/Sell/Dividend/Deposit/Conversion),
// not a position list. We reconstruct holdings: aggregate Buys/Sells per ticker
// into a weighted-average cost basis (net of fees), and roll up Dividends as
// cash held in the portfolio (per currency). Deposits/Conversions are internal
// cash movements and are ignored. Returns a positions batch, or null.
function tryParseLightyearCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  function parseLine(line) {
    const cols = []; let cur = "", q = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '"') q = !q;
      else if (ch === "," && !q) { cols.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    cols.push(cur.trim()); return cols;
  }
  const header = parseLine(lines[0]).map(h => h.toLowerCase().replace(/\.$/, "").trim());
  const idx = name => header.findIndex(h => h === name);
  const cTicker = idx("ticker"), cISIN = idx("isin"), cType = idx("type"), cQty = idx("quantity"),
        cCcy = idx("ccy"), cPrice = idx("price/share"), cGross = idx("gross amount"), cFee = idx("fee"),
        cNet = idx("net amt"), cDate = idx("date");
  // Detection: must look like a Lightyear statement
  if (cTicker === -1 || cType === -1 || cPrice === -1 || cISIN === -1) return null;

  const num = v => { const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : n; };
  function lyDate(s) {
    const first = (s || "").split(" ")[0];
    const p = first.split(/[/.]/);
    if (p.length === 3 && p[2].length === 4) return `${p[2]}-${p[1].padStart(2, "0")}-${p[0].padStart(2, "0")}`;
    return "";
  }

  const agg = {};       // ticker -> { ticker, isin, currency, qty, cost, firstDate }
  const cashByCcy = {}; // currency -> accumulated dividend cash
  let rowsSeen = 0;

  for (let i = 1; i < lines.length; i++) {
    const c = parseLine(lines[i]);
    if (c.length < header.length - 2) continue;
    const type = (c[cType] || "").toLowerCase();
    const ccy = (cCcy >= 0 ? c[cCcy] : "") || "EUR";
    if (type === "buy" || type === "sell") {
      const ticker = (c[cTicker] || "").trim();
      if (!ticker) continue;
      const qty = num(c[cQty]);
      const price = num(c[cPrice]);
      const fee = cFee >= 0 ? num(c[cFee]) : 0;
      if (!qty) continue;
      const a = agg[ticker] || (agg[ticker] = { ticker, isin: (cISIN >= 0 ? c[cISIN] : "") || "", currency: ccy, qty: 0, cost: 0, firstDate: "" });
      if (type === "buy") {
        a.qty += qty;
        a.cost += qty * price + fee; // money invested, net of fees
        const d = lyDate(c[cDate]);
        if (d && (!a.firstDate || d < a.firstDate)) a.firstDate = d;
      } else { // sell — reduce holding at current average cost
        const avg = a.qty > 0 ? a.cost / a.qty : price;
        a.qty -= qty;
        a.cost -= qty * avg;
        if (a.qty < 0.0000001) { a.qty = 0; a.cost = 0; }
      }
      rowsSeen++;
    } else if (type === "dividend") {
      const net = cNet >= 0 ? num(c[cNet]) : num(c[cGross]);
      if (net) cashByCcy[ccy] = (cashByCcy[ccy] || 0) + net;
      rowsSeen++;
    }
    // deposit / conversion / other → ignored (internal cash movements)
  }
  if (rowsSeen === 0) return null;

  const items = [];
  for (const t of Object.keys(agg)) {
    const a = agg[t];
    if (a.qty <= 0.0000001) continue;
    const costBasis = a.cost / a.qty;
    items.push({
      name: a.ticker, ticker: a.ticker, isin: a.isin,
      qty: parseFloat(a.qty.toFixed(8)),
      costBasis: parseFloat(costBasis.toFixed(6)),
      currentPrice: parseFloat(costBasis.toFixed(6)), // placeholder until live prices load
      currency: a.currency, assetClass: "ETF", region: "Global",
      purchaseDate: a.firstDate || "", notes: "Imported from Lightyear",
    });
  }
  // Dividends → cash positions (kept inside the portfolio, per currency)
  for (const ccy of Object.keys(cashByCcy)) {
    const amt = cashByCcy[ccy];
    if (amt <= 0) continue;
    items.push({
      name: `Cash · dividends (${ccy})`, ticker: ccy, isin: "",
      qty: parseFloat(amt.toFixed(2)), costBasis: 1, currentPrice: 1,
      currency: ccy, assetClass: "Cash", region: "Other",
      purchaseDate: "", notes: "Accumulated dividends",
    });
  }
  if (!items.length) return null;
  const posCount = items.filter(i => i.assetClass !== "Cash").length;
  return { type: "positions", portfolioName: "Lightyear", broker: "Lightyear",
    summary: `${posCount} position${posCount === 1 ? "" : "s"} reconstructed from Lightyear statement${Object.keys(cashByCcy).length ? ` + dividend cash` : ""}`,
    items };
}

// ─── Erste XLSX parser (client-side, no token limits) ────────────────────────
// Takes a SheetJS workbook (already read with { cellDates: true }) and returns
// an array of transaction rows, or null if the file is not an Erste statement.
function tryParseErsteXLSX(wb, learnedRules = {}) {
  if (!wb || !wb.SheetNames || !wb.SheetNames.length) return null;
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return null;
  const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  return tryParseErsteFromRows(rows, learnedRules);
}
// Text-based counterpart: used by the tab-upload path, which only has the
// converted text (see fileToText), not the original SheetJS workbook. Tries
// every parsed sheet and returns the first match, or null.
function tryParseErsteFromText(text, learnedRules = {}) {
  const sheets = parseDelimitedToSheets(text);
  for (const sh of sheets) {
    const out = tryParseErsteFromRows(sh.rows, learnedRules);
    if (out) return out;
  }
  return null;
}
// Shared row-parsing logic for the Erste bank-statement export (not the
// "Instrumentum bekerülés" holdings report — see tryParseErsteHoldingsXLS).
// `rows` is a 2D array: either from SheetJS sheet_to_json (raw cell types) or
// from parseDelimitedToSheets (all strings, dates already ISO-normalized by
// fileToText). Both shapes are handled by the code below.
function tryParseErsteFromRows(rows, learnedRules = {}) {
  // Detection: cell A1 contains a string starting with "Erste"
  if (!rows[0] || typeof rows[0][0] !== "string" || !rows[0][0].startsWith("Erste")) return null;
  // Row index 3 (4th row) holds the Hungarian column headers
  const headerRow = rows[3];
  if (!headerRow) return null;
  const col = {};
  headerRow.forEach((h, i) => { if (h != null) col[String(h).trim()] = i; });
  const cDate = col["Könyvelés dátuma"];
  const cAmt  = col["Összeg"];
  const cCur  = col["Devizanem"];
  const cPart = col["Partner név"];
  const cBook = col["Könyvelési információk"];
  const cNote = col["Közlemény"];
  const cTxn  = col["Tranzakció dátuma és ideje"];
  if (cDate === undefined || cAmt === undefined) return null;

  function excelDateToISO(v) {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === "number") return new Date((v - 25569) * 86400000).toISOString().slice(0, 10);
    if (typeof v === "string") return v.slice(0, 10).replace(/\./g, "-");
    return null;
  }

  const transactions = [];
  for (let i = 4; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(v => v == null || v === "")) continue;
    const rawDate = row[cDate];
    const rawAmt  = row[cAmt];
    if (rawDate == null || rawAmt == null) continue;
    const amount = typeof rawAmt === "number" ? rawAmt : parseFloat(String(rawAmt).replace(/,/g, "."));
    if (isNaN(amount) || amount === 0) continue;

    // Prefer the more precise transaction datetime; fall back to booking date
    const txnStr = cTxn != null ? row[cTxn] : null;
    const dateStr = (txnStr && typeof txnStr === "string")
      ? txnStr.slice(0, 10).replace(/\./g, "-")
      : excelDateToISO(rawDate);
    if (!dateStr || !dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) continue;

    const partner = cPart != null && row[cPart] ? String(row[cPart]).trim() : "";
    const booking = cBook != null && row[cBook] ? String(row[cBook]).trim() : "";
    const note    = cNote != null && row[cNote] ? String(row[cNote]).trim() : "";
    const currency = cCur != null && row[cCur] ? String(row[cCur]).trim() : "HUF";

    // Build description: partner name is cleanest; extract merchant from card
    // booking info ("478738xxxxxx0458 REFCODE merchantname CITY DDMMYYHH:MM") as fallback
    let desc = partner;
    if (!desc && booking) {
      const cardMerchant = booking.match(/\d{16}\s+\w+\s+([\w.*\-]+(?:\.\w+)*)\s/);
      desc = cardMerchant
        ? cardMerchant[1]
        : booking.replace(/Trn:.*|Oth\.\w.*$/g, "").trim().slice(0, 60);
    }
    if (!desc && note) desc = note.slice(0, 60);
    desc = desc.trim();
    if (!desc) continue;

    const type = amount < 0 ? "expense" : "income";
    const absAmt = Math.abs(amount);
    let category = inferCategory(desc, learnedRules);
    if (!category) category = guessCategoryByKeyword(desc);
    if (!category) category = type === "income" ? "Income" : "Uncategorized";
    transactions.push({ date: dateStr, desc, amount: absAmt, currency, category, type, account: "Erste" });
  }
  return transactions.length > 0 ? transactions : null;
}

// ─── PDF text extractor (lazy, only when a PDF is attached) ───────────────────
let pdfjsReady = false;
function loadPDFJS() {
  return new Promise((resolve, reject) => {
    if (pdfjsReady || window.pdfjsLib) { pdfjsReady = true; return resolve(); }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = () => {
      try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"; } catch {}
      pdfjsReady = true; resolve();
    };
    s.onerror = () => reject(new Error("Could not load the PDF reader. Try saving the statement as CSV instead."));
    document.head.appendChild(s);
  });
}
async function pdfToText(file) {
  await loadPDFJS();
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // Reconstruct rows by grouping text fragments on the same vertical line.
    const rows = {};
    content.items.forEach(it => {
      const y = Math.round(it.transform[5]);
      (rows[y] = rows[y] || []).push(it.str);
    });
    const lines = Object.keys(rows).sort((a, b) => b - a)
      .map(y => rows[y].join(" ").replace(/\s+/g, " ").trim()).filter(Boolean);
    pages.push(lines.join("\n"));
  }
  const text = pages.join("\n\n").trim();
  if (!text) throw new Error("This PDF has no selectable text (it may be a scan). Try a CSV/Excel export instead.");
  return text;
}

// Convert uploaded file → plain CSV/text for the parsers or Claude to read
async function fileToText(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "csv") return await file.text();
  if (ext === "pdf") return await pdfToText(file);
  if (ext === "xlsx" || ext === "xls") {
    await loadXLSX();
    const buf = await file.arrayBuffer();
    // cellDates: true converts Excel serial date numbers to JS Date objects,
    // so Claude receives readable ISO dates (2026-05-31) instead of serials (46173).
    const wb = window.XLSX.read(buf, { type: "array", cellDates: true });
    return wb.SheetNames.map(name => {
      const sheetRows = window.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" });
      const csv = sheetRows.map(row =>
        row.map(v => {
          if (v instanceof Date) return v.toISOString().slice(0, 10);
          const s = String(v);
          return (s.includes(",") || s.includes('"')) ? '"' + s.replace(/"/g, '""') + '"' : s;
        }).join(",")
      ).join("\n");
      return `--- Sheet: ${name} ---\n` + csv;
    }).join("\n\n");
  }
  throw new Error("Unsupported file type. Please upload .csv, .xlsx, .xls or .pdf");
}

// ─── AI-assisted investment import (column auto-detection) ────────────────────
// Robust path for arbitrary broker/bank holdings exports:
//   1) split the file into sheets+rows (handles CSV and the XLSX→text format),
//   2) ask the AI to map columns→roles from a SMALL sample (cheap, bounded),
//   3) parse ALL rows locally with that mapping (no row-count token limits).
// Split one line on a delimiter, respecting double-quotes.
function _splitDelim(line, d) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === d && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim().replace(/^"|"$/g, ""));
}
// Detect the delimiter used (comma / semicolon / tab / pipe) from the first lines.
// Crucial for European & Hungarian exports, which usually use ";".
function detectDelimiter(text) {
  const lines = String(text || "").split(/\r?\n/).filter(l => l.trim()).slice(0, 8);
  if (!lines.length) return ",";
  let best = ",", bestScore = -1;
  for (const d of [";", ",", "\t", "|"]) {
    const counts = lines.map(l => { let n = 0, q = false; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c === '"') q = !q; else if (c === d && !q) n++; } return n; });
    const min = Math.min(...counts), sum = counts.reduce((a, b) => a + b, 0);
    if (min > 0) { const score = min * 1000 + sum; if (score > bestScore) { bestScore = score; best = d; } }
  }
  return best;
}
function parseDelimitedToSheets(text) {
  const t = String(text || "");
  if (t.includes("--- Sheet:")) {
    const parts = t.split(/^--- Sheet:\s*(.*?)\s*---$/m); // ["", name1, body1, name2, body2, ...]
    const sheets = [];
    for (let i = 1; i < parts.length; i += 2) {
      const name = parts[i] || `Sheet${(i + 1) / 2}`;
      const body = parts[i + 1] || "";
      const d = detectDelimiter(body);
      const rows = body.split(/\r?\n/).filter(l => l.length).map(l => _splitDelim(l, d));
      if (rows.length) sheets.push({ name, rows });
    }
    if (sheets.length) return sheets;
  }
  const d = detectDelimiter(t);
  const rows = t.split(/\r?\n/).filter(l => l.length).map(l => _splitDelim(l, d));
  return [{ name: "Sheet1", rows }];
}

// Accent-insensitive normaliser for header matching (árfolyam → arfolyam).
function _norm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, ""); }

// Keyword-based column detection in Hungarian + English (no AI needed).
// Roles are checked in priority order so ambiguous headers resolve sensibly.
const HEADER_PATTERNS = [
  ["isin", ["isin"]],
  ["currency", ["deviza", "devizanem", "penznem", "valuta", "currency", "ccy", "curr"]],
  ["quantity", ["darabszam", "darab", "mennyiseg", "namennyiseg", "qty", "quantity", "units", "shares", "nominal", "stk", "db", "pieces", "pcs"]],
  ["costPrice", ["atlagarfolyam", "atlagar", "bekerulesiarfolyam", "bekerulesi", "vetelar", "beszerzesi", "avgcost", "averageprice", "avgprice", "purchaseprice", "bookcost", "costbasis", "cost", "konyvszerinti"]],
  ["currentPrice", ["aktualisarfolyam", "napiarfolyam", "utolsoarfolyam", "arfolyam", "piaciar", "aktualisar", "currentprice", "marketprice", "lastprice", "last", "price", "close", "quote", "kurzus", "nav"]],
  ["marketValue", ["piaciertek", "aktualisertek", "osszertek", "pozicioertek", "marketvalue", "mktvalue", "valuation", "positionvalue", "ertek", "value", "osszeg", "egyenleg", "balance"]],
  ["ticker", ["ticker", "szimbolum", "symbol", "jelzes", "tickerszimbolum"]],
  ["name", ["megnevezes", "ertekpapirmegnevezes", "ertekpapir", "instrumentum", "eszkozneve", "eszkoz", "termek", "instrumentname", "instrument", "security", "description", "holding", "fund", "name", "nev", "elnevezes"]],
  ["assetClass", ["eszkozosztaly", "instrumenttype", "assetclass", "kategoria", "tipus", "category", "type"]],
];
// Return the most SPECIFIC role for a header — the role whose matched keyword is
// longest. This stops "értékpapír" (security/name) being grabbed by "érték" (value),
// or "eszközosztály" (asset class) by "eszköz" (asset/name).
function _bestRoleFor(h, patterns) {
  const n = _norm(h);
  if (!n) return null;
  let bestRole = null, bestLen = 0;
  for (const [role, pats] of patterns) {
    for (const p of pats) { if (n.includes(p) && p.length > bestLen) { bestLen = p.length; bestRole = role; } }
  }
  return bestRole ? { role: bestRole, len: bestLen } : null;
}
function _bestRoleForHeader(h) { return _bestRoleFor(h, HEADER_PATTERNS); }
// Generic keyword-based column detector. `patterns` is a HEADER_PATTERNS-shaped
// table; `valueRoles`/`nameRoles` are the roles whose presence together boosts
// confidence that a row is really the header row (e.g. for positions: a price
// role + a name role; for transactions: an amount + a date/description).
function heuristicSchemaFor(sheets, patterns, valueRoles, nameRoles) {
  let best = null;
  sheets.forEach((sh, si) => {
    const scan = Math.min(sh.rows.length, 25);
    for (let r = 0; r < scan; r++) {
      const row = sh.rows[r] || [];
      const cols = {}, roleLen = {};
      row.forEach((cell, ci) => {
        const b = _bestRoleFor(cell, patterns);
        if (b && (cols[b.role] == null || b.len > roleLen[b.role])) { cols[b.role] = ci; roleLen[b.role] = b.len; }
      });
      const matches = Object.keys(cols).length;
      const hasVal = valueRoles.some(vr => cols[vr] != null);
      const hasName = nameRoles.some(nr => cols[nr] != null);
      const score = matches + (hasName && hasVal ? 2 : 0);
      if (matches >= 2 && (!best || score > best.score)) best = { sheetIndex: si, headerRow: r, columns: cols, globalCurrency: null, score };
    }
  });
  return best;
}
function heuristicSchema(sheets) {
  return heuristicSchemaFor(sheets, HEADER_PATTERNS, ["currentPrice", "marketValue"], ["name", "ticker", "isin"]);
}
// Keyword-based column detection for bank statements / transaction logs
// (Hungarian + English headers), analogous to HEADER_PATTERNS above.
const TXN_HEADER_PATTERNS = [
  ["date", ["tranzakciodatumaesideje", "konyveletsdatuma", "konyvelesdatuma", "ertéknap", "erteknap", "tranzakciodatum", "transactiondate", "bookingdate", "postingdate", "valuedate", "datum", "date", "kelt"]],
  ["currency", ["devizanem", "penznem", "deviza", "currency", "ccy", "curr", "valuta"]],
  ["amount", ["osszeg", "amount", "terheles", "jovairas", "ertek", "value"]],
  ["type", ["tranzakciotipus", "iranyd", "direction", "txtype", "tipus", "type"]],
  ["desc", ["kozlemenyekmegjegyzesek", "partnernev", "megnevezes", "kozlemeny", "leiras", "narrative", "reference", "merchant", "partner", "details", "description", "memo", "desc"]],
  ["category", ["kategoria", "category", "cimke", "tag"]],
  ["account", ["kartyaszam", "szamlaszam", "szamla", "account", "card", "bank"]],
];
function heuristicTxnSchema(sheets) {
  return heuristicSchemaFor(sheets, TXN_HEADER_PATTERNS, ["amount"], ["desc", "date"]);
}
// Keyword-based column detection for a cost / recurring-bill list.
const COST_HEADER_PATTERNS = [
  ["frequency", ["gyakorisag", "frequency", "periodicity", "interval"]],
  ["nextDue", ["kovetkezoesedekesseg", "esedekesseg", "nextdue", "duedate", "esedekes"]],
  ["currency", ["devizanem", "penznem", "deviza", "currency", "ccy", "curr", "valuta"]],
  ["category", ["kategoria", "category", "cimke", "tag"]],
  ["owner", ["tulajdonos", "felelos", "paidby", "owner"]],
  ["notes", ["megjegyzes", "comment", "notes", "note"]],
  ["amount", ["havidij", "osszeg", "amount", "koltseg", "ertek", "value", "ar", "price"]],
  ["type", ["ismetlodo", "recurring", "onetime", "tipus", "type"]],
  ["name", ["megnevezes", "kolcseg", "nev", "name", "item", "bill", "cost", "desc", "description"]],
];
function heuristicCostSchema(sheets) {
  return heuristicSchemaFor(sheets, COST_HEADER_PATTERNS, ["amount"], ["name"]);
}
// Locale-tolerant date parser: handles ISO strings (incl. those normalised by
// fileToText from Excel Date cells), "DD.MM.YYYY"/"DD/MM/YYYY" (day-first, as
// used throughout the rest of this file), "YYYY.MM.DD", and raw Excel serials.
function parseLooseDate(v) {
  if (v == null) return "";
  if (v instanceof Date) return isNaN(v) ? "" : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (!s) return "";
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  if (/^\d{4,6}(\.\d+)?$/.test(s)) { // bare Excel serial that survived text conversion
    const n = Number(s);
    if (n > 20000 && n < 80000) return new Date((n - 25569) * 86400000).toISOString().slice(0, 10);
  }
  return "";
}
// Locale-tolerant number parser: handles "1.234,56", "1,234.56", "1 234,5", "(123)".
function parseLooseNum(v) {
  if (v == null) return NaN;
  let s = String(v).trim();
  const neg = /^\(.*\)$/.test(s) || /-/.test(s);
  s = s.replace(/[^0-9.,]/g, "");
  if (!s) return NaN;
  const c = s.includes(","), d = s.includes(".");
  if (c && d) { if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", "."); else s = s.replace(/,/g, ""); }
  else if (c) { const p = s.split(","); if (p.length === 2 && p[1].length <= 2) s = p[0] + "." + p[1]; else s = s.replace(/,/g, ""); }
  const n = parseFloat(s);
  if (isNaN(n)) return NaN;
  return neg ? -Math.abs(n) : n;
}
function normCcy(s, fallback) {
  const u = String(s || "").toUpperCase();
  if (/\bEUR\b|€/.test(u)) return "EUR";
  if (/\bUSD\b|\$/.test(u)) return "USD";
  if (/\bHUF\b|\bFT\b/.test(u)) return "HUF";
  if (/\bGBP\b|£|GBX/.test(u)) return "GBP";
  const m = u.match(/[A-Z]{3}/);
  return m ? m[0] : (fallback || "EUR");
}
function extractJSONObject(text) {
  const i = String(text || "").indexOf("{");
  if (i < 0) return null;
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}") { depth--; if (depth === 0) { try { return JSON.parse(text.slice(i, j + 1)); } catch { return null; } } }
  }
  return null;
}
function buildSchemaSample(sheets) {
  return sheets.slice(0, 4).map((sh, si) =>
    `### Sheet index ${si} — name "${sh.name}" (${sh.rows.length} rows total)\n` +
    sh.rows.slice(0, 16).map((r, ri) => `r${ri}: ` + r.slice(0, 30).map(c => String(c == null ? "" : c).slice(0, 40)).join(" | ")).join("\n")
  ).join("\n\n");
}
const SCHEMA_SYSTEM = `You map columns in an investment / brokerage holdings export so a program can parse it.
Return ONLY a JSON object (no prose, no markdown fences):
{"sheetIndex": <int>, "headerRow": <int, 0-based row index of the header within that sheet>, "columns": {"name": <int|null>, "ticker": <int|null>, "isin": <int|null>, "quantity": <int|null>, "costPrice": <int|null>, "currentPrice": <int|null>, "marketValue": <int|null>, "currency": <int|null>, "assetClass": <int|null>}, "globalCurrency": <"EUR"|"USD"|"HUF"|"GBP"|null>}
Column values are 0-based column indices in the chosen sheet; use null when a field is absent.
Definitions: quantity = number of shares/units held; costPrice = purchase/average price per unit; currentPrice = latest price per unit; marketValue = current total value of the position. Choose the sheet that actually lists the holdings. If one currency applies to the whole file, set globalCurrency.`;
async function aiDetectInvestmentSchema(sheets) {
  const res = await fetch("/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 700, system: SCHEMA_SYSTEM, messages: [{ role: "user", content: buildSchemaSample(sheets) }] }),
  });
  const result = await res.json();
  return extractJSONObject(result?.content?.[0]?.text || "");
}
function buildPositionsFromSchema(sheets, schema, fileName) {
  if (!schema || !schema.columns) return null;
  const sh = sheets[schema.sheetIndex] || sheets[0];
  if (!sh) return null;
  const c = schema.columns;
  const header = Math.max(0, schema.headerRow || 0);
  const get = (row, idx) => (idx == null || idx < 0) ? "" : (row[idx] == null ? "" : String(row[idx]).trim());
  const items = [];
  for (let r = header + 1; r < sh.rows.length; r++) {
    const row = sh.rows[r];
    if (!row || !row.length) continue;
    const ticker = get(row, c.ticker), isin = get(row, c.isin);
    const name = get(row, c.name) || ticker || isin;
    if (!name) continue;
    if (/^(total|összesen|sum|subtotal|grand total|cash|készpénz)\b/i.test(name)) continue;
    let qty = parseLooseNum(get(row, c.quantity)); qty = isNaN(qty) ? 0 : qty;
    let cost = parseLooseNum(get(row, c.costPrice)); cost = isNaN(cost) ? 0 : cost;
    let price = parseLooseNum(get(row, c.currentPrice)); price = isNaN(price) ? 0 : price;
    let mv = parseLooseNum(get(row, c.marketValue)); mv = isNaN(mv) ? 0 : mv;
    if (!price && qty && mv) price = mv / qty;
    if (!qty && price && mv) qty = mv / price;
    if (!qty && mv && !price) { qty = 1; price = mv; }
    if (!price) continue; // no usable value on this row
    if (!cost) cost = price; // neutral P&L when no cost basis is given
    items.push({
      name, ticker, isin,
      qty: +qty.toFixed(8), costBasis: +cost.toFixed(6), currentPrice: +price.toFixed(6),
      currency: normCcy(get(row, c.currency), schema.globalCurrency), assetClass: get(row, c.assetClass) || "ETF",
      region: "Global", notes: "Imported",
    });
  }
  if (!items.length) return null;
  const base = (fileName || "").replace(/\.[^.]+$/, "").slice(0, 40) || "Imported Portfolio";
  return { type: "positions", portfolioName: base, broker: "", summary: `${items.length} holding${items.length === 1 ? "" : "s"} parsed from ${fileName || "file"}`, items };
}

// Deterministic transaction-row builder used once heuristicTxnSchema (or the
// manual ColumnMapper) has identified which column holds each field. Mirrors
// buildPositionsFromSchema's contract: never throws, returns null if nothing
// usable was found so the caller can fall back further.
function buildTransactionsFromSchema(sheets, schema, fileName, learnedRules) {
  if (!schema || !schema.columns) return null;
  const sh = sheets[schema.sheetIndex] || sheets[0];
  if (!sh) return null;
  const c = schema.columns;
  const header = Math.max(0, schema.headerRow || 0);
  const get = (row, idx) => (idx == null || idx < 0) ? "" : (row[idx] == null ? "" : String(row[idx]).trim());
  const items = [];
  for (let r = header + 1; r < sh.rows.length; r++) {
    const row = sh.rows[r];
    if (!row || !row.length) continue;
    const date = parseLooseDate(get(row, c.date));
    const amount = parseLooseNum(get(row, c.amount));
    const desc = get(row, c.desc) || get(row, c.account) || "";
    if (!date || isNaN(amount) || amount === 0 || !desc) continue;
    const rawType = get(row, c.type).toLowerCase();
    const type = /jov|bevetel|income|credit|^\+/.test(rawType) ? "income"
      : /kiad|terheles|expense|debit|^-/.test(rawType) ? "expense"
      : (amount >= 0 ? "income" : "expense");
    const category = get(row, c.category) || inferCategory(desc, learnedRules || {}) || guessCategoryByKeyword(desc) || (type === "income" ? "Income" : "Uncategorized");
    items.push({
      date, desc,
      amount: +Math.abs(amount).toFixed(2),
      currency: normCcy(get(row, c.currency), schema.globalCurrency),
      category, type,
      account: get(row, c.account) || "Imported",
    });
  }
  if (!items.length) return null;
  return { type: "transactions", summary: `${items.length} transaction${items.length === 1 ? "" : "s"} parsed from ${fileName || "file"}`, items };
}

// Deterministic cost/bill-row builder — same contract as the above, for the
// "cost_list" import type (recurring bills, subscriptions, one-off costs).
function buildCostsFromSchema(sheets, schema, fileName, learnedRules) {
  if (!schema || !schema.columns) return null;
  const sh = sheets[schema.sheetIndex] || sheets[0];
  if (!sh) return null;
  const c = schema.columns;
  const header = Math.max(0, schema.headerRow || 0);
  const get = (row, idx) => (idx == null || idx < 0) ? "" : (row[idx] == null ? "" : String(row[idx]).trim());
  const items = [];
  for (let r = header + 1; r < sh.rows.length; r++) {
    const row = sh.rows[r];
    if (!row || !row.length) continue;
    const name = get(row, c.name);
    if (!name) continue;
    if (/^(total|összesen|osszesen|sum|subtotal|grand total)\b/i.test(name)) continue;
    const amount = parseLooseNum(get(row, c.amount));
    if (isNaN(amount) || !amount) continue;
    const freqRaw = get(row, c.frequency).toLowerCase();
    const frequency = /negyed|quarter/.test(freqRaw) ? "quarterly" : /ev|year|annual/.test(freqRaw) ? "annual" : "monthly";
    const typeRaw = get(row, c.type).toLowerCase();
    const type = /egyszeri|one[- ]?time|onetime/.test(typeRaw) ? "onetime" : "recurring";
    // Same guessing chain as transactions: explicit column → learned merchant
    // rules (keyed the same way, since bill names are just short descriptions)
    // → hardcoded keywords → "Uncategorized" (NOT "Other" — that's reserved
    // for confirmed-miscellaneous, same convention as transactions).
    const category = get(row, c.category) || inferCategory(name, learnedRules || {}) || guessCategoryByKeyword(name) || "Uncategorized";
    items.push({
      name,
      amount: +Math.abs(amount).toFixed(2),
      currency: normCcy(get(row, c.currency), schema.globalCurrency),
      category,
      type, frequency,
      owner: get(row, c.owner) || "Joint",
      nextDue: parseLooseDate(get(row, c.nextDue)) || "",
      notes: get(row, c.notes) || "Imported",
    });
  }
  if (!items.length) return null;
  return { type: "costs", summary: `${items.length} cost${items.length === 1 ? "" : "s"} parsed from ${fileName || "file"}`, items };
}

// ─── Erste "Instrumentum bekerülés" holdings report (Crystal Reports .xls) ─────
// Quirky layout: title + metadata rows, header on a lower row, MERGED cells that
// shift values out of line with their header, several purchase-lot rows per
// instrument with subtotal rows, group labels, totals/footer, no ISIN/ticker, and
// cost in EUR while some market prices are in USD. We read each value as the
// nearest numeric to its header, aggregate lots per instrument (weighted-avg
// cost), and convert the market price into the cost currency. Returns a positions
// batch or null.
function tryParseErsteHoldingsXLS(text) {
  const convert = (amt, from, to) => { if (!from || !to || from === to) return amt; const huf = toHUF(amt, from); return to === "EUR" ? huf / RATES.EUR : to === "USD" ? huf / RATES.USD : huf; };
  const sheets = parseDelimitedToSheets(text);
  for (const sh of sheets) {
    const rows = sh.rows;
    let h = -1;
    for (let r = 0; r < Math.min(rows.length, 15); r++) {
      const nn = rows[r].map(_norm);
      if (nn.includes("instrumentum") && nn.some(x => x.includes("darabsz"))) { h = r; break; }
    }
    if (h < 0) continue;
    const hdr = rows[h].map(_norm);
    const idxOf = pred => hdr.findIndex(pred);
    const nameCol = idxOf(x => x === "instrumentum");
    const qtyCol = idxOf(x => x.includes("darabsz"));
    const costCol = idxOf(x => x.includes("bekerar"));   // "Beker. ár" — purchase price/unit
    const mktCol = idxOf(x => x.includes("piaciar"));     // "Piaci ár" — market price/unit
    const typeCol = idxOf(x => x === "ve" || x.includes("vetel"));
    const numNear = (row, idx) => { if (idx < 0) return { n: NaN, at: -1 }; for (let j = idx; j <= idx + 2 && j < row.length; j++) { const n = parseLooseNum(row[j]); if (!isNaN(n)) return { n, at: j }; } return { n: NaN, at: -1 }; };
    const ccyAfter = (row, at) => { for (let j = at + 1; j <= at + 2 && j < row.length; j++) { const c = normCcy(row[j], null); if (c) return c; } return null; };
    const FOOT = /^(osszesen|felhivjuk|total|mindosszesen|vegosszeg|egyenleg)/;
    const agg = {}; let group = null;
    for (let r = h + 1; r < rows.length; r++) {
      const row = rows[r]; const name = (row[nameCol] || "").trim();
      if (!name) continue; // subtotal / blank row
      if (FOOT.test(_norm(name))) continue;
      const q = numNear(row, qtyCol);
      if (isNaN(q.n) || q.n === 0) { if (_norm(name).length > 2 && !group) group = name; continue; } // group label
      const c = numNear(row, costCol), m = numNear(row, mktCol);
      const costCcy = ccyAfter(row, c.at) || "EUR";
      const mktCcy = ccyAfter(row, m.at) || costCcy;
      const sign = /elad/.test(_norm(row[typeCol] || "")) ? -1 : 1;
      const a = agg[name] || (agg[name] = { name, qty: 0, costSum: 0, costCcy, mkt: NaN, mktCcy });
      a.qty += sign * q.n;
      a.costSum += sign * q.n * (isNaN(c.n) ? 0 : c.n);
      if (!isNaN(m.n)) { a.mkt = m.n; a.mktCcy = mktCcy; }
    }
    const items = [];
    for (const k of Object.keys(agg)) {
      const a = agg[k];
      if (a.qty <= 1e-9) continue;
      const cb = a.costSum / a.qty;
      const cp = isNaN(a.mkt) ? cb : convert(a.mkt, a.mktCcy, a.costCcy);
      items.push({ name: a.name, ticker: "", isin: "", qty: +a.qty.toFixed(6), costBasis: +cb.toFixed(6), currentPrice: +cp.toFixed(6), currency: a.costCcy, assetClass: "ETF", region: "Global", notes: "Imported from Erste" });
    }
    if (items.length) return { type: "positions", portfolioName: group || "Erste", broker: "Erste", summary: `${items.length} holding${items.length === 1 ? "" : "s"} from Erste report`, items };
  }
  return null;
}

// ─── Default Data ─────────────────────────────────────────────────────────────
const EMPTY_DATA = {
  costs: [], transactions: [], portfolios: [], realEstate: [],
  cashAccounts: [], budgetTargets: [], savingsGoals: [], netWorthHistory: [],
  merchantRules: [], // { keyword, category } — learned from user corrections
  customCategories: [], // user-defined categories
  plannedExpenses: [], // { id, name, amount, currency, date, category, notes } — upcoming one-off outlays
  displayCurrency: "HUF" // preferred display currency (HUF | EUR | USD)
};

const DEMO_DATA = {
  costs: [
    { id: "c1", name: "Rent", category: "Housing", amount: 180000, currency: "HUF", type: "recurring", frequency: "monthly", owner: "Joint", nextDue: "2026-04-01", notes: "" },
    { id: "c2", name: "Netflix", category: "Entertainment", amount: 5, currency: "EUR", type: "recurring", frequency: "monthly", owner: "Joint", nextDue: "2026-04-10", notes: "" },
    { id: "c3", name: "Gym", category: "Health", amount: 12000, currency: "HUF", type: "recurring", frequency: "monthly", owner: "You", nextDue: "2026-04-05", notes: "" },
  ],
  transactions: [
    { id: "t1", date: "2026-03-01", desc: "Salary", amount: 750000, currency: "HUF", category: "Income", type: "income", account: "OTP" },
    { id: "t2", date: "2026-03-05", desc: "Lidl", amount: -18400, currency: "HUF", category: "Food", type: "expense", account: "OTP" },
    { id: "t3", date: "2026-03-10", desc: "BKK bérlet", amount: -9500, currency: "HUF", category: "Transport", type: "expense", account: "OTP" },
    { id: "t4", date: "2026-03-15", desc: "Zsófia salary", amount: 650000, currency: "HUF", category: "Income", type: "income", account: "Revolut" },
  ],
  portfolios: [{
    id: "p1", name: "IBKR Portfolio", broker: "Interactive Brokers", currency: "USD", description: "Main ETF portfolio",
    positions: [
      { id: "pos1", ticker: "IWDA", name: "iShares Core MSCI World", qty: 50, costBasis: 85, currentPrice: 98, currency: "USD", assetClass: "ETF", region: "Global" },
      { id: "pos2", ticker: "EIMI", name: "iShares Core MSCI EM", qty: 30, costBasis: 32, currentPrice: 35, currency: "USD", assetClass: "ETF", region: "EM" },
    ]
  }],
  realEstate: [
    { id: "re1", name: "Budapest Apartment", address: "Budapest, XIII.", purchasePrice: 45000000, currentValue: 62000000, mortgage: 18000000, currency: "HUF", purchaseYear: 2019 }
  ],
  cashAccounts: [
    { id: "ca1", name: "OTP Checking", balance: 320000, currency: "HUF", type: "Checking" },
    { id: "ca2", name: "Revolut EUR", balance: 2800, currency: "EUR", type: "Savings" },
  ],
  budgetTargets: [
    { category: "Food", monthlyLimit: 80000, currency: "HUF" },
    { category: "Entertainment", monthlyLimit: 30000, currency: "HUF" },
  ],
  savingsGoals: [
    { id: "sg1", name: "Emergency Fund", targetAmount: 3000000, currentAmount: 800000, currency: "HUF", targetDate: "2027-01-01", notes: "6 months expenses" },
    { id: "sg2", name: "Greece Holiday", targetAmount: 500000, currentAmount: 120000, currency: "HUF", targetDate: "2026-08-01", notes: "" },
  ],
  netWorthHistory: []
};

// ─── GDPR ─────────────────────────────────────────────────────────────────────
// TODO before launch: replace every [PLACEHOLDER] below with real values
const GDPR_CONSENT_KEY = "pfa_gdpr_consent_v1"; // localStorage key (per userId)
const PRIVACY_EMAIL    = "[knowyourinvestingframework@gmail.com]";       // TODO: e.g. privacy@yourdomain.com
const OPERATOR_NAME    = "[Dominik Zvara]";       // TODO: your legal name / business name
const APP_DOMAIN       = "[https://pfa-iota.vercel.app]";          // TODO: e.g. pfa.yourdomain.com
const SUPABASE_REGION  = "[eu-west-1]";     // TODO: Dashboard → Project Settings → Infrastructure

// ─── UI Primitives ────────────────────────────────────────────────────────────
function Card({ children, style }) {
  return <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, ...style }}>{children}</div>;
}
function Btn({ children, onClick, variant = "primary", style, disabled }) {
  const base = { padding: "8px 16px", borderRadius: 8, border: "none", cursor: disabled ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600, opacity: disabled ? 0.5 : 1 };
  const v = { primary: { background: C.accent, color: "#000" }, ghost: { background: C.surfaceHigh, color: C.text }, danger: { background: C.red, color: "#fff" }, success: { background: C.green, color: "#000" } };
  return <button onClick={onClick} disabled={disabled} style={{ ...base, ...v[variant], ...style }}>{children}</button>;
}
function Inp({ value, onChange, placeholder, type = "text", style, onKeyDown }) {
  return <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} onKeyDown={onKeyDown}
    style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.text, fontSize: 13, outline: "none", width: "100%", boxSizing: "border-box", colorScheme: "dark", ...style }} />;
}
function Sel({ value, onChange, options, style }) {
  return <select value={value} onChange={e => onChange(e.target.value)}
    style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.text, fontSize: 13, outline: "none", width: "100%", boxSizing: "border-box", ...style }}>
    {options.map(o => <option key={o} value={o}>{o}</option>)}
  </select>;
}
function Stat({ label, value, color }) {
  return <div style={{ textAlign: "center" }}>
    <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 1 }}>{label}</div>
    <div style={{ fontSize: 20, fontWeight: 700, color: color || C.text }}>{value}</div>
  </div>;
}
function Tag({ children, color }) {
  return <span style={{ background: (color || C.blue) + "22", color: color || C.blue, borderRadius: 6, padding: "2px 8px", fontSize: 11, fontWeight: 600 }}>{children}</span>;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function Auth({ onLogin }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [authError, setAuthError] = useState(null);
  const isMobile = useIsMobile();
  // GDPR: all three must be checked before sign-in is allowed
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [ageConfirmed, setAgeConfirmed]       = useState(false);
  const [partnerConfirmed, setPartnerConfirmed] = useState(false);
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);
  const canSendLink = email && consentAccepted && ageConfirmed && partnerConfirmed;

  async function sendLink() {
    if (!canSendLink) { setAuthError("Please check all boxes below before continuing."); return; }
    if (!email.includes("@")) { setAuthError("Please enter a valid email address."); return; }
    setLoading(true); setAuthError(null);
    const { error } = await supabase.auth.signInWithOtp({ email });
    if (error) { setAuthError("Couldn't send the link — you may not be on the access list yet."); }
    else { setSent(true); }
    setLoading(false);
  }

  const features = [
    { icon: "📊", label: "Spending by category", desc: "See exactly where your money goes each month" },
    { icon: "🏦", label: "Bank import", desc: "Upload Revolut, OTP, Erste CSV — auto-categorized" },
    { icon: "📈", label: "Investment tracker", desc: "Portfolio positions, P&L, asset class breakdown" },
    { icon: "🎯", label: "Budget targets", desc: "Set limits, auto-detect recurring bills, get alerts" },
    { icon: "💬", label: "AI assistant", desc: "Ask questions, log transactions by typing naturally" },
    { icon: "🔒", label: "Private & secure", desc: "No ads, no selling your data. AI chat sends a summary to Anthropic's API — see Privacy Policy." },
  ];

  return (
    <>
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'DM Sans', sans-serif", display: "flex", flexDirection: "column" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono&display=swap" rel="stylesheet" />

      {/* Hero */}
      <div style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", alignItems: "center", justifyContent: "center", padding: isMobile ? "40px 20px" : "60px 48px", gap: isMobile ? 40 : 80, maxWidth: 1100, margin: "0 auto", width: "100%", boxSizing: "border-box" }}>

        {/* Left — pitch */}
        <div style={{ flex: 1 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, background: C.accent + "18", border: `1px solid ${C.accent}44`, borderRadius: 20, padding: "4px 12px", marginBottom: 24 }}>
            <span style={{ color: C.accent, fontSize: 12, fontWeight: 600 }}>✦ Early Access · Invite Only</span>
          </div>
          <h1 style={{ fontSize: isMobile ? 32 : 44, fontWeight: 700, lineHeight: 1.15, margin: "0 0 16px", color: C.text }}>
            Your household finances,<br />
            <span style={{ color: C.accent }}>finally under control.</span>
          </h1>
          <p style={{ fontSize: 16, color: C.textSoft, lineHeight: 1.6, margin: "0 0 36px", maxWidth: 440 }}>
            PFA is a private finance assistant for families. Import bank statements, track investments, set budgets — and talk to an AI that knows your numbers.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12 }}>
            {features.map(f => (
              <div key={f.icon} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "12px 14px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10 }}>
                <span style={{ fontSize: 20, flexShrink: 0 }}>{f.icon}</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{f.label}</div>
                  <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.4 }}>{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right — login card */}
        <div style={{ width: isMobile ? "100%" : 360, flexShrink: 0 }}>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 32 }}>
            {sent ? (
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 40, marginBottom: 16 }}>📬</div>
                <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 8 }}>Check your inbox</div>
                <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6, marginBottom: 20 }}>
                  We sent a login link to <strong style={{ color: C.text }}>{email}</strong>.<br />
                  Click it to sign in — no password needed.
                </div>
                <div style={{ background: C.surfaceHigh, borderRadius: 8, padding: "10px 14px", fontSize: 12, color: C.muted, textAlign: "left" }}>
                  💡 Didn't get it? Check your spam folder or wait 30 seconds and try again.
                </div>
                <button onClick={() => { setSent(false); setEmail(""); }} style={{ marginTop: 20, background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 12, textDecoration: "underline" }}>
                  Use a different email
                </button>
              </div>
            ) : (
              <>
                <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 4 }}>Sign in to PFA</div>
                <div style={{ fontSize: 13, color: C.muted, marginBottom: 24, lineHeight: 1.5 }}>
                  Enter your email and we'll send you a secure login link. No password required.
                </div>

                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Email address</div>
                  <Inp value={email} onChange={v => { setEmail(v); setAuthError(null); }}
                    placeholder="you@example.com" type="email"
                    onKeyDown={e => e.key === "Enter" && sendLink()} />
                </div>

                {/* ── GDPR consent checkboxes ── */}
                <div style={{ marginBottom: 14, display: "flex", flexDirection: "column", gap: 9 }}>
                  <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
                    <input type="checkbox" checked={consentAccepted} onChange={e => setConsentAccepted(e.target.checked)}
                      style={{ marginTop: 2, width: 15, height: 15, flexShrink: 0, cursor: "pointer", accentColor: C.accent }} />
                    <span style={{ fontSize: 12, color: C.textSoft, lineHeight: 1.55 }}>
                      I accept the{" "}
                      <button onClick={() => setShowPrivacyModal(true)}
                        style={{ background: "none", border: "none", color: C.accent, cursor: "pointer", fontSize: 12, padding: 0, textDecoration: "underline" }}>
                        Privacy Policy
                      </button>.
                      {" "}My data is stored on Supabase. AI chat sends a summary to Anthropic's API.
                    </span>
                  </label>
                  <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
                    <input type="checkbox" checked={ageConfirmed} onChange={e => setAgeConfirmed(e.target.checked)}
                      style={{ marginTop: 2, width: 15, height: 15, flexShrink: 0, cursor: "pointer", accentColor: C.accent }} />
                    <span style={{ fontSize: 12, color: C.textSoft, lineHeight: 1.55 }}>
                      I confirm I am 16 years of age or older (GDPR Art. 8).
                    </span>
                  </label>
                  <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
                    <input type="checkbox" checked={partnerConfirmed} onChange={e => setPartnerConfirmed(e.target.checked)}
                      style={{ marginTop: 2, width: 15, height: 15, flexShrink: 0, cursor: "pointer", accentColor: C.accent }} />
                    <span style={{ fontSize: 12, color: C.textSoft, lineHeight: 1.55 }}>
                      If I add data about other household members, they are aware and have agreed.
                    </span>
                  </label>
                </div>

                {authError && (
                  <div style={{ background: C.red + "18", border: `1px solid ${C.red}44`, borderRadius: 8, padding: "10px 12px", fontSize: 12, color: C.red, marginBottom: 12, lineHeight: 1.5 }}>
                    ⚠ {authError}
                  </div>
                )}

                <Btn onClick={sendLink} disabled={loading || !canSendLink} style={{ width: "100%", marginBottom: 16, padding: "11px 0", fontSize: 14 }}>
                  {loading ? "Sending…" : "Send login link →"}
                </Btn>

                <div style={{ background: C.surfaceHigh, borderRadius: 8, padding: "10px 12px", fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
                  🔒 <strong style={{ color: C.textSoft }}>Invite only.</strong> Access is currently limited. If you don't receive a link, reach out to get added to the list.
                </div>
              </>
            )}

            <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${C.border}`, textAlign: "center" }}>
              <button onClick={onLogin} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 12, textDecoration: "underline" }}>
                Explore the demo without signing in →
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{ borderTop: `1px solid ${C.border}`, padding: "16px 24px", textAlign: "center", fontSize: 11, color: C.muted }}>
        PFA · Personal Finance Assistant ·{" "}
        <button onClick={() => setShowPrivacyModal(true)}
          style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 11, padding: 0, textDecoration: "underline" }}>
          Privacy Policy
        </button>
        {" "}· Supabase ({SUPABASE_REGION}) · AI by Anthropic
      </div>
    </div>
    {showPrivacyModal && <PrivacyPolicyModal onClose={() => setShowPrivacyModal(false)} />}
    </>
  );
}

// ─── Privacy Policy Modal ─────────────────────────────────────────────────────
function PrivacyPolicyModal({ onClose }) {
  const sections = [
    { title: "1. Who operates this service",
      body: `PFA (Personal Finance Assistant) is operated by ${OPERATOR_NAME}. Contact: ${PRIVACY_EMAIL}` },
    { title: "2. What data we collect",
      body: "We collect your email address (for authentication) and the financial data you enter: transactions, recurring costs, investment positions, cash accounts, real estate, savings goals, and budget targets. We do not collect bank credentials or card numbers." },
    { title: "3. Legal basis (GDPR Art. 6)",
      body: "Processing is based on the performance of a contract (Art. 6(1)(b)) — we store your data to provide the service you signed up for." },
    { title: "4. Third-party processors (GDPR Art. 28)",
      body: `• Supabase, Inc. (database + auth): your data is stored in Supabase's EU data centre (${SUPABASE_REGION}). DPA available at supabase.com/privacy.\n• Anthropic, Inc. (AI): when you use AI chat, a structured summary of your financial data and your messages are sent to Anthropic's Claude API. Uploaded bank files are also sent (up to 14,000 chars). Anthropic processes data under their API DPA. Neither processor may use your data for other purposes.` },
    { title: "5. Data retention",
      body: "Data is kept while your account is active. You can delete everything via Account Settings at any time. Accounts inactive for 3+ years will be deleted after a 30-day notice email." },
    { title: "6. Your rights (GDPR Art. 15–22)",
      body: `Access · Correct · Erase (Art. 17) · Portability (Art. 20) · Object · Withdraw consent.\nUse Account Settings (Export / Delete) or email ${PRIVACY_EMAIL}. We respond within 30 days.` },
    { title: "7. Household member data",
      body: "If you enter data about other people (e.g. a partner's income), you confirm they are aware and have agreed." },
    { title: "8. Security",
      body: "All data is transmitted over HTTPS/TLS. Authentication uses passwordless magic links. Supabase enforces row-level security — each account can only access its own data." },
    { title: "9. Supervisory authority",
      body: "To lodge a complaint: NAIH – Nemzeti Adatvédelmi és Információszabadság Hatóság\nugyfelszolgalat@naih.hu · naih.hu" },
  ];
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 28, maxWidth: 580, width: "100%", maxHeight: "88vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <div style={{ fontWeight: 700, fontSize: 18 }}>Privacy Policy</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 22, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 20 }}>
          Last updated: 2026-06-01 · Operator: {OPERATOR_NAME} · {APP_DOMAIN} · {PRIVACY_EMAIL}
        </div>
        {sections.map(s => (
          <div key={s.title} style={{ marginBottom: 18 }}>
            <div style={{ fontWeight: 600, fontSize: 13, color: C.text, marginBottom: 5 }}>{s.title}</div>
            <div style={{ fontSize: 12, color: C.textSoft, lineHeight: 1.75, whiteSpace: "pre-line" }}>{s.body}</div>
          </div>
        ))}
        <Btn onClick={onClose} style={{ width: "100%", marginTop: 8 }}>Close</Btn>
      </div>
    </div>
  );
}

// ─── GDPR Consent Gate ────────────────────────────────────────────────────────
// Shown once per user after first login. Overlays main app until all boxes checked.
function GDPRConsentGate({ userId, onAccept }) {
  const [consent, setConsent]   = useState(false);
  const [age, setAge]           = useState(false);
  const [partner, setPartner]   = useState(false);
  const [showPolicy, setShowPolicy] = useState(false);
  const canAccept = consent && age && partner;

  function accept() {
    if (!canAccept) return;
    try { localStorage.setItem(`${GDPR_CONSENT_KEY}_${userId}`, new Date().toISOString()); } catch (e) {}
    onAccept();
  }

  return (
    <>
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.88)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 28, maxWidth: 480, width: "100%" }}>
          <div style={{ fontSize: 26, marginBottom: 12, textAlign: "center" }}>🔒</div>
          <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 6, textAlign: "center" }}>Before you start</div>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 24, lineHeight: 1.6, textAlign: "center" }}>
            Please confirm the following to continue.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 24 }}>
            {[
              { val: consent, set: setConsent, label: <>I have read and accept the{" "}<button onClick={() => setShowPolicy(true)} style={{ background: "none", border: "none", color: C.accent, cursor: "pointer", fontSize: 13, padding: 0, textDecoration: "underline" }}>Privacy Policy</button>. I understand my data is stored on Supabase and AI chat sends a summary to Anthropic's API.</> },
              { val: age,     set: setAge,     label: "I confirm I am 16 years of age or older (GDPR Art. 8)." },
              { val: partner, set: setPartner, label: "If I add data about other household members, they are aware and have agreed." },
            ].map((item, i) => (
              <label key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start", cursor: "pointer" }}>
                <input type="checkbox" checked={item.val} onChange={e => item.set(e.target.checked)}
                  style={{ marginTop: 2, width: 16, height: 16, flexShrink: 0, cursor: "pointer", accentColor: C.accent }} />
                <span style={{ fontSize: 13, color: C.textSoft, lineHeight: 1.6 }}>{item.label}</span>
              </label>
            ))}
          </div>
          <Btn onClick={accept} disabled={!canAccept} style={{ width: "100%", padding: "12px 0", fontSize: 14 }}>
            Continue to PFA →
          </Btn>
          {!canAccept && <div style={{ textAlign: "center", fontSize: 11, color: C.muted, marginTop: 8 }}>Please check all three boxes</div>}
        </div>
      </div>
      {showPolicy && <PrivacyPolicyModal onClose={() => setShowPolicy(false)} />}
    </>
  );
}

// ─── Account Settings & Privacy Modal ─────────────────────────────────────────
function AccountSettingsModal({ onClose, onExport, onDeleteRequest, userEmail, onShowPrivacy }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    await onDeleteRequest();
    setDeleted(true);
    setDeleting(false);
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 28, maxWidth: 420, width: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 18 }}>Account &amp; Privacy</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 22, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 20 }}>
          Signed in as <strong style={{ color: C.textSoft }}>{userEmail}</strong>
        </div>

        <div style={{ marginBottom: 10 }}>
          <Btn variant="ghost" onClick={onExport} style={{ width: "100%", textAlign: "left", padding: "11px 16px" }}>
            📥 Export my data (JSON)
          </Btn>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 4, paddingLeft: 4 }}>
            GDPR Art. 20 — right to data portability. Downloads all your financial data as JSON.
          </div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <Btn variant="ghost" onClick={() => { onClose(); onShowPrivacy(); }} style={{ width: "100%", textAlign: "left", padding: "11px 16px" }}>
            🔒 View Privacy Policy
          </Btn>
        </div>

        <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 16 }}>
          {deleted ? (
            <div style={{ background: C.green + "18", border: `1px solid ${C.green}44`, borderRadius: 10, padding: 14, fontSize: 13, color: C.green, lineHeight: 1.7 }}>
              ✓ Your financial data has been deleted and you have been signed out.<br />
              <span style={{ fontSize: 11, color: C.muted }}>Login email queued for removal within 7 days. To expedite: {PRIVACY_EMAIL}</span>
            </div>
          ) : !confirmDelete ? (
            <>
              <Btn variant="danger" onClick={() => setConfirmDelete(true)} style={{ width: "100%", padding: "10px 0" }}>
                Delete my account and all data
              </Btn>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 6, textAlign: "center" }}>
                GDPR Art. 17 — right to erasure. Permanently deletes all financial data.
              </div>
            </>
          ) : (
            <div style={{ background: C.red + "18", border: `1px solid ${C.red}44`, borderRadius: 10, padding: 16 }}>
              <div style={{ fontWeight: 700, color: C.red, marginBottom: 8 }}>Are you sure?</div>
              <div style={{ fontSize: 12, color: C.textSoft, marginBottom: 16, lineHeight: 1.6 }}>
                This permanently deletes all your costs, transactions, investments, and savings. Cannot be undone.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn variant="danger" disabled={deleting} onClick={handleDelete} style={{ flex: 1 }}>
                  {deleting ? "Deleting…" : "Yes, delete everything"}
                </Btn>
                <Btn variant="ghost" onClick={() => setConfirmDelete(false)} style={{ flex: 1 }}>Cancel</Btn>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Month Picker helper ──────────────────────────────────────────────────────
function MonthPicker({ viewMonth, setViewMonth, thisMonth }) {
  const [y, m] = viewMonth.split("-").map(Number);
  const label = new Date(y, m - 1, 1).toLocaleString("en-GB", { month: "long", year: "numeric" });
  function shift(delta) {
    const d = new Date(y, m - 1 + delta, 1);
    const nm = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (nm <= thisMonth) setViewMonth(nm);
  }
  return (
    <Card style={{ padding: "12px 16px", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, minWidth: 150 }}>
      <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 1 }}>Month</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button onClick={() => shift(-1)} style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 9px", color: C.muted, cursor: "pointer", fontSize: 14 }}>‹</button>
        <span style={{ fontWeight: 700, fontSize: 13, color: C.text, whiteSpace: "nowrap" }}>{label}</span>
        <button onClick={() => shift(1)} disabled={viewMonth >= thisMonth}
          style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 9px", color: viewMonth >= thisMonth ? C.border : C.muted, cursor: viewMonth >= thisMonth ? "default" : "pointer", fontSize: 14 }}>›</button>
      </div>
      {viewMonth === thisMonth && <div style={{ fontSize: 10, color: C.accent }}>current month</div>}
    </Card>
  );
}

// ─── Editable Transaction Row (used in cost modal + all-txn modal) ────────────
function EditableTxnRow({ t, readonly, setData, data }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ date: t.date, desc: t.desc, amount: String(Math.abs(t.amount)), currency: t.currency, category: t.category, type: t.type });

  function save() {
    const amt = parseFloat(draft.amount);
    if (!amt) return;
    const keyword = (draft.desc || "").toLowerCase().split(/[\s,.\-/]+/).find(w => w.length >= 4);
    setData(d => ({
      ...d,
      transactions: d.transactions.map(x => x.id === t.id ? {
        ...x, date: draft.date, desc: draft.desc, category: draft.category, type: draft.type, currency: draft.currency,
        amount: draft.type === "expense" ? -Math.abs(amt) : Math.abs(amt)
      } : x),
      merchantRules: keyword && draft.category !== t.category
        ? [...(d.merchantRules || []).filter(r => r.keyword !== keyword), { keyword, category: draft.category }]
        : (d.merchantRules || [])
    }));
    setEditing(false);
  }

  if (editing && !readonly) {
    return (
      <div style={{ padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr 1fr 1fr", gap: 6, marginBottom: 6 }}>
          <Inp value={draft.date} onChange={v => setDraft(d => ({ ...d, date: v }))} type="date" />
          <Inp value={draft.desc} onChange={v => setDraft(d => ({ ...d, desc: v }))} placeholder="Description" />
          <Inp value={draft.amount} onChange={v => setDraft(d => ({ ...d, amount: v }))} placeholder="Amount" type="number" />
          <Sel value={draft.currency} onChange={v => setDraft(d => ({ ...d, currency: v }))} options={["HUF","EUR","USD"]} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto auto", gap: 6 }}>
          <Sel value={draft.category} onChange={v => setDraft(d => ({ ...d, category: v }))} options={allCategories(data)} />
          <Sel value={draft.type} onChange={v => setDraft(d => ({ ...d, type: v }))} options={["expense","income"]} />
          <Btn onClick={save} style={{ fontSize: 12 }}>Save</Btn>
          <Btn variant="ghost" onClick={() => setEditing(false)} style={{ fontSize: 12 }}>Cancel</Btn>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
        <span style={{ fontSize: 11, color: C.muted, flexShrink: 0 }}>{t.date}</span>
        <select value={t.category}
          onChange={e => {
            const newCat = e.target.value;
            const keyword = (t.desc || "").toLowerCase().split(/[\s,.\-/]+/).find(w => w.length >= 4);
            setData(d => ({
              ...d,
              transactions: d.transactions.map(x => x.id === t.id ? { ...x, category: newCat } : x),
              merchantRules: keyword ? [...(d.merchantRules || []).filter(r => r.keyword !== keyword), { keyword, category: newCat }] : (d.merchantRules || [])
            }));
          }}
          disabled={readonly}
          style={{ background: (t.type === "income" ? C.green : C.red) + "22", color: t.type === "income" ? C.green : C.red, border: "none", borderRadius: 6, padding: "2px 6px", fontSize: 11, fontWeight: 600, cursor: readonly ? "default" : "pointer", outline: "none", flexShrink: 0 }}>
          {allCategories(data).map(cat => <option key={cat} value={cat}>{cat}</option>)}
        </select>
        <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.desc}</span>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
        <span style={{ fontWeight: 600, color: t.type === "income" ? C.green : C.red }}>
          {t.type === "expense" ? "−" : "+"}{fmtHUF(toHUF(Math.abs(t.amount), t.currency))}
        </span>
        {!readonly && (
          <button onClick={() => { setDraft({ date: t.date, desc: t.desc, amount: String(Math.abs(t.amount)), currency: t.currency, category: t.category, type: t.type }); setEditing(true); }}
            style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 13, padding: "0 2px" }}>✎</button>
        )}
        {!readonly && <Btn variant="danger" onClick={() => setData(d => ({ ...d, transactions: d.transactions.filter(x => x.id !== t.id) }))} style={{ padding: "4px 10px" }}>×</Btn>}
      </div>
    </div>
  );
}

// ─── Getting Started Empty State ──────────────────────────────────────────────
function GettingStarted({ tab, readonly, onOpenChat, onOpenUpload, onAddRealEstate, onAddCash }) {
  const [hovered, setHovered] = useState(null);
  const configs = {
    costs: {
      icon: "📋",
      title: "Track your recurring costs",
      subtitle: "Add your bills, subscriptions, and fixed expenses to see where your money goes each month.",
      steps: [
        { icon: "➕", text: "Add a recurring bill (rent, subscriptions, utilities)", action: { type: "chat", message: "I want to add a recurring bill" } },
        { icon: "💬", text: "Tell the AI: \"Add 120k HUF monthly rent\"", action: { type: "chat", message: "Add 120k HUF monthly rent" } },
        { icon: "📂", text: "Import a cost list from Excel or CSV", action: { type: "upload" } },
      ],
    },
    cashflow: {
      icon: "💸",
      title: "See your monthly cash flow",
      subtitle: "Import your bank statement to automatically track income and expenses.",
      steps: [
        { icon: "🏦", text: "Upload your transactions (without sensitive data)", action: { type: "upload" } },
        { icon: "💬", text: "Tell the AI: \"I spent 8500 HUF on lunch today\"", action: { type: "chat", message: "I spent 8500 HUF on lunch today" } },
        { icon: "💬", text: "Or: \"I got paid 850,000 HUF salary this month\"", action: { type: "chat", message: "I got paid 850,000 HUF salary this month" } },
      ],
    },
    wealth: {
      icon: "📈",
      title: "Track your net worth",
      subtitle: "Add your investments, real estate, and cash accounts for a complete wealth picture.",
      steps: [
        { icon: "📤", text: "Upload your portfolios using file import", action: { type: "upload" } },
        { icon: "🏠", text: "Add real estate — enter property value, mortgage, and equity.", hint: "You can also tell the AI: \"I own a flat worth 45M HUF with 18M mortgage\"", action: { type: "chat", message: "Add real estate with current value and mortgage" }, manualKey: "re" },
        { icon: "💰", text: "Add cash or savings accounts — bank, brokerage, or cash holdings.", hint: "Or tell the AI: \"I have 2M HUF in OTP bank and €5,000 in Revolut\"", action: { type: "chat", message: "Add a cash account" }, manualKey: "cash" },
      ],
    },
  };

  const cfg = configs[tab];
  if (!cfg) return null;

  function handleStep(action) {
    if (readonly || !action) return;
    if (action.type === "upload") onOpenUpload?.();
    else if (action.type === "chat") onOpenChat?.(action.message);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "48px 24px", textAlign: "center", maxWidth: 520, margin: "0 auto" }}>
      <div style={{ fontSize: 48, marginBottom: 20, lineHeight: 1 }}>{cfg.icon}</div>
      <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 8, color: C.text }}>{cfg.title}</div>
      <div style={{ fontSize: 14, color: C.muted, lineHeight: 1.6, marginBottom: 32 }}>{cfg.subtitle}</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", marginBottom: 32 }}>
        {cfg.steps.map((s, i) => {
          const isUpload = s.action?.type === "upload";
          const isActive = !readonly;
          const hasManual = !!s.manualKey && isActive;
          return (
            <div
              key={i}
              style={{
                background: hovered === i && isActive ? C.surfaceHigh : C.surface,
                border: `1px solid ${hovered === i && isActive ? C.accent : C.border}`,
                borderRadius: 10, textAlign: "left",
                transition: "border-color 0.15s, background 0.15s",
              }}
            >
              {/* Main clickable row */}
              <button
                onClick={() => handleStep(s.action)}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
                disabled={readonly}
                style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "12px 16px", width: "100%", background: "none", border: "none",
                  cursor: isActive ? "pointer" : "default", outline: "none", borderRadius: 10,
                }}
              >
                <span style={{ fontSize: 18, flexShrink: 0 }}>{s.icon}</span>
                <span style={{ fontSize: 13, color: hovered === i && isActive ? C.text : C.textSoft, flex: 1, transition: "color 0.15s", textAlign: "left" }}>{s.text}</span>
                {isActive && (
                  <span style={{ fontSize: 11, color: hovered === i ? C.accent : C.muted, flexShrink: 0, fontWeight: 600, transition: "color 0.15s" }}>
                    {isUpload ? "Upload ↑" : "Try it →"}
                  </span>
                )}
              </button>
              {/* Extra row for manual-add tiles */}
              {hasManual && (
                <div style={{ padding: "0 16px 12px 46px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <button
                    onClick={() => { s.manualKey === "re" ? onAddRealEstate?.() : onAddCash?.(); }}
                    style={{ background: C.accent, border: "none", borderRadius: 7, padding: "5px 14px", fontSize: 12, fontWeight: 700, color: "#000", cursor: "pointer" }}>
                    + Add manually
                  </button>
                  {s.hint && <span style={{ fontSize: 11, color: C.muted, fontStyle: "italic" }}>{s.hint}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {readonly && (
        <div style={{ fontSize: 12, color: C.muted, background: C.surfaceHigh, borderRadius: 8, padding: "10px 16px" }}>
          📖 Demo mode — sign in to add your own data
        </div>
      )}
    </div>
  );
}

// ─── Costs Tab ────────────────────────────────────────────────────────────────
function Costs({ data, setData, readonly, onImport, onOpenChat, onOpenUpload }) {
  const isMobile = useIsMobile();
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [viewMonth, setViewMonth] = useState(thisMonth);
  const [viewMode, setViewMode] = useState("month"); // "month" | "average"
  const [showCostList, setShowCostList] = useState(false);
  const [showAllUpcoming, setShowAllUpcoming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", category: "Housing", amount: "", currency: "HUF", type: "recurring", frequency: "monthly", owner: "Joint", nextDue: "", notes: "" });

  const bills = data.costs;
  const billsHUF = bills.reduce((s, c) => s + toHUF(c.amount, c.currency), 0);
  const recurringBillsHUF = bills.filter(c => c.type === "recurring").reduce((s, c) => s + toHUF(c.amount, c.currency), 0);
  const onetimeBillsHUF = bills.filter(c => c.type !== "recurring").reduce((s, c) => s + toHUF(c.amount, c.currency), 0);

  // All months with transaction data
  const allMonths = [...new Set(data.transactions.map(t => t.date?.slice(0, 7)).filter(Boolean))].sort();

  // Current month expense transactions
  const monthTxns = data.transactions.filter(t => t.type === "expense" && t.date?.startsWith(viewMonth));
  const txnHUF = monthTxns.reduce((s, t) => s + toHUF(Math.abs(t.amount), t.currency), 0);

  // Average mode: avg monthly txn spend across all months with data
  const avgTxnHUF = allMonths.length > 0
    ? allMonths.map(ym => data.transactions.filter(t => t.type === "expense" && t.date?.startsWith(ym))
        .reduce((s, t) => s + toHUF(Math.abs(t.amount), t.currency), 0))
      .reduce((s, v) => s + v, 0) / allMonths.length
    : 0;

  const isAvg = viewMode === "average";
  const displayTxnHUF = isAvg ? avgTxnHUF : txnHUF;
  const totalHUF = billsHUF + displayTxnHUF;

  // Pie data — month or average
  const pieData = allCategories(data).filter(cat => cat !== "Income").map(cat => {
    const fromBills = bills.filter(c => c.category === cat).reduce((s, c) => s + toHUF(c.amount, c.currency), 0);
    const fromTxns = isAvg
      ? (allMonths.length > 0
          ? allMonths.map(ym => data.transactions.filter(t => t.type === "expense" && t.category === cat && t.date?.startsWith(ym))
              .reduce((s, t) => s + toHUF(Math.abs(t.amount), t.currency), 0))
            .reduce((s, v) => s + v, 0) / allMonths.length
          : 0)
      : monthTxns.filter(t => t.category === cat).reduce((s, t) => s + toHUF(Math.abs(t.amount), t.currency), 0);
    return { name: cat, value: Math.round(fromBills + fromTxns) };
  }).filter(d => d.value > 0);

  // Stacked bar chart: per month — % recurring vs % variable
  const stackedBarData = allMonths.map(ym => {
    const mTxnHUF = data.transactions.filter(t => t.type === "expense" && t.date?.startsWith(ym))
      .reduce((s, t) => s + toHUF(Math.abs(t.amount), t.currency), 0);
    const [y, m] = ym.split("-").map(Number);
    const rec = recurringBillsHUF;
    const vari = onetimeBillsHUF + mTxnHUF;
    const total = rec + vari;
    return {
      month: new Date(y, m - 1, 1).toLocaleString("en-GB", { month: "short", year: "2-digit" }),
      recurring: total > 0 ? Math.round((rec / total) * 100) : 0,
      variable: total > 0 ? Math.round((vari / total) * 100) : 0,
      recHUF: Math.round(rec), variHUF: Math.round(vari),
    };
  });
  // Average bar (single entry for avg mode)
  const avgBarData = (() => {
    if (allMonths.length === 0) return [];
    const rec = recurringBillsHUF;
    const variArr = allMonths.map(ym =>
      data.transactions.filter(t => t.type === "expense" && t.date?.startsWith(ym))
        .reduce((s, t) => s + toHUF(Math.abs(t.amount), t.currency), 0)
    );
    const vari = onetimeBillsHUF + variArr.reduce((a, b) => a + b, 0) / allMonths.length;
    const total = rec + vari;
    return [{ month: `Avg (${allMonths.length}mo)`, recurring: total > 0 ? Math.round((rec / total) * 100) : 0, variable: total > 0 ? Math.round((vari / total) * 100) : 0, recHUF: Math.round(rec), variHUF: Math.round(vari) }];
  })();
  const activeBarData = isAvg ? avgBarData : stackedBarData;

  // Upcoming due dates
  const allUpcoming = [...bills].filter(c => c.nextDue).sort((a, b) => a.nextDue.localeCompare(b.nextDue));
  const upcomingPreview = allUpcoming.slice(0, 3);

  function addCost() {
    if (!form.name || !form.amount) return;
    setData(d => ({ ...d, costs: [...d.costs, { ...form, id: Date.now().toString(), amount: parseFloat(form.amount) }] }));
    setAdding(false);
    setForm({ name: "", category: "Housing", amount: "", currency: "HUF", type: "recurring", frequency: "monthly", owner: "Joint", nextDue: "", notes: "" });
  }

  const isEmpty = data.costs.length === 0 && data.transactions.length === 0;
  if (isEmpty) return <GettingStarted tab="costs" readonly={readonly} onOpenChat={onOpenChat} onOpenUpload={onOpenUpload} />;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <FileUploadCard defaultType="cost_list" onFileReady={onImport} readonly={readonly} />

      {/* Month picker + view mode toggle + stats */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "auto auto 1fr 1fr 1fr", gap: 12, alignItems: "stretch" }}>
        <MonthPicker viewMonth={viewMonth} setViewMonth={setViewMonth} thisMonth={thisMonth} />
        <Card style={{ padding: "12px 14px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, minWidth: 120 }}>
          <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 1 }}>View</div>
          <div style={{ display: "flex", gap: 3, background: C.bg, borderRadius: 8, padding: 3 }}>
            <button onClick={() => setViewMode("month")} style={{ padding: "4px 10px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600, background: !isAvg ? C.accent : "transparent", color: !isAvg ? "#000" : C.muted }}>Month</button>
            <button onClick={() => setViewMode("average")} style={{ padding: "4px 10px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600, background: isAvg ? C.accent : "transparent", color: isAvg ? "#000" : C.muted }}>Avg</button>
          </div>
          {isAvg && allMonths.length > 0 && <div style={{ fontSize: 10, color: C.muted }}>{allMonths.length}mo avg</div>}
        </Card>
        <Card><Stat label={isAvg ? "Avg Monthly Total" : "Total"} value={`−${fmtHUF(totalHUF)}`} color={C.red} /></Card>
        <Card><Stat label="Bills" value={`−${fmtHUF(billsHUF)}`} color={C.blue} /></Card>
        <Card><Stat label={isAvg ? "Avg Spend" : "Transactions"} value={`−${fmtHUF(displayTxnHUF)}`} color={C.purple} /></Card>
      </div>

      {/* Pie + stacked bar side by side */}
      <div style={{ display: "grid", gridTemplateColumns: (!isMobile && stackedBarData.length > 1) ? "1fr 1fr" : "1fr", gap: 16 }}>
        {pieData.length > 0 && (
          <Card>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>Spending by Category</div>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>
              {isAvg ? `Average across ${allMonths.length} month${allMonths.length !== 1 ? "s" : ""}` : "Bills + expense transactions combined"}
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" cx="35%" cy="50%" outerRadius={80}>
                  {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={v => fmtHUF(v)} contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }} />
                <Legend layout="vertical" align="right" verticalAlign="middle" wrapperStyle={{ fontSize: 12, color: C.muted }} />
              </PieChart>
            </ResponsiveContainer>
          </Card>
        )}
        {activeBarData.length > 0 && (
          <Card>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>Cost Split</div>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>{isAvg ? "Average recurring vs variable split" : "Recurring vs variable % per month"}</div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={activeBarData} barGap={2}>
                <XAxis dataKey="month" tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `${v}%`} domain={[0, 100]} width={36} />
                <Tooltip formatter={(v, name, props) => [`${v}% · ${name === "Recurring" ? fmtHUF(props.payload.recHUF) : fmtHUF(props.payload.variHUF)}`, name]}
                  contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12, color: C.muted }} />
                <Bar dataKey="recurring" name="Recurring" stackId="a" fill={C.blue} />
                <Bar dataKey="variable" name="Variable" stackId="a" fill={C.purple} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        )}
      </div>

      {/* Upcoming due dates */}
      {upcomingPreview.length > 0 && (
        <Card style={{ padding: "14px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontWeight: 600 }}>Upcoming Due Dates</div>
            {allUpcoming.length > 3 && (
              <button onClick={() => setShowAllUpcoming(true)} style={{ background: "none", border: "none", color: C.accent, fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
                View all {allUpcoming.length} →
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            {upcomingPreview.map(c => (
              <div key={c.id} style={{ flex: 1, background: C.bg, borderRadius: 8, padding: "10px 12px", border: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>{c.name}</div>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>{c.nextDue}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.red }}>−{fmtHUF(toHUF(c.amount, c.currency))}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Cost list trigger row */}
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button onClick={() => setShowCostList(true)}
          style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 16px", color: C.textSoft, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, flex: 1, textAlign: "left" }}>
          <span>📋</span>
          <span style={{ fontWeight: 500 }}>View costs</span>
          <span style={{ fontSize: 12, color: C.muted }}>
            {bills.length} bill{bills.length !== 1 ? "s" : ""} · {monthTxns.length} transaction{monthTxns.length !== 1 ? "s" : ""} in {new Date(viewMonth + "-01").toLocaleString("en-GB", { month: "long" })}
          </span>
          <span style={{ marginLeft: "auto", color: C.accent, fontSize: 12 }}>→</span>
        </button>
        {!readonly && <Btn onClick={() => { setShowCostList(true); setAdding(true); }} style={{ flexShrink: 0 }}>+ Add bill</Btn>}
      </div>

      {/* ── Cost list modal ── */}
      {showCostList && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => { setShowCostList(false); setAdding(false); }}>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 24, width: 660, maxHeight: "82vh", overflowY: "auto" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>All Costs</div>
              <div style={{ display: "flex", gap: 8 }}>
                {!readonly && !adding && <Btn onClick={() => setAdding(true)} style={{ fontSize: 12 }}>+ Add bill</Btn>}
                <button onClick={() => { setShowCostList(false); setAdding(false); }} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 20 }}>×</button>
              </div>
            </div>

            {adding && !readonly && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 16, padding: 16, background: C.surfaceHigh, borderRadius: 10 }}>
                <Inp value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="Name" />
                <Sel value={form.category} onChange={v => setForm(f => ({ ...f, category: v }))} options={allCategories(data)} />
                <Inp value={form.amount} onChange={v => setForm(f => ({ ...f, amount: v }))} placeholder="Amount" type="number" />
                <Sel value={form.currency} onChange={v => setForm(f => ({ ...f, currency: v }))} options={["HUF","EUR","USD"]} />
                <Sel value={form.type} onChange={v => setForm(f => ({ ...f, type: v }))} options={["recurring","onetime"]} />
                <Sel value={form.frequency} onChange={v => setForm(f => ({ ...f, frequency: v }))} options={["monthly","quarterly","annual"]} />
                <Sel value={form.owner} onChange={v => setForm(f => ({ ...f, owner: v }))} options={["Joint","You","Wife"]} />
                <Inp value={form.nextDue} onChange={v => setForm(f => ({ ...f, nextDue: v }))} placeholder="Next due" type="date" />
                <div style={{ gridColumn: "span 4", display: "flex", gap: 8 }}>
                  <Btn onClick={addCost}>Save</Btn>
                  <Btn variant="ghost" onClick={() => setAdding(false)}>Cancel</Btn>
                </div>
              </div>
            )}

            {bills.length > 0 && (
              <>
                <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 1, padding: "8px 0 6px" }}>Recurring &amp; One-time Bills</div>
                {bills.map(c => (
                  <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <select value={c.category}
                        onChange={e => setData(d => ({ ...d, costs: d.costs.map(x => x.id === c.id ? { ...x, category: e.target.value } : x) }))}
                        disabled={readonly}
                        style={{ background: C.blue + "22", color: C.blue, border: "none", borderRadius: 6, padding: "2px 6px", fontSize: 11, fontWeight: 600, cursor: readonly ? "default" : "pointer", outline: "none" }}>
                        {allCategories(data).map(cat => <option key={cat} value={cat}>{cat}</option>)}
                      </select>
                      <Tag color={C.muted}>{c.type}</Tag>
                      <span style={{ fontSize: 13 }}>{c.name}</span>
                    </div>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <span style={{ color: C.red, fontWeight: 600 }}>−{fmtHUF(toHUF(c.amount, c.currency))}</span>
                      <span style={{ fontSize: 11, color: C.muted }}>{c.frequency}</span>
                      {!readonly && <Btn variant="danger" onClick={() => setData(d => ({ ...d, costs: d.costs.filter(x => x.id !== c.id) }))} style={{ padding: "4px 10px" }}>×</Btn>}
                    </div>
                  </div>
                ))}
              </>
            )}

            {monthTxns.length > 0 && (
              <>
                <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 1, padding: "14px 0 6px" }}>
                  Outflows — {new Date(viewMonth + "-01").toLocaleString("en-GB", { month: "long", year: "numeric" })}
                </div>
                {monthTxns.map(t => <EditableTxnRow key={t.id} t={t} readonly={readonly} setData={setData} data={data} />)}
              </>
            )}

            {bills.length === 0 && monthTxns.length === 0 && (
              <div style={{ color: C.muted, fontSize: 13, textAlign: "center", padding: "24px 0" }}>
                No costs yet. Import a bank statement or add a bill above.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Upcoming all modal */}
      {showAllUpcoming && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setShowAllUpcoming(false)}>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 24, width: 420, maxHeight: "70vh", overflowY: "auto" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>All Upcoming Due Dates</div>
              <button onClick={() => setShowAllUpcoming(false)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 20 }}>×</button>
            </div>
            {allUpcoming.map(c => (
              <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                <div><div style={{ fontSize: 13, fontWeight: 500 }}>{c.name}</div><div style={{ fontSize: 11, color: C.muted }}>{c.nextDue} · {c.frequency}</div></div>
                <div style={{ fontWeight: 600, color: C.red }}>−{fmtHUF(toHUF(c.amount, c.currency))}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Budget section ── */}
      <BudgetSection data={data} setData={setData} readonly={readonly} viewMonth={viewMonth} isAvg={isAvg} allMonths={allMonths} />

      {/* ── Manage Categories ── */}
      {!readonly && <ManageCategories data={data} setData={setData} />}
    </div>
  );
}

// ─── File Upload Card ─────────────────────────────────────────────────────────
const UPLOAD_GUIDES = {
  bank_statement: {
    label: "Bank Statement",
    icon: "🏦",
    color: C.blue,
    desc: "Import transactions from your bank account export.",
    formats: "CSV or Excel (.xlsx) exported from OTP, Revolut, Erste, K&H, Raiffeisen, etc.",
    columns: [
      { name: "Date", example: "2026-03-15 or 15/03/2026", required: true },
      { name: "Description / Merchant", example: "LIDL 1234 BUDAPEST, Netflix, BKK", required: true },
      { name: "Amount", example: "-8400 or 8400 (debit/credit)", required: true },
      { name: "Currency", example: "HUF, EUR, USD", required: false },
      { name: "Balance", example: "remaining balance — optional", required: false },
    ],
    tips: [
      "OTP: Export from netbank → Movements → CSV",
      "Revolut: Profile → Statements → Excel",
      "Column names don't matter — Claude reads the data, not the headers",
      "Categories are inferred from merchant names — you can correct them before importing",
    ],
  },
  investment_export: {
    label: "Investment Export",
    icon: "📈",
    color: C.green,
    desc: "Import portfolio positions from your broker.",
    formats: "CSV, Excel or PDF from Lightyear, Interactive Brokers, Erste, KBC, Erste Alapkezelő, etc.",
    columns: [
      { name: "Asset name", example: "iShares Core MSCI World ETF", required: true },
      { name: "Ticker / Symbol", example: "IWDA, AAPL, BTC", required: false },
      { name: "ISIN", example: "IE00B4L5Y983", required: false },
      { name: "Quantity", example: "50", required: true },
      { name: "Purchase price", example: "85.20", required: false },
      { name: "Current price or market value", example: "98.50 or 4925", required: true },
      { name: "Currency", example: "USD, EUR, HUF", required: false },
    ],
    tips: [
      "Lightyear: Account → Statements → CSV. Positions are rebuilt from your Buy/Sell history; dividends are kept as cash.",
      "IBKR: Reports → Statements → Activity → CSV",
      "At least 2 of: quantity, purchase price, current price/market value are required",
      "Ticker or ISIN helps identify the asset — include if available",
      "Multiple sheets are supported — Claude reads all of them",
    ],
  },
  cost_list: {
    label: "Cost / Bill List",
    icon: "🧾",
    color: C.purple,
    desc: "Import recurring bills or expenses from a spreadsheet.",
    formats: "Any CSV or Excel with a list of costs.",
    columns: [
      { name: "Name", example: "Netflix, Rent, Gym membership", required: true },
      { name: "Amount", example: "5, 180000, 12000", required: true },
      { name: "Currency", example: "EUR, HUF", required: false },
      { name: "Frequency", example: "monthly, quarterly, annual", required: false },
      { name: "Category", example: "Entertainment, Housing, Health", required: false },
    ],
    tips: [
      "Even a simple two-column list (Name, Amount) works",
      "Frequency defaults to monthly if not specified",
      "You can add notes in extra columns — Claude will include them",
    ],
  },
};

function FileUploadCard({ defaultType, onFileReady, readonly }) {
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [selectedType, setSelectedType] = useState(defaultType || null);
  const [uploadError, setUploadError] = useState(null);
  const [inputMode, setInputMode] = useState("file"); // "file" | "paste"
  const [pasteText, setPasteText] = useState("");
  const fileInputRef = useRef(null);

  async function processFile(file) {
    setUploadError(null);
    try {
      const text = await fileToText(file);
      onFileReady({ name: file.name, text }, selectedType || defaultType);
      setExpanded(false);
    } catch (err) {
      setUploadError(err.message || "Could not read file. Try saving as .csv and uploading again.");
    }
  }

  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  }

  function onPick(e) {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = "";
  }

  const guide = UPLOAD_GUIDES[selectedType || defaultType];

  if (readonly) return null;

  // Collapsed state — just a small bar
  if (!expanded) {
    return (
      <div
        onClick={() => setExpanded(true)}
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, cursor: "pointer", transition: "border-color 0.15s" }}
        onMouseEnter={e => e.currentTarget.style.borderColor = guide?.color || C.accent}
        onMouseLeave={e => e.currentTarget.style.borderColor = C.border}>
        <span style={{ fontSize: 16 }}>{guide?.icon || "📂"}</span>
        <span style={{ fontSize: 13, color: C.textSoft, fontWeight: 500 }}>
          Import {guide?.label || "file"} — click to upload
        </span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: C.muted }}>CSV, Excel or PDF</span>
        <span style={{ fontSize: 14, color: C.muted }}>›</span>
      </div>
    );
  }

  // Expanded state — full upload UI
  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      {!defaultType && (
        <div style={{ display: "flex", borderBottom: `1px solid ${C.border}` }}>
          {Object.entries(UPLOAD_GUIDES).map(([key, g]) => (
            <button key={key} onClick={() => setSelectedType(key)}
              style={{ flex: 1, padding: "10px 8px", background: selectedType === key ? C.surfaceHigh : "transparent", border: "none", borderRight: `1px solid ${C.border}`, cursor: "pointer", fontSize: 12, color: selectedType === key ? g.color : C.muted, fontWeight: selectedType === key ? 600 : 400, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
              <span style={{ fontSize: 16 }}>{g.icon}</span>
              <span>{g.label}</span>
            </button>
          ))}
        </div>
      )}
      <div style={{ padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {guide && <span style={{ fontSize: 18 }}>{guide.icon}</span>}
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{guide ? `Import ${guide.label}` : "Import File"}</div>
              {guide && <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>{guide.desc}</div>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setShowGuide(g => !g)}
              style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 7, padding: "4px 10px", color: C.muted, fontSize: 11, cursor: "pointer" }}>
              {showGuide ? "Hide guide" : "What should my file contain?"}
            </button>
            <button onClick={() => setExpanded(false)}
              style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
          </div>
        </div>

        {showGuide && guide && (
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14, marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>{guide.formats}</div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Expected columns</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {guide.columns.map(col => (
                  <div key={col.name} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: col.required ? C.text : C.muted, minWidth: 140 }}>
                      {col.name}{col.required && <span style={{ color: C.accent }}> *</span>}
                    </span>
                    <span style={{ fontSize: 11, color: C.muted, fontStyle: "italic" }}>{col.example}</span>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 10, color: C.muted, marginTop: 6 }}>* required</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Tips</div>
              {guide.tips.map((tip, i) => (
                <div key={i} style={{ fontSize: 11, color: C.muted, marginBottom: 3 }}>· {tip}</div>
              ))}
            </div>
          </div>
        )}

        {/* Input mode toggle: File | Paste */}
        <div style={{ display: "flex", background: C.bg, borderRadius: 8, padding: 3, marginBottom: 12 }}>
          {[["file","📂 Upload file"], ["paste","📋 Paste text"]].map(([mode, label]) => (
            <button key={mode} onClick={() => { setInputMode(mode); setUploadError(null); }}
              style={{ flex: 1, padding: "6px 0", borderRadius: 6, border: "none", cursor: "pointer",
                fontSize: 12, fontWeight: 600,
                background: inputMode === mode ? C.surfaceHigh : "transparent",
                color: inputMode === mode ? C.text : C.muted }}>
              {label}
            </button>
          ))}
        </div>

        {inputMode === "file" ? (
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => (guide || defaultType) && fileInputRef.current?.click()}
            style={{
              border: `2px dashed ${dragging ? (guide?.color || C.accent) : C.border}`,
              borderRadius: 10, padding: "12px 16px", textAlign: "center",
              cursor: (guide || defaultType) ? "pointer" : "default",
              background: dragging ? (guide?.color || C.accent) + "11" : "transparent",
              transition: "all 0.15s", display: "flex", alignItems: "center", justifyContent: "center", gap: 12,
            }}>
            <span style={{ fontSize: 18 }}>📂</span>
            <span style={{ fontSize: 13, color: C.muted }}>
              {dragging ? "Drop to import" : "Drag & drop or click to browse"}
            </span>
            <div style={{ display: "inline-block", background: guide?.color || C.accent, color: "#000", borderRadius: 7, padding: "5px 14px", fontSize: 12, fontWeight: 600, flexShrink: 0 }}>
              Choose file
            </div>
          </div>
        ) : (
          <div>
            <textarea
              value={pasteText}
              onChange={e => setPasteText(e.target.value)}
              placeholder={"Paste your bank statement or transaction list here.\n\nWorks with anything: copied table from your bank's website, exported text, or just a list of lines like:\n  2026-05-10  Spar supermarket  -4500\n  2026-05-11  Salary  +450000"}
              style={{
                width: "100%", minHeight: 140, background: C.bg, border: `1px solid ${C.border}`,
                borderRadius: 10, padding: 12, color: C.text, fontSize: 12, fontFamily: "'DM Mono', monospace",
                outline: "none", resize: "vertical", boxSizing: "border-box", lineHeight: 1.6, colorScheme: "dark",
              }}
            />
            <button
              onClick={() => {
                if (!pasteText.trim()) return;
                onFileReady({ name: "pasted_text.txt", text: pasteText.trim() }, selectedType || defaultType);
                setPasteText("");
                setExpanded(false);
              }}
              disabled={!pasteText.trim() || !(selectedType || defaultType)}
              style={{
                marginTop: 8, width: "100%", padding: "10px 0", borderRadius: 8, border: "none",
                background: pasteText.trim() && (selectedType || defaultType) ? (guide?.color || C.accent) : C.border,
                color: pasteText.trim() && (selectedType || defaultType) ? "#000" : C.muted,
                fontSize: 13, fontWeight: 600, cursor: pasteText.trim() && (selectedType || defaultType) ? "pointer" : "not-allowed",
              }}>
              Import from pasted text →
            </button>
            {!(selectedType || defaultType) && (
              <div style={{ fontSize: 11, color: C.orange, marginTop: 6, textAlign: "center" }}>
                Select an import type above first
              </div>
            )}
          </div>
        )}
        <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls,.pdf" onChange={onPick} style={{ display: "none" }} />

        {uploadError && (
          <div style={{ marginTop: 10, background: C.red + "18", border: `1px solid ${C.red}44`, borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "flex-start", gap: 10 }}>
            <span style={{ color: C.red, fontSize: 16, flexShrink: 0 }}>⚠</span>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.red, marginBottom: 2 }}>File could not be read</div>
              <div style={{ fontSize: 11, color: C.textSoft, lineHeight: 1.5 }}>{uploadError}</div>
              <button onClick={() => setUploadError(null)} style={{ marginTop: 6, background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 11, textDecoration: "underline", padding: 0 }}>Dismiss</button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

// ─── Cash Flow Tab ────────────────────────────────────────────────────────────
function CashFlow({ data, setData, readonly, onImport, onOpenChat, onOpenUpload }) {
  const isMobile = useIsMobile();
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [viewMonth, setViewMonth] = useState(thisMonth);
  const [form, setForm] = useState({ date: "", desc: "", amount: "", currency: "HUF", category: "Food", type: "expense", account: "OTP" });
  const [adding, setAdding] = useState(false);
  const [showAllTxns, setShowAllTxns] = useState(false);

  const allMonths = [...new Set(data.transactions.map(t => t.date?.slice(0, 7)).filter(Boolean))].sort();

  const monthlySummary = allMonths.map(ym => {
    const txns = data.transactions.filter(t => t.date?.startsWith(ym));
    const inc = txns.filter(t => t.type === "income").reduce((s, t) => s + toHUF(t.amount, t.currency), 0);
    const exp = txns.filter(t => t.type === "expense").reduce((s, t) => s + Math.abs(toHUF(t.amount, t.currency)), 0);
    const [y, m] = ym.split("-").map(Number);
    return { month: new Date(y, m - 1, 1).toLocaleString("en-GB", { month: "short", year: "2-digit" }), income: Math.round(inc), expenses: Math.round(exp) };
  });

  const monthTxns = data.transactions.filter(t => t.date?.startsWith(viewMonth));
  const income = monthTxns.filter(t => t.type === "income").reduce((s, t) => s + toHUF(t.amount, t.currency), 0);
  const expenses = monthTxns.filter(t => t.type === "expense").reduce((s, t) => s + Math.abs(toHUF(t.amount, t.currency)), 0);
  const net = income - expenses;
  const savingsRate = income > 0 ? Math.round((net / income) * 100) : null;

  // Top 10 by absolute HUF value
  const top10 = [...monthTxns]
    .sort((a, b) => toHUF(Math.abs(b.amount), b.currency) - toHUF(Math.abs(a.amount), a.currency))
    .slice(0, 10);

  const byCategory = allCategories(data).filter(c => c !== "Income").map(cat => ({
    name: cat,
    value: monthTxns.filter(t => t.category === cat && t.type === "expense").reduce((s, t) => s + Math.abs(toHUF(t.amount, t.currency)), 0)
  })).filter(d => d.value > 0);

  // Weekly cashflow buckets for selected month
  const [vy, vm] = viewMonth.split("-").map(Number);
  const daysInMonth = new Date(vy, vm, 0).getDate();
  const weekBounds = [1, 8, 15, 22, daysInMonth + 1];
  const weeklyData = weekBounds.slice(0, -1).map((wStart, w) => {
    const wEnd = Math.min(weekBounds[w + 1] - 1, daysInMonth);
    const wTxns = monthTxns.filter(t => {
      const day = parseInt(t.date?.slice(8, 10) || "0");
      return day >= wStart && day <= wEnd;
    });
    const wInc = wTxns.filter(t => t.type === "income").reduce((s, t) => s + toHUF(t.amount, t.currency), 0);
    const wExp = wTxns.filter(t => t.type === "expense").reduce((s, t) => s + Math.abs(toHUF(t.amount, t.currency)), 0);
    return { week: `W${w + 1}`, label: `${wStart}–${wEnd}`, net: Math.round(wInc - wExp), count: wTxns.length };
  }).filter(w => w.count > 0);

  // Cumulative daily net cashflow for selected month
  const cumulativeData = (() => {
    const dayTotals = {};
    monthTxns.forEach(t => {
      const day = t.date?.slice(8, 10);
      if (!day) return;
      const val = t.type === "income" ? toHUF(t.amount, t.currency) : -toHUF(Math.abs(t.amount), t.currency);
      dayTotals[day] = (dayTotals[day] || 0) + val;
    });
    let cum = 0;
    return Object.keys(dayTotals).sort().map(day => {
      cum += dayTotals[day];
      const cn = Math.round(cum);
      const label = new Date(`${viewMonth}-${day}`).toLocaleDateString("en-GB", { month: "short", day: "numeric" });
      return { day: label, cumNet: cn, cumPos: cn >= 0 ? cn : 0, cumNeg: cn < 0 ? cn : 0 };
    });
  })();

  function addTransaction() {
    if (!form.date || !form.desc || !form.amount) return;
    const amt = form.type === "expense" ? -Math.abs(parseFloat(form.amount)) : Math.abs(parseFloat(form.amount));
    setData(d => ({ ...d, transactions: [{ ...form, id: Date.now().toString(), amount: amt }, ...d.transactions] }));
    setAdding(false);
  }

  if (data.transactions.length === 0) return <GettingStarted tab="cashflow" readonly={readonly} onOpenChat={onOpenChat} onOpenUpload={onOpenUpload} />;

  const otherTxns = data.transactions.filter(t => t.category === "Other" && t.type === "expense");
  const [showOtherReview, setShowOtherReview] = useState(true);

  function reclassify(txId, newCat) {
    const tx = data.transactions.find(t => t.id === txId);
    const keyword = tx ? (tx.desc || "").toLowerCase().split(/[\s,.\-/]+/).find(w => w.length >= 4) : null;
    setData(d => ({
      ...d,
      transactions: d.transactions.map(t => t.id === txId ? { ...t, category: newCat } : t),
      merchantRules: keyword
        ? [...(d.merchantRules || []).filter(r => r.keyword !== keyword), { keyword, category: newCat }]
        : (d.merchantRules || [])
    }));
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <FileUploadCard defaultType="bank_statement" onFileReady={onImport} readonly={readonly} />

      {/* Uncategorized review banner */}
      {!readonly && showOtherReview && otherTxns.length > 0 && (
        <Card style={{ borderLeft: `3px solid ${C.orange}`, padding: "12px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div>
              <span style={{ fontWeight: 600, fontSize: 13, color: C.orange }}>⚠ {otherTxns.length} uncategorized transaction{otherTxns.length > 1 ? "s" : ""}</span>
              <span style={{ fontSize: 12, color: C.muted, marginLeft: 8 }}>— fix them here, they'll be remembered next time</span>
            </div>
            <button onClick={() => setShowOtherReview(false)} style={{ background: "none", border: "none", cursor: "pointer", color: C.muted, fontSize: 16, lineHeight: 1, padding: "0 4px" }}>×</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {otherTxns.slice(0, 15).map(t => (
              <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <span style={{ color: C.muted, flexShrink: 0, width: 72 }}>{t.date}</span>
                <span style={{ flex: 1, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.desc}>{t.desc}</span>
                <span style={{ color: C.red, flexShrink: 0, fontVariantNumeric: "tabular-nums", width: 80, textAlign: "right" }}>
                  −{t.amount?.toLocaleString()} {t.currency}
                </span>
                <select
                  value="Other"
                  onChange={e => reclassify(t.id, e.target.value)}
                  style={{ fontSize: 11, padding: "2px 4px", borderRadius: 4, border: `1px solid ${C.border}`, background: C.surface, color: C.text, cursor: "pointer", flexShrink: 0 }}
                >
                  <option value="Other" disabled>Categorize…</option>
                  {allCategories(data).filter(c => c !== "Income").map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            ))}
            {otherTxns.length > 15 && (
              <div style={{ fontSize: 11, color: C.muted, textAlign: "center", paddingTop: 4 }}>
                + {otherTxns.length - 15} more — use the transaction list below to fix the rest
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Monthly overview chart */}
      {monthlySummary.length > 1 && (
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>Monthly Overview</div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>Income vs expenses across all months</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={monthlySummary} barGap={2}>
              <XAxis dataKey="month" tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `${Math.round(v / 1000)}k`} width={40} />
              <Tooltip formatter={v => fmtHUF(v)} contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12, color: C.muted }} />
              <Bar dataKey="income" name="Income" fill={C.green} radius={[3, 3, 0, 0]} />
              <Bar dataKey="expenses" name="Expenses" fill={C.red} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Month picker + stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "auto 1fr 1fr 1fr 1fr", gap: 12, alignItems: "stretch" }}>
        <MonthPicker viewMonth={viewMonth} setViewMonth={setViewMonth} thisMonth={thisMonth} />
        <Card><Stat label="Income" value={`+${fmtHUF(income)}`} color={C.green} /></Card>
        <Card><Stat label="Expenses" value={`−${fmtHUF(expenses)}`} color={C.red} /></Card>
        <Card><Stat label="Net" value={`${net >= 0 ? "+" : "−"}${fmtHUF(Math.abs(net))}`} color={net >= 0 ? C.green : C.red} /></Card>
        <Card>
          <Stat label="Savings Rate"
            value={savingsRate !== null ? `${savingsRate}%` : "—"}
            color={savingsRate === null ? C.muted : savingsRate >= 20 ? C.green : savingsRate > 0 ? C.orange : C.red} />
          {savingsRate !== null && <div style={{ textAlign: "center", fontSize: 10, color: C.muted, marginTop: 3 }}>of income saved</div>}
        </Card>
      </div>

      {/* Expense breakdown */}
      {byCategory.length > 0 && (
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>Expense Breakdown</div>
          <ResponsiveContainer width="100%" height={Math.max(160, byCategory.length * 36)}>
            <BarChart data={byCategory} layout="vertical" margin={{ left: 0, right: 72 }}>
              <XAxis type="number" tick={false} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" tick={{ fill: C.text, fontSize: 11 }} width={96} axisLine={false} tickLine={false} interval={0} />
              <Tooltip formatter={v => fmtHUF(v)} contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, color: C.text }} cursor={{ fill: "transparent" }} />
              <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                {byCategory.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                <LabelList dataKey="value" position="right" formatter={v => v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v))} style={{ fill: C.text, fontSize: 11, fontWeight: 600 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Weekly cashflow chart */}
      {weeklyData.length > 0 && (
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>Weekly Cashflow</div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>Net (income − expenses) per week — green above zero, red below</div>
          <ResponsiveContainer width="100%" height={155}>
            <BarChart data={weeklyData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <XAxis dataKey="week" tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false}
                tickFormatter={(v, i) => `${v} (${weeklyData[i]?.label || ""})`} />
              <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false}
                tickFormatter={v => `${Math.round(v / 1000)}k`} width={44} />
              <Tooltip
                formatter={v => [fmtHUF(v), "Net"]}
                labelFormatter={(_, p) => p[0]?.payload ? `${p[0].payload.week} · days ${p[0].payload.label}` : ""}
                contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }} />
              <ReferenceLine y={0} stroke={C.border} strokeWidth={1} />
              <Bar dataKey="net" radius={[3, 3, 0, 0]}>
                {weeklyData.map((entry, i) => <Cell key={i} fill={entry.net >= 0 ? C.green : C.red} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Cumulative cashflow chart */}
      {cumulativeData.length > 1 && (
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>Cumulative Cashflow</div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>
            Running net through the month — {cumulativeData[cumulativeData.length - 1].cumNet >= 0 ? "ended positive" : "ended negative"}
          </div>
          <ResponsiveContainer width="100%" height={160}>
            <ComposedChart data={cumulativeData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="gradPos" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={C.green} stopOpacity={0.5} /><stop offset="95%" stopColor={C.green} stopOpacity={0.05} />
                </linearGradient>
                <linearGradient id="gradNeg" x1="0" y1="1" x2="0" y2="0">
                  <stop offset="5%" stopColor={C.red} stopOpacity={0.5} /><stop offset="95%" stopColor={C.red} stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <XAxis dataKey="day" tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `${Math.round(v / 1000)}k`} width={40} />
              <Tooltip formatter={(v, name) => name === "Net" ? [fmtHUF(v), "Cumulative net"] : null}
                contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }} />
              <ReferenceLine y={0} stroke={C.border} strokeWidth={1} strokeDasharray="4 4" />
              <Area type="monotone" dataKey="cumPos" stroke="none" fill="url(#gradPos)" dot={false} legendType="none" />
              <Area type="monotone" dataKey="cumNeg" stroke="none" fill="url(#gradNeg)" dot={false} legendType="none" />
              <Line type="monotone" dataKey="cumNet" name="Net" stroke="#ffffff" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Top 10 transactions by absolute value */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <div style={{ fontWeight: 600 }}>Top Transactions</div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
              {monthTxns.length > 0 ? `Top 10 by value · ${monthTxns.length} total · click category to recategorize` : "No transactions this month"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {monthTxns.length > 10 && (
              <button onClick={() => setShowAllTxns(true)}
                style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 7, padding: "5px 12px", color: C.muted, fontSize: 12, cursor: "pointer" }}>
                View all {monthTxns.length} →
              </button>
            )}
            {!readonly && <Btn onClick={() => setAdding(!adding)}>{adding ? "Cancel" : "+ Add manually"}</Btn>}
          </div>
        </div>
        {adding && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 16, padding: 16, background: C.surfaceHigh, borderRadius: 10 }}>
            <Inp value={form.date} onChange={v => setForm(f => ({ ...f, date: v }))} placeholder="Date" type="date" />
            <Inp value={form.desc} onChange={v => setForm(f => ({ ...f, desc: v }))} placeholder="Description" />
            <Inp value={form.amount} onChange={v => setForm(f => ({ ...f, amount: v }))} placeholder="Amount" type="number" />
            <Sel value={form.currency} onChange={v => setForm(f => ({ ...f, currency: v }))} options={["HUF", "EUR", "USD"]} />
            <Sel value={form.category} onChange={v => setForm(f => ({ ...f, category: v }))} options={allCategories(data)} />
            <Sel value={form.type} onChange={v => setForm(f => ({ ...f, type: v }))} options={["expense", "income"]} />
            <Inp value={form.account} onChange={v => setForm(f => ({ ...f, account: v }))} placeholder="Account" />
            <Btn onClick={addTransaction} style={{ gridColumn: "span 4" }}>Save</Btn>
          </div>
        )}
        {monthTxns.length === 0 && !adding && (
          <div style={{ color: C.muted, fontSize: 13, textAlign: "center", padding: "24px 0" }}>
            No transactions for this month.<br />
            <span style={{ fontSize: 12 }}>Upload a bank statement or add manually.</span>
          </div>
        )}
        {top10.map(t => <EditableTxnRow key={t.id} t={t} readonly={readonly} setData={setData} data={data} />)}
      </Card>

      {/* All transactions modal */}
      {showAllTxns && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setShowAllTxns(false)}>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 24, width: 720, maxHeight: "82vh", overflowY: "auto" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>
                All Transactions — {new Date(viewMonth + "-01").toLocaleString("en-GB", { month: "long", year: "numeric" })}
                <span style={{ fontSize: 12, color: C.muted, fontWeight: 400, marginLeft: 8 }}>{monthTxns.length} entries</span>
              </div>
              <button onClick={() => setShowAllTxns(false)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 20 }}>×</button>
            </div>
            {[...monthTxns].sort((a, b) => b.date.localeCompare(a.date)).map(t => <EditableTxnRow key={t.id} t={t} readonly={readonly} setData={setData} data={data} />)}
          </div>
        </div>
      )}

      {/* ── Savings Goals ── */}
      <SavingsGoals data={data} setData={setData} readonly={readonly} />
    </div>
  );
}

// ─── Savings Goals ────────────────────────────────────────────────────────────
function SavingsGoals({ data, setData, readonly }) {
  const goals = data.savingsGoals || [];
  const EMPTY_FORM = { name: "", targetAmount: "", currentAmount: "", monthlyContribution: "", currency: "HUF", targetDate: "", notes: "" };
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [calcGoalId, setCalcGoalId] = useState(null);

  const today = new Date(); today.setHours(0, 0, 0, 0);

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const t = new Date(dateStr); t.setHours(0, 0, 0, 0);
    return Math.ceil((t - today) / 86400000);
  }

  function estimateMonths(remaining, contribution) {
    if (!contribution || contribution <= 0 || remaining <= 0) return null;
    return Math.ceil(remaining / contribution);
  }

  function estimatedDate(months) {
    if (months === null) return null;
    const d = new Date(today.getFullYear(), today.getMonth() + months, 1);
    return d.toLocaleString("en-GB", { month: "short", year: "numeric" });
  }

  function saveGoal() {
    const g = {
      ...form,
      targetAmount: parseFloat(form.targetAmount) || 0,
      currentAmount: parseFloat(form.currentAmount) || 0,
      monthlyContribution: parseFloat(form.monthlyContribution) || 0,
    };
    if (!g.name || !g.targetAmount) return;
    if (editingId) {
      setData(d => ({ ...d, savingsGoals: d.savingsGoals.map(x => x.id === editingId ? { ...x, ...g } : x) }));
      setEditingId(null);
    } else {
      setData(d => ({ ...d, savingsGoals: [...(d.savingsGoals || []), { ...g, id: `sg_${Date.now()}` }] }));
    }
    setAdding(false);
    setForm(EMPTY_FORM);
  }

  function startEdit(g) {
    setForm({ name: g.name, targetAmount: String(g.targetAmount), currentAmount: String(g.currentAmount), monthlyContribution: String(g.monthlyContribution || ""), currency: g.currency || "HUF", targetDate: g.targetDate || "", notes: g.notes || "" });
    setEditingId(g.id);
    setAdding(true);
  }

  function updateCurrent(id, val) {
    setData(d => ({ ...d, savingsGoals: d.savingsGoals.map(g => g.id === id ? { ...g, currentAmount: parseFloat(val) || 0 } : g) }));
  }

  return (
    <Card style={{ marginTop: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>Savings Goals</div>
        {!readonly && (
          <Btn variant="ghost" onClick={() => { setAdding(!adding); setEditingId(null); setForm(EMPTY_FORM); }} style={{ fontSize: 12 }}>
            {adding ? "Cancel" : "+ Add goal"}
          </Btn>
        )}
      </div>
      {goals.some(g => !g.monthlyContribution || toHUF(g.monthlyContribution, g.currency || "HUF") === 0) && (
        <div style={{ fontSize: 12, color: C.accent, fontWeight: 500, marginBottom: 14, background: C.accent + "15", border: `1px solid ${C.accent}33`, borderRadius: 7, padding: "7px 12px" }}>
          💡 Some goals are missing a monthly contribution. Use the calculator on each goal to set one and see your estimated completion date.
        </div>
      )}
      {!goals.some(g => !g.monthlyContribution || toHUF(g.monthlyContribution, g.currency || "HUF") === 0) && goals.length > 0 && (
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>Track progress toward your financial targets — use the calculator to adjust monthly contributions.</div>
      )}

      {/* Add / edit form */}
      {adding && !readonly && (
        <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginBottom: 16, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <div style={{ gridColumn: "span 3" }}>
            <div style={{ fontSize: 10, color: C.muted, marginBottom: 3, textTransform: "uppercase" }}>Goal name</div>
            <Inp value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder='e.g. "Emergency Fund"' />
          </div>
          <div>
            <div style={{ fontSize: 10, color: C.muted, marginBottom: 3, textTransform: "uppercase" }}>Target amount</div>
            <Inp value={form.targetAmount} onChange={v => setForm(f => ({ ...f, targetAmount: v }))} placeholder="0" type="number" />
          </div>
          <div>
            <div style={{ fontSize: 10, color: C.muted, marginBottom: 3, textTransform: "uppercase" }}>Saved so far</div>
            <Inp value={form.currentAmount} onChange={v => setForm(f => ({ ...f, currentAmount: v }))} placeholder="0" type="number" />
          </div>
          <div>
            <div style={{ fontSize: 10, color: C.muted, marginBottom: 3, textTransform: "uppercase" }}>Currency</div>
            <Sel value={form.currency} onChange={v => setForm(f => ({ ...f, currency: v }))} options={["HUF", "EUR", "USD"]} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: C.muted, marginBottom: 3, textTransform: "uppercase" }}>Monthly contribution</div>
            <Inp value={form.monthlyContribution} onChange={v => setForm(f => ({ ...f, monthlyContribution: v }))} placeholder="How much/month?" type="number" />
          </div>
          <div>
            <div style={{ fontSize: 10, color: C.muted, marginBottom: 3, textTransform: "uppercase" }}>Target date (optional)</div>
            <Inp value={form.targetDate} onChange={v => setForm(f => ({ ...f, targetDate: v }))} placeholder="Target date" type="date" />
          </div>
          <div>
            <div style={{ fontSize: 10, color: C.muted, marginBottom: 3, textTransform: "uppercase" }}>Notes</div>
            <Inp value={form.notes} onChange={v => setForm(f => ({ ...f, notes: v }))} placeholder="Optional" />
          </div>
          <div style={{ gridColumn: "span 3" }}>
            <Btn onClick={saveGoal}>{editingId ? "Save changes" : "Add goal"}</Btn>
          </div>
        </div>
      )}

      {goals.length === 0 && !adding && (
        <div style={{ color: C.muted, fontSize: 13, textAlign: "center", padding: "24px 0" }}>
          No savings goals yet.<br />
          <span style={{ fontSize: 12 }}>Add one above, or tell the AI: "I want to save for Greece holiday, 500k HUF by August"</span>
        </div>
      )}

      <div style={{ display: "grid", gap: 14 }}>
        {goals.map(g => {
          const target = toHUF(g.targetAmount, g.currency || "HUF");
          const current = toHUF(g.currentAmount, g.currency || "HUF");
          const contribution = toHUF(g.monthlyContribution || 0, g.currency || "HUF");
          const remaining = Math.max(0, target - current);
          const pct = target > 0 ? Math.min((current / target) * 100, 100) : 0;
          const done = pct >= 100;
          const days = daysUntil(g.targetDate);
          const estMonths = estimateMonths(remaining, contribution);
          const estDate = estimatedDate(estMonths);
          const deadlineMissed = days !== null && days < 0;
          const onTrack = estMonths !== null && days !== null && estMonths * 30 <= days;

          return (
            <div key={g.id} style={{ background: C.bg, border: `1px solid ${done ? C.green + "55" : C.border}`, borderRadius: 10, padding: 14 }}>
              {/* Header row */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                <div>
                  <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{g.name}</span>
                    {done && <Tag color={C.green}>✓ Complete</Tag>}
                    {!done && deadlineMissed && <Tag color={C.red}>Overdue</Tag>}
                    {!done && !deadlineMissed && onTrack && <Tag color={C.green}>On track</Tag>}
                    {!done && !deadlineMissed && estMonths !== null && !onTrack && <Tag color={C.orange}>Behind</Tag>}
                  </div>
                  {g.notes && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{g.notes}</div>}
                </div>
                {!readonly && (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => startEdit(g)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 13 }}>✎</button>
                    <button onClick={() => setData(d => ({ ...d, savingsGoals: d.savingsGoals.filter(x => x.id !== g.id) }))}
                      style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 15 }}>×</button>
                  </div>
                )}
              </div>

              {/* Progress bar */}
              <div style={{ height: 10, background: C.surfaceHigh, borderRadius: 5, overflow: "hidden", marginBottom: 8 }}>
                <div style={{
                  height: "100%", borderRadius: 5, width: `${pct}%`,
                  background: done ? C.green : deadlineMissed ? C.red : C.accent,
                  transition: "width 0.5s ease",
                  boxShadow: done ? `0 0 10px ${C.green}55` : undefined,
                }} />
              </div>

              {/* Stats grid */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase" }}>Saved</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.accent }}>{fmtHUF(current)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase" }}>Target</div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{fmtHUF(target)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase" }}>Remaining</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: done ? C.green : C.textSoft }}>{done ? "—" : fmtHUF(remaining)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase" }}>{Math.round(pct)}% done</div>
                  {days !== null && !done && (
                    <div style={{ fontSize: 12, color: deadlineMissed ? C.red : C.muted }}>
                      {deadlineMissed ? `${Math.abs(days)}d overdue` : `${days}d left`}
                    </div>
                  )}
                </div>
              </div>

              {/* Estimate row + quick-update */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <div style={{ fontSize: 12, color: done ? C.green : C.muted }}>
                  {done ? "🎉 Goal reached!" :
                    estDate ? `✦ At ${fmtHUF(contribution)}/month → ~${estDate} (${estMonths} month${estMonths !== 1 ? "s" : ""})` :
                    "Already reached"
                  }
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  {!readonly && !done && (
                    <button onClick={() => setCalcGoalId(calcGoalId === g.id ? null : g.id)}
                      style={{ background: calcGoalId === g.id ? C.accent + "22" : C.surfaceHigh, border: `1px solid ${calcGoalId === g.id ? C.accent : C.border}`, borderRadius: 7, padding: "4px 10px", color: calcGoalId === g.id ? C.accent : C.muted, fontSize: 11, cursor: "pointer", fontWeight: 600 }}>
                      🧮 Calculator
                    </button>
                  )}
                  {!readonly && !done && (
                    <QuickUpdateAmount goalId={g.id} currentAmount={g.currentAmount} currency={g.currency || "HUF"} onUpdate={updateCurrent} />
                  )}
                </div>
              </div>

              {/* Goal contribution calculator */}
              {calcGoalId === g.id && !done && (
                <GoalContributionCalc
                  goal={g}
                  onSet={contrib => {
                    setData(d => ({ ...d, savingsGoals: d.savingsGoals.map(x => x.id === g.id ? { ...x, monthlyContribution: contrib } : x) }));
                    setCalcGoalId(null);
                  }}
                  onClose={() => setCalcGoalId(null)}
                />
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// Inline amount updater — pencil icon → input → save, without opening the full form
function QuickUpdateAmount({ goalId, currentAmount, currency, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(currentAmount));
  if (!editing) return (
    <button onClick={() => { setVal(String(currentAmount)); setEditing(true); }}
      style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 7, padding: "4px 10px", color: C.muted, fontSize: 11, cursor: "pointer" }}>
      ✎ Update amount
    </button>
  );
  return (
    <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
      <input value={val} onChange={e => setVal(e.target.value)} type="number" autoFocus
        onKeyDown={e => { if (e.key === "Enter") { onUpdate(goalId, val); setEditing(false); } if (e.key === "Escape") setEditing(false); }}
        style={{ width: 110, background: C.surfaceHigh, border: `1px solid ${C.accent}`, borderRadius: 7, padding: "4px 8px", color: C.text, fontSize: 12, outline: "none" }} />
      <span style={{ fontSize: 11, color: C.muted }}>{currency}</span>
      <button onClick={() => { onUpdate(goalId, val); setEditing(false); }}
        style={{ background: C.green, border: "none", borderRadius: 6, padding: "4px 9px", color: "#000", fontSize: 11, cursor: "pointer", fontWeight: 700 }}>✓</button>
      <button onClick={() => setEditing(false)}
        style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 14 }}>×</button>
    </div>
  );
}

// ─── Goal Contribution Calculator ────────────────────────────────────────────
function GoalContributionCalc({ goal, onSet, onClose }) {
  const target = toHUF(goal.targetAmount, goal.currency || "HUF");
  const current = toHUF(goal.currentAmount, goal.currency || "HUF");
  const remaining = Math.max(0, target - current);

  const today = new Date(); today.setHours(0, 0, 0, 0);

  // Two modes: by contribution amount (slider) OR by target date
  const [mode, setMode] = useState("contribution"); // "contribution" | "date"

  // Mode 1: slider for monthly contribution → show estimated date
  const minC = Math.max(1000, Math.round(remaining / 120)); // min: 1k or enough for 10y
  const maxC = Math.round(remaining); // max: one-shot
  const [sliderVal, setSliderVal] = useState(() => {
    if (goal.monthlyContribution) return toHUF(goal.monthlyContribution, goal.currency || "HUF");
    return Math.round(remaining / 12); // default: 1 year
  });

  // Mode 2: target date → show required monthly contribution
  const defaultTarget = new Date(today.getFullYear(), today.getMonth() + 12, 1).toISOString().slice(0, 7);
  const [targetMonth, setTargetMonth] = useState(goal.targetDate ? goal.targetDate.slice(0, 7) : defaultTarget);

  const estMonths = sliderVal > 0 ? Math.ceil(remaining / sliderVal) : null;
  const estDate = estMonths !== null ? new Date(today.getFullYear(), today.getMonth() + estMonths, 1).toLocaleString("en-GB", { month: "long", year: "numeric" }) : null;

  const targetDateObj = new Date(targetMonth + "-01"); targetDateObj.setHours(0, 0, 0, 0);
  const monthsToTarget = Math.max(1, Math.round((targetDateObj - today) / (30.44 * 86400000)));
  const requiredContrib = remaining > 0 ? Math.ceil(remaining / monthsToTarget) : 0;

  const displayContrib = mode === "contribution" ? sliderVal : requiredContrib;

  return (
    <div style={{ background: C.surfaceHigh, border: `1px solid ${C.accent}44`, borderRadius: 10, padding: 16, marginTop: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: C.text }}>Contribution Calculator</div>
        <button onClick={onClose} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 16 }}>×</button>
      </div>

      {/* Mode toggle */}
      <div style={{ display: "flex", background: C.bg, borderRadius: 8, padding: 3, gap: 2, marginBottom: 14, width: "fit-content" }}>
        {[["contribution","Set contribution"],["date","Set target date"]].map(([v, lbl]) => (
          <button key={v} onClick={() => setMode(v)}
            style={{ padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600,
              background: mode === v ? C.accent : "transparent", color: mode === v ? "#000" : C.muted }}>
            {lbl}
          </button>
        ))}
      </div>

      {mode === "contribution" ? (
        <div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>
            Monthly contribution — drag to explore scenarios
          </div>
          <input type="range" min={minC} max={maxC} step={Math.max(1000, Math.round((maxC - minC) / 100))}
            value={sliderVal} onChange={e => setSliderVal(Number(e.target.value))}
            style={{ width: "100%", accentColor: C.accent, marginBottom: 10 }} />
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: C.muted }}>{fmtHUF(minC)}/mo</span>
            <span style={{ fontWeight: 700, fontSize: 14, color: C.accent }}>{fmtHUF(sliderVal)}/month</span>
            <span style={{ fontSize: 12, color: C.muted }}>{fmtHUF(maxC)}/mo</span>
          </div>
          <div style={{ background: C.bg, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: C.text }}>
            {estMonths !== null ? (
              <>✦ You'd reach your goal in <strong style={{ color: C.green }}>{estMonths} month{estMonths !== 1 ? "s" : ""}</strong> — by <strong style={{ color: C.accent }}>{estDate}</strong></>
            ) : "Set a contribution above"}
          </div>
        </div>
      ) : (
        <div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Pick your target month</div>
          <input type="month" value={targetMonth} min={new Date(today.getFullYear(), today.getMonth() + 1, 1).toISOString().slice(0, 7)}
            onChange={e => setTargetMonth(e.target.value)}
            style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "7px 10px", color: C.text, fontSize: 13, outline: "none", marginBottom: 10, width: "100%" }} />
          <div style={{ background: C.bg, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: C.text }}>
            {requiredContrib > 0 ? (
              <>✦ To reach your goal by <strong style={{ color: C.accent }}>{new Date(targetMonth + "-01").toLocaleString("en-GB", { month: "long", year: "numeric" })}</strong> you need <strong style={{ color: C.green }}>{fmtHUF(requiredContrib)}/month</strong> ({monthsToTarget} months)</>
            ) : "Goal already reached!"}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <Btn onClick={() => onSet(Math.round(displayContrib / (goal.currency === "EUR" ? RATES.EUR : goal.currency === "USD" ? RATES.USD : 1)))} style={{ flex: 1 }}>
          Set {fmtHUF(displayContrib)}/month
        </Btn>
        <button onClick={onClose} style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${C.border}`, background: "none", color: C.muted, cursor: "pointer", fontSize: 13 }}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Portfolio Card with manual entry ────────────────────────────────────────
const EMPTY_POSITION = {
  name: "", ticker: "", isin: "",
  assetClass: "ETF", region: "Global", currency: "USD",
  qty: "", costBasis: "", currentPrice: "", marketValue: "",
  purchaseDate: "", notes: ""
};

// Given qty/costBasis/currentPrice/marketValue, derive the missing one
function derivePosition(pos) {
  const qty = parseFloat(pos.qty) || 0;
  const cb = parseFloat(pos.costBasis) || 0;
  const cp = parseFloat(pos.currentPrice) || 0;
  const mv = parseFloat(pos.marketValue) || 0;

  // Derive currentPrice from marketValue + qty
  if (qty && mv && !cp) return { ...pos, currentPrice: String(mv / qty) };
  // Derive marketValue from qty + currentPrice
  if (qty && cp && !mv) return { ...pos, marketValue: String(qty * cp) };
  // Derive qty from marketValue + currentPrice
  if (mv && cp && !qty) return { ...pos, qty: String(mv / cp) };
  return pos;
}

function PortfolioCard({ portfolio, data, setData, readonly }) {
  const [addingPos, setAddingPos] = useState(false);
  const [form, setForm] = useState(EMPTY_POSITION);
  const [editingPosId, setEditingPosId] = useState(null);
  const [inlineEdit, setInlineEdit] = useState(false); // true = inline edit, false = add at bottom
  const [editingPortfolio, setEditingPortfolio] = useState(false);
  const [portfolioForm, setPortfolioForm] = useState({ name: portfolio.name, broker: portfolio.broker || "" });
  const [closingPosId, setClosingPosId] = useState(null);
  const [closeForm, setCloseForm] = useState({ exitDate: "", exitPrice: "", qtyToClose: "" });
  const [closedNote, setClosedNote] = useState(null); // { realized, label }
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [detailed, setDetailed] = useState(false); // false = simple (name, value, P&L); true = full breakdown

  // Grid layout differs between the simple and detailed views.
  const gridCols = detailed ? "2.5fr 1fr 1fr 1fr 1fr 96px" : "2.5fr 1fr 1fr 96px";
  const headerCells = detailed ? ["Position", "Qty × Price", "Market Value", "Cost Basis", "P&L", ""] : ["Position", "Market Value", "P&L", ""];

  function openClose(pos) {
    setClosingPosId(pos.id);
    setCloseForm({ exitDate: todayStr(), exitPrice: String(pos.currentPrice), qtyToClose: String(pos.qty) });
  }

  function confirmClose() {
    const pos = portfolio.positions.find(p => p.id === closingPosId);
    if (!pos) return;
    const exitPrice = parseFloat(closeForm.exitPrice);
    const qtyClose = Math.min(parseFloat(closeForm.qtyToClose) || pos.qty, pos.qty);
    if (!exitPrice || qtyClose <= 0) return;
    const exitHUF = toHUF(qtyClose * exitPrice, pos.currency);
    const costHUF = toHUF(qtyClose * pos.costBasis, pos.currency);
    const realizedPnL = exitHUF - costHUF;
    const isFullClose = qtyClose >= pos.qty - 0.0001;
    setData(d => ({
      ...d,
      portfolios: d.portfolios.map(p => p.id === portfolio.id ? {
        ...p,
        positions: isFullClose
          ? p.positions.filter(x => x.id !== pos.id)
          : p.positions.map(x => x.id === pos.id ? { ...x, qty: parseFloat((x.qty - qtyClose).toFixed(6)) } : x)
      } : p)
    }));
    setClosedNote({ realized: realizedPnL, label: `${qtyClose} × ${pos.ticker || pos.name}` });
    setClosingPosId(null);
  }

  function savePortfolioMeta() {
    setData(d => ({ ...d, portfolios: d.portfolios.map(p => p.id === portfolio.id ? { ...p, ...portfolioForm } : p) }));
    setEditingPortfolio(false);
  }

  function savePosition() {
    const derived = derivePosition(form);
    const qty = parseFloat(derived.qty) || 0;
    const costBasis = parseFloat(derived.costBasis) || 0;
    const currentPrice = parseFloat(derived.currentPrice) || 0;
    // Validate: need at least name + 2 of (qty, costBasis, currentPrice/marketValue)
    if (!derived.name) return;
    const filledCount = [qty, costBasis, currentPrice].filter(v => v > 0).length;
    if (filledCount < 2) { alert("Please fill at least 2 of: Quantity, Purchase Price, Current Price / Market Value"); return; }

    const position = {
      id: editingPosId || `pos_${Date.now()}`,
      name: derived.name,
      ticker: derived.ticker || "",
      isin: derived.isin || "",
      assetClass: derived.assetClass,
      region: derived.region,
      currency: derived.currency,
      qty,
      costBasis,
      currentPrice: currentPrice || (qty ? parseFloat(derived.marketValue) / qty : 0),
      purchaseDate: derived.purchaseDate || "",
      notes: derived.notes || "",
    };

    setData(d => ({
      ...d,
      portfolios: d.portfolios.map(p => p.id === portfolio.id ? {
        ...p,
        positions: editingPosId
          ? p.positions.map(x => x.id === editingPosId ? position : x)
          : [...p.positions, position]
      } : p)
    }));
    setAddingPos(false);
    setEditingPosId(null);
    setInlineEdit(false);
    setForm(EMPTY_POSITION);
  }

  function startEditPos(pos) {
    setForm({ ...EMPTY_POSITION, ...pos, qty: String(pos.qty), costBasis: String(pos.costBasis), currentPrice: String(pos.currentPrice), marketValue: String(pos.qty * pos.currentPrice) });
    setEditingPosId(pos.id);
    setInlineEdit(true);
    setAddingPos(false);
  }

  function deletePos(posId) {
    setData(d => ({ ...d, portfolios: d.portfolios.map(p => p.id === portfolio.id ? { ...p, positions: p.positions.filter(x => x.id !== posId) } : p) }));
    setConfirmDeleteId(null);
  }

  function deletePortfolio() {
    if (!confirm(`Delete portfolio "${portfolio.name}"?`)) return;
    setData(d => ({ ...d, portfolios: d.portfolios.filter(p => p.id !== portfolio.id) }));
  }

  const F = (label, key, opts = {}) => (
    <div>
      <div style={{ fontSize: 10, color: C.muted, marginBottom: 3, textTransform: "uppercase" }}>{label}{opts.required && <span style={{ color: C.accent }}> *</span>}</div>
      {opts.options
        ? <Sel value={form[key]} onChange={v => setForm(f => ({ ...f, [key]: v }))} options={opts.options} />
        : <Inp value={form[key]} onChange={v => setForm(f => ({ ...f, [key]: v }))} placeholder={opts.placeholder || ""} type={opts.type || "text"} />
      }
    </div>
  );

  const totalMV = portfolio.positions.reduce((s, pos) => s + toHUF(pos.qty * pos.currentPrice, pos.currency), 0);
  const totalCost = portfolio.positions.reduce((s, pos) => s + toHUF(pos.qty * pos.costBasis, pos.currency), 0);
  const totalPnl = totalMV - totalCost;
  const totalPnlPct = totalCost > 0 ? ((totalPnl / totalCost) * 100).toFixed(1) : "—";

  return (
    <>
    <Card>
      {/* Portfolio header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        {editingPortfolio ? (
          <div style={{ display: "flex", gap: 8, flex: 1, marginRight: 8 }}>
            <Inp value={portfolioForm.name} onChange={v => setPortfolioForm(f => ({ ...f, name: v }))} placeholder="Portfolio name" style={{ flex: 1 }} />
            <Inp value={portfolioForm.broker} onChange={v => setPortfolioForm(f => ({ ...f, broker: v }))} placeholder="Provider (IBKR, Erste…)" style={{ flex: 1 }} />
            <Btn onClick={savePortfolioMeta} style={{ fontSize: 12 }}>Save</Btn>
            <button onClick={() => setEditingPortfolio(false)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 16 }}>×</button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontWeight: 600 }}>{portfolio.name}</span>
            {portfolio.broker && <Tag color={C.muted}>{portfolio.broker}</Tag>}
            <span style={{ fontSize: 12, color: C.muted }}>{portfolio.positions.length} position{portfolio.positions.length !== 1 ? "s" : ""}</span>
          </div>
        )}
        {!editingPortfolio && (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button onClick={() => setDetailed(v => !v)} title={detailed ? "Show summary view" : "Show full details"}
              style={{ background: detailed ? C.accent + "22" : C.surfaceHigh, border: `1px solid ${detailed ? C.accent : C.border}`, borderRadius: 7, padding: "3px 10px", color: detailed ? C.accent : C.muted, fontSize: 11, cursor: "pointer", fontWeight: 600 }}>
              {detailed ? "Hide details" : "Details"}
            </button>
            {!readonly && <button onClick={() => setEditingPortfolio(true)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 13 }}>✎</button>}
            {!readonly && <button onClick={deletePortfolio} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 15 }}>×</button>}
          </div>
        )}
      </div>

      {/* Column headers — adapt to simple vs detailed view */}
      <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 8, padding: "4px 0 8px", borderBottom: `1px solid ${C.border}` }}>
        {headerCells.map((h, i) => (
          <span key={i} style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>{h}</span>
        ))}
      </div>

      {/* Position rows */}
      {portfolio.positions.map(pos => {
        const marketVal = toHUF(pos.qty * pos.currentPrice, pos.currency);
        const costVal = toHUF(pos.qty * pos.costBasis, pos.currency);
        const pnl = marketVal - costVal;
        const pnlPct = costVal > 0 ? ((pnl / costVal) * 100).toFixed(1) : "—";
        const pnlColor = pnl >= 0 ? C.green : C.red;

        // Inline edit form replaces this row when editing
        if (inlineEdit && editingPosId === pos.id && !readonly) {
          return (
            <div key={pos.id} style={{ background: C.bg, border: `1px solid ${C.accent}55`, borderRadius: 10, padding: 16, margin: "6px 0" }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12, color: C.accent }}>
                Edit position
                <span style={{ fontSize: 11, color: C.muted, fontWeight: 400, marginLeft: 8 }}>Fill at least 2 of: Qty, Purchase Price, Current Price</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
                {F("Asset Name *", "name", { required: true, placeholder: "e.g. iShares MSCI World" })}
                {F("Ticker", "ticker", { placeholder: "e.g. IWDA" })}
                {F("ISIN", "isin", { placeholder: "e.g. IE00B4L5Y983" })}
                {F("Asset Class", "assetClass", { options: ["ETF", "Stock", "Bond", "Crypto", "Fund", "Other"] })}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 3fr", gap: 8, marginBottom: 8 }}>
                {F("Region", "region", { options: ["Global", "EU", "US", "EM", "Asia", "Other"] })}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
                {F("Quantity", "qty", { type: "number", placeholder: "# shares / units" })}
                {F("Purchase Price", "costBasis", { type: "number", placeholder: "price paid per unit" })}
                {F("Current Price", "currentPrice", { type: "number", placeholder: "price today per unit" })}
                {F("Market Value", "marketValue", { type: "number", placeholder: "or total value today" })}
                {F("Currency", "currency", { options: ["USD", "EUR", "HUF", "GBP", "CHF", "Other"] })}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8, marginBottom: 12 }}>
                {F("Purchase Date", "purchaseDate", { type: "date" })}
                {F("Notes", "notes", { placeholder: "optional free text" })}
              </div>
              {(() => {
                const d = derivePosition(form);
                const qty = parseFloat(d.qty) || 0;
                const cp = parseFloat(d.currentPrice) || 0;
                const cb = parseFloat(d.costBasis) || 0;
                const mv = qty * cp;
                const cost = qty * cb;
                if (qty && cp) return (
                  <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, padding: "6px 10px", background: C.surfaceHigh, borderRadius: 6 }}>
                    Preview: {qty} units × {cp} {form.currency} = <strong style={{ color: C.text }}>{fmtHUF(toHUF(mv, form.currency))}</strong>
                    {cb > 0 && <> · P&L: <strong style={{ color: mv > cost ? C.green : C.red }}>{mv > cost ? "+" : ""}{fmtHUF(toHUF(mv - cost, form.currency))}</strong></>}
                  </div>
                );
                return null;
              })()}
              <div style={{ display: "flex", gap: 8 }}>
                <Btn onClick={savePosition}>Save changes</Btn>
                <Btn variant="ghost" onClick={() => { setInlineEdit(false); setEditingPosId(null); setForm(EMPTY_POSITION); }}>Cancel</Btn>
              </div>
            </div>
          );
        }

        return (
          <div key={pos.id} style={{ display: "grid", gridTemplateColumns: gridCols, gap: 8, alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
            <div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 2 }}>
                {pos.ticker && <Tag color={pos.assetClass === "Cash" ? C.green : C.blue}>{pos.ticker}</Tag>}
                <span style={{ fontSize: 12, fontWeight: 500 }}>{pos.name}</span>
              </div>
              {detailed && <div style={{ fontSize: 10, color: C.muted }}>{pos.assetClass} · {pos.region} · {pos.currency}{pos.purchaseDate ? ` · bought ${pos.purchaseDate}` : ""}</div>}
              {detailed && pos.notes && <div style={{ fontSize: 10, color: C.muted, fontStyle: "italic" }}>{pos.notes}</div>}
            </div>
            {detailed && <span style={{ fontSize: 12, color: C.muted }}>{pos.qty} × {pos.currentPrice}</span>}
            <span style={{ fontSize: 13, fontWeight: 600 }}>{fmtHUF(marketVal)}</span>
            {detailed && <span style={{ fontSize: 12, color: C.muted }}>{costVal > 0 ? fmtHUF(costVal) : "—"}</span>}
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: pnlColor }}>{pnl >= 0 ? "+" : ""}{fmtHUF(pnl)}</div>
              <div style={{ fontSize: 10, color: pnlColor }}>{pnl >= 0 ? "+" : ""}{pnlPct}%</div>
            </div>
            {!readonly && (
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <button onClick={() => startEditPos(pos)} title="Edit position" style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 12, padding: "3px 5px" }}>✎</button>
                <button onClick={() => openClose(pos)}
                  style={{ background: "none", border: `1px solid ${C.orange}55`, borderRadius: 5, padding: "2px 7px", color: C.orange, cursor: "pointer", fontSize: 10, fontWeight: 600 }}>
                  Close
                </button>
                <button onClick={() => setConfirmDeleteId(pos.id)} title="Delete position" style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 14, padding: "3px 5px" }}>×</button>
              </div>
            )}
          </div>
        );
      })}

      {/* Totals row */}
      {portfolio.positions.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 8, padding: "10px 0 4px" }}>
          <span style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>Total</span>
          {detailed && <span />}
          <span style={{ fontSize: 13, fontWeight: 700, color: C.blue }}>{fmtHUF(totalMV)}</span>
          {detailed && <span style={{ fontSize: 12, color: C.muted }}>{fmtHUF(totalCost)}</span>}
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: totalPnl >= 0 ? C.green : C.red }}>{totalPnl >= 0 ? "+" : ""}{fmtHUF(totalPnl)}</div>
            <div style={{ fontSize: 10, color: totalPnl >= 0 ? C.green : C.red }}>{totalPnl >= 0 ? "+" : ""}{totalPnlPct}%</div>
          </div>
          <span />
        </div>
      )}

      {/* Add position form (new positions only — edits are inline above) */}
      {addingPos && !inlineEdit && !readonly && (
        <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginTop: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12, color: C.accent }}>
            Add position
            <span style={{ fontSize: 11, color: C.muted, fontWeight: 400, marginLeft: 8 }}>Fill at least 2 of: Qty, Purchase Price, Current Price</span>
          </div>

          {/* Row 1: Identifiers */}
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
            {F("Asset Name *", "name", { required: true, placeholder: "e.g. iShares MSCI World" })}
            {F("Ticker", "ticker", { placeholder: "e.g. IWDA" })}
            {F("ISIN", "isin", { placeholder: "e.g. IE00B4L5Y983" })}
            {F("Asset Class", "assetClass", { options: ["ETF", "Stock", "Bond", "Crypto", "Fund", "Other"] })}
          </div>

          {/* Row 2: Region */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 3fr", gap: 8, marginBottom: 8 }}>
            {F("Region", "region", { options: ["Global", "EU", "US", "EM", "Asia", "Other"] })}
            <div style={{ display: "flex", alignItems: "flex-end", paddingBottom: 1 }}>
              <span style={{ fontSize: 11, color: C.muted }}>Ticker and ISIN are optional but recommended — they help identify the asset unambiguously.</span>
            </div>
          </div>

          {/* Row 3: Quantities & prices */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
            {F("Quantity", "qty", { type: "number", placeholder: "# shares / units" })}
            {F("Purchase Price", "costBasis", { type: "number", placeholder: "price paid per unit" })}
            {F("Current Price", "currentPrice", { type: "number", placeholder: "price today per unit" })}
            {F("Market Value", "marketValue", { type: "number", placeholder: "or total value today" })}
            {F("Currency", "currency", { options: ["USD", "EUR", "HUF", "GBP", "CHF", "Other"] })}
          </div>

          {/* Row 4: Date + notes */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8, marginBottom: 12 }}>
            {F("Purchase Date", "purchaseDate", { type: "date" })}
            {F("Notes", "notes", { placeholder: "optional free text" })}
          </div>

          {/* Derived preview */}
          {(() => {
            const d = derivePosition(form);
            const qty = parseFloat(d.qty) || 0;
            const cp = parseFloat(d.currentPrice) || 0;
            const cb = parseFloat(d.costBasis) || 0;
            const mv = qty * cp;
            const cost = qty * cb;
            if (qty && cp) return (
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, padding: "6px 10px", background: C.surfaceHigh, borderRadius: 6 }}>
                Preview: {qty} units × {cp} {form.currency} = <strong style={{ color: C.text }}>{fmtHUF(toHUF(mv, form.currency))}</strong>
                {cb > 0 && <> · P&L: <strong style={{ color: mv > cost ? C.green : C.red }}>{mv > cost ? "+" : ""}{fmtHUF(toHUF(mv - cost, form.currency))}</strong></>}
              </div>
            );
            return null;
          })()}

          <div style={{ display: "flex", gap: 8 }}>
            <Btn onClick={savePosition}>Add position</Btn>
            <Btn variant="ghost" onClick={() => { setAddingPos(false); setInlineEdit(false); setEditingPosId(null); setForm(EMPTY_POSITION); }}>Cancel</Btn>
          </div>
        </div>
      )}

      {/* Add position button */}
      {!readonly && !addingPos && !inlineEdit && (
        <button onClick={() => { setAddingPos(true); setInlineEdit(false); setEditingPosId(null); setForm(EMPTY_POSITION); }}
          style={{ marginTop: 12, background: "none", border: `1px dashed ${C.border}`, borderRadius: 8, padding: "8px 16px", color: C.muted, cursor: "pointer", fontSize: 12, width: "100%" }}>
          + Add position
        </button>
      )}

      {/* Closed P&L notification */}
      {closedNote && (
        <div style={{ marginTop: 10, background: closedNote.realized >= 0 ? C.green + "18" : C.red + "18", border: `1px solid ${closedNote.realized >= 0 ? C.green : C.red}55`, borderRadius: 8, padding: "10px 14px", fontSize: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>✓ Closed {closedNote.label} · Realized P&amp;L: <strong style={{ color: closedNote.realized >= 0 ? C.green : C.red }}>{closedNote.realized >= 0 ? "+" : ""}{fmtHUF(closedNote.realized)}</strong></span>
          <button onClick={() => setClosedNote(null)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 14 }}>×</button>
        </div>
      )}
    </Card>

    {/* ── Close position modal ── */}
    {closingPosId && (() => {
      const pos = portfolio.positions.find(p => p.id === closingPosId);
      if (!pos) return null;
      const ep = parseFloat(closeForm.exitPrice) || 0;
      const qc = parseFloat(closeForm.qtyToClose) || 0;
      const previewPnL = (ep > 0 && qc > 0) ? toHUF(qc * ep, pos.currency) - toHUF(qc * pos.costBasis, pos.currency) : null;
      const isPartial = qc > 0 && qc < pos.qty - 0.0001;
      return (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setClosingPosId(null)}>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 24, width: 420 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>Close Position</div>
              <button onClick={() => setClosingPosId(null)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 20 }}>×</button>
            </div>
            <div style={{ marginBottom: 16, padding: "10px 12px", background: C.surfaceHigh, borderRadius: 8 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                {pos.ticker && <Tag color={C.blue}>{pos.ticker}</Tag>}
                <span style={{ fontSize: 13, fontWeight: 500 }}>{pos.name}</span>
              </div>
              <div style={{ fontSize: 11, color: C.muted }}>
                Open: {pos.qty} units · Cost basis: {pos.costBasis} {pos.currency} · Current: {pos.currentPrice} {pos.currency}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 10, color: C.muted, marginBottom: 4, textTransform: "uppercase" }}>Exit Date</div>
                <Inp value={closeForm.exitDate} onChange={v => setCloseForm(f => ({ ...f, exitDate: v }))} type="date" />
              </div>
              <div>
                <div style={{ fontSize: 10, color: C.muted, marginBottom: 4, textTransform: "uppercase" }}>Exit Price ({pos.currency})</div>
                <Inp value={closeForm.exitPrice} onChange={v => setCloseForm(f => ({ ...f, exitPrice: v }))} placeholder={String(pos.currentPrice)} type="number" />
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <div style={{ fontSize: 10, color: C.muted, marginBottom: 4, textTransform: "uppercase" }}>Qty to close (max {pos.qty})</div>
                <Inp value={closeForm.qtyToClose} onChange={v => setCloseForm(f => ({ ...f, qtyToClose: v }))} placeholder={String(pos.qty)} type="number" />
              </div>
            </div>
            {previewPnL !== null && (
              <div style={{ background: previewPnL >= 0 ? C.green + "18" : C.red + "18", border: `1px solid ${previewPnL >= 0 ? C.green : C.red}44`, borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 12 }}>
                <div>Realized P&amp;L: <strong style={{ color: previewPnL >= 0 ? C.green : C.red }}>{previewPnL >= 0 ? "+" : ""}{fmtHUF(previewPnL)}</strong></div>
                {isPartial && <div style={{ color: C.muted, marginTop: 3, fontSize: 11 }}>Partial close — {(pos.qty - qc).toFixed(4)} units remain</div>}
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={confirmClose} style={{ flex: 1 }} disabled={!closeForm.exitPrice || !closeForm.qtyToClose}>
                Confirm Close
              </Btn>
              <Btn variant="ghost" onClick={() => setClosingPosId(null)}>Cancel</Btn>
            </div>
          </div>
        </div>
      );
    })()}

    {/* Delete confirmation modal */}
    {confirmDeleteId && (() => {
      const pos = portfolio.positions.find(p => p.id === confirmDeleteId);
      if (!pos) return null;
      return (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setConfirmDeleteId(null)}>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 28, width: 360, boxShadow: "0 8px 40px rgba(0,0,0,0.5)" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Delete position?</div>
            <div style={{ fontSize: 13, color: C.textSoft, marginBottom: 20 }}>
              This will permanently remove <strong>{pos.ticker || pos.name}</strong> ({pos.qty} units) from your portfolio. This cannot be undone.
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <Btn variant="danger" onClick={() => deletePos(confirmDeleteId)} style={{ flex: 1 }}>Yes, delete</Btn>
              <Btn variant="ghost" onClick={() => setConfirmDeleteId(null)} style={{ flex: 1 }}>Cancel</Btn>
            </div>
          </div>
        </div>
      );
    })()}
  </>
  );
}


// ─── Data normalizer — ensures all expected arrays exist after Supabase load ───
function normalizeData(raw) {
  if (!raw || typeof raw !== "object") return EMPTY_DATA;
  return {
    ...EMPTY_DATA,
    ...raw,
    costs: raw.costs || [],
    transactions: raw.transactions || [],
    portfolios: (raw.portfolios || []).map(p => ({ ...p, positions: p.positions || [] })),
    realEstate: raw.realEstate || [],
    cashAccounts: raw.cashAccounts || [],
    budgetTargets: raw.budgetTargets || [],
    savingsGoals: raw.savingsGoals || [],
    netWorthHistory: raw.netWorthHistory || [],
    merchantRules: raw.merchantRules || [],
    customCategories: raw.customCategories || [],
    plannedExpenses: raw.plannedExpenses || [],
    displayCurrency: raw.displayCurrency || "HUF",
  };
}

// ─── Wealth Tab ───────────────────────────────────────────────────────────────
// NW snapshot: call once on app load if current month not yet recorded
function maybeSnapshotNW(data, setData) {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const history = data.netWorthHistory || [];
  if (history.some(h => h.date === ym)) return; // already have this month
  const investments = (data.portfolios || []).flatMap(p => p.positions || [])
    .reduce((s, pos) => s + toHUF((pos.qty || 0) * (pos.currentPrice || 0), pos.currency), 0);
  const realEstate = (data.realEstate || [])
    .reduce((s, r) => s + toHUF((r.currentValue || 0) - (r.mortgage || 0), r.currency), 0);
  const cash = (data.cashAccounts || [])
    .reduce((s, a) => s + toHUF(a.balance, a.currency), 0);
  const totalNW = investments + realEstate + cash;
  setData(d => ({
    ...d,
    netWorthHistory: [...(d.netWorthHistory || []),
      { date: ym, totalNW: Math.round(totalNW), investments: Math.round(investments), realEstate: Math.round(realEstate), cash: Math.round(cash) }
    ].sort((a, b) => a.date.localeCompare(b.date))
  }));
}

function Wealth({ data, setData, readonly, onImport, onOpenChat, onOpenUpload }) {
  const isMobile = useIsMobile();
  const [portfolioView, setPortfolioView] = useState("total"); // "total" | "single"
  const [selectedPortfolioId, setSelectedPortfolioId] = useState(() => data.portfolios[0]?.id || null);
  const [showREForm, setShowREForm] = useState(false);
  const [showCashForm, setShowCashForm] = useState(false);
  const [reForm, setREForm] = useState({ name: "", address: "", currentValue: "", mortgage: "", currency: "HUF", purchaseYear: new Date().getFullYear() });
  const [cashForm, setCashForm] = useState({ name: "", balance: "", currency: "HUF", type: "Savings" });
  const [editingREId, setEditingREId] = useState(null);
  const [editingCashId, setEditingCashId] = useState(null);
  const [confirmDeleteREId, setConfirmDeleteREId] = useState(null);
  const [confirmDeleteCashId, setConfirmDeleteCashId] = useState(null);
  const [priceStatus, setPriceStatus] = useState(null); // { loading, msg, error }

  // Apply live prices to every position with a ticker (skips Cash lines).
  async function refreshPrices(force = false) {
    const items = data.portfolios.flatMap(p => p.positions)
      .filter(pos => pos.assetClass !== "Cash" && pos.ticker)
      .map(pos => ({ ticker: pos.ticker, isin: pos.isin || "", currency: pos.currency || "" }));
    if (!items.length) { setPriceStatus({ error: true, msg: "No tickers to price — add tickers to your positions first." }); return; }
    setPriceStatus({ loading: true, msg: "Fetching latest prices…" });
    const r = await fetchLivePrices(items, { force });
    if (!r || !r.fetched.length) { setPriceStatus({ error: true, msg: "Couldn't fetch prices — the price service may be unavailable or over its daily quota." }); return; }
    setData(d => ({
      ...d,
      portfolios: d.portfolios.map(p => ({
        ...p,
        positions: p.positions.map(pos => (r.prices[pos.ticker] != null ? { ...pos, currentPrice: r.prices[pos.ticker] } : pos)),
      })),
    }));
    const miss = r.missing.length ? ` · ${r.missing.length} not found (${r.missing.slice(0, 4).join(", ")}${r.missing.length > 4 ? "…" : ""})` : "";
    setPriceStatus({ msg: `Updated ${r.fetched.length} price${r.fetched.length === 1 ? "" : "s"} · ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}${miss}` });
  }

  // Auto-refresh once per day if the cache is stale (server holds the key).
  useEffect(() => {
    if (readonly) return;
    let stale = true;
    try { const c = JSON.parse(localStorage.getItem("pfa_prices_v1") || "null"); stale = !c || c.date !== todayStr(); } catch {}
    if (stale) refreshPrices(false);
  }, []);

  const allPositions = data.portfolios.flatMap(p =>
    p.positions.map(pos => ({ ...pos, portfolioName: p.name }))
  );
  const investmentsHUF = allPositions.reduce((s, pos) => s + toHUF(pos.qty * pos.currentPrice, pos.currency), 0);
  const realEstateHUF = data.realEstate.reduce((s, r) => s + toHUF(r.currentValue - r.mortgage, r.currency), 0);
  const cashHUF = data.cashAccounts.reduce((s, a) => s + toHUF(a.balance, a.currency), 0);
  const totalNW = investmentsHUF + realEstateHUF + cashHUF;

  // Selected portfolio for single view
  const selectedPortfolio = data.portfolios.find(p => p.id === selectedPortfolioId) || data.portfolios[0] || null;
  const selPositions = selectedPortfolio?.positions || [];
  const selMV = selPositions.reduce((s, pos) => s + toHUF(pos.qty * pos.currentPrice, pos.currency), 0);
  const selCost = selPositions.reduce((s, pos) => s + toHUF(pos.qty * pos.costBasis, pos.currency), 0);
  const selPnL = selMV - selCost;
  const selPnLPct = selCost > 0 ? ((selPnL / selCost) * 100).toFixed(1) : "—";

  const buildPieData = (positions) => {
    const acMap = {}, rgMap = {};
    positions.forEach(pos => {
      const val = toHUF(pos.qty * pos.currentPrice, pos.currency);
      acMap[pos.assetClass || "Other"] = (acMap[pos.assetClass || "Other"] || 0) + val;
      rgMap[pos.region || "Other"] = (rgMap[pos.region || "Other"] || 0) + val;
    });
    return {
      assetClass: Object.entries(acMap).map(([name, value]) => ({ name, value: Math.round(value) })),
      region: Object.entries(rgMap).map(([name, value]) => ({ name, value: Math.round(value) })),
    };
  };

  const totalPies = buildPieData(allPositions);
  const selPies = buildPieData(selPositions);

  const PIE_COLORS_EXT = [C.blue, C.green, C.accent, C.purple, C.orange, C.red, C.muted];

  function takeSnapshot() {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    setData(d => ({
      ...d,
      netWorthHistory: [
        ...(d.netWorthHistory || []).filter(h => h.date !== ym),
        { date: ym, totalNW: Math.round(totalNW), investments: Math.round(investmentsHUF), realEstate: Math.round(realEstateHUF), cash: Math.round(cashHUF) }
      ].sort((a, b) => a.date.localeCompare(b.date))
    }));
  }

  const history = (data.netWorthHistory || []).map(h => {
    const [y, m] = h.date.split("-").map(Number);
    return { ...h, label: new Date(y, m - 1, 1).toLocaleString("en-GB", { month: "short", year: "2-digit" }) };
  });
  const nwChange = history.length >= 2
    ? history[history.length - 1].totalNW - history[history.length - 2].totalNW
    : null;

  function BreakdownPies({ pies }) {
    if (!pies.assetClass.length && !pies.region.length) return null;
    return (
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 16 }}>
        {pies.assetClass.length > 0 && (
          <Card>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>Asset class breakdown</div>
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie data={pies.assetClass} dataKey="value" nameKey="name" cx="40%" cy="50%" outerRadius={70} innerRadius={36}>
                  {pies.assetClass.map((_, i) => <Cell key={i} fill={PIE_COLORS_EXT[i % PIE_COLORS_EXT.length]} />)}
                </Pie>
                <Tooltip formatter={v => fmtHUF(v)} contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }} />
                <Legend layout="vertical" align="right" verticalAlign="middle" wrapperStyle={{ fontSize: 12, color: C.muted }} />
              </PieChart>
            </ResponsiveContainer>
          </Card>
        )}
        {pies.region.length > 0 && (
          <Card>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>Geographic exposure</div>
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie data={pies.region} dataKey="value" nameKey="name" cx="40%" cy="50%" outerRadius={70} innerRadius={36}>
                  {pies.region.map((_, i) => <Cell key={i} fill={PIE_COLORS_EXT[(i + 2) % PIE_COLORS_EXT.length]} />)}
                </Pie>
                <Tooltip formatter={v => fmtHUF(v)} contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }} />
                <Legend layout="vertical" align="right" verticalAlign="middle" wrapperStyle={{ fontSize: 12, color: C.muted }} />
              </PieChart>
            </ResponsiveContainer>
          </Card>
        )}
      </div>
    );
  }

  const wealthIsEmpty = allPositions.length === 0 && data.realEstate.length === 0 && data.cashAccounts.length === 0;

  const EMPTY_RE_FORM = { name: "", address: "", currentValue: "", mortgage: "", currency: "HUF", purchaseYear: new Date().getFullYear() };
  const EMPTY_CASH_FORM = { name: "", balance: "", currency: "HUF", type: "Savings" };

  function startEditRE(r) {
    setREForm({ name: r.name, address: r.address || "", currentValue: String(r.currentValue), mortgage: String(r.mortgage || 0), currency: r.currency || "HUF", purchaseYear: r.purchaseYear || new Date().getFullYear() });
    setEditingREId(r.id);
    setShowREForm(false);
  }

  function saveRE() {
    if (!reForm.name || !reForm.currentValue) return;
    const entry = { name: reForm.name, address: reForm.address, currentValue: Number(reForm.currentValue), mortgage: Number(reForm.mortgage) || 0, currency: reForm.currency, purchaseYear: Number(reForm.purchaseYear) };
    if (editingREId) {
      setData(d => ({ ...d, realEstate: d.realEstate.map(r => r.id === editingREId ? { ...r, ...entry } : r) }));
      setEditingREId(null);
    } else {
      setData(d => ({ ...d, realEstate: [...d.realEstate, { id: `re_${Date.now()}`, ...entry }] }));
      setShowREForm(false);
    }
    setREForm(EMPTY_RE_FORM);
  }

  function deleteRE(id) {
    setData(d => ({ ...d, realEstate: d.realEstate.filter(r => r.id !== id) }));
    setConfirmDeleteREId(null);
    if (editingREId === id) { setEditingREId(null); setREForm(EMPTY_RE_FORM); }
  }

  function startEditCash(a) {
    setCashForm({ name: a.name, balance: String(a.balance), currency: a.currency || "HUF", type: a.type || "Savings" });
    setEditingCashId(a.id);
    setShowCashForm(false);
  }

  function saveCash() {
    if (!cashForm.name || !cashForm.balance) return;
    const entry = { name: cashForm.name, balance: Number(cashForm.balance), currency: cashForm.currency, type: cashForm.type };
    if (editingCashId) {
      setData(d => ({ ...d, cashAccounts: d.cashAccounts.map(a => a.id === editingCashId ? { ...a, ...entry } : a) }));
      setEditingCashId(null);
    } else {
      setData(d => ({ ...d, cashAccounts: [...d.cashAccounts, { id: `ca_${Date.now()}`, ...entry }] }));
      setShowCashForm(false);
    }
    setCashForm(EMPTY_CASH_FORM);
  }

  function deleteCash(id) {
    setData(d => ({ ...d, cashAccounts: d.cashAccounts.filter(a => a.id !== id) }));
    setConfirmDeleteCashId(null);
    if (editingCashId === id) { setEditingCashId(null); setCashForm(EMPTY_CASH_FORM); }
  }

  if (wealthIsEmpty && !showREForm && !showCashForm) return (
    <GettingStarted tab="wealth" readonly={readonly} onOpenChat={onOpenChat} onOpenUpload={onOpenUpload}
      onAddRealEstate={() => setShowREForm(true)} onAddCash={() => setShowCashForm(true)} />
  );

  // Quick-add modals shown before any wealth data exists
  if (wealthIsEmpty) return (
    <div style={{ display: "grid", gap: 16, maxWidth: 560, margin: "0 auto", padding: "32px 16px" }}>
      <button onClick={() => { setShowREForm(false); setShowCashForm(false); }} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 13, textAlign: "left", padding: 0, marginBottom: 4 }}>← Back</button>
      {showREForm && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 24 }}>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>🏠 Add Real Estate</div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 20 }}>You can also ask the AI: "I own a flat worth 45M HUF with 18M mortgage"</div>
          {[
            ["Property name *", "name", "text", "e.g. Family home, Rental flat"],
            ["Address", "address", "text", "e.g. Budapest XI."],
            ["Current value *", "currentValue", "number", "e.g. 45000000"],
            ["Outstanding mortgage", "mortgage", "number", "0 if none"],
            ["Purchase year", "purchaseYear", "number", "e.g. 2018"],
          ].map(([label, key, type, placeholder]) => (
            <div key={key} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
              <input type={type} value={reForm[key]} onChange={e => setREForm(f => ({ ...f, [key]: e.target.value }))} placeholder={placeholder}
                style={{ width: "100%", background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.text, fontSize: 13, outline: "none", boxSizing: "border-box" }} />
            </div>
          ))}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Currency</div>
            <select value={reForm.currency} onChange={e => setREForm(f => ({ ...f, currency: e.target.value }))}
              style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.text, fontSize: 13, outline: "none" }}>
              {["HUF","EUR","USD"].map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn onClick={saveRE} disabled={!reForm.name || !reForm.currentValue}>Save property</Btn>
            <Btn variant="ghost" onClick={() => { setShowREForm(false); setREForm(EMPTY_RE_FORM); }}>Cancel</Btn>
          </div>
        </div>
      )}
      {showCashForm && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 24 }}>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>💰 Add Cash Account</div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 20 }}>You can also ask the AI: "I have 2M HUF in OTP and €5,000 in Revolut"</div>
          {[
            ["Account name *", "name", "text", "e.g. OTP Bank, Revolut"],
            ["Balance *", "balance", "number", "Current balance"],
          ].map(([label, key, type, placeholder]) => (
            <div key={key} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
              <input type={type} value={cashForm[key]} onChange={e => setCashForm(f => ({ ...f, [key]: e.target.value }))} placeholder={placeholder}
                style={{ width: "100%", background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.text, fontSize: 13, outline: "none", boxSizing: "border-box" }} />
            </div>
          ))}
          <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Currency</div>
              <select value={cashForm.currency} onChange={e => setCashForm(f => ({ ...f, currency: e.target.value }))}
                style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.text, fontSize: 13, outline: "none", width: "100%" }}>
                {["HUF","EUR","USD"].map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Type</div>
              <select value={cashForm.type} onChange={e => setCashForm(f => ({ ...f, type: e.target.value }))}
                style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.text, fontSize: 13, outline: "none", width: "100%" }}>
                {["Checking","Savings","Emergency fund","Brokerage cash","Other"].map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn onClick={saveCash} disabled={!cashForm.name || !cashForm.balance}>Save account</Btn>
            <Btn variant="ghost" onClick={() => setShowCashForm(false)}>Cancel</Btn>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div style={{ display: "grid", gap: 16 }}>

      <FileUploadCard defaultType="investment_export" onFileReady={onImport} readonly={readonly} />

      {/* ── Portfolio view toggle — pill tabs ── */}
      <Card style={{ padding: "10px 16px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {/* "Total Portfolio" pill */}
          <button
            onClick={() => setPortfolioView("total")}
            style={{ padding: "5px 16px", borderRadius: 20, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, background: portfolioView === "total" ? C.accent : C.surfaceHigh, color: portfolioView === "total" ? "#000" : C.muted, transition: "background 0.15s, color 0.15s" }}>
            Total Portfolio
          </button>
          {/* One pill per portfolio */}
          {data.portfolios.map(p => {
            const isActive = portfolioView === "single" && selectedPortfolioId === p.id;
            return (
              <button key={p.id}
                onClick={() => { setPortfolioView("single"); setSelectedPortfolioId(p.id); }}
                style={{ padding: "5px 16px", borderRadius: 20, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, background: isActive ? C.accent : C.surfaceHigh, color: isActive ? "#000" : C.muted, transition: "background 0.15s, color 0.15s" }}>
                {p.name}{p.broker ? <span style={{ fontSize: 10, opacity: 0.7, marginLeft: 4 }}>({p.broker})</span> : null}
              </button>
            );
          })}
          {data.portfolios.length === 0 && (
            <span style={{ fontSize: 12, color: C.muted, marginLeft: 4 }}>No portfolios yet — add one below</span>
          )}
        </div>
      </Card>

      {/* ══════ LIVE PRICES CONTROL ══════ */}
      {allPositions.length > 0 && (
        <Card style={{ padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 12, color: priceStatus?.error ? C.orange : C.muted }}>
            {priceStatus?.loading ? "⟳ " : "📈 "}
            {priceStatus?.msg || "Track live market prices. Holdings are auto-resolved by ISIN/ticker, converted to each holding's currency, and cached daily."}
          </div>
          {!readonly && (
            <button onClick={() => refreshPrices(true)} disabled={priceStatus?.loading}
              style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 8, padding: "5px 14px", color: C.text, fontSize: 12, fontWeight: 600, cursor: priceStatus?.loading ? "default" : "pointer", flexShrink: 0 }}>
              {priceStatus?.loading ? "Refreshing…" : "↻ Refresh prices"}
            </button>
          )}
        </Card>
      )}

      {/* ══════ TOTAL VIEW ══════ */}
      {portfolioView === "total" && (<>
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr 1fr", gap: 16 }}>
          <Card>
            <Stat label="Net Worth" value={fmtHUF(totalNW)} color={C.accent} />
            {nwChange !== null && (
              <div style={{ textAlign: "center", fontSize: 11, marginTop: 4, color: nwChange >= 0 ? C.green : C.red }}>
                {nwChange >= 0 ? "▲" : "▼"} {fmtHUF(Math.abs(nwChange))} vs last month
              </div>
            )}
          </Card>
          <Card><Stat label="Investments" value={fmtHUF(investmentsHUF)} color={C.blue} /></Card>
          <Card><Stat label="Real Estate Equity" value={fmtHUF(realEstateHUF)} color={C.purple} /></Card>
          <Card><Stat label="Cash" value={fmtHUF(cashHUF)} color={C.green} /></Card>
        </div>

        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div>
              <div style={{ fontWeight: 600 }}>Net Worth Timeline</div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                {history.length} snapshot{history.length !== 1 ? "s" : ""} · auto-saved monthly
              </div>
            </div>
            {!readonly && <Btn variant="ghost" onClick={takeSnapshot} style={{ fontSize: 12 }}>↺ Update snapshot</Btn>}
          </div>
          {history.length < 2 ? (
            <div style={{ color: C.muted, fontSize: 13, textAlign: "center", padding: "32px 0" }}>
              Net worth history builds automatically each month.<br />
              <span style={{ fontSize: 12 }}>Come back next month to see your first trend line.</span>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={history} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="gradCash" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={C.green} stopOpacity={0.5} /><stop offset="95%" stopColor={C.green} stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="gradRE" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={C.purple} stopOpacity={0.5} /><stop offset="95%" stopColor={C.purple} stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="gradInv" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={C.blue} stopOpacity={0.6} /><stop offset="95%" stopColor={C.blue} stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="label" tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `${Math.round(v / 1000000)}M`} width={36} />
                <Tooltip formatter={(v, name) => [fmtHUF(v), name]} contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }} labelStyle={{ color: C.text }} />
                <Legend wrapperStyle={{ fontSize: 12, color: C.muted, paddingTop: 8 }} />
                <Area type="monotone" dataKey="cash" name="Cash" stackId="1" stroke={C.green} fill="url(#gradCash)" strokeWidth={1.5} />
                <Area type="monotone" dataKey="realEstate" name="Real Estate" stackId="1" stroke={C.purple} fill="url(#gradRE)" strokeWidth={1.5} />
                <Area type="monotone" dataKey="investments" name="Investments" stackId="1" stroke={C.blue} fill="url(#gradInv)" strokeWidth={1.5} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Card>

        {allPositions.length > 0 && <BreakdownPies pies={totalPies} />}

        {data.portfolios.map(portfolio => (
          <PortfolioCard key={portfolio.id} portfolio={portfolio} data={data} setData={setData} readonly={readonly} />
        ))}

        {!readonly && (
          <button onClick={() => {
            const name = prompt("Sub-portfolio name (e.g. IBKR, Erste, KBC):");
            if (!name) return;
            const broker = prompt("Provider / broker name:");
            setData(d => ({ ...d, portfolios: [...d.portfolios, { id: `p_${Date.now()}`, name, broker: broker || "", currency: "USD", description: "", positions: [] }] }));
          }} style={{ background: "none", border: `2px dashed ${C.border}`, borderRadius: 12, padding: 16, color: C.muted, cursor: "pointer", fontSize: 13, width: "100%", textAlign: "center" }}>
            + Add portfolio (IBKR, Revolut, Erste…)
          </button>
        )}

        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 16 }}>

          {/* ── Real Estate card ── */}
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ fontWeight: 600 }}>Real Estate</div>
              {!readonly && <span style={{ fontSize: 11, color: C.muted, fontStyle: "italic" }}>✦ Add via chat</span>}
            </div>

            {data.realEstate.map(r => {
              if (editingREId === r.id) return (
                <div key={r.id} style={{ background: C.bg, border: `1px solid ${C.accent}55`, borderRadius: 10, padding: 14, margin: "6px 0" }}>
                  <div style={{ fontWeight: 600, fontSize: 12, color: C.accent, marginBottom: 10 }}>Edit property</div>
                  {[["Name *","name","text","e.g. Family home"],["Address","address","text","e.g. Budapest XI."],["Current value *","currentValue","number",""],["Outstanding mortgage","mortgage","number","0 if none"],["Purchase year","purchaseYear","number",""]].map(([label,key,type,ph]) => (
                    <div key={key} style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 10, color: C.muted, marginBottom: 3, textTransform: "uppercase" }}>{label}</div>
                      <input type={type} value={reForm[key]} onChange={e => setREForm(f => ({ ...f, [key]: e.target.value }))} placeholder={ph}
                        style={{ width: "100%", background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 7, padding: "7px 10px", color: C.text, fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                    </div>
                  ))}
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 10, color: C.muted, marginBottom: 3, textTransform: "uppercase" }}>Currency</div>
                    <select value={reForm.currency} onChange={e => setREForm(f => ({ ...f, currency: e.target.value }))}
                      style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 7, padding: "7px 10px", color: C.text, fontSize: 13, outline: "none" }}>
                      {["HUF","EUR","USD"].map(c => <option key={c}>{c}</option>)}
                    </select>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Btn onClick={saveRE} disabled={!reForm.name || !reForm.currentValue}>Save changes</Btn>
                    <Btn variant="ghost" onClick={() => { setEditingREId(null); setREForm(EMPTY_RE_FORM); }}>Cancel</Btn>
                  </div>
                </div>
              );
              return (
                <div key={r.id} style={{ padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 2 }}>
                    <div style={{ fontWeight: 500 }}>{r.name}</div>
                    {!readonly && (
                      <div style={{ display: "flex", gap: 4 }}>
                        <button onClick={() => startEditRE(r)} title="Edit" style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 12, padding: "2px 4px" }}>✎</button>
                        <button onClick={() => setConfirmDeleteREId(r.id)} title="Delete" style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 14, padding: "2px 4px" }}>×</button>
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>{r.address}{r.address && r.purchaseYear ? " · " : ""}{r.purchaseYear}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                    <div><div style={{ fontSize: 10, color: C.muted }}>VALUE</div><div style={{ fontSize: 13, fontWeight: 600 }}>{fmtHUF(toHUF(r.currentValue, r.currency || "HUF"))}</div></div>
                    <div><div style={{ fontSize: 10, color: C.muted }}>MORTGAGE</div><div style={{ fontSize: 13, fontWeight: 600, color: C.red }}>{fmtHUF(toHUF(r.mortgage || 0, r.currency || "HUF"))}</div></div>
                    <div><div style={{ fontSize: 10, color: C.muted }}>EQUITY</div><div style={{ fontSize: 13, fontWeight: 600, color: C.green }}>{fmtHUF(toHUF((r.currentValue || 0) - (r.mortgage || 0), r.currency || "HUF"))}</div></div>
                  </div>
                </div>
              );
            })}

            {/* Add form */}
            {showREForm && !readonly && (
              <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, marginTop: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 12, color: C.accent, marginBottom: 10 }}>Add property</div>
                {[["Name *","name","text","e.g. Family home"],["Address","address","text","e.g. Budapest XI."],["Current value *","currentValue","number",""],["Outstanding mortgage","mortgage","number","0 if none"],["Purchase year","purchaseYear","number",""]].map(([label,key,type,ph]) => (
                  <div key={key} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 10, color: C.muted, marginBottom: 3, textTransform: "uppercase" }}>{label}</div>
                    <input type={type} value={reForm[key]} onChange={e => setREForm(f => ({ ...f, [key]: e.target.value }))} placeholder={ph}
                      style={{ width: "100%", background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 7, padding: "7px 10px", color: C.text, fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                  </div>
                ))}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 10, color: C.muted, marginBottom: 3, textTransform: "uppercase" }}>Currency</div>
                  <select value={reForm.currency} onChange={e => setREForm(f => ({ ...f, currency: e.target.value }))}
                    style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 7, padding: "7px 10px", color: C.text, fontSize: 13, outline: "none" }}>
                    {["HUF","EUR","USD"].map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Btn onClick={saveRE} disabled={!reForm.name || !reForm.currentValue}>Add property</Btn>
                  <Btn variant="ghost" onClick={() => { setShowREForm(false); setREForm(EMPTY_RE_FORM); }}>Cancel</Btn>
                </div>
              </div>
            )}

            {!readonly && !showREForm && !editingREId && (
              <button onClick={() => { setShowREForm(true); setREForm(EMPTY_RE_FORM); }}
                style={{ marginTop: 12, background: "none", border: `1px dashed ${C.border}`, borderRadius: 8, padding: "7px 14px", color: C.muted, cursor: "pointer", fontSize: 12, width: "100%" }}>
                + Add property manually
              </button>
            )}
          </Card>

          {/* ── Cash Accounts card ── */}
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ fontWeight: 600 }}>Cash Accounts</div>
              {!readonly && <span style={{ fontSize: 11, color: C.muted, fontStyle: "italic" }}>✦ Add via chat</span>}
            </div>

            {data.cashAccounts.map(a => {
              if (editingCashId === a.id) return (
                <div key={a.id} style={{ background: C.bg, border: `1px solid ${C.accent}55`, borderRadius: 10, padding: 14, margin: "6px 0" }}>
                  <div style={{ fontWeight: 600, fontSize: 12, color: C.accent, marginBottom: 10 }}>Edit account</div>
                  {[["Name *","name","text","e.g. OTP Bank"],["Balance *","balance","number",""]].map(([label,key,type,ph]) => (
                    <div key={key} style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 10, color: C.muted, marginBottom: 3, textTransform: "uppercase" }}>{label}</div>
                      <input type={type} value={cashForm[key]} onChange={e => setCashForm(f => ({ ...f, [key]: e.target.value }))} placeholder={ph}
                        style={{ width: "100%", background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 7, padding: "7px 10px", color: C.text, fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                    </div>
                  ))}
                  <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 10, color: C.muted, marginBottom: 3, textTransform: "uppercase" }}>Currency</div>
                      <select value={cashForm.currency} onChange={e => setCashForm(f => ({ ...f, currency: e.target.value }))}
                        style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 7, padding: "7px 10px", color: C.text, fontSize: 13, outline: "none", width: "100%" }}>
                        {["HUF","EUR","USD"].map(c => <option key={c}>{c}</option>)}
                      </select>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 10, color: C.muted, marginBottom: 3, textTransform: "uppercase" }}>Type</div>
                      <select value={cashForm.type} onChange={e => setCashForm(f => ({ ...f, type: e.target.value }))}
                        style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 7, padding: "7px 10px", color: C.text, fontSize: 13, outline: "none", width: "100%" }}>
                        {["Checking","Savings","Emergency fund","Brokerage cash","Other"].map(t => <option key={t}>{t}</option>)}
                      </select>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Btn onClick={saveCash} disabled={!cashForm.name || !cashForm.balance}>Save changes</Btn>
                    <Btn variant="ghost" onClick={() => { setEditingCashId(null); setCashForm(EMPTY_CASH_FORM); }}>Cancel</Btn>
                  </div>
                </div>
              );
              return (
                <div key={a.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{a.name}</div>
                    <Tag color={C.muted}>{a.type}</Tag>
                    {a.currency !== "HUF" && <span style={{ fontSize: 11, color: C.muted, marginLeft: 6 }}>{a.balance} {a.currency}</span>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ fontWeight: 600, color: C.green }}>{fmtHUF(toHUF(a.balance, a.currency))}</div>
                    {!readonly && (
                      <div style={{ display: "flex", gap: 2 }}>
                        <button onClick={() => startEditCash(a)} title="Edit" style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 12, padding: "2px 4px" }}>✎</button>
                        <button onClick={() => setConfirmDeleteCashId(a.id)} title="Delete" style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 14, padding: "2px 4px" }}>×</button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Add form */}
            {showCashForm && !readonly && (
              <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, marginTop: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 12, color: C.accent, marginBottom: 10 }}>Add account</div>
                {[["Name *","name","text","e.g. OTP Bank, Revolut"],["Balance *","balance","number","Current balance"]].map(([label,key,type,ph]) => (
                  <div key={key} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 10, color: C.muted, marginBottom: 3, textTransform: "uppercase" }}>{label}</div>
                    <input type={type} value={cashForm[key]} onChange={e => setCashForm(f => ({ ...f, [key]: e.target.value }))} placeholder={ph}
                      style={{ width: "100%", background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 7, padding: "7px 10px", color: C.text, fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                  </div>
                ))}
                <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, color: C.muted, marginBottom: 3, textTransform: "uppercase" }}>Currency</div>
                    <select value={cashForm.currency} onChange={e => setCashForm(f => ({ ...f, currency: e.target.value }))}
                      style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 7, padding: "7px 10px", color: C.text, fontSize: 13, outline: "none", width: "100%" }}>
                      {["HUF","EUR","USD"].map(c => <option key={c}>{c}</option>)}
                    </select>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, color: C.muted, marginBottom: 3, textTransform: "uppercase" }}>Type</div>
                    <select value={cashForm.type} onChange={e => setCashForm(f => ({ ...f, type: e.target.value }))}
                      style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 7, padding: "7px 10px", color: C.text, fontSize: 13, outline: "none", width: "100%" }}>
                      {["Checking","Savings","Emergency fund","Brokerage cash","Other"].map(t => <option key={t}>{t}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Btn onClick={saveCash} disabled={!cashForm.name || !cashForm.balance}>Add account</Btn>
                  <Btn variant="ghost" onClick={() => { setShowCashForm(false); setCashForm(EMPTY_CASH_FORM); }}>Cancel</Btn>
                </div>
              </div>
            )}

            {!readonly && !showCashForm && !editingCashId && (
              <button onClick={() => { setShowCashForm(true); setCashForm(EMPTY_CASH_FORM); }}
                style={{ marginTop: 12, background: "none", border: `1px dashed ${C.border}`, borderRadius: 8, padding: "7px 14px", color: C.muted, cursor: "pointer", fontSize: 12, width: "100%" }}>
                + Add account manually
              </button>
            )}
          </Card>
        </div>

        {/* Delete confirmation modals */}
        {confirmDeleteREId && (() => {
          const r = data.realEstate.find(x => x.id === confirmDeleteREId);
          if (!r) return null;
          return (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }}
              onClick={() => setConfirmDeleteREId(null)}>
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 28, width: 360, boxShadow: "0 8px 40px rgba(0,0,0,0.5)" }}
                onClick={e => e.stopPropagation()}>
                <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Delete property?</div>
                <div style={{ fontSize: 13, color: C.textSoft, marginBottom: 20 }}>This will permanently remove <strong>{r.name}</strong>. This cannot be undone.</div>
                <div style={{ display: "flex", gap: 10 }}>
                  <Btn variant="danger" onClick={() => deleteRE(confirmDeleteREId)} style={{ flex: 1 }}>Yes, delete</Btn>
                  <Btn variant="ghost" onClick={() => setConfirmDeleteREId(null)} style={{ flex: 1 }}>Cancel</Btn>
                </div>
              </div>
            </div>
          );
        })()}
        {confirmDeleteCashId && (() => {
          const a = data.cashAccounts.find(x => x.id === confirmDeleteCashId);
          if (!a) return null;
          return (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }}
              onClick={() => setConfirmDeleteCashId(null)}>
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 28, width: 360, boxShadow: "0 8px 40px rgba(0,0,0,0.5)" }}
                onClick={e => e.stopPropagation()}>
                <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Delete account?</div>
                <div style={{ fontSize: 13, color: C.textSoft, marginBottom: 20 }}>This will permanently remove <strong>{a.name}</strong>. This cannot be undone.</div>
                <div style={{ display: "flex", gap: 10 }}>
                  <Btn variant="danger" onClick={() => deleteCash(confirmDeleteCashId)} style={{ flex: 1 }}>Yes, delete</Btn>
                  <Btn variant="ghost" onClick={() => setConfirmDeleteCashId(null)} style={{ flex: 1 }}>Cancel</Btn>
                </div>
              </div>
            </div>
          );
        })()}
      </>)}

      {/* ══════ BY PORTFOLIO VIEW ══════ */}
      {portfolioView === "single" && selectedPortfolio && (<>
        {/* Per-portfolio stats */}
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr 1fr", gap: 16 }}>
          <Card>
            <Stat label="Market Value" value={fmtHUF(selMV)} color={C.blue} />
            <div style={{ textAlign: "center", fontSize: 11, color: C.muted, marginTop: 3 }}>{selPositions.length} position{selPositions.length !== 1 ? "s" : ""}</div>
          </Card>
          <Card><Stat label="Cost Basis" value={fmtHUF(selCost)} color={C.textSoft} /></Card>
          <Card>
            <Stat label="Unrealized P&L" value={`${selPnL >= 0 ? "+" : ""}${fmtHUF(selPnL)}`} color={selPnL >= 0 ? C.green : C.red} />
          </Card>
          <Card>
            <Stat label="Return" value={selPnLPct !== "—" ? `${selPnL >= 0 ? "+" : ""}${selPnLPct}%` : "—"} color={selPnL >= 0 ? C.green : C.red} />
          </Card>
        </div>

        {/* Breakdown pies for selected portfolio */}
        <BreakdownPies pies={selPies} />

        {/* P&L by position — tax lot diff style */}
        {selPositions.length > 0 && (() => {
          const pnlData = selPositions
            .map(pos => ({
              name: pos.ticker || pos.name.slice(0, 10),
              pnl: Math.round(toHUF(pos.qty * (pos.currentPrice - pos.costBasis), pos.currency)),
              pct: pos.costBasis > 0 ? ((pos.currentPrice - pos.costBasis) / pos.costBasis * 100).toFixed(1) : 0,
            }))
            .sort((a, b) => b.pnl - a.pnl);
          return (
            <Card>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>Unrealized P&amp;L by Position</div>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>Cost basis vs current — sorted best to worst</div>
              <ResponsiveContainer width="100%" height={Math.max(120, pnlData.length * 32)}>
                <BarChart data={pnlData} layout="vertical" margin={{ left: 0, right: 60, top: 0, bottom: 0 }}>
                  <XAxis type="number" tick={{ fill: C.muted, fontSize: 10 }} tickFormatter={v => `${Math.round(v / 1000)}k`} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fill: C.text, fontSize: 11 }} width={80} axisLine={false} tickLine={false} interval={0} />
                  <Tooltip formatter={(v, _, props) => [`${v >= 0 ? "+" : ""}${fmtHUF(v)} (${props.payload?.pct >= 0 ? "+" : ""}${props.payload?.pct}%)`, "Unrealized P&L"]}
                    contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }} />
                  <ReferenceLine x={0} stroke={C.border} strokeWidth={1} />
                  <Bar dataKey="pnl" radius={[0, 4, 4, 0]}>
                    {pnlData.map((entry, i) => <Cell key={i} fill={entry.pnl >= 0 ? C.green : C.red} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Card>
          );
        })()}

        {/* Portfolio card (positions table) for selected portfolio */}
        <PortfolioCard key={selectedPortfolio.id} portfolio={selectedPortfolio} data={data} setData={setData} readonly={readonly} />
      </>)}

      {portfolioView === "single" && data.portfolios.length === 0 && (
        <Card>
          <div style={{ color: C.muted, fontSize: 13, textAlign: "center", padding: "32px 0" }}>
            No portfolios yet. Use the Wealth section below to add one.
          </div>
        </Card>
      )}

    </div>
  );
}

// ─── Budget Intelligence ──────────────────────────────────────────────────────
const EXPENSE_CATEGORIES = CATEGORIES.filter(c => c !== "Income" && c !== "Savings");
// Merge built-in + user custom categories
function allCategories(data) { return [...CATEGORIES, ...(data?.customCategories || [])]; }
function allExpenseCategories(data) { return [...EXPENSE_CATEGORIES, ...(data?.customCategories || [])]; }
const VARIABLE_RECURRING_CATEGORIES = ["Utilities"]; // always expected monthly, amount varies

// Returns "YYYY-MM" for a date offset by `monthsAgo` calendar months from a given "YYYY-MM"
function offsetMonth(ym, monthsAgo) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 - monthsAgo, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// For a category, sum expenses in a given "YYYY-MM" from transactions
function sumExpensesInMonth(transactions, category, ym) {
  return transactions
    .filter(t => t.type === "expense" && t.category === category && t.date?.startsWith(ym))
    .reduce((s, t) => s + toHUF(Math.abs(t.amount), t.currency), 0);
}

// Detect fixed recurring: same category appeared in each of last 3 calendar months
// with amounts within ±10% of each other. Returns { isFixed, avgAmount } or null.
function detectFixedRecurring(transactions, category, viewMonth) {
  const months = [1, 2, 3].map(n => offsetMonth(viewMonth, n));
  const sums = months.map(m => sumExpensesInMonth(transactions, category, m));
  // Must have spend in all 3 prior months
  if (sums.some(s => s === 0)) return null;
  const avg = sums.reduce((a, b) => a + b, 0) / 3;
  // All within ±10% of average
  const allClose = sums.every(s => Math.abs(s - avg) / avg <= 0.10);
  if (!allClose) return null;
  return { isFixed: true, avgAmount: Math.round(avg) };
}

// For variable recurring categories: compute 3-month average (could be 0 if no history)
function variableRecurringAvg(transactions, category, viewMonth) {
  const months = [1, 2, 3].map(n => offsetMonth(viewMonth, n));
  const sums = months.map(m => sumExpensesInMonth(transactions, category, m));
  const nonZero = sums.filter(s => s > 0);
  if (nonZero.length === 0) return 0;
  return Math.round(nonZero.reduce((a, b) => a + b, 0) / nonZero.length);
}

// Core spend calculation for a category in the view month.
// Returns { actual, estimated, isFixed, isVariableRecurring, hasActualThisMonth }
function computeCategorySpend(transactions, category, viewMonth) {
  const actualThisMonth = sumExpensesInMonth(transactions, category, viewMonth);
  const hasActual = actualThisMonth > 0;
  const isVariable = VARIABLE_RECURRING_CATEGORIES.includes(category);
  const fixed = detectFixedRecurring(transactions, category, viewMonth);

  if (hasActual) {
    // Real transaction logged — use it as the source of truth
    return { actual: actualThisMonth, estimated: 0, isFixed: !!fixed, isVariableRecurring: isVariable, hasActualThisMonth: true };
  }
  if (fixed) {
    // No transaction yet but pattern detected — show expected fixed amount
    return { actual: fixed.avgAmount, estimated: fixed.avgAmount, isFixed: true, isVariableRecurring: false, hasActualThisMonth: false };
  }
  if (isVariable) {
    // Utilities: no transaction yet — show 3-month avg as estimate
    const avg = variableRecurringAvg(transactions, category, viewMonth);
    return { actual: avg, estimated: avg, isVariableRecurring: true, isFixed: false, hasActualThisMonth: false };
  }
  return { actual: 0, estimated: 0, isFixed: false, isVariableRecurring: false, hasActualThisMonth: false };
}

// ─── BudgetBar ────────────────────────────────────────────────────────────────
function BudgetBar({ category, spendInfo, limit, onEdit, onRemove, readonly }) {
  const { actual, estimated, isFixed, isVariableRecurring, hasActualThisMonth } = spendInfo;
  const isEstimate = !hasActualThisMonth && actual > 0;
  const pct = limit > 0 ? Math.min((actual / limit) * 100, 100) : 0;
  const over = actual > limit && limit > 0;
  const warn = !over && pct >= 80;
  const barColor = over ? C.red : warn ? C.orange : isEstimate ? C.orange + "bb" : C.green;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(limit));
  function save() { const v = parseFloat(draft); if (!isNaN(v) && v > 0) onEdit(Math.round(v)); setEditing(false); }

  return (
    <div style={{ padding: "14px 0", borderBottom: `1px solid ${C.border}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 7 }}>
        {/* Left: category name + badges */}
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{category}</span>
          {isFixed && !isEstimate && <Tag color={C.muted}>fixed</Tag>}
          {isFixed && isEstimate && <Tag color={C.orange}>expected · fixed</Tag>}
          {isVariableRecurring && isEstimate && <Tag color={C.orange}>expected · est.</Tag>}
          {over && <Tag color={C.red}>over budget</Tag>}
          {warn && !over && <Tag color={C.orange}>almost full</Tag>}
        </div>
        {/* Right: amounts + edit controls */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: over ? C.red : isEstimate ? C.orange : C.text }}>
            {fmtHUF(actual)}
            {isEstimate && <span style={{ fontSize: 10, color: C.orange, marginLeft: 3 }}>est.</span>}
          </span>
          <span style={{ fontSize: 11, color: C.muted }}>of</span>
          {editing ? (
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input value={draft} onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
                autoFocus type="number"
                style={{ width: 90, background: C.surfaceHigh, border: `1px solid ${C.accent}`, borderRadius: 6, padding: "3px 8px", color: C.text, fontSize: 12, outline: "none" }} />
              <button onClick={save} style={{ background: C.green, border: "none", borderRadius: 5, padding: "3px 8px", color: "#000", fontSize: 11, cursor: "pointer", fontWeight: 700 }}>✓</button>
              <button onClick={() => setEditing(false)} style={{ background: "none", border: "none", color: C.muted, fontSize: 14, cursor: "pointer" }}>×</button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
              <span style={{ fontSize: 12, color: C.muted }}>{fmtHUF(limit)}</span>
              {!readonly && <>
                <button onClick={() => { setDraft(String(limit)); setEditing(true); }}
                  style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 12, padding: "0 2px" }}>✎</button>
                <button onClick={onRemove}
                  style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 14, padding: "0 2px" }}>×</button>
              </>}
            </div>
          )}
        </div>
      </div>

      {/* Progress bar — dashed border when estimated */}
      <div style={{ height: 8, background: C.surfaceHigh, borderRadius: 4, overflow: "hidden",
        outline: isEstimate ? `1px dashed ${C.orange}44` : "none" }}>
        <div style={{
          height: "100%", borderRadius: 4, width: `${pct}%`, background: barColor,
          transition: "width 0.4s ease",
          backgroundImage: isEstimate ? `repeating-linear-gradient(90deg, transparent, transparent 6px, ${C.bg}44 6px, ${C.bg}44 10px)` : undefined,
          boxShadow: over ? `0 0 8px ${C.red}66` : undefined,
        }} />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
        <span style={{ fontSize: 10, color: C.muted }}>
          {Math.round(pct)}% used{isEstimate ? " · based on history" : ""}
        </span>
        <span style={{ fontSize: 10, color: over ? C.red : C.muted }}>
          {over ? `${fmtHUF(actual - limit)} over` : limit > 0 ? `${fmtHUF(limit - actual)} left` : ""}
        </span>
      </div>
    </div>
  );
}

// ─── Budget Section (embedded in Costs tab) ───────────────────────────────────
// ─── Manage Categories ────────────────────────────────────────────────────────
function ManageCategories({ data, setData }) {
  const [open, setOpen] = React.useState(false);
  const [input, setInput] = React.useState("");
  const custom = data.customCategories || [];

  function add() {
    const name = input.trim();
    if (!name || allCategories(data).map(c => c.toLowerCase()).includes(name.toLowerCase())) return;
    setData(d => ({ ...d, customCategories: [...(d.customCategories || []), name] }));
    setInput("");
  }

  function remove(cat) {
    setData(d => ({ ...d, customCategories: (d.customCategories || []).filter(c => c !== cat) }));
  }

  return (
    <div style={{ borderTop: `2px solid ${C.border}`, paddingTop: 8, marginTop: 8 }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", userSelect: "none" }}>
        <div>
          <span style={{ fontWeight: 700, fontSize: 15, color: C.text }}>Custom Categories</span>
          {custom.length > 0 && <span style={{ marginLeft: 8, fontSize: 12, color: C.muted }}>{custom.length} added</span>}
        </div>
        <span style={{ color: C.muted, fontSize: 14 }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
            Add new categories for costs and transactions. Built-in categories cannot be removed.
          </div>
          {/* Add input */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") add(); }}
              placeholder="New category name"
              style={{ flex: 1, background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 7, padding: "7px 10px", color: C.text, fontSize: 13, outline: "none" }} />
            <Btn onClick={add} style={{ fontSize: 12 }}>Add</Btn>
          </div>
          {/* Built-in */}
          <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Built-in</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
            {CATEGORIES.map(cat => (
              <span key={cat} style={{ background: C.surfaceHigh, color: C.textSoft, borderRadius: 6, padding: "3px 10px", fontSize: 12 }}>{cat}</span>
            ))}
          </div>
          {/* Custom */}
          {custom.length > 0 && (
            <>
              <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Custom</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {custom.map(cat => (
                  <span key={cat} style={{ display: "flex", alignItems: "center", gap: 4, background: C.accent + "22", color: C.accent, borderRadius: 6, padding: "3px 8px 3px 10px", fontSize: 12 }}>
                    {cat}
                    <button onClick={() => remove(cat)} style={{ background: "none", border: "none", color: C.accent, cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
                  </span>
                ))}
              </div>
            </>
          )}
          {custom.length === 0 && (
            <div style={{ color: C.muted, fontSize: 12 }}>No custom categories yet. Add one above.</div>
          )}
        </div>
      )}
    </div>
  );
}

function BudgetSection({ data, setData, readonly, viewMonth, isAvg, allMonths }) {
  // Derive monthLabel from viewMonth prop
  const [_y, _m] = (viewMonth || "2024-01").split("-").map(Number);
  const monthLabel = isAvg
    ? `avg (${(allMonths || []).length} month${(allMonths || []).length !== 1 ? "s" : ""})`
    : new Date(_y, _m - 1, 1).toLocaleString("en-GB", { month: "long", year: "numeric" });

  // Budget targets map
  const targetMap = {};
  (data.budgetTargets || []).forEach(bt => { targetMap[bt.category] = bt.monthlyLimit; });

  // Compute spend info — single month or average across all months
  const spendInfoByCategory = {};
  const expCats = allExpenseCategories(data);
  expCats.forEach(cat => {
    if (isAvg && allMonths.length > 0) {
      const avgActual = allMonths.map(ym => sumExpensesInMonth(data.transactions, cat, ym))
        .reduce((a, b) => a + b, 0) / allMonths.length;
      spendInfoByCategory[cat] = { actual: Math.round(avgActual), estimated: 0, isFixed: false, isVariableRecurring: false, hasActualThisMonth: avgActual > 0 };
    } else {
      spendInfoByCategory[cat] = computeCategorySpend(data.transactions, cat, viewMonth);
    }
  });

  // Which categories to show: has a target OR has spend/estimate
  const trackedCats = expCats.filter(c => targetMap[c] !== undefined);
  const untrackedWithSpend = expCats.filter(c =>
    targetMap[c] === undefined && spendInfoByCategory[c].actual > 0
  );

  // Summary stats (only tracked categories)
  const totalBudgeted = trackedCats.reduce((s, c) => s + (targetMap[c] || 0), 0);
  const totalSpent = trackedCats.reduce((s, c) => s + spendInfoByCategory[c].actual, 0);
  const overCount = trackedCats.filter(c => spendInfoByCategory[c].actual > (targetMap[c] || 0)).length;
  const estimateCount = trackedCats.filter(c => !spendInfoByCategory[c].hasActualThisMonth && spendInfoByCategory[c].actual > 0).length;

  function setTarget(category, limit) {
    setData(d => {
      const rest = (d.budgetTargets || []).filter(bt => bt.category !== category);
      return { ...d, budgetTargets: [...rest, { category, monthlyLimit: limit, currency: "HUF" }] };
    });
  }
  function removeTarget(category) {
    setData(d => ({ ...d, budgetTargets: (d.budgetTargets || []).filter(bt => bt.category !== category) }));
  }

  const [addingFor, setAddingFor] = useState(null);
  const [newLimit, setNewLimit] = useState("");
  const [newCat, setNewCat] = useState(expCats[0]);

  function confirmAdd(category, limitStr) {
    const v = parseFloat(limitStr);
    if (!isNaN(v) && v > 0) setTarget(category, Math.round(v));
    setAddingFor(null);
    setNewLimit("");
  }

  return (
    <div style={{ display: "grid", gap: 16, marginTop: 8 }}>
      {/* Section header */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>Budget Targets</div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
              {isAvg ? `Average spend across ${(allMonths || []).length} months · fixed recurring auto-detected` : "Monthly limits per category — track actual vs target"}
            </div>
          </div>
        </div>
      </Card>

      {/* Summary stats — month picker is in Costs tab, shared */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <Card><Stat label={isAvg ? "Avg Spent vs Budgeted" : "Spent vs Budgeted"} value={`${fmtHUF(totalSpent)} / ${fmtHUF(totalBudgeted)}`} color={totalSpent > totalBudgeted ? C.red : C.text} /></Card>
        <Card><Stat label="Remaining" value={fmtHUF(Math.max(0, totalBudgeted - totalSpent))} color={C.green} /></Card>
        <Card><Stat label="Over budget" value={overCount === 0 ? "✓ None" : `${overCount} categor${overCount === 1 ? "y" : "ies"}`} color={overCount > 0 ? C.red : C.green} /></Card>
      </div>

      {estimateCount > 0 && !isAvg && (
        <div style={{ background: C.orange + "18", border: `1px solid ${C.orange}44`, borderRadius: 8, padding: "8px 14px", fontSize: 12, color: C.orange }}>
          ⚠ {estimateCount} categor{estimateCount === 1 ? "y uses a" : "ies use"} estimated amounts based on past months — actual bills not yet logged this month.
        </div>
      )}

      {/* Budget bars */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontWeight: 600 }}>Budget Targets</div>
          {!readonly && (
            <button onClick={() => setAddingFor("new")}
              style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 7, padding: "5px 12px", color: C.muted, fontSize: 12, cursor: "pointer" }}>
              + Add target
            </button>
          )}
        </div>

        {addingFor === "new" && !readonly && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "12px 0 4px", borderBottom: `1px solid ${C.border}` }}>
            <select value={newCat} onChange={e => setNewCat(e.target.value)}
              style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 7, padding: "7px 10px", color: C.text, fontSize: 13, outline: "none", flex: 1 }}>
              {expCats.filter(c => !targetMap[c]).map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input value={newLimit} onChange={e => setNewLimit(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") confirmAdd(newCat, newLimit); if (e.key === "Escape") setAddingFor(null); }}
              autoFocus type="number" placeholder="Monthly limit (HUF)"
              style={{ background: C.surfaceHigh, border: `1px solid ${C.accent}`, borderRadius: 7, padding: "7px 10px", color: C.text, fontSize: 13, outline: "none", width: 180 }} />
            <Btn onClick={() => confirmAdd(newCat, newLimit)} style={{ fontSize: 12 }}>Save</Btn>
            <button onClick={() => setAddingFor(null)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 16 }}>×</button>
          </div>
        )}

        {trackedCats.length === 0 && addingFor !== "new" && (
          <div style={{ color: C.muted, fontSize: 13, padding: "24px 0", textAlign: "center" }}>
            No budget targets set yet.<br />
            <span style={{ fontSize: 12 }}>Add one above, or ask the chat: "suggest budget targets based on my spending"</span>
          </div>
        )}

        {trackedCats.map(cat => (
          <BudgetBar key={cat} category={cat}
            spendInfo={spendInfoByCategory[cat]}
            limit={targetMap[cat]}
            onEdit={v => setTarget(cat, v)}
            onRemove={() => removeTarget(cat)}
            readonly={readonly} />
        ))}
      </Card>

      {/* Untracked categories with spend */}
      {untrackedWithSpend.length > 0 && (
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Spending Without a Target</div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>
            Categories with activity in {monthLabel} but no budget limit set.
          </div>
          {untrackedWithSpend.map(cat => {
            const si = spendInfoByCategory[cat];
            return (
              <div key={cat} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${C.border}` }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{cat}</span>
                  {si.isFixed && <Tag color={C.muted}>fixed recurring</Tag>}
                  {si.isVariableRecurring && !si.hasActualThisMonth && <Tag color={C.orange}>expected · est.</Tag>}
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <span style={{ fontWeight: 600, color: (si.estimated > 0) ? C.orange : C.textSoft }}>
                    {fmtHUF(si.actual)}{!si.hasActualThisMonth && si.actual > 0 ? " est." : ""}
                  </span>
                  {!readonly && (
                    <button onClick={() => { setNewCat(cat); setNewLimit(""); setAddingFor("new"); }}
                      style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 10px", color: C.muted, fontSize: 11, cursor: "pointer" }}>
                      + Set target
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}

// ─── AI System Prompt ─────────────────────────────────────────────────────────
function buildSystemPrompt(data, readonly, todayDate) {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  // GDPR Art. 5(1)(c) data minimisation: strip real-estate address (not needed for AI queries)
  const safeData = {
    ...data,
    realEstate: (data.realEstate || []).map(({ address: _omit, ...rest }) => rest),
  };
  return `You are PFA, a personal finance assistant for a Hungarian household. Today is ${todayDate}.
Primary currency: HUF (EUR≈358 HUF, USD≈310 HUF).
Current household data: ${JSON.stringify(safeData)}

${readonly ? "DEMO MODE: Answer questions only. Do not suggest data mutations or output IMPORT_BATCH blocks." : `
You operate in one of three modes depending on the user's message:

━━ MODE 1: QUESTION / ANALYSIS ━━
User asks about their finances (e.g. "how much did I spend on food?", "what's my net worth?").
Answer concisely using their data. No IMPORT_BATCH needed.

━━ MODE 2: NATURAL LANGUAGE ENTRY ━━
User types a financial entry like:
  "paid 8400 Ft at Lidl today"
  "Netflix 5 EUR monthly subscription"
  "bought 10 IWDA at 98 USD"
  "salary 750000 HUF"
Parse it, give a brief friendly confirmation, then output one IMPORT_BATCH block.

━━ MODE 3: FILE IMPORT ━━
User sends spreadsheet/CSV content with a user-selected file type hint (bank_statement, investment_export, or cost_list). Parse ALL data rows (skip headers and empty rows), then output one IMPORT_BATCH block.
- bank_statement → type "transactions" — parse date, description, debit/credit columns
- investment_export → type "positions" — parse symbol/ticker, ISIN, quantity, price columns
- cost_list → type "costs" — parse name, amount, frequency columns
Tell the user how many rows you parsed before the batch.

━━ IMPORT_BATCH FORMAT ━━
When you have data to import, output EXACTLY this block (no markdown, no extra text around it):

IMPORT_BATCH:
{"type":"transactions"|"costs"|"positions","summary":"Human-readable summary e.g. 23 transactions from OTP March statement","items":[...]}

Transaction item shape:
{"date":"YYYY-MM-DD","desc":"string","amount":number,"currency":"HUF"|"EUR"|"USD","category":"Housing"|"Food"|"Transport"|"Utilities"|"Health"|"Education"|"Entertainment"|"Clothing"|"Garden"|"Savings"|"Income"|"Transfer"|"Other"|"Uncategorized","type":"expense"|"income","account":"string"}
  - amount is NEGATIVE for expenses, POSITIVE for income
  - Use "Uncategorized" when you cannot determine the category — the user will be prompted to review. Use "Other" only when you are confident it is genuinely miscellaneous.
  - "yesterday" = ${yesterday}, "today" = ${todayDate}
  - default account = "OTP"

Cost item shape:
{"name":"string","category":"...","amount":number,"currency":"HUF"|"EUR"|"USD","type":"recurring","frequency":"monthly"|"quarterly"|"annual","owner":"Joint","nextDue":"YYYY-MM-DD","notes":""}
  - amount is always POSITIVE
  - nextDue: 1st of next month if not stated

Position item shape:
{"ticker":"string","isin":"string","name":"string","qty":number,"costBasis":number,"currentPrice":number,"currency":"USD"|"EUR"|"HUF"|"GBP"|"CHF","assetClass":"ETF"|"Stock"|"Bond"|"Crypto"|"Fund"|"Other","region":"Global"|"EU"|"US"|"EM"|"Asia"|"Other","purchaseDate":"YYYY-MM-DD"|"","sedol":"","cusip":"","bloomberg":"","notes":""}

IMPORTANT: For positions, also include portfolioName and broker at the top level of the batch (not inside each item):
IMPORT_BATCH:
{"type":"positions","portfolioName":"TBSZ 2021 D","broker":"Erste","summary":"...","items":[...]}

Extract portfolioName from the user's message (e.g. "this is TBSZ 2021 D at Erste" → portfolioName="TBSZ 2021 D", broker="Erste"). If not mentioned, use the account name from the file itself.

━━ FILE AUTO-DETECTION ━━
When a file is attached, Claude identifies the type automatically:
- Bank statement (OTP, Revolut, K&H, Erste etc): columns like date, description, debit/credit, balance → type "transactions"
- Investment export (IBKR Activity Statement, broker export): columns like symbol, quantity, price, proceeds → type "positions"  
- Cost/bill list: columns like name, amount, frequency → type "costs"
- Mixed file: split into multiple IMPORT_BATCH blocks if needed, one per type
Tell the user what you detected before the batch.

━━ BUDGET TARGET SUGGESTIONS ━━
If the user asks to suggest budget targets (e.g. "suggest budgets", "what should my limits be"), analyze last 3 months of transaction data, compute average monthly spend per category, add a 10-15% buffer, and output:

IMPORT_BATCH:
{"type":"budget_targets","summary":"Suggested targets based on your last 3 months average","items":[{"category":"Food","monthlyLimit":85000,"currency":"HUF"},...]}

━━ SAVINGS GOALS ━━
If the user describes a savings goal but has NOT mentioned a monthly contribution amount, ask them: "How much can you set aside for this goal each month?" — do NOT output a batch yet.
Once the user provides a monthly contribution, output:

IMPORT_BATCH:
{"type":"savings_goals","summary":"New savings goal","items":[{"name":"string","targetAmount":number,"currentAmount":number,"monthlyContribution":number,"currency":"HUF"|"EUR"|"USD","targetDate":"YYYY-MM-DD"|"","notes":"string"}]}

━━ PLANNED / UPCOMING EXPENSES ━━
If the user describes a future one-off outlay to plan for (e.g. "plan a 2M HUF kitchen renovation in October", "save up for 500k dental work next spring"), output:

IMPORT_BATCH:
{"type":"planned_expenses","summary":"New planned expense","items":[{"name":"string","amount":number,"currency":"HUF"|"EUR"|"USD","date":"YYYY-MM-DD"|"","category":"Housing"|"Health"|"Transport"|"Education"|"Garden"|"Other","notes":"string"}]}
  - amount is always POSITIVE. If only a month is given, use the 1st of that month.

━━ CATEGORY INFERENCE ━━
Lidl/Aldi/Spar/Tesco/Penny/market/zöldséges/étterem/pizza/kebab/food → Food
BKK/Volán/MÁV/Uber/Bolt/taxi/fuel/MOL/Shell/OMV/parking → Transport
Netflix/Spotify/Steam/HBO/cinema/mozi/TV2/arena → Entertainment
Doctor/orvos/pharmacy/patika/gyógyszer/gyógyszertár → Health
Electricity/áram/MVM/gas/gáz/Díjnet/internet/water/víz → Utilities
Rent/lakbér/albérlet/mortgage/jelzálog → Housing
Zara/H&M/Sinsay/Pepco/Reserved/Vinted/Deichmann/ruha → Clothing
Hornbach/OBI/Bauhaus/Leroy/kertészet/garden/növény → Garden
Salary/fizetés/bér/dividend → Income (type=income, amount positive)
Átutalás/transfer/utalás between accounts → Transfer
Feltöltés/top-up/refill → Income
Default → Other
`}`;
}

// Robust IMPORT_BATCH extractor — walks braces to find the full JSON object
function parseImportBatch(text) {
  const marker = "IMPORT_BATCH:";
  const start = text.indexOf(marker);
  if (start === -1) return null;
  const jsonStart = text.indexOf("{", start + marker.length);
  if (jsonStart === -1) return null;
  let depth = 0, end = -1;
  for (let i = jsonStart; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  try {
    const parsed = JSON.parse(text.slice(jsonStart, end + 1));
    if (!parsed.type || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch { return null; }
}

// Build a fuzzy duplicate key for a transaction-shaped item.
// Matches re-uploaded statements where descriptions vary in trailing detail
// (e.g. "LIDL 1234" vs "LIDL 1234 BUDAPEST KAROLYI"). Same date + same abs
// amount + same first 6 alphanumeric chars of description.
function buildDupKey(item) {
  const desc = (item.desc || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
  const amt = Math.round(Math.abs(parseFloat(item.amount) || 0));
  return `${item.date || ""}|${amt}|${desc}`;
}

// Returns boolean[] aligned to `items`; true = matches an existing transaction.
function markDuplicates(items, existing) {
  const seen = new Set((existing || []).map(buildDupKey));
  return items.map(it => seen.has(buildDupKey(it)));
}

const FILE_TYPE_LABELS = {
  bank_statement: "Bank statement",
  investment_export: "Investment export",
  cost_list: "Cost / bill list",
};

// ─── Monthly Sweep Wizard ─────────────────────────────────────────────────────
function MonthlySweep({ data, setData, onClose, thisMonth }) {
  const [step, setStep] = useState(0);

  const [y, m] = thisMonth.split("-").map(Number);
  const monthLabel = new Date(y, m - 1, 1).toLocaleString("en-GB", { month: "long", year: "numeric" });

  const recurring = (data.costs || []).filter(c => c.type === "recurring");
  const [checked, setChecked] = useState(() =>
    Object.fromEntries(recurring.map(c => [c.id, true]))
  );

  // Last month reference income
  const lastMonthYM = (() => {
    const d = new Date(y, m - 2, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  })();
  const lastIncome = (data.transactions || [])
    .filter(t => t.date?.startsWith(lastMonthYM) && t.type === "income")
    .reduce((s, t) => s + toHUF(Math.abs(t.amount), t.currency), 0);

  const [includeIncome, setIncludeIncome] = useState(false);
  const [incomeAmount, setIncomeAmount] = useState(lastIncome > 0 ? String(Math.round(lastIncome)) : "");
  const [incomeDesc, setIncomeDesc] = useState("Salary");

  const selectedCosts = recurring.filter(c => checked[c.id]);
  const totalSelected = selectedCosts.reduce((s, c) => s + toHUF(c.amount, c.currency), 0);

  function commit() {
    const costTxns = selectedCosts.map((c, i) => ({
      id: `t_sweep_${Date.now()}_${i}`,
      date: `${thisMonth}-01`,
      desc: c.name,
      amount: -Math.abs(c.amount),
      currency: c.currency || "HUF",
      category: c.category || "Other",
      type: "expense",
      account: "Manual",
    }));
    const incomeAmt = parseFloat(incomeAmount);
    const incomeTxns = includeIncome && incomeAmt > 0 ? [{
      id: `t_sweep_inc_${Date.now()}`,
      date: `${thisMonth}-01`,
      desc: incomeDesc.trim() || "Salary",
      amount: Math.abs(incomeAmt),
      currency: "HUF",
      category: "Income",
      type: "income",
      account: "Manual",
    }] : [];
    setData(d => ({ ...d, transactions: [...incomeTxns, ...costTxns, ...d.transactions] }));
    onClose();
  }

  const overlayStyle = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 };
  const modalStyle = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 24, width: "100%", maxWidth: 440, maxHeight: "85vh", overflowY: "auto", boxShadow: "0 8px 48px rgba(0,0,0,0.5)" };

  // Step 0 — Recurring cost confirmation
  if (step === 0) return (
    <div style={overlayStyle} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={modalStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>📅 Monthly Check-in</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 22, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 18 }}>{monthLabel} · Tick the costs you actually paid this month</div>

        {recurring.length === 0 ? (
          <div style={{ color: C.muted, fontSize: 13, textAlign: "center", padding: "24px 0" }}>No recurring costs set up yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
            {recurring.map(c => (
              <div key={c.id} onClick={() => setChecked(ch => ({ ...ch, [c.id]: !ch[c.id] }))}
                style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "10px 12px", borderRadius: 10, cursor: "pointer",
                  border: `1.5px solid ${checked[c.id] ? C.accent + "66" : C.border}`,
                  background: checked[c.id] ? C.accent + "11" : C.bg,
                  transition: "all 0.12s",
                }}>
                <div style={{
                  width: 18, height: 18, borderRadius: 4, flexShrink: 0,
                  border: `2px solid ${checked[c.id] ? C.accent : C.muted}`,
                  background: checked[c.id] ? C.accent : "transparent",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  {checked[c.id] && <span style={{ color: "#000", fontSize: 11, fontWeight: 800, lineHeight: 1 }}>✓</span>}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{c.name}</div>
                  <div style={{ fontSize: 11, color: C.muted }}>{c.category} · {c.frequency}</div>
                </div>
                <div style={{ fontWeight: 600, fontSize: 13, color: checked[c.id] ? C.red : C.muted, flexShrink: 0 }}>
                  −{fmtHUF(toHUF(c.amount, c.currency))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ fontSize: 12, color: C.muted, textAlign: "right", marginBottom: 14 }}>
          {selectedCosts.length}/{recurring.length} selected · <span style={{ color: C.red }}>{fmtHUF(totalSelected)}</span>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <Btn variant="ghost" onClick={onClose} style={{ flex: 1 }}>Skip</Btn>
          <Btn onClick={() => setStep(1)} style={{ flex: 2 }}>Next: Income →</Btn>
        </div>
      </div>
    </div>
  );

  // Step 1 — Income
  return (
    <div style={overlayStyle} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={modalStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>💵 Income for {monthLabel}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 22, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 18 }}>Optional — log your income for this month</div>

        <div onClick={() => setIncludeIncome(v => !v)}
          style={{
            display: "flex", alignItems: "center", gap: 12, padding: "12px 14px",
            borderRadius: 10, cursor: "pointer", marginBottom: 14,
            border: `1.5px solid ${includeIncome ? C.green + "66" : C.border}`,
            background: includeIncome ? C.green + "11" : C.bg,
            transition: "all 0.12s",
          }}>
          <div style={{
            width: 18, height: 18, borderRadius: 4, flexShrink: 0,
            border: `2px solid ${includeIncome ? C.green : C.muted}`,
            background: includeIncome ? C.green : "transparent",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {includeIncome && <span style={{ color: "#000", fontSize: 11, fontWeight: 800, lineHeight: 1 }}>✓</span>}
          </div>
          <div style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>Log income this month</div>
          {lastIncome > 0 && <span style={{ fontSize: 11, color: C.muted }}>Last month: {fmtHUF(lastIncome)}</span>}
        </div>

        {includeIncome && (
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <input
              autoFocus inputMode="numeric" type="number"
              placeholder={lastIncome > 0 ? String(Math.round(lastIncome)) : "Amount (HUF)"}
              value={incomeAmount}
              onChange={e => setIncomeAmount(e.target.value)}
              style={{ flex: 2, background: C.surfaceHigh, border: `1px solid ${C.green}`, borderRadius: 8,
                padding: "10px 12px", color: C.text, fontSize: 16, fontWeight: 700, outline: "none" }}
            />
            <input
              placeholder="Label (e.g. Salary)"
              value={incomeDesc}
              onChange={e => setIncomeDesc(e.target.value)}
              style={{ flex: 2, background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 8,
                padding: "10px 12px", color: C.text, fontSize: 13, outline: "none" }}
            />
          </div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <Btn variant="ghost" onClick={() => setStep(0)} style={{ flex: 1 }}>← Back</Btn>
          <Btn onClick={commit} style={{ flex: 2 }}>
            ✓ Log {selectedCosts.length > 0 ? `${selectedCosts.length} cost${selectedCosts.length !== 1 ? "s" : ""}` : ""}
            {includeIncome && parseFloat(incomeAmount) > 0 ? " + income" : ""}
          </Btn>
        </div>
      </div>
    </div>
  );
}

// ─── Quick Add Sheet ──────────────────────────────────────────────────────────
const CAT_TILES = [
  { cat: "Food",          icon: "🛒" },
  { cat: "Transport",     icon: "🚗" },
  { cat: "Housing",       icon: "🏠" },
  { cat: "Utilities",     icon: "⚡" },
  { cat: "Health",        icon: "💊" },
  { cat: "Entertainment", icon: "🎬" },
  { cat: "Clothing",      icon: "👔" },
  { cat: "Education",     icon: "📚" },
  { cat: "Other",         icon: "📦" },
  { cat: "Income",        icon: "💵" },
];

function QuickAdd({ setData, onClose, isMobile }) {
  const [type, setType] = useState("expense");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("Food");
  const [desc, setDesc] = useState("");
  const [date, setDate] = useState(todayStr());
  const [currency, setCurrency] = useState("HUF");
  const amountRef = useRef(null);

  useEffect(() => { setTimeout(() => amountRef.current?.focus(), 60); }, []);
  useEffect(() => {
    if (type === "income") setCategory("Income");
    else if (category === "Income") setCategory("Food");
  }, [type]);

  const tiles = type === "income"
    ? CAT_TILES.filter(t => t.cat === "Income" || t.cat === "Other")
    : CAT_TILES.filter(t => t.cat !== "Income");

  function commit() {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return;
    setData(d => ({
      ...d,
      transactions: [{
        id: `t_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        date,
        desc: desc.trim() || category,
        amount: type === "expense" ? -Math.abs(amt) : Math.abs(amt),
        currency,
        category,
        type,
        account: "Manual",
      }, ...d.transactions],
    }));
    onClose();
  }

  const accentColor = type === "expense" ? C.red : C.green;

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 200 }} />

      {/* Sheet / Modal */}
      <div style={{
        position: "fixed", zIndex: 201,
        ...(isMobile
          ? { bottom: 0, left: 0, right: 0, borderRadius: "20px 20px 0 0", maxHeight: "88vh", overflowY: "auto" }
          : { top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 420, borderRadius: 16 }),
        background: C.surface, border: `1px solid ${C.border}`,
        boxShadow: "0 -8px 48px rgba(0,0,0,0.5)", padding: 24,
      }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>⚡ Quick Add</div>
          <button onClick={onClose}
            style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 22, lineHeight: 1 }}>×</button>
        </div>

        {/* Expense / Income toggle */}
        <div style={{ display: "flex", background: C.bg, borderRadius: 10, padding: 3, marginBottom: 18 }}>
          {[["expense","Expense"], ["income","Income"]].map(([val, label]) => (
            <button key={val} onClick={() => setType(val)} style={{
              flex: 1, padding: "8px 0", borderRadius: 8, border: "none", cursor: "pointer",
              fontWeight: 600, fontSize: 13, transition: "all 0.15s",
              background: type === val ? (val === "expense" ? C.red : C.green) : "transparent",
              color: type === val ? "#fff" : C.muted,
            }}>{label}</button>
          ))}
        </div>

        {/* Amount row */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <input
            ref={amountRef}
            inputMode="decimal"
            type="number"
            placeholder="0"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            onKeyDown={e => e.key === "Enter" && commit()}
            style={{
              flex: 1, background: C.surfaceHigh,
              border: `1px solid ${amount && parseFloat(amount) > 0 ? accentColor : C.border}`,
              borderRadius: 10, padding: "14px 16px", color: C.text, fontSize: 26,
              fontWeight: 700, outline: "none", fontFamily: "'DM Mono', monospace",
              transition: "border-color 0.15s",
            }}
          />
          <select value={currency} onChange={e => setCurrency(e.target.value)}
            style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 10,
              padding: "0 14px", color: C.text, fontSize: 14, fontWeight: 600, outline: "none",
              cursor: "pointer", minWidth: 70 }}>
            {["HUF","EUR","USD"].map(c => <option key={c}>{c}</option>)}
          </select>
        </div>

        {/* Category grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6, marginBottom: 16 }}>
          {tiles.map(({ cat, icon }) => (
            <button key={cat} onClick={() => setCategory(cat)} style={{
              display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
              padding: "10px 4px", borderRadius: 10,
              border: `1.5px solid ${category === cat ? accentColor : C.border}`,
              background: category === cat ? accentColor + "22" : C.bg,
              cursor: "pointer", transition: "all 0.12s",
            }}>
              <span style={{ fontSize: 20, lineHeight: 1 }}>{icon}</span>
              <span style={{ fontSize: 9, color: category === cat ? C.text : C.muted, fontWeight: category === cat ? 700 : 400 }}>{cat}</span>
            </button>
          ))}
        </div>

        {/* Description + date */}
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          <input
            placeholder="Description (optional)"
            value={desc}
            onChange={e => setDesc(e.target.value)}
            onKeyDown={e => e.key === "Enter" && commit()}
            style={{ flex: 1, background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 8,
              padding: "9px 12px", color: C.text, fontSize: 13, outline: "none" }}
          />
          <input
            type="date" value={date} onChange={e => setDate(e.target.value)}
            style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 8,
              padding: "9px 10px", color: C.text, fontSize: 12, outline: "none", width: 130,
              colorScheme: "dark" }}
          />
        </div>

        {/* Commit */}
        <button onClick={commit}
          disabled={!amount || parseFloat(amount) <= 0}
          style={{
            width: "100%", padding: "14px 0", borderRadius: 10, border: "none",
            background: amount && parseFloat(amount) > 0 ? accentColor : C.border,
            color: amount && parseFloat(amount) > 0 ? "#fff" : C.muted,
            fontSize: 15, fontWeight: 700, cursor: amount && parseFloat(amount) > 0 ? "pointer" : "not-allowed",
            transition: "all 0.15s",
          }}>
          {type === "expense" ? "− Log Expense" : "+ Log Income"}
        </button>
      </div>
    </>
  );
}

// ─── Manual column mapper (guaranteed-to-work import fallback) ─────────────────
// Shows the uploaded file as a preview and lets the user pick which column holds
// each field. Pre-filled from auto-detection; the preview updates live.
// Per-import-type configuration for the manual column mapper: which roles are
// offered, how to build a preview batch from a chosen mapping, and how each
// row previews in the confirmation list. Adding a new import type only means
// adding an entry here — the mapper UI itself stays generic.
const MAPPER_CONFIG = {
  positions: {
    label: "holding",
    roles: [
      ["name", "Name / Instrument"], ["ticker", "Ticker / Symbol"], ["isin", "ISIN"],
      ["quantity", "Quantity / Units"], ["costPrice", "Cost / Avg price"], ["currentPrice", "Current price"],
      ["marketValue", "Market value"], ["currency", "Currency"], ["assetClass", "Asset class"],
    ],
    build: buildPositionsFromSchema,
    left: it => `${it.ticker ? it.ticker + " · " : ""}${it.name}`,
    right: it => `${it.qty} × ${it.currentPrice} ${it.currency}`,
  },
  transactions: {
    label: "transaction",
    roles: [
      ["date", "Date"], ["desc", "Description"], ["amount", "Amount"], ["currency", "Currency"],
      ["category", "Category"], ["type", "Type (income/expense)"], ["account", "Account"],
    ],
    build: (sheets, schema, fileName) => buildTransactionsFromSchema(sheets, schema, fileName, {}),
    left: it => `${it.date} · ${it.desc}`,
    right: it => `${it.type === "income" ? "+" : "−"}${it.amount} ${it.currency}`,
  },
  costs: {
    label: "cost",
    roles: [
      ["name", "Name"], ["amount", "Amount"], ["currency", "Currency"], ["frequency", "Frequency"],
      ["category", "Category"], ["type", "Type (recurring/onetime)"], ["owner", "Owner"],
      ["nextDue", "Next due date"], ["notes", "Notes"],
    ],
    build: buildCostsFromSchema,
    left: it => it.name,
    right: it => `${it.amount} ${it.currency} · ${it.frequency}`,
  },
};
function ColumnMapper({ sheets, fileName, guess, kind = "positions", onCancel, onConfirm }) {
  const cfg = MAPPER_CONFIG[kind] || MAPPER_CONFIG.positions;
  const ROLES = cfg.roles;
  const [sheetIndex, setSheetIndex] = useState(guess?.sheetIndex || 0);
  const [headerRow, setHeaderRow] = useState(guess?.headerRow || 0);
  const [cols, setCols] = useState(() => ({ ...(guess?.columns || {}) }));
  const [globalCur, setGlobalCur] = useState(guess?.globalCurrency || "");
  const sh = sheets[sheetIndex] || sheets[0] || { rows: [] };
  const headerCells = sh.rows[headerRow] || [];
  const maxCols = Math.max(0, ...sh.rows.slice(0, 30).map(r => r.length));
  const colOpts = Array.from({ length: maxCols }, (_, i) => ({ i, label: `Col ${i}${headerCells[i] ? " · " + String(headerCells[i]).slice(0, 20) : ""}` }));
  const schema = { sheetIndex, headerRow, columns: cols, globalCurrency: globalCur || null };
  const preview = cfg.build(sheets, schema, fileName);
  const items = preview ? preview.items : [];
  const setRole = (role, v) => setCols(c => ({ ...c, [role]: v === "" ? null : Number(v) }));
  const selStyle = { background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 7, padding: "6px 8px", color: C.text, fontSize: 12, outline: "none", width: "100%" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={e => e.target === e.currentTarget && onCancel()}>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 22, width: "min(680px, 96vw)", maxHeight: "92vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Map import columns</div>
          <button onClick={onCancel} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 20 }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>{fileName} — tell the app which column holds each field. The preview updates live.</div>

        <div style={{ display: "grid", gridTemplateColumns: sheets.length > 1 ? "1fr 1fr 1fr" : "1fr 1fr", gap: 10, marginBottom: 14 }}>
          {sheets.length > 1 && (
            <div><div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", marginBottom: 3 }}>Sheet</div>
              <select value={sheetIndex} onChange={e => setSheetIndex(Number(e.target.value))} style={selStyle}>
                {sheets.map((s, i) => <option key={i} value={i}>{s.name} ({s.rows.length} rows)</option>)}
              </select></div>
          )}
          <div><div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", marginBottom: 3 }}>Header row #</div>
            <input type="number" min={0} value={headerRow} onChange={e => setHeaderRow(Math.max(0, Number(e.target.value) || 0))} style={selStyle} /></div>
          <div><div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", marginBottom: 3 }}>Currency (if no column)</div>
            <select value={globalCur} onChange={e => setGlobalCur(e.target.value)} style={selStyle}>
              <option value="">Auto / per row</option>{["EUR", "USD", "HUF", "GBP"].map(c => <option key={c} value={c}>{c}</option>)}
            </select></div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
          {ROLES.map(([role, label]) => (
            <div key={role}>
              <div style={{ fontSize: 10, color: C.muted, marginBottom: 3 }}>{label}</div>
              <select value={cols[role] == null ? "" : cols[role]} onChange={e => setRole(role, e.target.value)} style={selStyle}>
                <option value="">—</option>
                {colOpts.map(o => <option key={o.i} value={o.i}>{o.label}</option>)}
              </select>
            </div>
          ))}
        </div>

        <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: items.length ? C.green : C.orange }}>
            {items.length ? `✓ ${items.length} holding${items.length === 1 ? "" : "s"} detected` : "No holdings detected yet — adjust the columns above"}
          </div>
          {items.slice(0, 4).map((it, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.textSoft, padding: "3px 0" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>{cfg.left(it)}</span>
              <span style={{ color: C.muted }}>{cfg.right(it)}</span>
            </div>
          ))}
          {items.length > 4 && <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>+ {items.length - 4} more</div>}
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <Btn onClick={() => onConfirm(schema)} disabled={!items.length} style={{ flex: 1 }}>Import {items.length || ""} {cfg.label}{items.length === 1 ? "" : "s"}</Btn>
          <Btn variant="ghost" onClick={onCancel}>Cancel</Btn>
        </div>
      </div>
    </div>
  );
}

// ─── AI Chat ──────────────────────────────────────────────────────────────────
function AIChat({ data, setData, open, setOpen, readonly, pendingImport, clearPendingImport, isMobile, initialMessage, clearInitialMessage, triggerFileOpen, clearTriggerFileOpen, onShowPrivacy }) {
  const [messages, setMessages] = useState([]);
  const [history, setHistory] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [attachedFile, setAttachedFile] = useState(null);
  const [fileType, setFileType] = useState(null);
  const [pendingBatch, setPendingBatch] = useState(null);
  const [pendingMapping, setPendingMapping] = useState(null); // { kind, sheets, fileName, guess } — manual column mapper
  const fileInputRef = useRef(null);
  const bottomRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading, pendingBatch]);

  // Pre-fill input when opened with a suggested message from a quick-start tile
  useEffect(() => {
    if (!open || !initialMessage) return;
    setInput(initialMessage);
    setMinimized(false);
    clearInitialMessage?.();
    // Auto-focus the input after a short delay to ensure the chat is rendered
    setTimeout(() => {
      const inputEl = document.querySelector(".pfa-chat-input");
      inputEl?.focus();
    }, 80);
  }, [open, initialMessage]);

  // Trigger file input when opened via an upload quick-start tile
  useEffect(() => {
    if (!open || !triggerFileOpen) return;
    setMinimized(false);
    clearTriggerFileOpen?.();
    setTimeout(() => fileInputRef.current?.click(), 80);
  }, [open, triggerFileOpen]);

  // AI-assisted investment import: detect the column layout, then parse every row
  // locally. Falls back to attaching the file for the assistant if mapping fails.
  async function aiInvestmentImport(text, fileName) {
    setMessages(m => [...m, { role: "user", content: `📎 ${fileName} [Investment export]` }]);
    setMessages(m => [...m, { role: "assistant", content: "Reading the file and identifying the columns…" }]);
    setLoading(true);
    let sheets = [];
    try {
      // 0) Dedicated Erste "Instrumentum bekerülés" report (Crystal Reports layout).
      const erste = tryParseErsteHoldingsXLS(text);
      if (erste && erste.items.length) {
        setMessages(m => [...m, { role: "assistant", content: `Detected an Erste holdings report — aggregated ${erste.items.length} holding${erste.items.length === 1 ? "" : "s"} (purchase lots merged, prices converted to ${erste.items[0].currency}). Note: Erste's report has no ISIN/ticker, so live prices can't auto-update these unless you add a ticker. Review and confirm below.` }]);
        setPendingBatch({ ...erste, duplicates: erste.items.map(() => false), checked: erste.items.map(() => true) });
        setLoading(false);
        return;
      }
      sheets = parseDelimitedToSheets(text);
      // 1) Fast keyword detection (Hungarian + English headers, no AI round-trip).
      let schema = heuristicSchema(sheets);
      let batch = schema ? buildPositionsFromSchema(sheets, schema, fileName) : null;
      // 2) Ask the AI to map columns if the heuristic didn't yield holdings.
      if (!batch || !batch.items.length) {
        try {
          const ai = await aiDetectInvestmentSchema(sheets);
          if (ai) { const b2 = buildPositionsFromSchema(sheets, ai, fileName); if (b2 && b2.items.length) { schema = ai; batch = b2; } }
        } catch {}
      }
      if (batch && batch.items.length) {
        setMessages(m => [...m, { role: "assistant", content: `Mapped the columns and parsed ${batch.items.length} holding${batch.items.length === 1 ? "" : "s"}. Live prices will fill in current values where missing — review and confirm below.` }]);
        setPendingBatch({ ...batch, duplicates: batch.items.map(() => false), checked: batch.items.map(() => true) });
      } else {
        // 3) Guaranteed fallback: let the user map the columns by hand.
        setMessages(m => [...m, { role: "assistant", content: "I couldn't auto-detect the columns — please map them below. The preview updates as you choose." }]);
        setPendingMapping({ kind: "positions", sheets, fileName, guess: schema || { sheetIndex: 0, headerRow: 0, columns: {}, globalCurrency: null } });
      }
    } catch (e) {
      if (sheets && sheets.length) {
        setMessages(m => [...m, { role: "assistant", content: "I couldn't auto-detect the columns — please map them below." }]);
        setPendingMapping({ kind: "positions", sheets, fileName, guess: { sheetIndex: 0, headerRow: 0, columns: {}, globalCurrency: null } });
      } else {
        setAttachedFile({ name: fileName, text }); setFileType("investment_export");
        setMessages(m => [...m, { role: "assistant", content: "Couldn't read the file — press send and I'll try to parse it directly." }]);
      }
    }
    setLoading(false);
  }

  function showTxnBatch(items, fileName, label) {
    const dups = markDuplicates(items, data.transactions || []);
    const dupCount = dups.filter(Boolean).length;
    setMessages(m => [...m, { role: "user", content: `📎 ${fileName} [Bank statement]` }]);
    setMessages(m => [...m, { role: "assistant", content: `Detected ${label} — parsed ${items.length} transaction${items.length === 1 ? "" : "s"}.${dupCount ? ` ${dupCount} look like duplicates and were pre-unchecked.` : ""} Review and confirm below.` }]);
    setPendingBatch({
      type: "transactions",
      summary: `${items.length} transactions from ${fileName}${dupCount ? ` · ${dupCount} possible duplicate${dupCount === 1 ? "" : "s"}` : ""}`,
      items, duplicates: dups, checked: dups.map(d => !d),
    });
  }

  // Deterministic-first bank-statement pipeline, same shape as aiInvestmentImport:
  // dedicated bank parsers → generic keyword-based column detection → guaranteed
  // manual mapper. No network call is required to reach a working result.
  function routeBankImport(text, fileName, learnedRules) {
    const ersteRows = tryParseErsteFromText(text, learnedRules);
    if (ersteRows && ersteRows.length) { showTxnBatch(ersteRows, fileName, "Erste bank statement"); return; }
    const revRows = tryParseRevolutCSV(text, learnedRules);
    if (revRows && revRows.length) { showTxnBatch(revRows, fileName, "Revolut statement"); return; }
    const sheets = parseDelimitedToSheets(text);
    const schema = heuristicTxnSchema(sheets);
    const batch = schema ? buildTransactionsFromSchema(sheets, schema, fileName, learnedRules) : null;
    if (batch && batch.items.length) {
      showTxnBatch(batch.items, fileName, "the statement");
      return;
    }
    setMessages(m => [...m, { role: "user", content: `📎 ${fileName} [Bank statement]` }]);
    setMessages(m => [...m, { role: "assistant", content: "I couldn't auto-detect the columns — please map them below. The preview updates as you choose." }]);
    setPendingMapping({ kind: "transactions", sheets, fileName, guess: schema || { sheetIndex: 0, headerRow: 0, columns: {}, globalCurrency: null } });
  }

  // Same deterministic-first shape for cost/bill lists — there is no dedicated
  // per-provider parser here (cost lists aren't bank-format-specific), so it's
  // heuristic detection → guaranteed manual mapper.
  function routeCostImport(text, fileName, learnedRules) {
    const sheets = parseDelimitedToSheets(text);
    const schema = heuristicCostSchema(sheets);
    const batch = schema ? buildCostsFromSchema(sheets, schema, fileName, learnedRules) : null;
    if (batch && batch.items.length) {
      setMessages(m => [...m, { role: "user", content: `📎 ${fileName} [Cost / bill list]` }]);
      setMessages(m => [...m, { role: "assistant", content: `Mapped the columns and parsed ${batch.items.length} cost${batch.items.length === 1 ? "" : "s"}. Review and confirm below.` }]);
      setPendingBatch({ ...batch, duplicates: batch.items.map(() => false), checked: batch.items.map(() => true) });
      return;
    }
    setMessages(m => [...m, { role: "user", content: `📎 ${fileName} [Cost / bill list]` }]);
    setMessages(m => [...m, { role: "assistant", content: "I couldn't auto-detect the columns — please map them below. The preview updates as you choose." }]);
    setPendingMapping({ kind: "costs", sheets, fileName, guess: schema || { sheetIndex: 0, headerRow: 0, columns: {}, globalCurrency: null } });
  }

  // When a file arrives from a tab upload card, pre-load it
  useEffect(() => {
    if (!pendingImport) return;
    const text = pendingImport.text || "";
    const learnedRules = buildLearnedRules(data.transactions || [], data.merchantRules || []);
    // Try the deterministic Lightyear parser first; then route by file type.
    const lyBatch = tryParseLightyearCSV(text);
    if (lyBatch) {
      setMessages(m => [...m, { role: "user", content: `📎 ${pendingImport.name} [Investment export]` }]);
      setMessages(m => [...m, { role: "assistant", content: `Detected a Lightyear statement — ${lyBatch.summary}. Live prices will fill in current values; review and confirm below.` }]);
      setPendingBatch({ ...lyBatch, duplicates: lyBatch.items.map(() => false), checked: lyBatch.items.map(() => true) });
    } else if (pendingImport.fileType === "investment_export") {
      // Robust AI-assisted column-mapping path for any broker/bank holdings export.
      aiInvestmentImport(text, pendingImport.name);
    } else if (pendingImport.fileType === "cost_list") {
      routeCostImport(text, pendingImport.name, learnedRules);
    } else {
      // bank_statement (or unset) — deterministic pipeline, no AI required.
      routeBankImport(text, pendingImport.name, learnedRules);
    }
    setMinimized(false);
    clearPendingImport?.();
  }, [pendingImport]);

  const chatBottom = isMobile ? 72 : 28;
  const chatRight = isMobile ? 16 : 28;

  // Minimized pill — shows last message, click to expand
  if (!open) return (
    <button onClick={() => setOpen(true)} title="Open AI Assistant"
      style={{ position: "fixed", bottom: chatBottom, right: chatRight, width: 52, height: 52, borderRadius: "50%", background: C.accent, border: "none", cursor: "pointer", fontSize: 22, color: "#000", fontWeight: 700, boxShadow: "0 4px 20px rgba(0,0,0,0.4)", zIndex: 100 }}>✦</button>
  );

  if (minimized) return (
    <div style={{ position: "fixed", bottom: chatBottom, right: chatRight, zIndex: 100, display: "flex", alignItems: "center", gap: 8 }}>
      <div onClick={() => setMinimized(false)}
        style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 24, padding: "10px 16px", cursor: "pointer", boxShadow: "0 4px 20px rgba(0,0,0,0.4)", display: "flex", alignItems: "center", gap: 10, maxWidth: 280 }}>
        <span style={{ color: C.accent, fontWeight: 700, fontSize: 15, flexShrink: 0 }}>✦</span>
        <span style={{ fontSize: 12, color: C.textSoft, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {messages.length > 0 ? messages[messages.length - 1].content.slice(0, 60) : "PFA Assistant"}
        </span>
        {loading && <span style={{ fontSize: 11, color: C.muted, flexShrink: 0 }}>…</span>}
      </div>
      <button onClick={() => setOpen(false)}
        style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: "50%", width: 32, height: 32, cursor: "pointer", color: C.muted, fontSize: 16, flexShrink: 0 }}>×</button>
    </div>
  );

  async function handleFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const learnedRules = buildLearnedRules(data.transactions || [], data.merchantRules || []);
      const ext = file.name.split(".").pop().toLowerCase();

      // ── XLSX: try Erste direct parse first (bypasses Claude entirely) ──
      if (ext === "xlsx" || ext === "xls") {
        await loadXLSX();
        const wb = window.XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
        const ersteRows = tryParseErsteXLSX(wb, learnedRules);
        if (ersteRows && ersteRows.length > 0) {
          const dups = markDuplicates(ersteRows, data.transactions || []);
          const dupCount = dups.filter(Boolean).length;
          const dupNote = dupCount > 0 ? ` ${dupCount} look like duplicates and have been pre-unchecked.` : "";
          setMessages(m => [...m, { role: "user", content: `📎 ${file.name} [Bank statement]` }]);
          setMessages(m => [...m, { role: "assistant", content: `Detected Erste bank statement — parsed ${ersteRows.length} transactions using your learned categorization rules.${dupNote} Review and confirm below.` }]);
          setPendingBatch({
            type: "transactions",
            summary: `${ersteRows.length} transactions from ${file.name}${dupCount > 0 ? ` · ${dupCount} possible duplicate${dupCount === 1 ? "" : "s"}` : ""}`,
            items: ersteRows,
            duplicates: dups,
            checked: dups.map(d => !d),
          });
          e.target.value = "";
          return;
        }
      }

      const text = await fileToText(file);
      // ── CSV: try Lightyear investment statement (reconstruct positions) ──
      const lyBatch = tryParseLightyearCSV(text);
      if (lyBatch) {
        setMessages(m => [...m, { role: "user", content: `📎 ${file.name} [Investment export]` }]);
        setMessages(m => [...m, { role: "assistant", content: `Detected a Lightyear statement — ${lyBatch.summary}. Live prices will fill in current values; review and confirm below.` }]);
        setPendingBatch({ ...lyBatch, duplicates: lyBatch.items.map(() => false), checked: lyBatch.items.map(() => true) });
        e.target.value = "";
        return;
      }
      // ── CSV: try Revolut direct parse (bypasses Claude token limits entirely) ──
      const revRows = tryParseRevolutCSV(text, learnedRules);
      if (revRows && revRows.length > 0) {
        const dups = markDuplicates(revRows, data.transactions || []);
        const dupCount = dups.filter(Boolean).length;
        const dupNote = dupCount > 0 ? ` ${dupCount} look like duplicates of existing transactions and have been pre-unchecked.` : "";
        setMessages(m => [...m, { role: "user", content: `📎 ${file.name} [Bank statement]` }]);
        setMessages(m => [...m, { role: "assistant", content: `Detected Revolut statement — parsed ${revRows.length} transactions using your learned categorization rules.${dupNote} Review and confirm below.` }]);
        setPendingBatch({
          type: "transactions",
          summary: `${revRows.length} transactions from ${file.name}${dupCount > 0 ? ` · ${dupCount} possible duplicate${dupCount === 1 ? "" : "s"}` : ""}`,
          items: revRows,
          duplicates: dups,
          checked: dups.map(d => !d),
        });
        e.target.value = "";
        return;
      }
      // Fall back to Claude for other formats
      setAttachedFile({ name: file.name, text });
      setFileType(null);
    } catch (err) {
      setMessages(m => [...m, { role: "assistant", content: `⚠️ ${err.message}` }]);
    }
    e.target.value = "";
  }

  async function send() {
    if ((!input.trim() && !attachedFile) || loading) return;
    if (attachedFile && !fileType) return; // must select type before sending

    // Investment exports go through the robust AI column-mapping pipeline instead
    // of the generic one-shot extraction (handles large files / any layout).
    if (attachedFile && fileType === "investment_export" && !readonly) {
      const f = attachedFile;
      setAttachedFile(null); setFileType(null); setInput("");
      await aiInvestmentImport(f.text, f.name);
      return;
    }
    // Bank statements / cost lists: same deterministic-first pipeline as the tab
    // upload cards, so a paperclip attachment gets the same guarantee (no AI
    // round-trip required to reach a working import).
    if (attachedFile && fileType === "bank_statement" && !readonly) {
      const f = attachedFile;
      setAttachedFile(null); setFileType(null); setInput("");
      const learnedRules = buildLearnedRules(data.transactions || [], data.merchantRules || []);
      routeBankImport(f.text, f.name, learnedRules);
      return;
    }
    if (attachedFile && fileType === "cost_list" && !readonly) {
      const f = attachedFile;
      setAttachedFile(null); setFileType(null); setInput("");
      const learnedRules = buildLearnedRules(data.transactions || [], data.merchantRules || []);
      routeCostImport(f.text, f.name, learnedRules);
      return;
    }

    let displayContent = input.trim();
    if (attachedFile) displayContent = (displayContent ? displayContent + "\n" : "") + `📎 ${attachedFile.name} [${FILE_TYPE_LABELS[fileType]}]`;

    const fileTypeHint = fileType ? `\nFILE TYPE (user-selected): ${fileType} — parse accordingly and output the correct IMPORT_BATCH type.` : "";
    let apiContent = input.trim();
    if (attachedFile) {
      apiContent = (apiContent ? apiContent + "\n\n" : "") +
        `FILE ATTACHED: ${attachedFile.name}${fileTypeHint}\n\`\`\`\n${attachedFile.text.slice(0, 14000)}\n\`\`\``;
    }

    const userApiMsg = { role: "user", content: apiContent };
    setMessages(m => [...m, { role: "user", content: displayContent }]);
    setHistory(h => [...h, userApiMsg]);
    setInput("");
    setAttachedFile(null);
    setFileType(null);
    setLoading(true);
    setPendingBatch(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4000,
          system: buildSystemPrompt(data, readonly, todayStr()),
          messages: [...history, userApiMsg]
        })
      });
      const result = await res.json();
      const rawText = result.content?.[0]?.text || "Sorry, couldn't process that.";

      // Extract batch, strip it from display text
      const batch = parseImportBatch(rawText);
      const displayText = rawText
        .replace(/IMPORT_BATCH:\s*\n?\{[\s\S]*?\}(?:\s*$|\s*\n)/, "")
        .trim();

      setMessages(m => [...m, { role: "assistant", content: displayText }]);
      setHistory(h => [...h, { role: "assistant", content: rawText }]);

      if (batch && !readonly && batch.items.length > 0) {
        const dups = batch.type === "transactions"
          ? markDuplicates(batch.items, data.transactions || [])
          : batch.items.map(() => false);
        const dupCount = dups.filter(Boolean).length;
        setPendingBatch({
          ...batch,
          duplicates: dups,
          checked: dups.map(d => !d),
          summary: batch.summary + (dupCount > 0 ? ` · ${dupCount} possible duplicate${dupCount === 1 ? "" : "s"}` : ""),
        });
      }
    } catch (err) {
      const isNetwork = !navigator.onLine || (err?.message || "").toLowerCase().includes("network") || (err?.message || "").toLowerCase().includes("fetch");
      setMessages(m => [...m, {
        role: "assistant",
        content: isNetwork
          ? "⚠ No connection — check your internet and try again."
          : "⚠ Something went wrong. The AI may be temporarily unavailable — please try again in a moment.",
      }]);
    }
    setLoading(false);
  }

  function toggleItem(idx) {
    setPendingBatch(b => ({ ...b, checked: b.checked.map((v, i) => i === idx ? !v : v) }));
  }

  function commitBatch() {
    if (!pendingBatch) return;
    const selected = pendingBatch.items.filter((_, i) => pendingBatch.checked[i]);
    const count = selected.length;

    if (pendingBatch.type === "transactions") {
      setData(d => ({
        ...d,
        transactions: [
          ...selected.map(item => ({
            id: `t_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            date: item.date,
            desc: item.desc,
            amount: item.type === "expense" ? -Math.abs(item.amount) : Math.abs(item.amount),
            currency: item.currency || "HUF",
            category: item.category || "Other",
            type: item.type,
            account: item.account || "OTP",
          })),
          ...d.transactions
        ]
      }));
    } else if (pendingBatch.type === "costs") {
      setData(d => ({
        ...d,
        costs: [...d.costs, ...selected.map(item => ({
          ...item, id: `c_${Date.now()}_${Math.random().toString(36).slice(2)}`
        }))]
      }));
    } else if (pendingBatch.type === "positions") {
      setData(d => {
        const newPositions = selected.map(item => ({
          ...item, id: `pos_${Date.now()}_${Math.random().toString(36).slice(2)}`
        }));
        // Use portfolioName from batch if provided, else "Imported Portfolio"
        const targetName = pendingBatch.portfolioName || "Imported Portfolio";
        const targetBroker = pendingBatch.broker || "";
        const existing = d.portfolios.find(p => p.name === targetName);
        if (existing) {
          // Append to existing portfolio with this name
          return { ...d, portfolios: d.portfolios.map(p => p.name === targetName ? { ...p, positions: [...p.positions, ...newPositions] } : p) };
        }
        // Create new named portfolio
        return { ...d, portfolios: [...d.portfolios, { id: `p_${Date.now()}`, name: targetName, broker: targetBroker, currency: "USD", description: "", positions: newPositions }] };
      });
    } else if (pendingBatch.type === "budget_targets") {
      setData(d => {
        const merged = [...(d.budgetTargets || [])];
        selected.forEach(item => {
          const idx = merged.findIndex(bt => bt.category === item.category);
          if (idx >= 0) merged[idx] = { ...merged[idx], monthlyLimit: item.monthlyLimit };
          else merged.push({ category: item.category, monthlyLimit: item.monthlyLimit, currency: item.currency || "HUF" });
        });
        return { ...d, budgetTargets: merged };
      });
    } else if (pendingBatch.type === "savings_goals") {
      setData(d => ({
        ...d,
        savingsGoals: [
          ...(d.savingsGoals || []),
          ...selected.map(item => ({ ...item, id: `sg_${Date.now()}_${Math.random().toString(36).slice(2)}` }))
        ]
      }));
    } else if (pendingBatch.type === "planned_expenses") {
      setData(d => ({
        ...d,
        plannedExpenses: [
          ...(d.plannedExpenses || []),
          ...selected.map(item => ({
            id: `pe_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            name: item.name, amount: parseFloat(item.amount) || 0, currency: item.currency || "HUF",
            date: item.date || "", category: item.category || "Other", notes: item.notes || "",
          }))
        ]
      }));
    }

    setPendingBatch(null);
    setMessages(m => [...m, { role: "assistant", content: `✓ Imported ${count} ${pendingBatch.type}. Data updated.` }]);
  }

  const batchColor = { transactions: C.blue, costs: C.purple, positions: C.green, budget_targets: C.accent, savings_goals: C.orange, planned_expenses: C.orange };

  return (
    <div style={{ position: "fixed", bottom: isMobile ? 0 : 28, right: isMobile ? 0 : 28, left: isMobile ? 0 : "auto", top: isMobile ? 0 : "auto", width: isMobile ? "100%" : 430, height: isMobile ? "100%" : 620, background: C.surface, border: isMobile ? "none" : `1px solid ${C.border}`, borderRadius: isMobile ? 0 : 16, display: "flex", flexDirection: "column", zIndex: 100, boxShadow: "0 8px 40px rgba(0,0,0,0.6)" }}>

      {/* Manual column mapper (guaranteed import fallback) */}
      {pendingMapping && (
        <ColumnMapper
          sheets={pendingMapping.sheets}
          fileName={pendingMapping.fileName}
          guess={pendingMapping.guess}
          kind={pendingMapping.kind || "positions"}
          onCancel={() => setPendingMapping(null)}
          onConfirm={(schema) => {
            const kind = pendingMapping.kind || "positions";
            const cfg = MAPPER_CONFIG[kind];
            const b = cfg.build(pendingMapping.sheets, schema, pendingMapping.fileName);
            setPendingMapping(null);
            if (b && b.items.length) {
              const dups = b.type === "transactions" ? markDuplicates(b.items, data.transactions || []) : b.items.map(() => false);
              setMessages(m => [...m, { role: "assistant", content: `Parsed ${b.items.length} ${cfg.label}${b.items.length === 1 ? "" : "s"} from your mapping. Review and confirm below.` }]);
              setPendingBatch({ ...b, duplicates: dups, checked: dups.map(d => !d) });
            }
          }}
        />
      )}

      {/* Header */}
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontWeight: 700, color: C.accent }}>✦ PFA Assistant</span>
          {readonly && <Tag color={C.orange}>Demo</Tag>}
          {!readonly && (
            <button onClick={onShowPrivacy}
              title="Messages and your financial data are sent to Anthropic's API. Click for Privacy Policy."
              style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 13, padding: "0 2px", lineHeight: 1 }}>ℹ️</button>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button onClick={() => setMinimized(true)} title="Minimize"
            style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "0 4px" }}>−</button>
          <button onClick={() => setOpen(false)} title="Close"
            style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 20, lineHeight: 1, padding: 0 }}>×</button>
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "14px 14px 8px", display: "flex", flexDirection: "column", gap: 10 }}>
        {messages.length === 0 && (
          <div style={{ color: C.muted, fontSize: 13, textAlign: "center", marginTop: 28, lineHeight: 1.8 }}>
            <div style={{ fontSize: 26, marginBottom: 10, color: C.accent }}>✦</div>
            <div style={{ color: C.textSoft, marginBottom: 12 }}>Type an entry or upload a file.</div>
            <div style={{ fontSize: 11, color: C.muted, lineHeight: 2 }}>
              "paid 8 400 Ft at Lidl today"<br />
              "Netflix 5 EUR monthly"<br />
              "bought 10 IWDA at 98 USD"<br />
              📎 OTP_march_statement.xlsx<br />
              📎 IBKR_positions.csv
            </div>
            {!readonly && (
              <div style={{ marginTop: 16, padding: "9px 12px", background: C.surfaceHigh, borderRadius: 8, fontSize: 11, color: C.muted, lineHeight: 1.65, textAlign: "left" }}>
                🔒 Your messages and a financial data summary are sent to Anthropic's API.
                Uploaded files are also sent for parsing.{" "}
                <button onClick={onShowPrivacy} style={{ background: "none", border: "none", color: C.accent, cursor: "pointer", fontSize: 11, padding: 0, textDecoration: "underline" }}>Privacy policy</button>
              </div>
            )}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} style={{
            alignSelf: m.role === "user" ? "flex-end" : "flex-start",
            maxWidth: "88%",
            background: m.role === "user" ? C.accent : C.surfaceHigh,
            color: m.role === "user" ? "#000" : C.text,
            borderRadius: m.role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
            padding: "9px 13px", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap"
          }}>{m.content}</div>
        ))}

        {/* Loading dots */}
        {loading && (
          <div style={{ alignSelf: "flex-start", display: "flex", gap: 5, alignItems: "center", padding: "10px 14px", background: C.surfaceHigh, borderRadius: "12px 12px 12px 2px" }}>
            {[0, 1, 2].map(i => (
              <div key={i} style={{ width: 7, height: 7, borderRadius: "50%", background: C.muted, animation: "pfa-pulse 1.2s ease-in-out infinite", animationDelay: `${i * 0.18}s` }} />
            ))}
          </div>
        )}

        {/* Batch confirm card */}
        {pendingBatch && (
          <div style={{ background: C.bg, border: `1px solid ${(batchColor[pendingBatch.type] || C.accent)}55`, borderRadius: 12, padding: 13, marginTop: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 9 }}>
              <div>
                <Tag color={batchColor[pendingBatch.type] || C.accent}>{pendingBatch.type}</Tag>
                <div style={{ fontSize: 12, color: C.textSoft, marginTop: 4 }}>{pendingBatch.summary}</div>
              </div>
              <button onClick={() => setPendingBatch(null)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 16, padding: 0, lineHeight: 1 }}>×</button>
            </div>

            {/* Scrollable item list */}
            <div style={{ maxHeight: 190, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3, marginBottom: 8 }}>
              {pendingBatch.items.map((item, idx) => (
                <label key={idx} style={{
                  display: "flex", gap: 8, alignItems: "center",
                  padding: "5px 7px", borderRadius: 6, cursor: "pointer",
                  background: pendingBatch.checked[idx] ? C.surfaceHigh : "transparent",
                  opacity: pendingBatch.checked[idx] ? 1 : 0.5,
                  transition: "opacity 0.1s, background 0.1s"
                }}>
                  <input type="checkbox" checked={pendingBatch.checked[idx]} onChange={() => toggleItem(idx)}
                    style={{ accentColor: C.accent, width: 13, height: 13, flexShrink: 0 }} />

                  {pendingBatch.type === "transactions" && (
                    <div style={{ display: "flex", flex: 1, gap: 6, alignItems: "center", minWidth: 0, fontSize: 12 }}>
                      <span style={{ color: C.muted, flexShrink: 0, fontSize: 11 }}>{item.date}</span>
                      {pendingBatch.duplicates?.[idx] && <Tag color={C.orange}>dup</Tag>}
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.desc}</span>
                      <select
                        value={item.category}
                        onChange={e => setPendingBatch(b => ({ ...b, items: b.items.map((it, i) => i === idx ? { ...it, category: e.target.value } : it) }))}
                        onClick={e => e.stopPropagation()}
                        style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 5, padding: "2px 4px", color: C.text, fontSize: 11, outline: "none", cursor: "pointer" }}>
                        {allCategories(data).map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <span style={{ fontWeight: 600, flexShrink: 0, color: item.type === "income" ? C.green : C.red }}>
                        {item.type === "income" ? "+" : "−"}{fmtHUF(toHUF(Math.abs(item.amount), item.currency))}
                      </span>
                    </div>
                  )}
                  {pendingBatch.type === "costs" && (
                    <div style={{ display: "flex", flex: 1, gap: 6, alignItems: "center", fontSize: 12 }}>
                      <span style={{ flex: 1 }}>{item.name}</span>
                      <Tag color={C.muted}>{item.frequency}</Tag>
                      <span style={{ fontWeight: 600, color: C.red }}>{fmtHUF(toHUF(item.amount, item.currency))}</span>
                    </div>
                  )}
                  {pendingBatch.type === "positions" && (
                    <div style={{ display: "flex", flex: 1, gap: 6, alignItems: "center", fontSize: 12 }}>
                      <Tag color={C.blue}>{item.ticker}</Tag>
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
                      <span style={{ color: C.muted, flexShrink: 0 }}>{item.qty} × {item.currentPrice} {item.currency}</span>
                    </div>
                  )}
                  {pendingBatch.type === "budget_targets" && (
                    <div style={{ display: "flex", flex: 1, gap: 6, alignItems: "center", fontSize: 12 }}>
                      <span style={{ flex: 1, fontWeight: 500 }}>{item.category}</span>
                      <span style={{ color: C.muted }}>limit:</span>
                      <span style={{ fontWeight: 600, color: C.accent }}>{fmtHUF(item.monthlyLimit)}</span>
                    </div>
                  )}
                  {pendingBatch.type === "savings_goals" && (
                    <div style={{ display: "flex", flex: 1, gap: 6, alignItems: "center", fontSize: 12 }}>
                      <span style={{ flex: 1, fontWeight: 500 }}>{item.name}</span>
                      {item.targetDate && <Tag color={C.muted}>{item.targetDate}</Tag>}
                      <span style={{ fontWeight: 600, color: C.orange }}>{fmtHUF(toHUF(item.targetAmount, item.currency || "HUF"))}</span>
                    </div>
                  )}
                </label>
              ))}
            </div>

            {/* Select controls */}
            <div style={{ display: "flex", alignItems: "center", marginBottom: 9, gap: 8 }}>
              <button onClick={() => setPendingBatch(b => ({ ...b, checked: b.items.map(() => true) }))}
                style={{ fontSize: 11, color: C.muted, background: "none", border: "none", cursor: "pointer", padding: 0 }}>All</button>
              <span style={{ color: C.border }}>·</span>
              <button onClick={() => setPendingBatch(b => ({ ...b, checked: b.items.map(() => false) }))}
                style={{ fontSize: 11, color: C.muted, background: "none", border: "none", cursor: "pointer", padding: 0 }}>None</button>
              <span style={{ marginLeft: "auto", fontSize: 11, color: C.muted }}>
                {pendingBatch.checked.filter(Boolean).length}/{pendingBatch.items.length} selected
              </span>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant="success" onClick={commitBatch} disabled={!pendingBatch.checked.some(Boolean)} style={{ flex: 1, fontSize: 12 }}>
                ✓ Import {pendingBatch.checked.filter(Boolean).length} {pendingBatch.type}
              </Btn>
              <Btn variant="danger" onClick={() => setPendingBatch(null)} style={{ fontSize: 12 }}>✗ Discard</Btn>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* File attachment + type selector */}
      {attachedFile && (
        <div style={{ margin: "0 12px 4px", background: C.surfaceHigh, border: `1px solid ${C.accent}44`, borderRadius: 10, padding: "10px 12px", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: fileType ? 0 : 8 }}>
            <span style={{ fontSize: 12, color: C.accent }}>📎 {attachedFile.name}</span>
            <button onClick={() => { setAttachedFile(null); setFileType(null); }} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 14, padding: 0 }}>×</button>
          </div>
          {attachedFile.text.length > 14000 && (() => {
            const total = attachedFile.text.length;
            const lines = attachedFile.text.split(/\r?\n/).length;
            const cutLines = attachedFile.text.slice(14000).split(/\r?\n/).length;
            return (
              <div style={{ background: C.orange + "18", border: `1px solid ${C.orange}55`, borderRadius: 7, padding: "7px 10px", marginTop: 8, marginBottom: fileType ? 0 : 8, fontSize: 11, color: C.orange, lineHeight: 1.5 }}>
                ⚠ Large file: {Math.round(total / 1000)}k chars · ~{lines} rows. The AI will only parse the first 14k chars — roughly the last {cutLines} rows will be skipped. Tip: split the file or export a shorter date range.
              </div>
            );
          })()}
          {/* GDPR: file will be sent to Anthropic — notify user */}
          <div style={{ background: C.blue + "15", border: `1px solid ${C.blue}44`, borderRadius: 7, padding: "7px 10px", marginTop: 6, marginBottom: 6, fontSize: 11, color: C.textSoft, lineHeight: 1.55 }}>
            🔒 This file will be sent to Anthropic's API for parsing. Remove sensitive rows (e.g. recipient names) if needed.{" "}
            <button onClick={onShowPrivacy} style={{ background: "none", border: "none", color: C.accent, cursor: "pointer", fontSize: 11, padding: 0, textDecoration: "underline" }}>Privacy policy</button>
          </div>
          {!fileType && (
            <div>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>What type of file is this?</div>
              <div style={{ display: "flex", gap: 6 }}>
                {Object.entries(FILE_TYPE_LABELS).map(([key, label]) => (
                  <button key={key} onClick={() => setFileType(key)}
                    style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 7, padding: "5px 10px", color: C.textSoft, fontSize: 11, cursor: "pointer", fontWeight: 500 }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {fileType && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
              <Tag color={C.accent}>{FILE_TYPE_LABELS[fileType]}</Tag>
              <button onClick={() => setFileType(null)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 11 }}>change</button>
            </div>
          )}
        </div>
      )}

      {/* Input row */}
      <div style={{ padding: "10px 12px 14px", borderTop: `1px solid ${C.border}`, display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
        <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls,.pdf" onChange={handleFileSelect} style={{ display: "none" }} />
        <button
          onClick={() => !readonly && fileInputRef.current?.click()}
          disabled={readonly}
          title="Attach Excel or CSV file"
          style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 11px", cursor: readonly ? "not-allowed" : "pointer", color: attachedFile ? C.accent : C.muted, fontSize: 15, flexShrink: 0, opacity: readonly ? 0.4 : 1, lineHeight: 1 }}
        >📎</button>
        <input
          className="pfa-chat-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={readonly ? "Demo mode — read only" : "Type or attach a file…"}
          disabled={readonly || loading}
          style={{ flex: 1, background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.text, fontSize: 13, outline: "none", opacity: readonly ? 0.5 : 1 }}
          onFocus={e => e.target.style.borderColor = C.accent}
          onBlur={e => e.target.style.borderColor = C.border}
        />
        <Btn onClick={send} disabled={(!input.trim() && !attachedFile) || (attachedFile && !fileType) || loading || readonly} style={{ flexShrink: 0 }}>
          {loading ? "…" : "Send"}
        </Btn>
      </div>

      <style>{`@keyframes pfa-pulse { 0%,100%{opacity:.25;transform:scale(.75)} 50%{opacity:1;transform:scale(1)} }`}</style>
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function Dashboard({ data, setTab, viewMonth, onOpenChat }) {
  const isMobile = useIsMobile();
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const monthFraction = viewMonth === thisMonth ? dayOfMonth / daysInMonth : 1;

  // Exclude "Transfer" (money moving between the owner's own accounts) so the
  // dashboard totals match the Cash flow tab and reflect real money in/out.
  const isFlow = t => t.category !== "Transfer";
  const monthTxns = (data.transactions || []).filter(t => t.date?.startsWith(viewMonth));
  const income = monthTxns.filter(t => t.type === "income" && isFlow(t)).reduce((s, t) => s + toHUF(t.amount, t.currency), 0);
  const expenses = monthTxns.filter(t => t.type === "expense" && isFlow(t)).reduce((s, t) => s + Math.abs(toHUF(t.amount, t.currency)), 0);
  const net = income - expenses;
  const savingsRate = income > 0 ? Math.round((net / income) * 100) : null;

  const allPositions = (data.portfolios || []).flatMap(p => p.positions || []);
  const investmentsHUF = allPositions.reduce((s, pos) => s + toHUF((pos.qty || 0) * (pos.currentPrice || 0), pos.currency), 0);
  const realEstateHUF = (data.realEstate || []).reduce((s, r) => s + toHUF((r.currentValue || 0) - (r.mortgage || 0), r.currency), 0);
  const cashHUF = (data.cashAccounts || []).reduce((s, a) => s + toHUF(a.balance, a.currency), 0);
  const totalNW = investmentsHUF + realEstateHUF + cashHUF;

  // Spending pace vs budget targets
  const totalBudget = (data.budgetTargets || []).reduce((s, bt) => s + toHUF(bt.monthlyLimit, bt.currency || "HUF"), 0);
  const pacePct = totalBudget > 0 ? Math.round((expenses / totalBudget) * 100) : null;
  const expectedSpend = totalBudget > 0 ? Math.round(totalBudget * monthFraction) : null;
  const isOverPace = expectedSpend !== null && expenses > expectedSpend;

  // Uncategorized transactions + costs (any month — "Uncategorized" means the
  // system couldn't classify it; "Other" means the user/import confirmed it's
  // genuinely miscellaneous). Both transactions and cost/bill imports use this
  // same convention — see buildTransactionsFromSchema / buildCostsFromSchema.
  const uncategorized = (data.transactions || []).filter(t => t.category === "Uncategorized");
  const uncategorizedBills = (data.costs || []).filter(c => c.category === "Uncategorized");
  const uncategorizedTotal = uncategorized.length + uncategorizedBills.length;

  // Categories at ≥90% budget
  const overBudget = (data.budgetTargets || []).filter(bt => {
    const spent = monthTxns.filter(t => t.category === bt.category && t.type === "expense")
      .reduce((s, t) => s + Math.abs(toHUF(t.amount, t.currency)), 0);
    return spent >= toHUF(bt.monthlyLimit, bt.currency || "HUF") * 0.9;
  });

  // Budget bars (top 5 by % used)
  const budgetBars = (data.budgetTargets || []).map(bt => {
    const spent = monthTxns.filter(t => t.category === bt.category && t.type === "expense")
      .reduce((s, t) => s + Math.abs(toHUF(t.amount, t.currency)), 0);
    const limit = toHUF(bt.monthlyLimit, bt.currency || "HUF");
    return { category: bt.category, spent: Math.round(spent), limit: Math.round(limit), pct: limit > 0 ? Math.min(Math.round((spent / limit) * 100), 100) : 0 };
  }).sort((a, b) => b.pct - a.pct).slice(0, 5);

  // Savings goals (top 3)
  const goals = (data.savingsGoals || []).slice(0, 3);
  const goalColors = [C.blue, C.green, C.orange, C.purple];

  // Recent 5 transactions (all time, most recent first)
  const recentTxns = [...(data.transactions || [])].sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 5);

  // Net worth MoM change
  const nwChange = (() => {
    const h = data.netWorthHistory || [];
    if (h.length < 2) return null;
    return h[h.length - 1].totalNW - h[h.length - 2].totalNW;
  })();

  const [vy, vm] = viewMonth.split("-").map(Number);
  const viewMonthLabel = new Date(vy, vm - 1, 1).toLocaleString("en-GB", { month: "long", year: "numeric" });
  const CAT_ICONS = { Housing: "🏠", Food: "🛒", Transport: "🚗", Utilities: "⚡", Health: "💊", Entertainment: "🎬", Clothing: "👔", Education: "📚", Savings: "🏦", Other: "📦", Income: "💵", Garden: "🌿" };

  const isEmpty = (data.transactions || []).length === 0 && allPositions.length === 0;
  if (isEmpty) return (
    <div style={{ textAlign: "center", padding: "60px 20px", color: C.muted }}>
      <div style={{ fontSize: 40, marginBottom: 16 }}>📊</div>
      <div style={{ fontWeight: 600, fontSize: 16, color: C.text, marginBottom: 8 }}>Your dashboard is empty</div>
      <div style={{ fontSize: 13, marginBottom: 24, lineHeight: 1.6 }}>Import a bank statement or add transactions to see your financial overview here.</div>
      <Btn onClick={onOpenChat}>Open AI assistant →</Btn>
    </div>
  );

  return (
    <div style={{ display: "grid", gap: 14 }}>

      {/* ── Alerts ── */}
      {uncategorizedTotal > 0 && (
        <div style={{ background: C.orange + "18", border: `1px solid ${C.orange}44`, borderRadius: 10, padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 13, color: C.orange }}>
            ⚠ <strong>{uncategorizedTotal} item{uncategorizedTotal > 1 ? "s" : ""}</strong>{uncategorized.length > 0 && uncategorizedBills.length > 0 ? ` (${uncategorized.length} transaction${uncategorized.length > 1 ? "s" : ""}, ${uncategorizedBills.length} cost${uncategorizedBills.length > 1 ? "s" : ""})` : ""} need categorization — affects budget accuracy
          </div>
          <button onClick={() => setTab("expenses")} style={{ background: C.orange, border: "none", borderRadius: 7, padding: "5px 14px", color: "#000", fontSize: 12, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>Review →</button>
        </div>
      )}
      {overBudget.length > 0 && (
        <div style={{ background: C.red + "18", border: `1px solid ${C.red}44`, borderRadius: 10, padding: "10px 16px", fontSize: 13, color: C.red }}>
          🔴 <strong>{overBudget.map(b => b.category).join(", ")}</strong> {overBudget.length === 1 ? "is" : "are"} at ≥90% of budget in {viewMonthLabel}
        </div>
      )}

      {/* ── KPI tiles ── */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: 12 }}>
        <Card style={{ borderTop: `2px solid ${C.accent}`, cursor: "pointer" }} onClick={() => setTab("wealth")}>
          <Stat label="Net worth" value={totalNW > 0 ? fmtHUF(totalNW) : "—"} color={C.accent} />
          {nwChange !== null && <div style={{ textAlign: "center", fontSize: 11, marginTop: 5, color: nwChange >= 0 ? C.green : C.red, fontWeight: 600 }}>{nwChange >= 0 ? "↑" : "↓"} {fmtHUF(Math.abs(nwChange))} MoM</div>}
        </Card>
        <Card style={{ borderTop: `2px solid ${net >= 0 ? C.green : C.red}`, cursor: "pointer" }} onClick={() => setTab("expenses")}>
          <Stat label={`Saved — ${new Date(vy, vm - 1, 1).toLocaleString("en-GB", { month: "short" })}`} value={income > 0 ? `${net >= 0 ? "+" : ""}${fmtHUF(net)}` : "—"} color={net >= 0 ? C.green : C.red} />
          {savingsRate !== null && <div style={{ textAlign: "center", fontSize: 11, marginTop: 5, color: C.muted }}>{savingsRate}% savings rate</div>}
        </Card>
        <Card style={{ borderTop: `2px solid ${isOverPace ? C.red : C.blue}`, cursor: "pointer" }} onClick={() => setTab("expenses")}>
          <Stat label="Budget pace" value={pacePct !== null ? `${pacePct}%` : expenses > 0 ? fmtHUF(expenses) : "—"} color={pacePct === null ? C.text : pacePct > 100 ? C.red : pacePct > 85 ? C.orange : C.green} />
          {pacePct !== null && <div style={{ textAlign: "center", fontSize: 11, marginTop: 5, color: C.muted }}>Day {dayOfMonth} of {daysInMonth}</div>}
        </Card>
        <Card style={{ borderTop: `2px solid ${C.blue}`, cursor: "pointer" }} onClick={() => setTab("wealth")}>
          <Stat label="Investments" value={investmentsHUF > 0 ? fmtHUF(investmentsHUF) : "—"} color={C.blue} />
          {cashHUF > 0 && <div style={{ textAlign: "center", fontSize: 11, marginTop: 5, color: C.muted }}>+ {fmtHUF(cashHUF)} cash</div>}
        </Card>
      </div>

      {/* ── Spending pace bar ── */}
      {pacePct !== null && (
        <Card style={{ padding: "12px 16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>Spending pace — {viewMonthLabel}</div>
            <div style={{ fontSize: 11, color: C.muted }}>{Math.round(monthFraction * 100)}% through month</div>
          </div>
          <div style={{ position: "relative", height: 10, background: C.surfaceHigh, borderRadius: 6, overflow: "visible", marginBottom: 6 }}>
            <div style={{ height: "100%", width: `${Math.min(pacePct, 100)}%`, background: pacePct > 100 ? C.red : pacePct > 90 ? C.orange : pacePct > 70 ? C.accent : C.green, borderRadius: 6 }} />
            {/* Expected-pace marker */}
            <div style={{ position: "absolute", top: -3, bottom: -3, left: `${Math.min(Math.round(monthFraction * 100), 100)}%`, width: 2, background: C.muted, borderRadius: 1 }} title="Budget target for today" />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted }}>
            <span>Spent: <strong style={{ color: isOverPace ? C.red : C.text }}>{fmtHUF(expenses)}</strong></span>
            <span>On-pace target: {fmtHUF(expectedSpend)}</span>
            <span>Monthly budget: {fmtHUF(totalBudget)}</span>
          </div>
        </Card>
      )}

      {/* ── Quick actions ── */}
      {(() => {
        const quickActions = [
          {
            label: "Import",
            action: () => onOpenChat(),
            icon: (
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="4" y="18" width="20" height="3" rx="1.5" fill={C.accent} opacity="0.9"/>
                <rect x="4" y="22" width="20" height="3" rx="1.5" fill={C.accent} opacity="0.5"/>
                <path d="M14 4 L14 16 M9 11 L14 16 L19 11" stroke={C.accent} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )
          },
          {
            label: "Cash flow",
            action: () => setTab("expenses"),
            icon: (
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="3" y="13" width="22" height="2" rx="1" fill={C.muted} opacity="0.4"/>
                <path d="M5 13 L11 7 L17 11 L23 5" stroke={C.green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M5 13 L11 19 L17 15 L23 21" stroke={C.red} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )
          },
          {
            label: "Portfolio",
            action: () => setTab("wealth"),
            icon: (
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="4" y="18" width="5" height="7" rx="1" fill={C.blue} opacity="0.7"/>
                <rect x="11" y="12" width="5" height="13" rx="1" fill={C.blue} opacity="0.85"/>
                <rect x="18" y="6" width="5" height="19" rx="1" fill={C.blue}/>
                <path d="M4 18 L9 14 L14 9 L19 6 L23 4" stroke={C.accent} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.8"/>
              </svg>
            )
          },
          {
            label: "AI assistant",
            action: () => onOpenChat(),
            icon: (
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="4" y="6" width="20" height="14" rx="3" stroke={C.purple} strokeWidth="2" fill="none"/>
                <path d="M9 23 L14 18 L19 23" stroke={C.purple} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <circle cx="10" cy="13" r="1.5" fill={C.purple}/>
                <circle cx="14" cy="13" r="1.5" fill={C.purple}/>
                <circle cx="18" cy="13" r="1.5" fill={C.purple}/>
              </svg>
            )
          },
        ];
        return (
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${isMobile ? 2 : 4}, 1fr)`, gap: 10 }}>
            {quickActions.map(({ icon, label, action }) => (
              <button key={label} onClick={action}
                style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: isMobile ? "18px 10px" : "22px 12px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 10, transition: "border-color 0.15s, background 0.15s" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = C.accent; e.currentTarget.style.background = C.surfaceHigh; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.background = C.surface; }}>
                {icon}
                <span style={{ fontSize: 12, fontWeight: 600, color: C.textSoft }}>{label}</span>
              </button>
            ))}
          </div>
        );
      })()}

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 14 }}>

        {/* ── Budget bars ── */}
        {budgetBars.length > 0 && (
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Budget this month</div>
              <button onClick={() => setTab("expenses")} style={{ background: "none", border: "none", color: C.accent, fontSize: 12, cursor: "pointer" }}>See all →</button>
            </div>
            {budgetBars.map(b => (
              <div key={b.category} style={{ marginBottom: 9 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
                  <span style={{ color: C.text }}>{CAT_ICONS[b.category] || "📦"} {b.category}</span>
                  <span style={{ color: b.pct >= 90 ? C.red : C.muted, fontWeight: b.pct >= 90 ? 600 : 400 }}>{b.pct}% · {fmtHUF(b.spent)} / {fmtHUF(b.limit)}</span>
                </div>
                <div style={{ height: 6, background: C.surfaceHigh, borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${b.pct}%`, background: b.pct >= 90 ? C.red : b.pct >= 70 ? C.orange : C.green, borderRadius: 4 }} />
                </div>
              </div>
            ))}
          </Card>
        )}

        {/* ── Savings goals ── */}
        {goals.length > 0 && (
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Savings goals</div>
              <button onClick={() => setTab("expenses")} style={{ background: "none", border: "none", color: C.accent, fontSize: 12, cursor: "pointer" }}>See all →</button>
            </div>
            {goals.map((g, gi) => {
              const target = toHUF(g.targetAmount, g.currency || "HUF");
              const current = toHUF(g.currentAmount, g.currency || "HUF");
              const pct = target > 0 ? Math.min(Math.round((current / target) * 100), 100) : 0;
              const done = pct >= 100;
              const gc = done ? C.green : goalColors[gi % goalColors.length];
              return (
                <div key={g.id} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                    <span style={{ fontWeight: 500, color: C.text }}>{g.name}</span>
                    <span style={{ color: done ? C.green : C.muted, fontWeight: 600 }}>{pct}%{done ? " 🎉" : ""}</span>
                  </div>
                  <div style={{ height: 6, background: C.surfaceHigh, borderRadius: 4, overflow: "hidden", marginBottom: 3 }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: gc, borderRadius: 4 }} />
                  </div>
                  <div style={{ fontSize: 10, color: C.muted }}>{fmtHUF(current)} / {fmtHUF(target)}{g.targetDate ? ` · by ${g.targetDate}` : ""}</div>
                </div>
              );
            })}
          </Card>
        )}
      </div>

      {/* ── Recent transactions ── */}
      {recentTxns.length > 0 && (
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>Recent transactions</div>
            <button onClick={() => setTab("expenses")} style={{ background: "none", border: "none", color: C.accent, fontSize: 12, cursor: "pointer" }}>See all →</button>
          </div>
          {recentTxns.map((t, i) => (
            <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: i < recentTxns.length - 1 ? `1px solid ${C.border}` : "none" }}>
              <span style={{ width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", background: t.type === "income" ? C.green + "20" : C.red + "15", borderRadius: 6, fontSize: 13, flexShrink: 0 }}>
                {CAT_ICONS[t.category] || "📦"}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.desc}</div>
                <div style={{ fontSize: 10, color: C.muted }}>{t.date} · {t.category}</div>
              </div>
              <div style={{ fontWeight: 600, flexShrink: 0, fontSize: 12, color: t.type === "income" ? C.green : C.red }}>
                {t.type === "income" ? "+" : "−"}{fmtHUF(toHUF(Math.abs(t.amount), t.currency))}
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// ─── Cash Flow & Expenses Tab (merged) ────────────────────────────────────────
// ─── Planned / Upcoming Expenses ──────────────────────────────────────────────
// Plan one-off future outlays (renovation, health, etc.) and check whether your
// liquid capital (cash) covers them. Lives on the Cash flow tab.
const EMPTY_PLANNED = { name: "", amount: "", currency: "HUF", date: "", category: "Other", notes: "" };
function PlannedExpenses({ data, setData, readonly }) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_PLANNED);
  const items = [...(data.plannedExpenses || [])].sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));

  const today = todayStr();
  const totalPlanned = items.reduce((s, p) => s + toHUF(parseFloat(p.amount) || 0, p.currency), 0);
  const next3 = items.filter(p => p.date && p.date <= addMonthsISO(today, 3)).reduce((s, p) => s + toHUF(parseFloat(p.amount) || 0, p.currency), 0);
  const liquidCapital = (data.cashAccounts || []).reduce((s, a) => s + toHUF(a.balance, a.currency), 0);
  const shortfall = totalPlanned - liquidCapital;

  function save() {
    if (!form.name || !form.amount) return;
    const entry = { name: form.name, amount: parseFloat(form.amount), currency: form.currency, date: form.date || "", category: form.category, notes: form.notes || "" };
    if (editingId) {
      setData(d => ({ ...d, plannedExpenses: (d.plannedExpenses || []).map(p => p.id === editingId ? { ...p, ...entry } : p) }));
    } else {
      setData(d => ({ ...d, plannedExpenses: [...(d.plannedExpenses || []), { id: `pe_${Date.now()}`, ...entry }] }));
    }
    setForm(EMPTY_PLANNED); setAdding(false); setEditingId(null);
  }
  function startEdit(p) {
    setForm({ name: p.name, amount: String(p.amount), currency: p.currency || "HUF", date: p.date || "", category: p.category || "Other", notes: p.notes || "" });
    setEditingId(p.id); setAdding(true);
  }
  function remove(id) { setData(d => ({ ...d, plannedExpenses: (d.plannedExpenses || []).filter(p => p.id !== id) })); }

  const cats = ["Housing", "Health", "Transport", "Education", "Garden", "Other"];
  const F = (
    <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, marginTop: 10 }}>
      <div style={{ fontWeight: 600, fontSize: 12, color: C.accent, marginBottom: 10 }}>{editingId ? "Edit planned expense" : "Add planned expense"}</div>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
        <Inp value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="e.g. Kitchen renovation" />
        <Inp value={form.amount} onChange={v => setForm(f => ({ ...f, amount: v }))} placeholder="Amount" type="number" />
        <Sel value={form.currency} onChange={v => setForm(f => ({ ...f, currency: v }))} options={["HUF", "EUR", "USD"]} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 2fr", gap: 8, marginBottom: 10 }}>
        <Inp value={form.date} onChange={v => setForm(f => ({ ...f, date: v }))} type="date" />
        <Sel value={form.category} onChange={v => setForm(f => ({ ...f, category: v }))} options={cats} />
        <Inp value={form.notes} onChange={v => setForm(f => ({ ...f, notes: v }))} placeholder="Notes (optional)" />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn onClick={save} disabled={!form.name || !form.amount}>{editingId ? "Save" : "Add"}</Btn>
        <Btn variant="ghost" onClick={() => { setForm(EMPTY_PLANNED); setAdding(false); setEditingId(null); }}>Cancel</Btn>
      </div>
    </div>
  );

  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div>
          <div style={{ fontWeight: 600 }}>Planned / Upcoming Expenses</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>Set aside capital for renovations, health and other one-off outlays</div>
        </div>
        {!readonly && !adding && (
          <button onClick={() => { setForm(EMPTY_PLANNED); setEditingId(null); setAdding(true); }}
            style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 7, padding: "5px 12px", color: C.muted, fontSize: 12, cursor: "pointer" }}>
            + Add
          </button>
        )}
      </div>

      {items.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, margin: "12px 0" }}>
          <div style={{ background: C.surfaceHigh, borderRadius: 8, padding: "8px 12px" }}>
            <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase" }}>Total planned</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.orange }}>{fmtHUF(totalPlanned)}</div>
          </div>
          <div style={{ background: C.surfaceHigh, borderRadius: 8, padding: "8px 12px" }}>
            <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase" }}>Next 3 months</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{fmtHUF(next3)}</div>
          </div>
          <div style={{ background: C.surfaceHigh, borderRadius: 8, padding: "8px 12px" }}>
            <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase" }}>Cash on hand</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.green }}>{fmtHUF(liquidCapital)}</div>
          </div>
        </div>
      )}

      {items.length > 0 && (
        <div style={{ background: shortfall > 0 ? C.red + "14" : C.green + "14", border: `1px solid ${shortfall > 0 ? C.red : C.green}44`, borderRadius: 8, padding: "9px 13px", fontSize: 12, marginBottom: 12 }}>
          {shortfall > 0
            ? <>⚠ Your cash covers part of your plans — <strong style={{ color: C.red }}>{fmtHUF(shortfall)}</strong> short of the <strong>{fmtHUF(totalPlanned)}</strong> total. Consider funding a savings goal or trimming the timeline.</>
            : <>✓ Your cash on hand covers all planned expenses, with <strong style={{ color: C.green }}>{fmtHUF(-shortfall)}</strong> to spare.</>}
        </div>
      )}

      {items.map(p => {
        const amtHUF = toHUF(parseFloat(p.amount) || 0, p.currency);
        const when = p.date ? new Date(p.date + "T00:00:00") : null;
        const monthsAway = when ? Math.round((when - new Date(today + "T00:00:00")) / (30.44 * 86400000)) : null;
        return (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: `1px solid ${C.border}` }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</span>
                <Tag color={C.muted}>{p.category}</Tag>
              </div>
              <div style={{ fontSize: 11, color: C.muted }}>
                {p.date ? `${p.date}${monthsAway !== null ? ` · ${monthsAway <= 0 ? "due" : `in ~${monthsAway} mo`}` : ""}` : "no date set"}
                {p.notes ? ` · ${p.notes}` : ""}
              </div>
            </div>
            <span style={{ fontSize: 13, fontWeight: 600, color: C.orange, flexShrink: 0 }}>{fmtHUF(amtHUF)}</span>
            {!readonly && (
              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                <button onClick={() => startEdit(p)} title="Edit" style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 12 }}>✎</button>
                <button onClick={() => remove(p.id)} title="Delete" style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 14 }}>×</button>
              </div>
            )}
          </div>
        );
      })}

      {items.length === 0 && !adding && (
        <div style={{ color: C.muted, fontSize: 13, textAlign: "center", padding: "20px 0" }}>
          Nothing planned yet.<br /><span style={{ fontSize: 12 }}>Add an upcoming expense, or tell the chat e.g. "plan a 2M HUF renovation in October".</span>
        </div>
      )}

      {adding && !readonly && F}
    </Card>
  );
}

function CashFlowExpenses({ data, setData, readonly, onImport, onOpenChat, onOpenUpload, viewMonth }) {
  const isMobile = useIsMobile();
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // Uncategorized review — "Uncategorized" = the system couldn't classify; "Other" = confirmed miscellaneous
  const [showOtherReview, setShowOtherReview] = useState(true);
  const otherTxns = data.transactions.filter(t => t.category === "Uncategorized");
  // Same convention applies to cost/bill imports (see buildCostsFromSchema) — surface them too.
  const [showBillReview, setShowBillReview] = useState(true);
  const otherBills = (data.costs || []).filter(c => c.category === "Uncategorized");

  function reclassifyBill(costId, newCat) {
    const bill = (data.costs || []).find(c => c.id === costId);
    const keyword = bill ? (bill.name || "").toLowerCase().split(/[\s,.\-/]+/).find(w => w.length >= 4) : null;
    setData(d => ({
      ...d,
      costs: (d.costs || []).map(c => c.id === costId ? { ...c, category: newCat } : c),
      merchantRules: keyword
        ? [...(d.merchantRules || []).filter(r => r.keyword !== keyword), { keyword, category: newCat }]
        : (d.merchantRules || [])
    }));
  }

  function reclassify(txId, newCat) {
    const tx = data.transactions.find(t => t.id === txId);
    const keyword = tx ? (tx.desc || "").toLowerCase().split(/[\s,.\-/]+/).find(w => w.length >= 4) : null;
    setData(d => ({
      ...d,
      transactions: d.transactions.map(t => t.id === txId ? { ...t, category: newCat } : t),
      merchantRules: keyword
        ? [...(d.merchantRules || []).filter(r => r.keyword !== keyword), { keyword, category: newCat }]
        : (d.merchantRules || [])
    }));
  }

  // Transaction list state
  const [txOpen, setTxOpen] = useState(false);
  const [filterCat, setFilterCat] = useState("All");
  const [filterAmtMin, setFilterAmtMin] = useState("");
  const [filterAmtMax, setFilterAmtMax] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [filterType, setFilterType] = useState("all"); // "all" | "transaction" | "bill"
  const [filterSort, setFilterSort] = useState("date_desc");
  const [adding, setAdding] = useState(false);
  const [addTarget, setAddTarget] = useState("transaction");
  const [txForm, setTxForm] = useState({ date: "", desc: "", amount: "", currency: "HUF", category: "Food", type: "expense", account: "OTP" });
  const [billForm, setBillForm] = useState({ name: "", category: "Housing", amount: "", currency: "HUF", type: "recurring", frequency: "monthly", owner: "Joint", nextDue: "", notes: "" });

  // ── Computed data ──
  // "Transfer" = money moving between the owner's own accounts. Excluded from
  // income/expense totals so the cash-flow figures reflect real money in/out.
  const isFlow = t => t.category !== "Transfer";
  const [showAvg, setShowAvg] = useState(false);

  const allMonths = [...new Set(data.transactions.map(t => t.date?.slice(0, 7)).filter(Boolean))].sort();
  const monthTxns = data.transactions.filter(t => t.date?.startsWith(viewMonth));
  const income = monthTxns.filter(t => t.type === "income" && isFlow(t)).reduce((s, t) => s + toHUF(t.amount, t.currency), 0);
  const expenses = monthTxns.filter(t => t.type === "expense" && isFlow(t)).reduce((s, t) => s + Math.abs(toHUF(t.amount, t.currency)), 0);
  const net = income - expenses;
  const savingsRate = income > 0 ? Math.round((net / income) * 100) : null;

  const monthlySummary = allMonths.map(ym => {
    const txns = data.transactions.filter(t => t.date?.startsWith(ym));
    const inc = txns.filter(t => t.type === "income" && isFlow(t)).reduce((s, t) => s + toHUF(t.amount, t.currency), 0);
    const exp = txns.filter(t => t.type === "expense" && isFlow(t)).reduce((s, t) => s + Math.abs(toHUF(t.amount, t.currency)), 0);
    const [y, m] = ym.split("-").map(Number);
    return { month: new Date(y, m - 1, 1).toLocaleString("en-GB", { month: "short", year: "2-digit" }), income: Math.round(inc), expenses: Math.round(exp) };
  });

  // Averages over months that actually have cash-flow activity (not transfer-only).
  const monthsWithFlow = monthlySummary.filter(m => m.income > 0 || m.expenses > 0);
  const avgN = monthsWithFlow.length || 1;
  const avgIncome = monthsWithFlow.reduce((s, m) => s + m.income, 0) / avgN;
  const avgExpenses = monthsWithFlow.reduce((s, m) => s + m.expenses, 0) / avgN;
  const avgNet = avgIncome - avgExpenses;
  const avgSavingsRate = avgIncome > 0 ? Math.round((avgNet / avgIncome) * 100) : null;

  // What the stat tiles show, depending on the monthly/average toggle.
  const tileIncome = showAvg ? avgIncome : income;
  const tileExpenses = showAvg ? avgExpenses : expenses;
  const tileNet = showAvg ? avgNet : net;
  const tileSavingsRate = showAvg ? avgSavingsRate : savingsRate;
  const tileSuffix = showAvg ? ` · avg of ${monthsWithFlow.length} month${monthsWithFlow.length === 1 ? "" : "s"}` : "";

  const byCategory = allCategories(data).filter(c => c !== "Income" && c !== "Transfer").map(cat => ({
    name: cat,
    value: monthTxns.filter(t => t.category === cat && t.type === "expense").reduce((s, t) => s + Math.abs(toHUF(t.amount, t.currency)), 0)
  })).filter(d => d.value > 0).sort((a, b) => b.value - a.value);

  const cumulativeData = (() => {
    const dayTotals = {};
    monthTxns.filter(isFlow).forEach(t => {
      const day = t.date?.slice(8, 10); if (!day) return;
      const val = t.type === "income" ? toHUF(t.amount, t.currency) : -toHUF(Math.abs(t.amount), t.currency);
      dayTotals[day] = (dayTotals[day] || 0) + val;
    });
    let cum = 0;
    return Object.keys(dayTotals).sort().map(day => {
      cum += dayTotals[day];
      const cn = Math.round(cum);
      const label = new Date(`${viewMonth}-${day}`).toLocaleDateString("en-GB", { month: "short", day: "numeric" });
      return { day: label, cumNet: cn, cumPos: cn >= 0 ? cn : 0, cumNeg: cn < 0 ? cn : 0 };
    });
  })();

  // ── Filtered transaction list ──
  const bills = data.costs || [];
  const filteredItems = (() => {
    let items = [];
    if (filterType === "all" || filterType === "transaction") {
      items = [...items, ...monthTxns.filter(t => t.type === "expense").map(t => ({ ...t, _kind: "transaction" }))];
    }
    if (filterType === "all" || filterType === "bill") {
      items = [...items, ...bills.map(b => ({ id: b.id, date: b.nextDue || viewMonth + "-01", desc: b.name, amount: b.amount, currency: b.currency, category: b.category, type: "expense", _kind: "bill" }))];
    }
    if (filterCat !== "All") items = items.filter(t => t.category === filterCat);
    if (filterAmtMin) items = items.filter(t => toHUF(Math.abs(t.amount), t.currency) >= parseFloat(filterAmtMin));
    if (filterAmtMax) items = items.filter(t => toHUF(Math.abs(t.amount), t.currency) <= parseFloat(filterAmtMax));
    if (filterDateFrom) items = items.filter(t => (t.date || "") >= filterDateFrom);
    if (filterDateTo) items = items.filter(t => (t.date || "") <= filterDateTo);
    if (filterSort === "date_desc") items.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    else if (filterSort === "date_asc") items.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    else if (filterSort === "amt_desc") items.sort((a, b) => toHUF(Math.abs(b.amount), b.currency) - toHUF(Math.abs(a.amount), a.currency));
    else if (filterSort === "amt_asc") items.sort((a, b) => toHUF(Math.abs(a.amount), a.currency) - toHUF(Math.abs(b.amount), b.currency));
    return items;
  })();

  function addTransaction() {
    if (!txForm.date || !txForm.desc || !txForm.amount) return;
    const amt = txForm.type === "expense" ? -Math.abs(parseFloat(txForm.amount)) : Math.abs(parseFloat(txForm.amount));
    setData(d => ({ ...d, transactions: [{ ...txForm, id: Date.now().toString(), amount: amt }, ...d.transactions] }));
    setAdding(false);
  }
  function addBill() {
    if (!billForm.name || !billForm.amount) return;
    setData(d => ({ ...d, costs: [...d.costs, { ...billForm, id: Date.now().toString(), amount: parseFloat(billForm.amount) }] }));
    setAdding(false);
    setBillForm({ name: "", category: "Housing", amount: "", currency: "HUF", type: "recurring", frequency: "monthly", owner: "Joint", nextDue: "", notes: "" });
  }

  const isEmpty = data.transactions.length === 0 && data.costs.length === 0;
  if (isEmpty) return <GettingStarted tab="cashflow" readonly={readonly} onOpenChat={onOpenChat} onOpenUpload={onOpenUpload} />;

  return (
    <div style={{ display: "grid", gap: 16 }}>

      {/* ── Upload ── */}
      <FileUploadCard defaultType="bank_statement" onFileReady={onImport} readonly={readonly} />

      {/* ── Uncategorized review ── */}
      {!readonly && showOtherReview && otherTxns.length > 0 && (
        <Card style={{ borderLeft: `3px solid ${C.orange}`, padding: "12px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
            <div>
              <span style={{ fontWeight: 600, fontSize: 13, color: C.orange }}>⚠ {otherTxns.length} uncategorized transaction{otherTxns.length > 1 ? "s" : ""}</span>
              <span style={{ fontSize: 12, color: C.muted, marginLeft: 8 }}>— the system couldn't classify these</span>
            </div>
            <button onClick={() => setShowOtherReview(false)} style={{ background: "none", border: "none", cursor: "pointer", color: C.muted, fontSize: 16, lineHeight: 1, padding: "0 4px" }}>×</button>
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
            Pick a specific category for each, or use <strong style={{ color: C.text }}>Other</strong> (= miscellaneous) if you don't know a better fit. Rules learned from your choices will be applied automatically next time.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {otherTxns.slice(0, 15).map(t => (
              <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <span style={{ color: C.muted, flexShrink: 0, width: 72 }}>{t.date}</span>
                <span style={{ flex: 1, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.desc}>{t.desc}</span>
                <span style={{ color: t.type === "income" ? C.green : C.red, flexShrink: 0, fontVariantNumeric: "tabular-nums", width: 80, textAlign: "right" }}>{t.type === "income" ? "+" : "−"}{Math.abs(t.amount)?.toLocaleString()} {t.currency}</span>
                <select value="Uncategorized" onChange={e => reclassify(t.id, e.target.value)}
                  style={{ fontSize: 11, padding: "2px 4px", borderRadius: 4, border: `1px solid ${C.border}`, background: C.surface, color: C.text, cursor: "pointer", flexShrink: 0 }}>
                  <option value="Uncategorized" disabled>Categorize…</option>
                  {allCategories(data).filter(c => c !== "Income" && c !== "Uncategorized").map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            ))}
            {otherTxns.length > 15 && <div style={{ fontSize: 11, color: C.muted, textAlign: "center", paddingTop: 4 }}>+ {otherTxns.length - 15} more — use "Browse" below to categorize the rest</div>}
          </div>
          {/* Bulk "leave as Other" action */}
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: C.muted, flex: 1 }}>Don't know a better fit for the rest?</span>
            <button
              onClick={() => {
                setData(d => ({
                  ...d,
                  transactions: d.transactions.map(t => t.category === "Uncategorized" ? { ...t, category: "Other" } : t)
                }));
                setShowOtherReview(false);
              }}
              style={{ fontSize: 11, padding: "5px 14px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surfaceHigh, color: C.text, fontWeight: 600, cursor: "pointer" }}>
              Leave all as Other →
            </button>
          </div>
        </Card>
      )}

      {/* ── Uncategorized bills/costs review (same "Uncategorized" vs "Other" convention) ── */}
      {!readonly && showBillReview && otherBills.length > 0 && (
        <Card style={{ borderLeft: `3px solid ${C.orange}`, padding: "12px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
            <div>
              <span style={{ fontWeight: 600, fontSize: 13, color: C.orange }}>⚠ {otherBills.length} uncategorized cost{otherBills.length > 1 ? "s" : ""}</span>
              <span style={{ fontSize: 12, color: C.muted, marginLeft: 8 }}>— the system couldn't classify these bills</span>
            </div>
            <button onClick={() => setShowBillReview(false)} style={{ background: "none", border: "none", cursor: "pointer", color: C.muted, fontSize: 16, lineHeight: 1, padding: "0 4px" }}>×</button>
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
            Pick a specific category for each, or use <strong style={{ color: C.text }}>Other</strong> (= miscellaneous) if you don't know a better fit. Rules learned from your choices will be applied automatically next time.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {otherBills.slice(0, 15).map(c => (
              <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <span style={{ flex: 1, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.name}>{c.name}</span>
                <span style={{ color: C.red, flexShrink: 0, fontVariantNumeric: "tabular-nums", width: 90, textAlign: "right" }}>−{Math.abs(c.amount)?.toLocaleString()} {c.currency} · {c.frequency}</span>
                <select value="Uncategorized" onChange={e => reclassifyBill(c.id, e.target.value)}
                  style={{ fontSize: 11, padding: "2px 4px", borderRadius: 4, border: `1px solid ${C.border}`, background: C.surface, color: C.text, cursor: "pointer", flexShrink: 0 }}>
                  <option value="Uncategorized" disabled>Categorize…</option>
                  {allCategories(data).filter(cat => cat !== "Income" && cat !== "Uncategorized").map(cat => <option key={cat} value={cat}>{cat}</option>)}
                </select>
              </div>
            ))}
            {otherBills.length > 15 && <div style={{ fontSize: 11, color: C.muted, textAlign: "center", paddingTop: 4 }}>+ {otherBills.length - 15} more — use "Browse" below to categorize the rest</div>}
          </div>
          {/* Bulk "leave as Other" action */}
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: C.muted, flex: 1 }}>Don't know a better fit for the rest?</span>
            <button
              onClick={() => {
                setData(d => ({
                  ...d,
                  costs: (d.costs || []).map(c => c.category === "Uncategorized" ? { ...c, category: "Other" } : c)
                }));
                setShowBillReview(false);
              }}
              style={{ fontSize: 11, padding: "5px 14px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surfaceHigh, color: C.text, fontWeight: 600, cursor: "pointer" }}>
              Leave all as Other →
            </button>
          </div>
        </Card>
      )}

      {/* ── Monthly / average toggle ── */}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, marginTop: -4 }}>
        <span style={{ fontSize: 11, color: C.muted }}>Transfers between your own accounts are excluded.</span>
        <div style={{ display: "flex", background: C.surfaceHigh, borderRadius: 8, padding: 3, gap: 2 }}>
          {[["false", "This month"], ["true", "Monthly average"]].map(([v, lbl]) => (
            <button key={v} onClick={() => setShowAvg(v === "true")}
              style={{ padding: "4px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600,
                background: String(showAvg) === v ? C.accent : "transparent", color: String(showAvg) === v ? "#000" : C.muted }}>
              {lbl}
            </button>
          ))}
        </div>
      </div>

      {/* ── Stat tiles ── */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: 12 }}>
        <Card><Stat label={showAvg ? "Avg income" : "Income"} value={`+${fmtHUF(tileIncome)}`} color={C.green} />{tileSuffix && <div style={{ textAlign: "center", fontSize: 10, color: C.muted, marginTop: 3 }}>{tileSuffix.replace(" · ", "")}</div>}</Card>
        <Card><Stat label={showAvg ? "Avg expenses" : "Expenses"} value={`−${fmtHUF(tileExpenses)}`} color={C.red} /></Card>
        <Card><Stat label={showAvg ? "Avg net" : "Net"} value={`${tileNet >= 0 ? "+" : "−"}${fmtHUF(Math.abs(tileNet))}`} color={tileNet >= 0 ? C.green : C.red} /></Card>
        <Card>
          <Stat label="Savings Rate" value={tileSavingsRate !== null ? `${tileSavingsRate}%` : "—"}
            color={tileSavingsRate === null ? C.muted : tileSavingsRate >= 20 ? C.green : tileSavingsRate > 0 ? C.orange : C.red} />
          {tileSavingsRate !== null && <div style={{ textAlign: "center", fontSize: 10, color: C.muted, marginTop: 3 }}>of income saved</div>}
        </Card>
      </div>

      {/* ── Spending pace bar ── */}
      {(() => {
        const totalBudget = (data.budgetTargets || []).reduce((s, bt) => s + toHUF(bt.monthlyLimit, bt.currency || "HUF"), 0);
        if (totalBudget <= 0) return null;
        const now2 = new Date();
        const daysInMonth2 = new Date(now2.getFullYear(), now2.getMonth() + 1, 0).getDate();
        const dayOfMonth2 = viewMonth === `${now2.getFullYear()}-${String(now2.getMonth() + 1).padStart(2, "0")}` ? now2.getDate() : daysInMonth2;
        const monthFrac = dayOfMonth2 / daysInMonth2;
        const expectedSpend = Math.round(totalBudget * monthFrac);
        const pacePct = Math.round((expenses / totalBudget) * 100);
        const isOverPace = expenses > expectedSpend;
        const [_vy2, _vm2] = viewMonth.split("-").map(Number);
        const viewMonthLabel2 = new Date(_vy2, _vm2 - 1, 1).toLocaleString("en-GB", { month: "long", year: "numeric" });
        return (
          <Card style={{ padding: "12px 16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Spending pace — {viewMonthLabel2}</div>
              <div style={{ fontSize: 11, color: C.muted }}>Day {dayOfMonth2} of {daysInMonth2}</div>
            </div>
            <div style={{ position: "relative", height: 10, background: C.surfaceHigh, borderRadius: 6, overflow: "visible", marginBottom: 6 }}>
              <div style={{ height: "100%", width: `${Math.min(pacePct, 100)}%`, background: pacePct > 100 ? C.red : pacePct > 90 ? C.orange : pacePct > 70 ? C.accent : C.green, borderRadius: 6 }} />
              <div style={{ position: "absolute", top: -3, bottom: -3, left: `${Math.min(Math.round(monthFrac * 100), 100)}%`, width: 2, background: C.muted, borderRadius: 1 }} title="On-pace target for today" />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, flexWrap: "wrap", gap: 4 }}>
              <span>Spent: <strong style={{ color: isOverPace ? C.red : C.text }}>{fmtHUF(expenses)}</strong></span>
              <span>On-pace target: {fmtHUF(expectedSpend)}</span>
              <span>Monthly budget: {fmtHUF(totalBudget)}</span>
            </div>
          </Card>
        );
      })()}

      {/* ── Planned / upcoming expenses ── */}
      <PlannedExpenses data={data} setData={setData} readonly={readonly} />

      {/* ── Monthly overview (all months) ── */}
      {monthlySummary.length > 1 && (
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>Monthly Overview</div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>Income vs expenses across all months</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={monthlySummary} barGap={2}>
              <XAxis dataKey="month" tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `${Math.round(v / 1000)}k`} width={40} />
              <Tooltip formatter={v => fmtHUF(v)} contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12, color: C.muted }} />
              <Bar dataKey="income" name="Income" fill={C.green} radius={[3, 3, 0, 0]} />
              <Bar dataKey="expenses" name="Expenses" fill={C.red} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* ── Cumulative cashflow — tap to see value ── */}
      {cumulativeData.length > 1 && (
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>Cumulative Cashflow</div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>
            Running net through {new Date(viewMonth + "-01").toLocaleString("en-GB", { month: "long" })} — tap any point to see the value
          </div>
          <ResponsiveContainer width="100%" height={165}>
            <ComposedChart data={cumulativeData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="gradPos" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={C.green} stopOpacity={0.5} /><stop offset="95%" stopColor={C.green} stopOpacity={0.05} />
                </linearGradient>
                <linearGradient id="gradNeg" x1="0" y1="1" x2="0" y2="0">
                  <stop offset="5%" stopColor={C.red} stopOpacity={0.5} /><stop offset="95%" stopColor={C.red} stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <XAxis dataKey="day" tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `${Math.round(v / 1000)}k`} width={40} />
              <Tooltip formatter={(v, name) => name === "Net" ? [fmtHUF(v), "Cumulative net"] : null}
                contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }} />
              <ReferenceLine y={0} stroke={C.border} strokeWidth={1} strokeDasharray="4 4" />
              <Area type="monotone" dataKey="cumPos" stroke="none" fill="url(#gradPos)" dot={false} legendType="none" />
              <Area type="monotone" dataKey="cumNeg" stroke="none" fill="url(#gradNeg)" dot={false} legendType="none" />
              <Line type="monotone" dataKey="cumNet" name="Net" stroke={C.text} strokeWidth={2} dot={{ r: 3, fill: C.text, strokeWidth: 0 }} activeDot={{ r: 5, fill: C.accent }} />
            </ComposedChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* ── Expense breakdown — tap bar to filter ── */}
      {byCategory.length > 0 && (
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontWeight: 600 }}>Expense Breakdown</div>
            {filterCat !== "All" && (
              <button onClick={() => setFilterCat("All")} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.surfaceHigh, color: C.muted, cursor: "pointer" }}>
                Clear filter ×
              </button>
            )}
          </div>
          <ResponsiveContainer width="100%" height={Math.max(140, byCategory.length * 34)}>
            <BarChart data={byCategory} layout="vertical" margin={{ left: 0, right: 72 }}>
              <XAxis type="number" tick={false} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" tick={{ fill: C.text, fontSize: 11 }} width={96} axisLine={false} tickLine={false} interval={0} />
              <Tooltip formatter={v => [fmtHUF(v), "Spent"]} contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }} labelStyle={{ color: C.text, fontWeight: 600 }} itemStyle={{ color: C.text }} cursor={{ fill: C.surfaceHigh }} />
              <Bar dataKey="value" radius={[0, 4, 4, 0]} style={{ cursor: "pointer" }}
                onClick={(entry) => { setFilterCat(entry.name); setTxOpen(true); setFilterType("transaction"); }}>
                {byCategory.map((entry, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]}
                    opacity={filterCat === "All" || filterCat === entry.name ? 1 : 0.35} />
                ))}
                <LabelList dataKey="value" position="right" formatter={v => v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v))} style={{ fill: C.text, fontSize: 11, fontWeight: 600 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 6, textAlign: "right" }}>Tap a bar to filter the list below ↓</div>
        </Card>
      )}

      {/* ── Latest 5 transactions (pinned) ── */}
      {(() => {
        const latest = [...data.transactions].sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 5);
        if (latest.length === 0) return null;
        const CAT_ICONS2 = { Housing: "🏠", Food: "🛒", Transport: "🚗", Utilities: "⚡", Health: "💊", Entertainment: "🎬", Clothing: "👔", Education: "📚", Savings: "🏦", Other: "📦", Income: "💵", Garden: "🌿" };
        return (
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Latest transactions</div>
              <button onClick={() => setTxOpen(true)} style={{ background: "none", border: "none", color: C.accent, fontSize: 12, cursor: "pointer" }}>Browse all →</button>
            </div>
            {latest.map((t, i) => (
              <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: i < latest.length - 1 ? `1px solid ${C.border}` : "none" }}>
                <span style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", background: t.type === "income" ? C.green + "20" : C.red + "15", borderRadius: 7, fontSize: 14, flexShrink: 0 }}>
                  {CAT_ICONS2[t.category] || "📦"}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.desc}</div>
                  <div style={{ fontSize: 10, color: C.muted }}>{t.date} · {t.category}</div>
                </div>
                <div style={{ fontWeight: 600, flexShrink: 0, fontSize: 12, color: t.type === "income" ? C.green : C.red }}>
                  {t.type === "income" ? "+" : "−"}{fmtHUF(toHUF(Math.abs(t.amount), t.currency))}
                </div>
              </div>
            ))}
          </Card>
        );
      })()}

      {/* ── Browse transactions & costs ── */}
      <Card style={{ padding: 0, overflow: "hidden", border: `1px solid ${txOpen ? C.accent + "55" : C.border}` }}>
        <button onClick={() => setTxOpen(o => !o)}
          style={{ width: "100%", padding: "16px 20px", display: "flex", alignItems: "center", gap: 12, background: txOpen ? C.accent + "0d" : "transparent", border: "none", cursor: "pointer", textAlign: "left", transition: "background 0.2s" }}>
          <span style={{ fontSize: 18, lineHeight: 1 }}>📋</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>Transactions & Costs</div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
              {monthTxns.filter(t => t.type === "expense").length} transactions · {bills.length} bills
              {filterCat !== "All" && <span style={{ color: C.accent }}> · filtered: {filterCat}</span>}
            </div>
          </div>
          <span style={{ color: txOpen ? C.accent : C.muted, fontSize: 20, fontWeight: 700, transform: txOpen ? "rotate(90deg)" : "none", transition: "transform 0.2s, color 0.2s", display: "inline-block" }}>›</span>
        </button>

        {txOpen && (
          <div style={{ borderTop: `1px solid ${C.border}`, padding: "16px 20px 20px" }}>
            {/* ── Filters ── */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14, alignItems: "center" }}>
              {/* Type toggle */}
              <div style={{ display: "flex", background: C.bg, borderRadius: 8, padding: 3, gap: 2, flexShrink: 0 }}>
                {[["all","All"],["transaction","Transactions"],["bill","Bills"]].map(([v, label]) => (
                  <button key={v} onClick={() => setFilterType(v)}
                    style={{ padding: "4px 10px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600, background: filterType === v ? C.accent : "transparent", color: filterType === v ? "#000" : C.muted }}>
                    {label}
                  </button>
                ))}
              </div>
              {/* Category */}
              <select value={filterCat} onChange={e => setFilterCat(e.target.value)}
                style={{ fontSize: 11, padding: "5px 8px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface, color: C.text, cursor: "pointer" }}>
                <option value="All">All categories</option>
                {allCategories(data).map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              {/* Date range */}
              <input value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)} placeholder="From"
                style={{ fontSize: 11, padding: "5px 8px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface, color: C.text, width: isMobile ? 108 : 118 }} type="date" title="From date" />
              <input value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)} placeholder="To"
                style={{ fontSize: 11, padding: "5px 8px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface, color: C.text, width: isMobile ? 108 : 118 }} type="date" title="To date" />
              {/* Amount range */}
              <input value={filterAmtMin} onChange={e => setFilterAmtMin(e.target.value)} placeholder="Min Ft"
                style={{ width: 72, fontSize: 11, padding: "5px 8px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface, color: C.text }} type="number" />
              <input value={filterAmtMax} onChange={e => setFilterAmtMax(e.target.value)} placeholder="Max Ft"
                style={{ width: 72, fontSize: 11, padding: "5px 8px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface, color: C.text }} type="number" />
              {/* Sort */}
              <select value={filterSort} onChange={e => setFilterSort(e.target.value)}
                style={{ fontSize: 11, padding: "5px 8px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface, color: C.text, cursor: "pointer" }}>
                <option value="date_desc">Date ↓</option>
                <option value="date_asc">Date ↑</option>
                <option value="amt_desc">Amount ↓</option>
                <option value="amt_asc">Amount ↑</option>
              </select>
              {/* Clear */}
              {(filterCat !== "All" || filterAmtMin || filterAmtMax || filterType !== "all" || filterDateFrom || filterDateTo) && (
                <button onClick={() => { setFilterCat("All"); setFilterAmtMin(""); setFilterAmtMax(""); setFilterType("all"); setFilterDateFrom(""); setFilterDateTo(""); }}
                  style={{ fontSize: 11, padding: "5px 10px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surfaceHigh, color: C.muted, cursor: "pointer" }}>
                  Clear ×
                </button>
              )}
              {/* Add */}
              {!readonly && (
                <button onClick={() => setAdding(a => !a)}
                  style={{ fontSize: 11, padding: "5px 14px", borderRadius: 8, border: "none", background: C.accent, color: "#000", fontWeight: 600, cursor: "pointer", marginLeft: "auto" }}>
                  {adding ? "Cancel" : "+ Add"}
                </button>
              )}
            </div>

            {/* ── Add form ── */}
            {adding && !readonly && (
              <div style={{ background: C.surfaceHigh, borderRadius: 10, padding: 14, marginBottom: 14 }}>
                <div style={{ display: "flex", gap: 4, marginBottom: 12, background: C.bg, borderRadius: 8, padding: 3, width: "fit-content" }}>
                  {[["transaction","Transaction"],["bill","Bill / Recurring"]].map(([v, lbl]) => (
                    <button key={v} onClick={() => setAddTarget(v)}
                      style={{ padding: "4px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600, background: addTarget === v ? C.accent : "transparent", color: addTarget === v ? "#000" : C.muted }}>
                      {lbl}
                    </button>
                  ))}
                </div>
                {addTarget === "transaction" ? (
                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: 8 }}>
                    <Inp value={txForm.date} onChange={v => setTxForm(f => ({ ...f, date: v }))} placeholder="Date" type="date" />
                    <Inp value={txForm.desc} onChange={v => setTxForm(f => ({ ...f, desc: v }))} placeholder="Description" />
                    <Inp value={txForm.amount} onChange={v => setTxForm(f => ({ ...f, amount: v }))} placeholder="Amount" type="number" />
                    <Sel value={txForm.currency} onChange={v => setTxForm(f => ({ ...f, currency: v }))} options={["HUF","EUR","USD"]} />
                    <Sel value={txForm.category} onChange={v => setTxForm(f => ({ ...f, category: v }))} options={allCategories(data)} />
                    <Sel value={txForm.type} onChange={v => setTxForm(f => ({ ...f, type: v }))} options={["expense","income"]} />
                    <Inp value={txForm.account} onChange={v => setTxForm(f => ({ ...f, account: v }))} placeholder="Account" />
                    <Btn onClick={addTransaction} style={{ gridColumn: isMobile ? "span 2" : "span 4" }}>Save transaction</Btn>
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: 8 }}>
                    <Inp value={billForm.name} onChange={v => setBillForm(f => ({ ...f, name: v }))} placeholder="Name" />
                    <Sel value={billForm.category} onChange={v => setBillForm(f => ({ ...f, category: v }))} options={allCategories(data)} />
                    <Inp value={billForm.amount} onChange={v => setBillForm(f => ({ ...f, amount: v }))} placeholder="Amount" type="number" />
                    <Sel value={billForm.currency} onChange={v => setBillForm(f => ({ ...f, currency: v }))} options={["HUF","EUR","USD"]} />
                    <Sel value={billForm.type} onChange={v => setBillForm(f => ({ ...f, type: v }))} options={["recurring","onetime"]} />
                    <Sel value={billForm.frequency} onChange={v => setBillForm(f => ({ ...f, frequency: v }))} options={["monthly","quarterly","annual"]} />
                    <Sel value={billForm.owner} onChange={v => setBillForm(f => ({ ...f, owner: v }))} options={["Joint","You","Wife"]} />
                    <Inp value={billForm.nextDue} onChange={v => setBillForm(f => ({ ...f, nextDue: v }))} placeholder="Next due" type="date" />
                    <Btn onClick={addBill} style={{ gridColumn: isMobile ? "span 2" : "span 4" }}>Save bill</Btn>
                  </div>
                )}
              </div>
            )}

            {/* ── Filtered list ── */}
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>
              Showing {filteredItems.length} of {monthTxns.filter(t => t.type === "expense").length + bills.length} items
            </div>
            {filteredItems.length === 0 && (
              <div style={{ color: C.muted, fontSize: 13, textAlign: "center", padding: "20px 0" }}>No items match your filters.</div>
            )}
            {filteredItems.map(item => {
              if (item._kind === "bill") {
                const b = data.costs.find(c => c.id === item.id);
                if (!b) return null;
                return (
                  <div key={b.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flex: 1, minWidth: 0, flexWrap: "wrap" }}>
                      <select value={b.category} disabled={readonly}
                        onChange={e => setData(d => ({ ...d, costs: d.costs.map(x => x.id === b.id ? { ...x, category: e.target.value } : x) }))}
                        style={{ background: C.blue + "22", color: C.blue, border: "none", borderRadius: 6, padding: "2px 6px", fontSize: 11, fontWeight: 600, cursor: readonly ? "default" : "pointer", outline: "none", flexShrink: 0 }}>
                        {allCategories(data).map(cat => <option key={cat} value={cat}>{cat}</option>)}
                      </select>
                      <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
                      <span style={{ fontSize: 11, color: C.muted, flexShrink: 0 }}>{b.frequency}</span>
                      {!readonly && (
                        <button onClick={() => setData(d => ({ ...d, costs: d.costs.map(x => x.id === b.id ? { ...x, type: x.type === "recurring" ? "onetime" : "recurring" } : x) }))}
                          style={{ fontSize: 10, padding: "2px 8px", borderRadius: 5, border: `1px solid ${C.border}`, background: b.type === "recurring" ? C.blue + "22" : C.surfaceHigh, color: b.type === "recurring" ? C.blue : C.muted, cursor: "pointer", flexShrink: 0, fontWeight: 600 }}>
                          {b.type === "recurring" ? "↺ Recurring" : "① One-time"}
                        </button>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                      <span style={{ color: C.red, fontWeight: 600 }}>−{fmtHUF(toHUF(b.amount, b.currency))}</span>
                      {!readonly && <Btn variant="danger" onClick={() => setData(d => ({ ...d, costs: d.costs.filter(x => x.id !== b.id) }))} style={{ padding: "4px 10px" }}>×</Btn>}
                    </div>
                  </div>
                );
              }
              return <EditableTxnRow key={item.id} t={item} readonly={readonly} setData={setData} data={data} />;
            })}
          </div>
        )}
      </Card>

      {/* ── Savings Goals ── */}
      <SavingsGoals data={data} setData={setData} readonly={readonly} />

      {/* ── Budget Targets ── */}
      <BudgetSection data={data} setData={setData} readonly={readonly} viewMonth={viewMonth} isAvg={false} allMonths={allMonths} />

      {!readonly && <ManageCategories data={data} setData={setData} />}
    </div>
  );
}

// ─── Error Boundary ───────────────────────────────────────────────────────────
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: "100vh", background: "#0f0f11", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 40, fontFamily: "'DM Sans', sans-serif", color: "#e8e8f0" }}>
          <div style={{ fontSize: 40, marginBottom: 20 }}>⚠</div>
          <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 8, color: "#f05a5a" }}>Something went wrong</div>
          <div style={{ fontSize: 13, color: "#a0a0b8", marginBottom: 24, maxWidth: 480, textAlign: "center", lineHeight: 1.6 }}>
            {this.state.error?.message || "An unexpected error occurred."}
          </div>
          <button onClick={() => window.location.reload()} style={{ background: "#e8c547", border: "none", borderRadius: 8, padding: "10px 24px", fontSize: 14, fontWeight: 700, color: "#000", cursor: "pointer" }}>
            Reload
          </button>
          <details style={{ marginTop: 20, fontSize: 11, color: "#6b6b7e", maxWidth: 600 }}>
            <summary style={{ cursor: "pointer" }}>Technical details</summary>
            <pre style={{ marginTop: 8, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{this.state.error?.stack}</pre>
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── App Shell ────────────────────────────────────────────────────────────────
function AppInner() {
  const [session, setSession] = useState(null);
  const [isDemo, setIsDemo] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [tab, setTab] = useState("dashboard");
  const [chatOpen, setChatOpen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [sweepOpen, setSweepOpen] = useState(false);
  const [sweepDismissed, setSweepDismissed] = useState(false);
  const [pendingImport, setPendingImport] = useState(null);
  const [pendingChatMessage, setPendingChatMessage] = useState(null);
  const [pendingFileOpen, setPendingFileOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(true);
  const [showPrivacyPolicy, setShowPrivacyPolicy] = useState(false);
  const [showAccountSettings, setShowAccountSettings] = useState(false);
  Object.assign(C, darkMode ? DARK_C : LIGHT_C);

  // Live FX rates (ECB via frankfurter.app) — fetched once per day, cached.
  const [fxRates, setFxRates] = useState(() => {
    try { return JSON.parse(localStorage.getItem("pfa_fx_v1") || "null"); } catch { return null; }
  });
  useEffect(() => { fetchFXRates().then(r => { if (r) setFxRates(r); }); }, []);
  if (fxRates && fxRates.EUR && fxRates.USD) { RATES.EUR = fxRates.EUR; RATES.USD = fxRates.USD; }

  // Display currency — persisted locally (instant) and to the household record (cross-device).
  const [displayCurOverride, setDisplayCurOverride] = useState(() => {
    try { return localStorage.getItem("pfa_disp_cur"); } catch { return null; }
  });

  // Global month picker
  const _now = new Date();
  const _thisMonth = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, "0")}`;
  const [viewMonth, setViewMonth] = useState(_thisMonth);
  const [_vy, _vm] = viewMonth.split("-").map(Number);
  const viewMonthLabel = new Date(_vy, _vm - 1, 1).toLocaleString("en-GB", { month: "short", year: "numeric" });
  function shiftViewMonth(delta) {
    const d = new Date(_vy, _vm - 1 + delta, 1);
    const nm = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (nm <= _thisMonth) setViewMonth(nm);
  }

  function handleImport(file, fileType) {
    setPendingImport({ ...file, fileType });
    setChatOpen(true);
  }
  function handleOpenChat(message) {
    if (message) setPendingChatMessage(message);
    setChatOpen(true);
  }
  function handleOpenUpload() {
    setPendingFileOpen(true);
    setChatOpen(true);
  }

  const [data, setDataRaw] = useState(EMPTY_DATA);
  const [householdId, setHouseholdId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => { setSession(session); setAuthReady(true); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!authReady) return;
    if (isDemo) {
      setHouseholdId(DEMO_ID);
      setDataRaw(normalizeData(DEMO_DATA));
      setConsentGiven(true);
    } else if (session?.user) {
      try {
        const stored = localStorage.getItem(`${GDPR_CONSENT_KEY}_${session.user.id}`);
        setConsentGiven(!!stored);
      } catch (e) { setConsentGiven(true); }
      loadOrCreateHousehold(session.user.id);
    }
  }, [session, isDemo, authReady]);

  const [consentGiven, setConsentGiven] = useState(false);

  async function deleteAccount() {
    if (!session?.user) return;
    await supabase.from("households").delete().eq("user_id", session.user.id);
    await signOut();
  }
  function exportData() {
    const payload = { exported_at: new Date().toISOString(), version: "1.0", data };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `pfa_export_${todayStr()}.json`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  async function loadOrCreateHousehold(userId) {
    let { data: row, error } = await supabase.from("households").select("id, data").eq("user_id", userId).single();
    if (error && error.code !== "PGRST116") { setLoadError("Could not load your data — check your connection and try refreshing."); return; }
    if (!row) {
      const { data: newRow, error: insertErr } = await supabase.from("households").insert({ user_id: userId, data: EMPTY_DATA }).select().single();
      if (insertErr) { setLoadError("Could not create your account — please try again."); return; }
      row = newRow;
    }
    if (row) { setHouseholdId(row.id); setDataRaw(normalizeData(row.data)); }
  }

  useEffect(() => {
    if (!householdId || isDemo) return;
    setSaving(true);
    setSaveError(false);
    const t = setTimeout(async () => {
      const { error } = await supabase.from("households").update({ data, updated_at: new Date().toISOString() }).eq("id", householdId);
      if (error) { console.error("Save failed:", error); setSaveError(true); }
      setSaving(false);
    }, 1000);
    return () => clearTimeout(t);
  }, [data]);

  function setData(updater) { if (isDemo) return; setDataRaw(updater); }
  async function signOut() { await supabase.auth.signOut(); setIsDemo(false); setDataRaw(EMPTY_DATA); setHouseholdId(null); }

  // Resolve + apply the display currency for this render (used by fmtHUF everywhere).
  const displayCur = displayCurOverride || data.displayCurrency || "HUF";
  DISPLAY.cur = displayCur;
  function changeDisplayCur(c) {
    setDisplayCurOverride(c);
    try { localStorage.setItem("pfa_disp_cur", c); } catch {}
    if (!isDemo) setData(d => ({ ...d, displayCurrency: c }));
  }

  useEffect(() => {
    if (!householdId || isDemo) return;
    maybeSnapshotNW(data, setData);
  }, [householdId]);

  const isMobile = useIsMobile();

  if (!authReady) return <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted }}>Loading…</div>;
  if (!session && !isDemo) return <Auth onLogin={() => setIsDemo(true)} />;

  if (session?.user && !consentGiven) {
    return <GDPRConsentGate userId={session.user.id} onAccept={() => setConsentGiven(true)} />;
  }

  const uncategorizedCount = (data.transactions || []).filter(t => t.category === "Uncategorized").length
    + (data.costs || []).filter(c => c.category === "Uncategorized").length;
  const tabs = [
    { id: "dashboard", label: "Dashboard",         icon: "🏠" },
    { id: "expenses",  label: "Cash flow",         icon: "💸", badge: uncategorizedCount > 0 ? uncategorizedCount : null },
    { id: "wealth",    label: "Wealth",             icon: "📈" },
  ];
  const readonly = isDemo;

  const sweepThisMonth = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  })();
  const sweepMonthLabel = (() => {
    const [sy, sm] = sweepThisMonth.split("-").map(Number);
    return new Date(sy, sm - 1, 1).toLocaleString("en-GB", { month: "long" });
  })();
  const hasTransactionsThisMonth = (data.transactions || []).some(t => t.date?.startsWith(sweepThisMonth));
  const hasRecurringCosts = (data.costs || []).some(c => c.type === "recurring");
  const showSweepBanner = !readonly && householdId && hasRecurringCosts && !hasTransactionsThisMonth && !sweepDismissed && !sweepOpen;

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'DM Sans', sans-serif", colorScheme: darkMode ? "dark" : "light" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono&display=swap" rel="stylesheet" />

      {/* ── Header ── */}
      <header style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: isMobile ? "0 12px" : "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56, position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 18, color: C.accent }}>✦ PFA</div>
          {/* Global month picker */}
          <div style={{ display: "flex", alignItems: "center", gap: 2, background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 8, padding: "3px 6px" }}>
            <button onClick={() => shiftViewMonth(-1)} style={{ background: "none", border: "none", cursor: "pointer", color: C.muted, fontSize: 15, lineHeight: 1, padding: "0 3px" }}>‹</button>
            <span style={{ fontSize: 12, fontWeight: 600, color: C.text, whiteSpace: "nowrap", minWidth: isMobile ? 58 : 78, textAlign: "center" }}>{viewMonthLabel}</span>
            <button onClick={() => shiftViewMonth(1)} disabled={viewMonth >= _thisMonth}
              style={{ background: "none", border: "none", cursor: viewMonth >= _thisMonth ? "default" : "pointer", color: viewMonth >= _thisMonth ? C.border : C.muted, fontSize: 15, lineHeight: 1, padding: "0 3px" }}>›</button>
          </div>
        </div>

        {/* Desktop nav tabs */}
        {!isMobile && (
          <nav style={{ display: "flex", gap: 4 }}>
            {tabs.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                style={{ padding: "6px 16px", borderRadius: 8, border: "none", cursor: "pointer", fontWeight: 600, fontSize: 13, background: tab === t.id ? C.accent : "transparent", color: tab === t.id ? "#000" : C.muted, position: "relative" }}>
                {t.label}
                {t.badge && (
                  <span style={{ position: "absolute", top: 0, right: 2, background: C.orange, color: "#000", fontSize: 9, fontWeight: 800, borderRadius: 8, padding: "1px 5px", lineHeight: 1.4 }}>{t.badge}</span>
                )}
              </button>
            ))}
          </nav>
        )}

        <div style={{ display: "flex", gap: isMobile ? 6 : 10, alignItems: "center" }}>
          {saving && !isMobile && <span style={{ fontSize: 11, color: C.muted }}>Saving…</span>}
          {saveError && <span style={{ fontSize: 11, color: C.red, cursor: "pointer" }} onClick={() => setSaveError(false)} title="Data may not have saved — check your connection">⚠{isMobile ? "" : " Save failed"}</span>}
          {!isMobile && (
            <button onClick={() => setShowPrivacyPolicy(true)}
              style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 11, padding: "0 2px", textDecoration: "underline" }}>
              Privacy
            </button>
          )}
          {!readonly && (
            <button onClick={() => setShowAccountSettings(true)} title="Account & Privacy Settings"
              style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontSize: 14, color: C.muted, lineHeight: 1 }}>
              ⚙
            </button>
          )}
          <select value={displayCur} onChange={e => changeDisplayCur(e.target.value)}
            title={`Display currency${fxRates ? ` · EUR ${Math.round(RATES.EUR)} / USD ${Math.round(RATES.USD)} Ft` : " · using fallback rates"}`}
            style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 8, padding: "5px 8px", cursor: "pointer", fontSize: 12, color: C.text, lineHeight: 1, fontWeight: 600, outline: "none" }}>
            {["HUF", "EUR", "USD"].map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <button onClick={() => setDarkMode(d => !d)} title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
            style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontSize: 14, color: C.muted, lineHeight: 1 }}>
            {darkMode ? "☀" : "🌙"}
          </button>
          {isDemo
            ? <Btn variant="ghost" onClick={() => setIsDemo(false)} style={{ fontSize: 12 }}>{isMobile ? "Login" : "← Sign in"}</Btn>
            : <Btn variant="ghost" onClick={signOut} style={{ fontSize: 12 }}>{isMobile ? "Out" : "Sign out"}</Btn>}
          {readonly && !isMobile && <Tag color={C.orange}>Demo</Tag>}
        </div>
      </header>

      {/* ── Modals ── */}
      {showPrivacyPolicy && <PrivacyPolicyModal onClose={() => setShowPrivacyPolicy(false)} />}
      {showAccountSettings && !readonly && (
        <AccountSettingsModal onClose={() => setShowAccountSettings(false)} onExport={exportData} onDeleteRequest={deleteAccount} userEmail={session?.user?.email} onShowPrivacy={() => { setShowAccountSettings(false); setShowPrivacyPolicy(true); }} />
      )}

      {/* ── Load error banner ── */}
      {loadError && (
        <div style={{ background: C.red + "18", borderBottom: `1px solid ${C.red}44`, padding: "10px 24px", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: C.red, fontSize: 16 }}>⚠</span>
          <span style={{ fontSize: 13, color: C.red, flex: 1 }}>{loadError}</span>
          <button onClick={() => setLoadError(null)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 16 }}>×</button>
        </div>
      )}

      {/* ── Monthly Sweep banner ── */}
      {showSweepBanner && (
        <div style={{ background: C.accent + "18", borderBottom: `1px solid ${C.accent}44`, padding: "10px 24px", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 16 }}>📅</span>
          <span style={{ fontSize: 13, color: C.text, flex: 1 }}>
            No transactions logged yet for <strong>{sweepMonthLabel}</strong> — run your monthly check-in to confirm recurring costs.
          </span>
          <Btn onClick={() => setSweepOpen(true)} style={{ fontSize: 12, padding: "5px 14px", flexShrink: 0 }}>Start check-in</Btn>
          <button onClick={() => setSweepDismissed(true)}
            style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "0 4px", flexShrink: 0 }}>×</button>
        </div>
      )}

      {sweepOpen && !readonly && (
        <MonthlySweep data={data} setData={setData} onClose={() => setSweepOpen(false)} thisMonth={sweepThisMonth} />
      )}

      {/* ── Main content ── */}
      <main style={{ padding: isMobile ? "16px 12px" : "24px clamp(16px, 2vw, 32px)", maxWidth: "min(2400px, 98vw)", margin: "0 auto", width: "100%", boxSizing: "border-box", paddingBottom: isMobile ? 80 : undefined }}>
        {tab === "dashboard" && <Dashboard data={data} setTab={setTab} viewMonth={viewMonth} onOpenChat={handleOpenChat} />}
        {tab === "expenses" && <CashFlowExpenses data={data} setData={setData} readonly={readonly} onImport={handleImport} onOpenChat={handleOpenChat} onOpenUpload={handleOpenUpload} viewMonth={viewMonth} />}
        {tab === "wealth" && <Wealth data={data} setData={setData} readonly={readonly} onImport={handleImport} onOpenChat={handleOpenChat} onOpenUpload={handleOpenUpload} />}
      </main>

      {/* ── Bottom tab bar (mobile) ── */}
      {isMobile && (
        <nav style={{ position: "fixed", bottom: 0, left: 0, right: 0, height: 64, background: C.surface, borderTop: `1px solid ${C.border}`, display: "flex", alignItems: "center", zIndex: 60 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, background: "none", border: "none", cursor: "pointer", padding: "8px 0", color: tab === t.id ? C.accent : C.muted, position: "relative" }}>
              <span style={{ fontSize: 18, lineHeight: 1 }}>{t.icon}</span>
              {t.badge && (
                <span style={{ position: "absolute", top: 6, left: "50%", marginLeft: 4, background: C.orange, color: "#000", fontSize: 8, fontWeight: 800, borderRadius: 6, padding: "1px 4px", lineHeight: 1.4 }}>{t.badge}</span>
              )}
              <span style={{ fontSize: 10, fontWeight: tab === t.id ? 700 : 400 }}>{t.label}</span>
              {tab === t.id && <div style={{ width: 20, height: 2, background: C.accent, borderRadius: 1, marginTop: 1 }} />}
            </button>
          ))}
        </nav>
      )}

      {/* ── Quick Add FAB ── */}
      {!readonly && (
        <button onClick={() => setQuickAddOpen(true)} title="Quick Add"
          style={{ position: "fixed", bottom: isMobile ? 72 : 28, left: 28, width: 52, height: 52, borderRadius: "50%", background: C.surfaceHigh, border: `1.5px solid ${C.border}`, cursor: "pointer", fontSize: 22, color: C.text, fontWeight: 700, boxShadow: "0 4px 20px rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
      )}
      {quickAddOpen && !readonly && (
        <QuickAdd setData={setData} onClose={() => setQuickAddOpen(false)} isMobile={isMobile} />
      )}

      <AIChat data={data} setData={setData} open={chatOpen} setOpen={setChatOpen} readonly={readonly} pendingImport={pendingImport} clearPendingImport={() => setPendingImport(null)} isMobile={isMobile} initialMessage={pendingChatMessage} clearInitialMessage={() => setPendingChatMessage(null)} triggerFileOpen={pendingFileOpen} clearTriggerFileOpen={() => setPendingFileOpen(false)} onShowPrivacy={() => setShowPrivacyPolicy(true)} />

      {/* ── GDPR: Consent gate — shown once per user on first login ── */}
      {!isDemo && session?.user && !consentGiven && (
        <GDPRConsentGate userId={session.user.id} onAccept={() => setConsentGiven(true)} />
      )}
      {/* ── GDPR: Privacy Policy modal ── */}
      {showPrivacyPolicy && <PrivacyPolicyModal onClose={() => setShowPrivacyPolicy(false)} />}
      {/* ── GDPR: Account settings (export + delete) ── */}
      {showAccountSettings && !readonly && (
        <AccountSettingsModal
          onClose={() => setShowAccountSettings(false)}
          onExport={exportData}
          onDeleteRequest={deleteAccount}
          userEmail={session?.user?.email}
          onShowPrivacy={() => setShowPrivacyPolicy(true)}
        />
      )}
    </div>
  );
}

export default function App() {
  return <ErrorBoundary><AppInner /></ErrorBoundary>;
}
