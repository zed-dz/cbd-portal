// Books · cash-basis P&L by month + simple balance snapshot + budget vs actual.
// Pure functions over books_transactions (is_cash rows) and books_accounts
// (Type / Class from Xero's chart). Nothing here needs Xero's Reports API.

import { monthKey } from './books';

const r2 = (n) => Math.round(n * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);

export const PNL_GROUPS = ['REVENUE', 'DIRECTCOSTS', 'EXPENSE', 'OTHERINCOME', 'OTHEREXPENSE'];
const GROUP_LABEL = { REVENUE: 'Revenue', DIRECTCOSTS: 'Direct costs', EXPENSE: 'Expenses', OTHERINCOME: 'Other income', OTHEREXPENSE: 'Other expenses', UNCODED: 'Uncoded' };
export const pnlGroupLabel = (g) => GROUP_LABEL[g] || g;

// Which P&L group a cash line belongs to, from the chart; uncoded lines fall
// back on their direction so the totals still add up.
export function pnlGroupOf(t, accountsByCode) {
  const a = t.account_code ? accountsByCode[t.account_code] : null;
  const type = String(a?.type || '').toUpperCase();
  const cls = String(a?.class || '').toUpperCase();
  if (type === 'REVENUE' || type === 'SALES') return 'REVENUE';
  if (type === 'OTHERINCOME') return 'OTHERINCOME';
  if (type === 'DIRECTCOSTS') return 'DIRECTCOSTS';
  if (type === 'EXPENSE' || type === 'OVERHEADS' || type === 'DEPRECIATN') return 'EXPENSE';
  if (type === 'OTHEREXPENSE') return 'OTHEREXPENSE';
  if (cls === 'REVENUE') return 'REVENUE';
  if (cls === 'EXPENSE') return 'EXPENSE';
  if (cls === 'ASSET' || cls === 'LIABILITY' || cls === 'EQUITY') return 'BALANCE';   // transfers to balance-sheet accounts: not P&L
  return t.direction === 'in' ? 'REVENUE' : 'EXPENSE';
}

// Lines are counted ex-GST (cash basis P&L shows net amounts).
export function netOf(t) {
  const total = num(t.total);
  if (t.subtotal !== null && t.subtotal !== undefined && t.subtotal !== '') return num(t.subtotal);
  return r2(total - num(t.gst));
}

// P&L for `months` (['YYYY-MM', …]) → { months, groups: [{ group, label, total, byMonth: {ym: n}, accounts: [{ code, name, total, byMonth }] }], net: {ym: n}, net_total }
export function pnlByMonth(transactions, accounts, months) {
  const byCode = Object.fromEntries((accounts || []).map((a) => [a.code, a]));
  const want = new Set(months || []);
  const groups = new Map();
  for (const t of transactions || []) {
    if (!t.is_cash) continue;
    const st = String(t.status || 'AUTHORISED').toUpperCase();
    if (st !== 'AUTHORISED' && st !== 'PAID') continue;
    const ym = monthKey(t.txn_date);
    if (!want.has(ym)) continue;
    const g = pnlGroupOf(t, byCode);
    if (g === 'BALANCE') continue;
    const sign = t.direction === 'in' ? 1 : -1;
    const v = sign * netOf(t);
    let G = groups.get(g);
    if (!G) { G = { group: g, label: pnlGroupLabel(g), total: 0, byMonth: {}, accounts: new Map() }; groups.set(g, G); }
    G.total += v; G.byMonth[ym] = (G.byMonth[ym] || 0) + v;
    const code = t.account_code || '—';
    let A = G.accounts.get(code);
    if (!A) { A = { code, name: byCode[code]?.name || t.account_name || (code === '—' ? 'Uncoded' : code), total: 0, byMonth: {} }; G.accounts.set(code, A); }
    A.total += v; A.byMonth[ym] = (A.byMonth[ym] || 0) + v;
  }
  const order = { REVENUE: 0, OTHERINCOME: 1, DIRECTCOSTS: 2, EXPENSE: 3, OTHEREXPENSE: 4 };
  const out = [...groups.values()].sort((a, b) => (order[a.group] ?? 9) - (order[b.group] ?? 9)).map((G) => ({
    ...G, total: r2(G.total),
    byMonth: Object.fromEntries(Object.entries(G.byMonth).map(([k, v]) => [k, r2(v)])),
    accounts: [...G.accounts.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total)).map((A) => ({ ...A, total: r2(A.total), byMonth: Object.fromEntries(Object.entries(A.byMonth).map(([k, v]) => [k, r2(v)])) })),
  }));
  const net = {};
  for (const ym of months || []) net[ym] = r2(out.reduce((s, G) => s + (G.byMonth[ym] || 0), 0));
  const income = r2(out.filter((G) => G.group === 'REVENUE' || G.group === 'OTHERINCOME').reduce((s, G) => s + G.total, 0));
  const costs = r2(out.filter((G) => G.group !== 'REVENUE' && G.group !== 'OTHERINCOME').reduce((s, G) => s + G.total, 0));   // negative numbers
  return { months: months || [], groups: out, net, net_total: r2(income + costs), income, costs: r2(-costs), margin_pct: income > 0 ? r2(((income + costs) / income) * 100) : 0 };
}

// What we can say about the balance sheet without Xero's reports:
// bank (typed + rolled), receivables, payables, GST position for the open BAS.
export function balanceSnapshot({ bank, openItems, bas }) {
  const ar = r2((openItems || []).filter((o) => o.item_type === 'ACCREC').reduce((s, o) => s + num(o.amount_due), 0));
  const ap = r2((openItems || []).filter((o) => o.item_type === 'ACCPAY').reduce((s, o) => s + num(o.amount_due), 0));
  const gst = r2(num(bas?.gst_1a) - num(bas?.gst_1b));
  const bankV = bank === null || bank === undefined ? null : r2(num(bank));
  return {
    bank: bankV, receivables: ar, payables: ap, gst_owing: gst,
    working_capital: bankV === null ? null : r2(bankV + ar - ap - gst),
  };
}

// Budget rows [{ account_group, month (YYYY-MM-01 or YYYY-MM), amount }] →
// per group per month { budget, actual, variance } (variance = actual − budget,
// costs are compared on absolute values so "over budget" is positive).
export function budgetVsActual(pnl, budgets) {
  const b = new Map();
  for (const r of budgets || []) b.set(`${r.account_group}|${monthKey(r.month)}`, num(r.amount));
  const rows = [];
  for (const G of pnl.groups) {
    const isCost = G.group !== 'REVENUE' && G.group !== 'OTHERINCOME';
    const cells = {};
    let budgetTotal = 0; let actualTotal = 0;
    for (const ym of pnl.months) {
      const budget = b.get(`${G.group}|${ym}`) ?? null;
      const actual = r2(Math.abs(G.byMonth[ym] || 0));
      cells[ym] = { budget, actual, variance: budget === null ? null : r2(isCost ? actual - budget : actual - budget) };
      if (budget !== null) budgetTotal += budget;
      actualTotal += actual;
    }
    rows.push({ group: G.group, label: G.label, is_cost: isCost, cells, budget_total: r2(budgetTotal), actual_total: r2(actualTotal) });
  }
  return rows;
}

export function pnlCSVRows(pnl) {
  const out = [];
  for (const G of pnl.groups) {
    const row = { 'Group': G.label, 'Account': '(all)' };
    for (const ym of pnl.months) row[ym] = (G.byMonth[ym] || 0).toFixed(2);
    row['Total'] = G.total.toFixed(2);
    out.push(row);
    for (const A of G.accounts) {
      const r = { 'Group': G.label, 'Account': `${A.code} ${A.name}` };
      for (const ym of pnl.months) r[ym] = (A.byMonth[ym] || 0).toFixed(2);
      r['Total'] = A.total.toFixed(2);
      out.push(r);
    }
  }
  const net = { 'Group': 'NET', 'Account': '' };
  for (const ym of pnl.months) net[ym] = (pnl.net[ym] || 0).toFixed(2);
  net['Total'] = pnl.net_total.toFixed(2);
  out.push(net);
  return out;
}
