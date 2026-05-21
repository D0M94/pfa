import { useState, useEffect, useRef, Component } from "react";
import { createClient } from "@supabase/supabase-js";
import {
  BarChart, Bar, PieChart, Pie, Cell,
  AreaChart, Area,
  ComposedChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, ReferenceLine
} from "recharts";

// ─── Supabase ─────────────────────────────────────────────────────────────────
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);
const DEMO_ID = import.meta.env.VITE_DEMO_HOUSEHOLD_ID;

// ─── Constants ────────────────────────────────────────────────────────────────
const EUR_HUF = 358;
const USD_HUF = 310;

const DARK_C = {
  bg: "#0f0f11", surface: "#18181c", surfaceHigh: "#222228", border: "#2a2a32",
  accent: "#e8c547", red: "#f05a5a", green: "#4fc98a", blue: "#5a9cf0",
  purple: "#a07cf0", orange: "#f09a5a", muted: "#6b6b7e", text: "#e8e8f0", textSoft: "#a0a0b8",
};
const LIGHT_C = {
  bg: "#f2f3f7", surface: "#ffffff", surfaceHigh: "#e8eaf2", border: "#d0d4e8",
  accent: "#b8950a", red: "#c93030", green: "#2a8a55", blue: "#2a5cb5",
  purple: "#6030b0", orange: "#c06010", muted: "#7878a0", text: "#13131e", textSoft: "#44446a",
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

const CATEGORIES = ["Housing","Food","Transport","Utilities","Health","Education","Entertainment","Clothing","Garden","Savings","Income","Transfer","Other"];
const PIE_COLORS = [C.blue, C.green, C.accent, C.purple, C.orange, C.red, C.muted, C.textSoft, "#e87ca0", "#7acc7a", C.blue, C.orange, C.muted];

function toHUF(amount, currency) {
  if (currency === "EUR") return amount * EUR_HUF;
  if (currency === "USD") return amount * USD_HUF;
  return amount;
}
function fmtHUF(n) { return Math.round(n).toLocaleString("hu-HU") + " Ft"; }
function todayStr() { return new Date().toISOString().slice(0, 10); }

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

    // 2. Hard-coded fallbacks (ASCII merchant names survive encoding)
    if (!category) {
      if (/lidl|spar|aldi|tesco|penny|cba|yolo food|cityfood|vegafutar|obstermann|flekken|kebab|bisztro|pizza|kurtoskalacs|cukraszda|bundiner|kifli|balena|ichigo|burger|restau/i.test(d)) category = 'Food';
      else if (/patika|pharmy|pharmacy|pingvin|gyogyszer/i.test(d)) category = 'Health';
      else if (/mvm|dijnet|e\.on|nmhh/i.test(d)) category = 'Utilities';
      else if (/omv|mol |shell|bkk|vonat|mav|parking|bolt taxi|uber/i.test(d)) category = 'Transport';
      else if (/netflix|spotify|tv2|arena|steam|mozi|cinema/i.test(d)) category = 'Entertainment';
      else if (/zara|h&m|sinsay|pepco|reserved|vinted|deichmann|tshirt/i.test(d)) category = 'Clothing';
      else if (/hornbach|obi|bauhaus|leroy|kerteszet|garden/i.test(d)) category = 'Garden';
      else if (/temu|emag|alza|zooplus|tchibo/i.test(d)) category = 'Other';
      // Transfer detection via type column ('tual' survives from 'átutalás')
      else if (/tual|transfer/i.test(txType)) category = isIncome ? 'Income' : 'Transfer';
      else if (isIncome) category = 'Income';
      else category = 'Other';
    }

    rows.push({ date, desc, amount, currency, category, type: entryType, account: 'Revolut' });
  }
  return rows.length > 0 ? rows : null;
}

// Convert uploaded file → plain CSV text for Claude to read
async function fileToText(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "csv") return await file.text();
  if (ext === "xlsx" || ext === "xls") {
    await loadXLSX();
    const buf = await file.arrayBuffer();
    const wb = window.XLSX.read(buf, { type: "array" });
    return wb.SheetNames.map(name =>
      `--- Sheet: ${name} ---\n` + window.XLSX.utils.sheet_to_csv(wb.Sheets[name])
    ).join("\n\n");
  }
  throw new Error("Unsupported file type. Please upload .csv, .xlsx or .xls");
}

// ─── Default Data ─────────────────────────────────────────────────────────────
const EMPTY_DATA = {
  costs: [], transactions: [], portfolios: [], realEstate: [],
  cashAccounts: [], budgetTargets: [], savingsGoals: [], netWorthHistory: [],
  merchantRules: [] // { keyword, category } — learned from user corrections
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

  async function sendLink() {
    if (!email || !email.includes("@")) { setAuthError("Please enter a valid email address."); return; }
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
    { icon: "🔒", label: "Private & secure", desc: "Your data is yours — no ads, no sharing" },
  ];

  return (
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

                {authError && (
                  <div style={{ background: C.red + "18", border: `1px solid ${C.red}44`, borderRadius: 8, padding: "10px 12px", fontSize: 12, color: C.red, marginBottom: 12, lineHeight: 1.5 }}>
                    ⚠ {authError}
                  </div>
                )}

                <Btn onClick={sendLink} disabled={loading || !email} style={{ width: "100%", marginBottom: 16, padding: "11px 0", fontSize: 14 }}>
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
        PFA · Personal Finance Assistant · Built for families · Data stored securely
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
function EditableTxnRow({ t, readonly, setData }) {
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
          <Sel value={draft.category} onChange={v => setDraft(d => ({ ...d, category: v }))} options={CATEGORIES} />
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
          {CATEGORIES.map(cat => <option key={cat} value={cat}>{cat}</option>)}
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
  const pieData = CATEGORIES.filter(cat => cat !== "Income").map(cat => {
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
                <Sel value={form.category} onChange={v => setForm(f => ({ ...f, category: v }))} options={CATEGORIES} />
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
                        {CATEGORIES.map(cat => <option key={cat} value={cat}>{cat}</option>)}
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
                {monthTxns.map(t => <EditableTxnRow key={t.id} t={t} readonly={readonly} setData={setData} />)}
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
      <div style={{ borderTop: `2px solid ${C.border}`, paddingTop: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 2 }}>
          {isAvg ? "Average Monthly Budget" : "Monthly Budget"}
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>
          {isAvg ? `Average spend across ${allMonths.length} months · fixed recurring auto-detected` : "Actual spend from transactions · fixed recurring auto-detected · Utilities estimated from history"}
        </div>
        <BudgetSection data={data} setData={setData} readonly={readonly} viewMonth={viewMonth} isAvg={isAvg} allMonths={allMonths} />
      </div>
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
    formats: "CSV or Excel from Interactive Brokers, Erste, KBC, Erste Alapkezelő, etc.",
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
        <span style={{ marginLeft: "auto", fontSize: 11, color: C.muted }}>CSV or Excel</span>
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
        <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" onChange={onPick} style={{ display: "none" }} />

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

  const byCategory = CATEGORIES.filter(c => c !== "Income").map(cat => ({
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
      return { day: `${parseInt(day)}`, cumNet: cn, cumPos: cn >= 0 ? cn : 0, cumNeg: cn < 0 ? cn : 0 };
    });
  })();

  function addTransaction() {
    if (!form.date || !form.desc || !form.amount) return;
    const amt = form.type === "expense" ? -Math.abs(parseFloat(form.amount)) : Math.abs(parseFloat(form.amount));
    setData(d => ({ ...d, transactions: [{ ...form, id: Date.now().toString(), amount: amt }, ...d.transactions] }));
    setAdding(false);
  }

  if (data.transactions.length === 0) return <GettingStarted tab="cashflow" readonly={readonly} onOpenChat={onOpenChat} onOpenUpload={onOpenUpload} />;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <FileUploadCard defaultType="bank_statement" onFileReady={onImport} readonly={readonly} />

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
            <BarChart data={byCategory} layout="vertical" margin={{ left: 0, right: 16 }}>
              <XAxis type="number" tick={{ fill: C.text, fontSize: 10 }} tickFormatter={v => `${Math.round(v / 1000)}k`} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" tick={{ fill: C.text, fontSize: 11 }} width={96} axisLine={false} tickLine={false} interval={0} />
              <Tooltip formatter={v => fmtHUF(v)} contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                {byCategory.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
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
              <XAxis dataKey="day" tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} />
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
            <Sel value={form.category} onChange={v => setForm(f => ({ ...f, category: v }))} options={CATEGORIES} />
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
        {top10.map(t => <EditableTxnRow key={t.id} t={t} readonly={readonly} setData={setData} />)}
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
            {[...monthTxns].sort((a, b) => b.date.localeCompare(a.date)).map(t => <EditableTxnRow key={t.id} t={t} readonly={readonly} setData={setData} />)}
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ fontWeight: 600 }}>Savings Goals</div>
        {!readonly && (
          <Btn variant="ghost" onClick={() => { setAdding(!adding); setEditingId(null); setForm(EMPTY_FORM); }} style={{ fontSize: 12 }}>
            {adding ? "Cancel" : "+ Add goal"}
          </Btn>
        )}
      </div>

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
                <div style={{ fontSize: 12, color: C.muted }}>
                  {done ? "🎉 Goal reached!" :
                    !contribution ? "Set a monthly contribution to see your estimate" :
                    estDate ? `✦ At ${fmtHUF(contribution)}/month → ~${estDate} (${estMonths} month${estMonths !== 1 ? "s" : ""})` :
                    "Already reached"
                  }
                </div>
                {!readonly && !done && (
                  <QuickUpdateAmount goalId={g.id} currentAmount={g.currentAmount} currency={g.currency || "HUF"} onUpdate={updateCurrent} />
                )}
              </div>
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
        {!readonly && !editingPortfolio && (
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => setEditingPortfolio(true)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 13 }}>✎</button>
            <button onClick={deletePortfolio} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 15 }}>×</button>
          </div>
        )}
      </div>

      {/* Column headers — fixed last column to match data rows */}
      <div style={{ display: "grid", gridTemplateColumns: "2.5fr 1fr 1fr 1fr 1fr 96px", gap: 8, padding: "4px 0 8px", borderBottom: `1px solid ${C.border}` }}>
        {["Position", "Qty × Price", "Market Value", "Cost Basis", "P&L", ""].map(h => (
          <span key={h} style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>{h}</span>
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
          <div key={pos.id} style={{ display: "grid", gridTemplateColumns: "2.5fr 1fr 1fr 1fr 1fr 96px", gap: 8, alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
            <div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 2 }}>
                {pos.ticker && <Tag color={C.blue}>{pos.ticker}</Tag>}
                <span style={{ fontSize: 12, fontWeight: 500 }}>{pos.name}</span>
              </div>
              <div style={{ fontSize: 10, color: C.muted }}>{pos.assetClass} · {pos.region} · {pos.currency}{pos.purchaseDate ? ` · bought ${pos.purchaseDate}` : ""}</div>
              {pos.notes && <div style={{ fontSize: 10, color: C.muted, fontStyle: "italic" }}>{pos.notes}</div>}
            </div>
            <span style={{ fontSize: 12, color: C.muted }}>{pos.qty} × {pos.currentPrice}</span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{fmtHUF(marketVal)}</span>
            <span style={{ fontSize: 12, color: C.muted }}>{costVal > 0 ? fmtHUF(costVal) : "—"}</span>
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
        <div style={{ display: "grid", gridTemplateColumns: "2.5fr 1fr 1fr 1fr 1fr 96px", gap: 8, padding: "10px 0 4px" }}>
          <span style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>Total</span>
          <span />
          <span style={{ fontSize: 13, fontWeight: 700, color: C.blue }}>{fmtHUF(totalMV)}</span>
          <span style={{ fontSize: 12, color: C.muted }}>{fmtHUF(totalCost)}</span>
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

      {/* ── Portfolio view toggle ── */}
      <Card style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ fontSize: 12, color: C.muted, fontWeight: 600, flexShrink: 0 }}>Investments:</div>
        <div style={{ display: "flex", gap: 3, background: C.bg, borderRadius: 8, padding: 3 }}>
          <button onClick={() => setPortfolioView("total")}
            style={{ padding: "5px 14px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, background: portfolioView === "total" ? C.accent : "transparent", color: portfolioView === "total" ? "#000" : C.muted }}>
            All Portfolios
          </button>
          <button onClick={() => setPortfolioView("single")}
            disabled={data.portfolios.length === 0}
            style={{ padding: "5px 14px", borderRadius: 6, border: "none", cursor: data.portfolios.length === 0 ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 600, background: portfolioView === "single" ? C.accent : "transparent", color: portfolioView === "single" ? "#000" : C.muted, opacity: data.portfolios.length === 0 ? 0.4 : 1 }}>
            By Portfolio
          </button>
        </div>
        {portfolioView === "single" && data.portfolios.length > 0 && (
          <select value={selectedPortfolioId || ""} onChange={e => setSelectedPortfolioId(e.target.value)}
            style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 7, padding: "5px 10px", color: C.text, fontSize: 12, outline: "none" }}>
            {data.portfolios.map(p => <option key={p.id} value={p.id}>{p.name}{p.broker ? ` (${p.broker})` : ""}</option>)}
          </select>
        )}
      </Card>

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
            No portfolios yet. Switch to All Portfolios view and add one.
          </div>
        </Card>
      )}

    </div>
  );
}

// ─── Budget Intelligence ──────────────────────────────────────────────────────
const EXPENSE_CATEGORIES = CATEGORIES.filter(c => c !== "Income" && c !== "Savings");
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
  EXPENSE_CATEGORIES.forEach(cat => {
    if (isAvg && allMonths.length > 0) {
      const avgActual = allMonths.map(ym => sumExpensesInMonth(data.transactions, cat, ym))
        .reduce((a, b) => a + b, 0) / allMonths.length;
      spendInfoByCategory[cat] = { actual: Math.round(avgActual), estimated: 0, isFixed: false, isVariableRecurring: false, hasActualThisMonth: avgActual > 0 };
    } else {
      spendInfoByCategory[cat] = computeCategorySpend(data.transactions, cat, viewMonth);
    }
  });

  // Which categories to show: has a target OR has spend/estimate
  const trackedCats = EXPENSE_CATEGORIES.filter(c => targetMap[c] !== undefined);
  const untrackedWithSpend = EXPENSE_CATEGORIES.filter(c =>
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
  const [newCat, setNewCat] = useState(EXPENSE_CATEGORIES[0]);

  function confirmAdd(category, limitStr) {
    const v = parseFloat(limitStr);
    if (!isNaN(v) && v > 0) setTarget(category, Math.round(v));
    setAddingFor(null);
    setNewLimit("");
  }

  return (
    <div style={{ display: "grid", gap: 16, marginTop: 8 }}>
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
              {EXPENSE_CATEGORIES.filter(c => !targetMap[c]).map(c => <option key={c} value={c}>{c}</option>)}
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
  return `You are PFA, a personal finance assistant for a Hungarian household. Today is ${todayDate}.
Primary currency: HUF (EUR≈358 HUF, USD≈310 HUF).
Current household data: ${JSON.stringify(data)}

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
{"date":"YYYY-MM-DD","desc":"string","amount":number,"currency":"HUF"|"EUR"|"USD","category":"Housing"|"Food"|"Transport"|"Utilities"|"Health"|"Education"|"Entertainment"|"Savings"|"Income"|"Other","type":"expense"|"income","account":"string"}
  - amount is NEGATIVE for expenses, POSITIVE for income
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

// ─── AI Chat ──────────────────────────────────────────────────────────────────
function AIChat({ data, setData, open, setOpen, readonly, pendingImport, clearPendingImport, isMobile, initialMessage, clearInitialMessage, triggerFileOpen, clearTriggerFileOpen }) {
  const [messages, setMessages] = useState([]);
  const [history, setHistory] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [attachedFile, setAttachedFile] = useState(null);
  const [fileType, setFileType] = useState(null);
  const [pendingBatch, setPendingBatch] = useState(null);
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

  // When a file arrives from a tab upload card, pre-load it
  useEffect(() => {
    if (!pendingImport) return;
    setAttachedFile({ name: pendingImport.name, text: pendingImport.text });
    setFileType(pendingImport.fileType);
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
      const text = await fileToText(file);
      // Try Revolut direct parse — bypasses Claude token limits entirely
      const learnedRules = buildLearnedRules(data.transactions || [], data.merchantRules || []);
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
    }

    setPendingBatch(null);
    setMessages(m => [...m, { role: "assistant", content: `✓ Imported ${count} ${pendingBatch.type}. Data updated.` }]);
  }

  const batchColor = { transactions: C.blue, costs: C.purple, positions: C.green, budget_targets: C.accent, savings_goals: C.orange };

  return (
    <div style={{ position: "fixed", bottom: isMobile ? 0 : 28, right: isMobile ? 0 : 28, left: isMobile ? 0 : "auto", top: isMobile ? 0 : "auto", width: isMobile ? "100%" : 430, height: isMobile ? "100%" : 620, background: C.surface, border: isMobile ? "none" : `1px solid ${C.border}`, borderRadius: isMobile ? 0 : 16, display: "flex", flexDirection: "column", zIndex: 100, boxShadow: "0 8px 40px rgba(0,0,0,0.6)" }}>

      {/* Header */}
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontWeight: 700, color: C.accent }}>✦ PFA Assistant</span>
          {readonly && <Tag color={C.orange}>Demo</Tag>}
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
                        {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
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
        <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleFileSelect} style={{ display: "none" }} />
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
  const [tab, setTab] = useState("costs");
  const [chatOpen, setChatOpen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [sweepOpen, setSweepOpen] = useState(false);
  const [sweepDismissed, setSweepDismissed] = useState(false);
  const [pendingImport, setPendingImport] = useState(null); // { name, text, fileType }
  const [pendingChatMessage, setPendingChatMessage] = useState(null); // pre-fill message from quick-start tile
  const [pendingFileOpen, setPendingFileOpen] = useState(false); // trigger file input from quick-start tile
  const [darkMode, setDarkMode] = useState(true);
  Object.assign(C, darkMode ? DARK_C : LIGHT_C);

  function handleImport(file, fileType) {
    setPendingImport({ ...file, fileType });
    setChatOpen(true);
  }

  // Called by quick-start tiles with an optional pre-filled message
  function handleOpenChat(message) {
    if (message) setPendingChatMessage(message);
    setChatOpen(true);
  }

  // Called by quick-start upload tiles
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
      // Use hardcoded demo data — no Supabase dependency, always fresh
      setHouseholdId(DEMO_ID);
      setDataRaw(normalizeData(DEMO_DATA));
    } else if (session?.user) {
      loadOrCreateHousehold(session.user.id);
    }
  }, [session, isDemo, authReady]);

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
      if (error) {
        console.error("Save failed:", error);
        setSaveError(true);
      }
      setSaving(false);
    }, 1000);
    return () => clearTimeout(t);
  }, [data]);

  function setData(updater) { if (isDemo) return; setDataRaw(updater); }
  async function signOut() { await supabase.auth.signOut(); setIsDemo(false); setDataRaw(EMPTY_DATA); setHouseholdId(null); }

  // Auto-snapshot net worth on first load of each month (skip demo)
  useEffect(() => {
    if (!householdId || isDemo) return;
    maybeSnapshotNW(data, setData);
  }, [householdId]);

  const isMobile = useIsMobile();

  if (!authReady) return <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted }}>Loading…</div>;
  if (!session && !isDemo) return <Auth onLogin={() => setIsDemo(true)} />;

  const tabs = [
    { id: "costs",    label: "Costs",     icon: "📋" },
    { id: "cashflow", label: "Cash Flow",  icon: "💸" },
    { id: "wealth",   label: "Wealth",     icon: "📈" },
  ];
  const readonly = isDemo;

  // Monthly Sweep detection
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
      <header style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: isMobile ? "0 16px" : "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56, position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ fontWeight: 700, fontSize: 18, color: C.accent }}>✦ PFA</div>

        {/* Desktop nav tabs — hidden on mobile */}
        {!isMobile && (
          <nav style={{ display: "flex", gap: 4 }}>
            {tabs.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{ padding: "6px 16px", borderRadius: 8, border: "none", cursor: "pointer", fontWeight: 600, fontSize: 13, background: tab === t.id ? C.accent : "transparent", color: tab === t.id ? "#000" : C.muted }}>
                {t.label}
              </button>
            ))}
          </nav>
        )}

        <div style={{ display: "flex", gap: isMobile ? 6 : 10, alignItems: "center" }}>
          {saving && !isMobile && <span style={{ fontSize: 11, color: C.muted }}>Saving…</span>}
          {saveError && <span style={{ fontSize: 11, color: C.red, cursor: "pointer" }} onClick={() => setSaveError(false)} title="Data may not have saved — check your connection">⚠{isMobile ? "" : " Save failed"}</span>}
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

      {/* ── Monthly Sweep modal ── */}
      {sweepOpen && !readonly && (
        <MonthlySweep data={data} setData={setData} onClose={() => setSweepOpen(false)} thisMonth={sweepThisMonth} />
      )}

      {/* ── Main content ── */}
      <main style={{ padding: isMobile ? "16px 12px" : "24px clamp(16px, 3vw, 48px)", maxWidth: "min(1600px, 96vw)", margin: "0 auto", width: "100%", boxSizing: "border-box", paddingBottom: isMobile ? 80 : undefined }}>
        {tab === "costs" && <Costs data={data} setData={setData} readonly={readonly} onImport={handleImport} onOpenChat={handleOpenChat} onOpenUpload={handleOpenUpload} />}
        {tab === "cashflow" && <CashFlow data={data} setData={setData} readonly={readonly} onImport={handleImport} onOpenChat={handleOpenChat} onOpenUpload={handleOpenUpload} />}
        {tab === "wealth" && <Wealth data={data} setData={setData} readonly={readonly} onImport={handleImport} onOpenChat={handleOpenChat} onOpenUpload={handleOpenUpload} />}
      </main>

      {/* ── Bottom tab bar (mobile only) ── */}
      {isMobile && (
        <nav style={{ position: "fixed", bottom: 0, left: 0, right: 0, height: 64, background: C.surface, borderTop: `1px solid ${C.border}`, display: "flex", alignItems: "center", zIndex: 60 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, background: "none", border: "none", cursor: "pointer", padding: "8px 0", color: tab === t.id ? C.accent : C.muted }}>
              <span style={{ fontSize: 18, lineHeight: 1 }}>{t.icon}</span>
              <span style={{ fontSize: 10, fontWeight: tab === t.id ? 700 : 400 }}>{t.label}</span>
              {tab === t.id && <div style={{ width: 20, height: 2, background: C.accent, borderRadius: 1, marginTop: 1 }} />}
            </button>
          ))}
        </nav>
      )}

      {/* ── Quick Add FAB (bottom-left, mirrors AI chat FAB) ── */}
      {!readonly && (
        <button onClick={() => setQuickAddOpen(true)} title="Quick Add"
          style={{
            position: "fixed",
            bottom: isMobile ? 72 : 28,
            left: 28,
            width: 52, height: 52, borderRadius: "50%",
            background: C.surfaceHigh, border: `1.5px solid ${C.border}`,
            cursor: "pointer", fontSize: 22, color: C.text, fontWeight: 700,
            boxShadow: "0 4px 20px rgba(0,0,0,0.4)", zIndex: 100,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>+</button>
      )}

      {quickAddOpen && !readonly && (
        <QuickAdd setData={setData} onClose={() => setQuickAddOpen(false)} isMobile={isMobile} />
      )}

      <AIChat data={data} setData={setData} open={chatOpen} setOpen={setChatOpen} readonly={readonly} pendingImport={pendingImport} clearPendingImport={() => setPendingImport(null)} isMobile={isMobile} initialMessage={pendingChatMessage} clearInitialMessage={() => setPendingChatMessage(null)} triggerFileOpen={pendingFileOpen} clearTriggerFileOpen={() => setPendingFileOpen(false)} />
    </div>
  );
}

export default function App() {
  return <ErrorBoundary><AppInner /></ErrorBoundary>;
}
