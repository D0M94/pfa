import { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";
import {
  BarChart, Bar, PieChart, Pie, Cell,
  AreaChart, Area,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend
} from "recharts";

// ─── Supabase ─────────────────────────────────────────────────────────────────
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);
const DEMO_ID = import.meta.env.VITE_DEMO_HOUSEHOLD_ID;

// ─── Constants ────────────────────────────────────────────────────────────────
const EUR_HUF = 395;
const USD_HUF = 360;

const C = {
  bg: "#0f0f11", surface: "#18181c", surfaceHigh: "#222228", border: "#2a2a32",
  accent: "#e8c547", red: "#f05a5a", green: "#4fc98a", blue: "#5a9cf0",
  purple: "#a07cf0", orange: "#f09a5a", muted: "#6b6b7e", text: "#e8e8f0", textSoft: "#a0a0b8",
};

const CATEGORIES = ["Housing","Food","Transport","Utilities","Health","Education","Entertainment","Savings","Income","Other"];
const PIE_COLORS = [C.blue, C.green, C.accent, C.purple, C.orange, C.red, C.muted, C.textSoft, C.blue, C.green];

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
  cashAccounts: [], budgetTargets: [], savingsGoals: [], netWorthHistory: []
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
    style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.text, fontSize: 13, outline: "none", width: "100%", boxSizing: "border-box", ...style }} />;
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
  async function sendLink() {
    if (!email) return;
    setLoading(true);
    const { error } = await supabase.auth.signInWithOtp({ email });
    if (!error) setSent(true);
    setLoading(false);
  }
  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Card style={{ width: 360, textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>✦</div>
        <div style={{ fontSize: 22, fontWeight: 700, color: C.accent, marginBottom: 4 }}>PFA</div>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 24 }}>Personal Finance Assistant</div>
        {sent ? (
          <div style={{ color: C.green, fontSize: 14 }}>✓ Check your email for the login link.</div>
        ) : (
          <>
            <Inp value={email} onChange={setEmail} placeholder="your@email.com" type="email" style={{ marginBottom: 10 }} />
            <Btn onClick={sendLink} disabled={loading} style={{ width: "100%" }}>{loading ? "Sending..." : "Send Magic Link"}</Btn>
          </>
        )}
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
          <Btn variant="ghost" onClick={onLogin} style={{ width: "100%", fontSize: 12 }}>👀 View Demo (no login)</Btn>
        </div>
      </Card>
    </div>
  );
}

// ─── Costs Tab ────────────────────────────────────────────────────────────────
function Costs({ data, setData, readonly }) {
  const [form, setForm] = useState({ name: "", category: "Housing", amount: "", currency: "HUF", type: "recurring", frequency: "monthly", owner: "Joint", nextDue: "", notes: "" });
  const [adding, setAdding] = useState(false);
  const totalHUF = data.costs.reduce((s, c) => s + toHUF(c.amount, c.currency), 0);
  const pieData = CATEGORIES.map(cat => ({ name: cat, value: data.costs.filter(c => c.category === cat).reduce((s, c) => s + toHUF(c.amount, c.currency), 0) })).filter(d => d.value > 0);
  function addCost() {
    if (!form.name || !form.amount) return;
    setData(d => ({ ...d, costs: [...d.costs, { ...form, id: Date.now().toString(), amount: parseFloat(form.amount) }] }));
    setAdding(false);
    setForm({ name: "", category: "Housing", amount: "", currency: "HUF", type: "recurring", frequency: "monthly", owner: "Joint", nextDue: "", notes: "" });
  }
  const upcoming = [...data.costs].filter(c => c.nextDue).sort((a, b) => a.nextDue.localeCompare(b.nextDue)).slice(0, 5);
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
        <Card><Stat label="Total Monthly" value={fmtHUF(totalHUF)} color={C.red} /></Card>
        <Card><Stat label="Recurring" value={data.costs.filter(c => c.type === "recurring").length} /></Card>
        <Card><Stat label="One-time" value={data.costs.filter(c => c.type === "onetime").length} /></Card>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>By Category</div>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart><Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80}>
              {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
            </Pie><Tooltip formatter={v => fmtHUF(v)} /></PieChart>
          </ResponsiveContainer>
        </Card>
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Upcoming Due Dates</div>
          {upcoming.map(c => (
            <div key={c.id} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
              <div><div style={{ fontSize: 13 }}>{c.name}</div><div style={{ fontSize: 11, color: C.muted }}>{c.nextDue}</div></div>
              <div style={{ fontWeight: 600, color: C.red }}>{fmtHUF(toHUF(c.amount, c.currency))}</div>
            </div>
          ))}
        </Card>
      </div>
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ fontWeight: 600 }}>All Costs</div>
          {!readonly && <Btn onClick={() => setAdding(!adding)}>{adding ? "Cancel" : "+ Add manually"}</Btn>}
        </div>
        {adding && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 16, padding: 16, background: C.surfaceHigh, borderRadius: 10 }}>
            <Inp value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="Name" />
            <Sel value={form.category} onChange={v => setForm(f => ({ ...f, category: v }))} options={CATEGORIES} />
            <Inp value={form.amount} onChange={v => setForm(f => ({ ...f, amount: v }))} placeholder="Amount" type="number" />
            <Sel value={form.currency} onChange={v => setForm(f => ({ ...f, currency: v }))} options={["HUF","EUR","USD"]} />
            <Sel value={form.type} onChange={v => setForm(f => ({ ...f, type: v }))} options={["recurring","onetime"]} />
            <Sel value={form.frequency} onChange={v => setForm(f => ({ ...f, frequency: v }))} options={["monthly","quarterly","annual"]} />
            <Sel value={form.owner} onChange={v => setForm(f => ({ ...f, owner: v }))} options={["Joint","You","Wife"]} />
            <Inp value={form.nextDue} onChange={v => setForm(f => ({ ...f, nextDue: v }))} placeholder="Next due (YYYY-MM-DD)" />
            <Btn onClick={addCost} style={{ gridColumn: "span 4" }}>Save</Btn>
          </div>
        )}
        {data.costs.map(c => (
          <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <Tag color={C.blue}>{c.category}</Tag>
              <Tag color={C.muted}>{c.owner}</Tag>
              <span style={{ fontSize: 13 }}>{c.name}</span>
            </div>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <span style={{ color: C.red, fontWeight: 600 }}>{fmtHUF(toHUF(c.amount, c.currency))}</span>
              <span style={{ fontSize: 11, color: C.muted }}>{c.frequency}</span>
              {!readonly && <Btn variant="danger" onClick={() => setData(d => ({ ...d, costs: d.costs.filter(x => x.id !== c.id) }))} style={{ padding: "4px 10px" }}>×</Btn>}
            </div>
          </div>
        ))}
      </Card>

      {/* ── Budget section ── */}
      <div style={{ borderTop: `2px solid ${C.border}`, paddingTop: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 2 }}>Monthly Budget</div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>
          Actual spend from transactions · fixed recurring auto-detected · Utilities estimated from history
        </div>
        <BudgetSection data={data} setData={setData} readonly={readonly} />
      </div>
    </div>
  );
}

// ─── Cash Flow Tab ────────────────────────────────────────────────────────────
function CashFlow({ data, setData, readonly }) {
  const [form, setForm] = useState({ date: "", desc: "", amount: "", currency: "HUF", category: "Food", type: "expense", account: "OTP" });
  const [adding, setAdding] = useState(false);
  const income = data.transactions.filter(t => t.type === "income").reduce((s, t) => s + toHUF(t.amount, t.currency), 0);
  const expenses = data.transactions.filter(t => t.type === "expense").reduce((s, t) => s + Math.abs(toHUF(t.amount, t.currency)), 0);
  const byCategory = CATEGORIES.map(cat => ({ name: cat, value: data.transactions.filter(t => t.category === cat && t.type === "expense").reduce((s, t) => s + Math.abs(toHUF(t.amount, t.currency)), 0) })).filter(d => d.value > 0);
  function addTransaction() {
    if (!form.date || !form.desc || !form.amount) return;
    const amt = form.type === "expense" ? -Math.abs(parseFloat(form.amount)) : Math.abs(parseFloat(form.amount));
    setData(d => ({ ...d, transactions: [{ ...form, id: Date.now().toString(), amount: amt }, ...d.transactions] }));
    setAdding(false);
  }
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
        <Card><Stat label="Income" value={fmtHUF(income)} color={C.green} /></Card>
        <Card><Stat label="Expenses" value={fmtHUF(expenses)} color={C.red} /></Card>
        <Card><Stat label="Net" value={fmtHUF(income - expenses)} color={income >= expenses ? C.green : C.red} /></Card>
      </div>
      <Card>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Expense Breakdown</div>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={byCategory}>
            <XAxis dataKey="name" tick={{ fill: C.muted, fontSize: 11 }} />
            <YAxis tick={{ fill: C.muted, fontSize: 11 }} />
            <Tooltip formatter={v => fmtHUF(v)} />
            <Bar dataKey="value" fill={C.blue} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ fontWeight: 600 }}>Transactions</div>
          {!readonly && <Btn onClick={() => setAdding(!adding)}>{adding ? "Cancel" : "+ Add manually"}</Btn>}
        </div>
        {adding && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 16, padding: 16, background: C.surfaceHigh, borderRadius: 10 }}>
            <Inp value={form.date} onChange={v => setForm(f => ({ ...f, date: v }))} placeholder="Date (YYYY-MM-DD)" />
            <Inp value={form.desc} onChange={v => setForm(f => ({ ...f, desc: v }))} placeholder="Description" />
            <Inp value={form.amount} onChange={v => setForm(f => ({ ...f, amount: v }))} placeholder="Amount" type="number" />
            <Sel value={form.currency} onChange={v => setForm(f => ({ ...f, currency: v }))} options={["HUF","EUR","USD"]} />
            <Sel value={form.category} onChange={v => setForm(f => ({ ...f, category: v }))} options={CATEGORIES} />
            <Sel value={form.type} onChange={v => setForm(f => ({ ...f, type: v }))} options={["expense","income"]} />
            <Inp value={form.account} onChange={v => setForm(f => ({ ...f, account: v }))} placeholder="Account" />
            <Btn onClick={addTransaction} style={{ gridColumn: "span 4" }}>Save</Btn>
          </div>
        )}
        {data.transactions.map(t => (
          <div key={t.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: C.muted }}>{t.date}</span>
              <Tag color={t.type === "income" ? C.green : C.red}>{t.category}</Tag>
              <span style={{ fontSize: 13 }}>{t.desc}</span>
            </div>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <span style={{ fontWeight: 600, color: t.type === "income" ? C.green : C.red }}>{fmtHUF(toHUF(Math.abs(t.amount), t.currency))}</span>
              {!readonly && <Btn variant="danger" onClick={() => setData(d => ({ ...d, transactions: d.transactions.filter(x => x.id !== t.id) }))} style={{ padding: "4px 10px" }}>×</Btn>}
            </div>
          </div>
        ))}
      </Card>

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
            <Inp value={form.targetDate} onChange={v => setForm(f => ({ ...f, targetDate: v }))} placeholder="YYYY-MM-DD" />
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
  const [editingPortfolio, setEditingPortfolio] = useState(false);
  const [portfolioForm, setPortfolioForm] = useState({ name: portfolio.name, broker: portfolio.broker || "" });

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
    setForm(EMPTY_POSITION);
  }

  function startEditPos(pos) {
    setForm({ ...EMPTY_POSITION, ...pos, qty: String(pos.qty), costBasis: String(pos.costBasis), currentPrice: String(pos.currentPrice), marketValue: String(pos.qty * pos.currentPrice) });
    setEditingPosId(pos.id);
    setAddingPos(true);
  }

  function deletePos(posId) {
    setData(d => ({ ...d, portfolios: d.portfolios.map(p => p.id === portfolio.id ? { ...p, positions: p.positions.filter(x => x.id !== posId) } : p) }));
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

      {/* Column headers */}
      <div style={{ display: "grid", gridTemplateColumns: "2.5fr 1fr 1fr 1fr 1fr auto", gap: 8, padding: "4px 0 8px", borderBottom: `1px solid ${C.border}` }}>
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
        const hasISIN = pos.isin;
        const hasTicker = pos.ticker;
        return (
          <div key={pos.id} style={{ display: "grid", gridTemplateColumns: "2.5fr 1fr 1fr 1fr 1fr auto", gap: 8, alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
            <div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 2 }}>
                {hasTicker && <Tag color={C.blue}>{pos.ticker}</Tag>}
                {hasISIN && <span style={{ fontSize: 10, color: C.muted, fontFamily: "monospace" }}>{pos.isin}</span>}
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
              <div style={{ display: "flex", gap: 4 }}>
                <button onClick={() => startEditPos(pos)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 12 }}>✎</button>
                <button onClick={() => deletePos(pos.id)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 14 }}>×</button>
              </div>
            )}
          </div>
        );
      })}

      {/* Totals row */}
      {portfolio.positions.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "2.5fr 1fr 1fr 1fr 1fr auto", gap: 8, padding: "10px 0 4px" }}>
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

      {/* Add position form */}
      {addingPos && !readonly && (
        <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginTop: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12, color: C.accent }}>
            {editingPosId ? "Edit position" : "Add position"}
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
            {F("Purchase Date", "purchaseDate", { placeholder: "YYYY-MM-DD" })}
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
            <Btn onClick={savePosition}>{editingPosId ? "Save changes" : "Add position"}</Btn>
            <Btn variant="ghost" onClick={() => { setAddingPos(false); setEditingPosId(null); setForm(EMPTY_POSITION); }}>Cancel</Btn>
          </div>
        </div>
      )}

      {/* Add position button */}
      {!readonly && !addingPos && (
        <button onClick={() => { setAddingPos(true); setEditingPosId(null); setForm(EMPTY_POSITION); }}
          style={{ marginTop: 12, background: "none", border: `1px dashed ${C.border}`, borderRadius: 8, padding: "8px 16px", color: C.muted, cursor: "pointer", fontSize: 12, width: "100%" }}>
          + Add position
        </button>
      )}
    </Card>
  );
}

// ─── Wealth Tab ───────────────────────────────────────────────────────────────
// NW snapshot: call once on app load if current month not yet recorded
function maybeSnapshotNW(data, setData) {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const history = data.netWorthHistory || [];
  if (history.some(h => h.date === ym)) return; // already have this month
  const investments = data.portfolios.flatMap(p => p.positions)
    .reduce((s, pos) => s + toHUF(pos.qty * pos.currentPrice, pos.currency), 0);
  const realEstate = data.realEstate
    .reduce((s, r) => s + toHUF(r.currentValue - r.mortgage, r.currency), 0);
  const cash = data.cashAccounts
    .reduce((s, a) => s + toHUF(a.balance, a.currency), 0);
  const totalNW = investments + realEstate + cash;
  setData(d => ({
    ...d,
    netWorthHistory: [...(d.netWorthHistory || []),
      { date: ym, totalNW: Math.round(totalNW), investments: Math.round(investments), realEstate: Math.round(realEstate), cash: Math.round(cash) }
    ].sort((a, b) => a.date.localeCompare(b.date))
  }));
}

function Wealth({ data, setData, readonly }) {
  const allPositions = data.portfolios.flatMap(p =>
    p.positions.map(pos => ({ ...pos, portfolioName: p.name }))
  );
  const investmentsHUF = allPositions.reduce((s, pos) => s + toHUF(pos.qty * pos.currentPrice, pos.currency), 0);
  const realEstateHUF = data.realEstate.reduce((s, r) => s + toHUF(r.currentValue - r.mortgage, r.currency), 0);
  const cashHUF = data.cashAccounts.reduce((s, a) => s + toHUF(a.balance, a.currency), 0);
  const totalNW = investmentsHUF + realEstateHUF + cashHUF;

  // Manual snapshot
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

  // Timeline chart data — label months nicely
  const history = (data.netWorthHistory || []).map(h => {
    const [y, m] = h.date.split("-").map(Number);
    const label = new Date(y, m - 1, 1).toLocaleString("en-GB", { month: "short", year: "2-digit" });
    return { ...h, label };
  });

  // Asset class breakdown for pie
  const assetClassMap = {};
  allPositions.forEach(pos => {
    const val = toHUF(pos.qty * pos.currentPrice, pos.currency);
    assetClassMap[pos.assetClass || "Other"] = (assetClassMap[pos.assetClass || "Other"] || 0) + val;
  });
  const assetClassData = Object.entries(assetClassMap).map(([name, value]) => ({ name, value: Math.round(value) }));

  // Geographic breakdown for pie
  const regionMap = {};
  allPositions.forEach(pos => {
    const val = toHUF(pos.qty * pos.currentPrice, pos.currency);
    regionMap[pos.region || "Other"] = (regionMap[pos.region || "Other"] || 0) + val;
  });
  const regionData = Object.entries(regionMap).map(([name, value]) => ({ name, value: Math.round(value) }));

  const PIE_COLORS_EXT = [C.blue, C.green, C.accent, C.purple, C.orange, C.red, C.muted];

  // NW change vs previous snapshot
  const nwChange = history.length >= 2
    ? history[history.length - 1].totalNW - history[history.length - 2].totalNW
    : null;

  return (
    <div style={{ display: "grid", gap: 16 }}>

      {/* ── Stats row ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 16 }}>
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

      {/* ── Net Worth Timeline ── */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 600 }}>Net Worth Timeline</div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
              {history.length} snapshot{history.length !== 1 ? "s" : ""} · auto-saved monthly
            </div>
          </div>
          {!readonly && (
            <Btn variant="ghost" onClick={takeSnapshot} style={{ fontSize: 12 }}>
              ↺ Update snapshot
            </Btn>
          )}
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
                  <stop offset="5%" stopColor={C.green} stopOpacity={0.5} />
                  <stop offset="95%" stopColor={C.green} stopOpacity={0.05} />
                </linearGradient>
                <linearGradient id="gradRE" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={C.purple} stopOpacity={0.5} />
                  <stop offset="95%" stopColor={C.purple} stopOpacity={0.05} />
                </linearGradient>
                <linearGradient id="gradInv" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={C.blue} stopOpacity={0.6} />
                  <stop offset="95%" stopColor={C.blue} stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <XAxis dataKey="label" tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false}
                tickFormatter={v => `${Math.round(v / 1000000)}M`} width={36} />
              <Tooltip formatter={(v, name) => [fmtHUF(v), name]}
                contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: C.text }} />
              <Legend wrapperStyle={{ fontSize: 12, color: C.muted, paddingTop: 8 }} />
              <Area type="monotone" dataKey="cash" name="Cash" stackId="1"
                stroke={C.green} fill="url(#gradCash)" strokeWidth={1.5} />
              <Area type="monotone" dataKey="realEstate" name="Real Estate" stackId="1"
                stroke={C.purple} fill="url(#gradRE)" strokeWidth={1.5} />
              <Area type="monotone" dataKey="investments" name="Investments" stackId="1"
                stroke={C.blue} fill="url(#gradInv)" strokeWidth={1.5} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </Card>

      {/* ── Investment breakdown pies ── */}
      {allPositions.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Card>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>By Asset Class</div>
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie data={assetClassData} dataKey="value" nameKey="name" cx="40%" cy="50%" outerRadius={70} innerRadius={36}>
                  {assetClassData.map((_, i) => <Cell key={i} fill={PIE_COLORS_EXT[i % PIE_COLORS_EXT.length]} />)}
                </Pie>
                <Tooltip formatter={v => fmtHUF(v)}
                  contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }} />
                <Legend layout="vertical" align="right" verticalAlign="middle"
                  wrapperStyle={{ fontSize: 12, color: C.muted }} />
              </PieChart>
            </ResponsiveContainer>
          </Card>
          <Card>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>By Geography</div>
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie data={regionData} dataKey="value" nameKey="name" cx="40%" cy="50%" outerRadius={70} innerRadius={36}>
                  {regionData.map((_, i) => <Cell key={i} fill={PIE_COLORS_EXT[(i + 2) % PIE_COLORS_EXT.length]} />)}
                </Pie>
                <Tooltip formatter={v => fmtHUF(v)}
                  contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }} />
                <Legend layout="vertical" align="right" verticalAlign="middle"
                  wrapperStyle={{ fontSize: 12, color: C.muted }} />
              </PieChart>
            </ResponsiveContainer>
          </Card>
        </div>
      )}

      {/* ── Portfolio positions ── */}
      {data.portfolios.map(portfolio => (
        <PortfolioCard key={portfolio.id} portfolio={portfolio} data={data} setData={setData} readonly={readonly} />
      ))}

      {/* Add new portfolio button */}
      {!readonly && (
        <button onClick={() => {
          const name = prompt("Sub-portfolio name (e.g. IBKR, Erste, KBC):");
          if (!name) return;
          const broker = prompt("Provider / broker name:");
          setData(d => ({ ...d, portfolios: [...d.portfolios, { id: `p_${Date.now()}`, name, broker: broker || "", currency: "USD", description: "", positions: [] }] }));
        }} style={{ background: "none", border: `2px dashed ${C.border}`, borderRadius: 12, padding: 16, color: C.muted, cursor: "pointer", fontSize: 13, width: "100%", textAlign: "center" }}>
          + Add sub-portfolio (IBKR, Erste, Revolut…)
        </button>
      )}

      {/* ── Real estate + cash ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Real Estate</div>
          {data.realEstate.map(r => (
            <div key={r.id} style={{ padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ fontWeight: 500 }}>{r.name}</div>
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>{r.address} · {r.purchaseYear}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <div><div style={{ fontSize: 10, color: C.muted }}>VALUE</div><div style={{ fontSize: 13, fontWeight: 600 }}>{fmtHUF(r.currentValue)}</div></div>
                <div><div style={{ fontSize: 10, color: C.muted }}>MORTGAGE</div><div style={{ fontSize: 13, fontWeight: 600, color: C.red }}>{fmtHUF(r.mortgage)}</div></div>
                <div><div style={{ fontSize: 10, color: C.muted }}>EQUITY</div><div style={{ fontSize: 13, fontWeight: 600, color: C.green }}>{fmtHUF(r.currentValue - r.mortgage)}</div></div>
              </div>
            </div>
          ))}
        </Card>
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Cash Accounts</div>
          {data.cashAccounts.map(a => (
            <div key={a.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
              <div><div style={{ fontSize: 13, fontWeight: 500 }}>{a.name}</div><Tag color={C.muted}>{a.type}</Tag></div>
              <div style={{ fontWeight: 600, color: C.green }}>{fmtHUF(toHUF(a.balance, a.currency))}</div>
            </div>
          ))}
        </Card>
      </div>

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
function BudgetSection({ data, setData, readonly }) {
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [viewMonth, setViewMonth] = useState(thisMonth);

  const monthLabel = (() => {
    const [y, m] = viewMonth.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleString("en-GB", { month: "long", year: "numeric" });
  })();

  function shiftMonth(delta) {
    const [y, m] = viewMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    const nm = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (nm <= thisMonth) setViewMonth(nm); // don't go into the future
  }

  // Budget targets map
  const targetMap = {};
  (data.budgetTargets || []).forEach(bt => { targetMap[bt.category] = bt.monthlyLimit; });

  // Compute spend info for every expense category
  const spendInfoByCategory = {};
  EXPENSE_CATEGORIES.forEach(cat => {
    spendInfoByCategory[cat] = computeCategorySpend(data.transactions, cat, viewMonth);
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
      {/* Month picker + summary stats */}
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr 1fr", gap: 12, alignItems: "stretch" }}>
        {/* Month picker */}
        <Card style={{ padding: "14px 16px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, minWidth: 140 }}>
          <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 1 }}>Month</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button onClick={() => shiftMonth(-1)}
              style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 9px", color: C.muted, cursor: "pointer", fontSize: 14 }}>‹</button>
            <span style={{ fontWeight: 700, fontSize: 13, color: C.text, whiteSpace: "nowrap" }}>{monthLabel}</span>
            <button onClick={() => shiftMonth(1)} disabled={viewMonth >= thisMonth}
              style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 9px", color: viewMonth >= thisMonth ? C.border : C.muted, cursor: viewMonth >= thisMonth ? "default" : "pointer", fontSize: 14 }}>›</button>
          </div>
          {viewMonth === thisMonth && <div style={{ fontSize: 10, color: C.accent }}>current month</div>}
        </Card>
        <Card><Stat label="Spent vs Budgeted" value={`${fmtHUF(totalSpent)} / ${fmtHUF(totalBudgeted)}`} color={totalSpent > totalBudgeted ? C.red : C.text} /></Card>
        <Card><Stat label="Remaining" value={fmtHUF(Math.max(0, totalBudgeted - totalSpent))} color={C.green} /></Card>
        <Card><Stat label="Over budget" value={overCount === 0 ? "✓ None" : `${overCount} categor${overCount === 1 ? "y" : "ies"}`} color={overCount > 0 ? C.red : C.green} /></Card>
      </div>

      {estimateCount > 0 && (
        <div style={{ background: C.orange + "18", border: `1px solid ${C.orange}44`, borderRadius: 8, padding: "8px 14px", fontSize: 12, color: C.orange }}>
          ⚠ {estimateCount} categor{estimateCount === 1 ? "y uses a" : "ies use"} estimated amounts based on past months — actual bills not yet logged for {monthLabel}.
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
            <span style={{ fontSize: 12 }}>Add one above, or ask the AI: "suggest budget targets based on my spending"</span>
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
                  <span style={{ fontWeight: 600, color: si.isEstimate ? C.orange : C.textSoft }}>
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
Primary currency: HUF (EUR≈395 HUF, USD≈360 HUF).
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
Lidl/Aldi/Spar/Tesco/Penny/market/zöldséges → Food
BKK/Volán/MÁV/Uber/Bolt/taxi/fuel/MOL/Shell → Transport
Netflix/Spotify/Steam/HBO/cinema/mozi → Entertainment
Doctor/orvos/pharmacy/patika/gyógyszer → Health
Electricity/áram/gas/gáz/internet/water/víz → Utilities
Rent/lakbér/albérlet/mortgage/jelzálog → Housing
Salary/fizetés/bér/dividend → Income (type=income, amount positive)
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

const FILE_TYPE_LABELS = {
  bank_statement: "Bank statement",
  investment_export: "Investment export",
  cost_list: "Cost / bill list",
};

// ─── AI Chat ──────────────────────────────────────────────────────────────────
function AIChat({ data, setData, open, setOpen, readonly }) {
  const [messages, setMessages] = useState([]);
  const [history, setHistory] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [attachedFile, setAttachedFile] = useState(null);
  const [fileType, setFileType] = useState(null); // "bank_statement"|"investment_export"|"cost_list"
  const [pendingBatch, setPendingBatch] = useState(null);
  const fileInputRef = useRef(null);
  const bottomRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading, pendingBatch]);

  // Minimized pill — shows last message, click to expand
  if (!open) return (
    <button onClick={() => setOpen(true)} title="Open AI Assistant"
      style={{ position: "fixed", bottom: 28, right: 28, width: 52, height: 52, borderRadius: "50%", background: C.accent, border: "none", cursor: "pointer", fontSize: 22, color: "#000", fontWeight: 700, boxShadow: "0 4px 20px rgba(0,0,0,0.4)", zIndex: 100 }}>✦</button>
  );

  if (minimized) return (
    <div style={{ position: "fixed", bottom: 28, right: 28, zIndex: 100, display: "flex", alignItems: "center", gap: 8 }}>
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
      setAttachedFile({ name: file.name, text });
      setFileType(null); // reset type selection for each new file
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
          max_tokens: 2000,
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
        setPendingBatch({ ...batch, checked: batch.items.map(() => true) });
      }
    } catch {
      setMessages(m => [...m, { role: "assistant", content: "Connection error — please try again." }]);
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
        if (d.portfolios.length === 0) {
          return { ...d, portfolios: [{ id: "p_auto", name: "Imported Portfolio", broker: "", currency: "USD", description: "", positions: newPositions }] };
        }
        return { ...d, portfolios: d.portfolios.map((p, i) => i === 0 ? { ...p, positions: [...p.positions, ...newPositions] } : p) };
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

  if (!open) return (
    <button onClick={() => setOpen(true)} title="Open AI Assistant"
      style={{ position: "fixed", bottom: 28, right: 28, width: 52, height: 52, borderRadius: "50%", background: C.accent, border: "none", cursor: "pointer", fontSize: 22, color: "#000", fontWeight: 700, boxShadow: "0 4px 20px rgba(0,0,0,0.4)", zIndex: 100 }}>✦</button>
  );

  return (
    <div style={{ position: "fixed", bottom: 28, right: 28, width: 430, height: 620, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, display: "flex", flexDirection: "column", zIndex: 100, boxShadow: "0 8px 40px rgba(0,0,0,0.6)" }}>

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
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.desc}</span>
                      <Tag color={item.type === "income" ? C.green : C.blue} >{item.category}</Tag>
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

// ─── App Shell ────────────────────────────────────────────────────────────────
export default function App() {
  const [session, setSession] = useState(null);
  const [isDemo, setIsDemo] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [tab, setTab] = useState("costs");
  const [chatOpen, setChatOpen] = useState(false);
  const [data, setDataRaw] = useState(EMPTY_DATA);
  const [householdId, setHouseholdId] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => { setSession(session); setAuthReady(true); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!authReady) return;
    if (isDemo) loadHousehold(DEMO_ID);
    else if (session?.user) loadOrCreateHousehold(session.user.id);
  }, [session, isDemo, authReady]);

  async function loadHousehold(id) {
    const { data: row } = await supabase.from("households").select("id, data").eq("id", id).single();
    if (row) { setHouseholdId(row.id); setDataRaw(row.data); }
  }
  async function loadOrCreateHousehold(userId) {
    let { data: row } = await supabase.from("households").select("id, data").eq("user_id", userId).single();
    if (!row) {
      const { data: newRow } = await supabase.from("households").insert({ user_id: userId, data: EMPTY_DATA }).select().single();
      row = newRow;
    }
    if (row) { setHouseholdId(row.id); setDataRaw(row.data); }
  }
  useEffect(() => {
    if (!householdId || isDemo) return;
    setSaving(true);
    const t = setTimeout(async () => {
      await supabase.from("households").update({ data, updated_at: new Date().toISOString() }).eq("id", householdId);
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

  if (!authReady) return <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted }}>Loading…</div>;
  if (!session && !isDemo) return <Auth onLogin={() => setIsDemo(true)} />;

  const tabs = [{ id: "costs", label: "Costs" }, { id: "cashflow", label: "Cash Flow" }, { id: "wealth", label: "Wealth" }];
  const readonly = isDemo;

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'DM Sans', sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono&display=swap" rel="stylesheet" />
      <header style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56, position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ fontWeight: 700, fontSize: 18, color: C.accent }}>✦ PFA</div>
        <nav style={{ display: "flex", gap: 4 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{ padding: "6px 16px", borderRadius: 8, border: "none", cursor: "pointer", fontWeight: 600, fontSize: 13, background: tab === t.id ? C.accent : "transparent", color: tab === t.id ? "#000" : C.muted }}>
              {t.label}
            </button>
          ))}
        </nav>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {saving && <span style={{ fontSize: 11, color: C.muted }}>Saving…</span>}
          {isDemo
            ? <Btn variant="ghost" onClick={() => setIsDemo(false)} style={{ fontSize: 12 }}>← Sign in</Btn>
            : <Btn variant="ghost" onClick={signOut} style={{ fontSize: 12 }}>Sign out</Btn>}
          {readonly && <Tag color={C.orange}>Demo</Tag>}
        </div>
      </header>

      <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
        {tab === "costs" && <Costs data={data} setData={setData} readonly={readonly} />}
        {tab === "cashflow" && <CashFlow data={data} setData={setData} readonly={readonly} />}
        {tab === "wealth" && <Wealth data={data} setData={setData} readonly={readonly} />}
      </main>

      <AIChat data={data} setData={setData} open={chatOpen} setOpen={setChatOpen} readonly={readonly} />
    </div>
  );
}
