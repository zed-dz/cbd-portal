// Books · gross margin by client / site / worker / week.
// One shift = one row priced EXACTLY as the Payroll page prices it
// (computePayrollRow + applyFullTimeMinDay from payroll.js — the hour rules are
// never re-implemented here). Pure functions, no React, no Supabase.

import { computePayrollRow, applyFullTimeMinDay, findRateLine, withRoleRate } from './payroll';

const num = (v) => parseFloat(v) || 0;
const r2 = (n) => Math.round(n * 100) / 100;

// Monday (YYYY-MM-DD) of the week that holds `dateStr`.
export function weekStart(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const dow = (d.getUTCDay() + 6) % 7;              // Mon = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

// Short label for a week: 'Wk 13 Oct'.
export function weekLabel(monday) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(monday || ''));
  if (!m) return monday || '';
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `Wk ${Number(m[3])} ${names[Number(m[2]) - 1]}`;
}

// Flatten approved timesheets to priced shift rows.
// Inputs mirror ReportsPage/MarginReport: timesheets (status approved), workers
// (v_workers_admin), clients (v_clients_admin), rateCards, roleRates, config.
export function shiftMarginRows({ timesheets, workers, clients, rateCards, roleRates, config }) {
  const workersById = Object.fromEntries((workers || []).map((w) => [w.id, w]));
  const rows = applyFullTimeMinDay(timesheets || [], workersById, config || {});
  const out = [];
  for (const ts of rows) {
    const base = workersById[ts.worker_id] || {};
    const worker = withRoleRate(base, ts.role, roleRates || []);
    const client = (ts.client_id && (clients || []).find((c) => c.id === ts.client_id))
      || (clients || []).find((c) => c.name === ts.client) || null;
    const { line, match } = client
      ? findRateLine((rateCards || []).filter((r) => r.client_id === client.id), ts.role)
      : { line: null, match: 'none' };
    const pr = computePayrollRow(ts, { ...worker, name: ts.workers?.name || worker.name }, client, config || {}, line, match);
    out.push({
      id: ts.id,
      date: ts.date,
      week: weekStart(ts.date),
      client: client?.name || ts.client || '(no client)',
      client_id: client?.id || ts.client_id || null,
      site: ts.project || ts.site || '(no site)',
      worker: ts.workers?.name || worker.name || '(unknown)',
      worker_id: ts.worker_id || null,
      role: ts.role || '',
      hours: num(ts.charge_hours),
      pay_hours: num(ts.pay_hours),
      charge: num(pr.charge_amount),
      pay: num(pr.total_pay),
      rate_missing: !!pr.rate_missing,
      charge_source: pr.charge_rate_source,
    });
  }
  return out;
}

const finish = (g) => {
  const margin = r2(g.charge - g.pay);
  return {
    ...g,
    hours: r2(g.hours), pay_hours: r2(g.pay_hours), charge: r2(g.charge), pay: r2(g.pay),
    margin,
    margin_pct: g.charge > 0 ? r2((margin / g.charge) * 100) : (g.pay > 0 ? -100 : 0),
  };
};

// Group priced rows by 'client' | 'site' | 'worker' | 'week'.
// Site groups carry their client; worker groups carry the roles seen.
export function groupMargin(rows, dim) {
  const m = new Map();
  for (const r of rows || []) {
    const key = dim === 'site' ? `${r.client} · ${r.site}` : dim === 'week' ? r.week : r[dim];
    let g = m.get(key);
    if (!g) {
      g = { key, label: dim === 'week' ? weekLabel(key) : key, client: r.client, hours: 0, pay_hours: 0, charge: 0, pay: 0, shifts: 0, rate_missing: 0, roles: new Set(), workers: new Set() };
      m.set(key, g);
    }
    g.hours += r.hours; g.pay_hours += r.pay_hours; g.charge += r.charge; g.pay += r.pay; g.shifts += 1;
    if (r.rate_missing) g.rate_missing += 1;
    if (r.role) g.roles.add(r.role);
    g.workers.add(r.worker);
  }
  const list = [...m.values()].map((g) => finish({ ...g, roles: [...g.roles].sort(), workers: g.workers.size }));
  if (dim === 'week') list.sort((a, b) => a.key.localeCompare(b.key));
  else list.sort((a, b) => b.charge - a.charge);
  return list;
}

export function marginTotals(rows) {
  const t = { hours: 0, pay_hours: 0, charge: 0, pay: 0, shifts: 0 };
  for (const r of rows || []) { t.hours += r.hours; t.pay_hours += r.pay_hours; t.charge += r.charge; t.pay += r.pay; t.shifts += 1; }
  return finish(t);
}

// Margin leaks: clients under the floor, workers whose pay beats their charge,
// shifts with a missing subcontractor rate, shifts billed at $0 with pay > 0.
export function marginLeaks(rows, floorPct = 15) {
  const leaks = [];
  for (const c of groupMargin(rows, 'client')) {
    if (c.charge > 0 && c.margin_pct < floorPct) leaks.push({ kind: 'client_under_floor', who: c.key, margin: c.margin, margin_pct: c.margin_pct, detail: `${c.margin_pct.toFixed(1)}% — floor is ${floorPct}%` });
  }
  for (const w of groupMargin(rows, 'worker')) {
    if (w.pay > w.charge && w.shifts > 0) leaks.push({ kind: 'worker_cost_over_charge', who: w.key, margin: w.margin, margin_pct: w.margin_pct, detail: `paid $${w.pay.toFixed(2)} for $${w.charge.toFixed(2)} billed` });
    if (w.rate_missing) leaks.push({ kind: 'rate_missing', who: w.key, margin: 0, margin_pct: 0, detail: `${w.rate_missing} shift${w.rate_missing === 1 ? '' : 's'} with no subcontractor rate` });
  }
  const unbilled = (rows || []).filter((r) => r.charge === 0 && r.pay > 0);
  if (unbilled.length) {
    const pay = r2(unbilled.reduce((s, r) => s + r.pay, 0));
    leaks.push({ kind: 'paid_not_billed', who: `${unbilled.length} shift${unbilled.length === 1 ? '' : 's'}`, margin: -pay, margin_pct: -100, detail: `$${pay.toFixed(2)} paid with nothing billed (training days are expected here)` });
  }
  const order = { worker_cost_over_charge: 0, client_under_floor: 1, paid_not_billed: 2, rate_missing: 3 };
  return leaks.sort((a, b) => (order[a.kind] - order[b.kind]) || a.margin - b.margin);
}

export function marginCSVRows(groups, dim) {
  return (groups || []).map((g) => ({
    [dim === 'week' ? 'Week' : dim === 'site' ? 'Client · Site' : dim === 'worker' ? 'Worker' : 'Client']: g.label,
    'Shifts': g.shifts, 'Charge hrs': g.hours.toFixed(2), 'Pay hrs': g.pay_hours.toFixed(2),
    'Billed $': g.charge.toFixed(2), 'Pay $': g.pay.toFixed(2), 'Margin $': g.margin.toFixed(2), 'Margin %': g.margin_pct.toFixed(1),
  }));
}
