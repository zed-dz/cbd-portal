// Labour margin report — pure functions over the same inputs the Payroll page
// uses, so charge and pay here can never disagree with the Payroll screen.
// Money in, money out: only ever called from an admin-gated page.

import { computePayrollRow, applyFullTimeMinDay, findRateLine, withRoleRate } from './payroll';

const num = (v) => parseFloat(v) || 0;
const r2 = (n) => Math.round(n * 100) / 100;

const zero = () => ({ hours: 0, charge: 0, pay: 0, plant_hours: 0, plant_charge: 0, shifts: 0 });
const add = (acc, x) => {
  acc.hours += x.hours; acc.charge += x.charge; acc.pay += x.pay;
  acc.plant_hours += x.plant_hours; acc.plant_charge += x.plant_charge; acc.shifts += x.shifts;
  return acc;
};
const finish = (g) => ({
  ...g,
  hours: r2(g.hours), charge: r2(g.charge), pay: r2(g.pay),
  plant_hours: r2(g.plant_hours), plant_charge: r2(g.plant_charge),
  billable: r2(g.charge + g.plant_charge),
  margin: r2(g.charge + g.plant_charge - g.pay),
  margin_pct: (g.charge + g.plant_charge) > 0 ? r2(((g.charge + g.plant_charge - g.pay) / (g.charge + g.plant_charge)) * 100) : 0,
});

// timesheets: approved (+ client-accepted) rows in range, each with worker_id,
//   client_id/client, site/project, header_id.
// plantRows: plant_hours joined to the admin plant view:
//   { header_id, hours, plant_items: { hourly_charge, name } }
// Returns { clients: [{ client, ...totals, sites: [{ site, ...totals }] }], totals }
export function buildMarginReport({ timesheets, workers, clients, rateCards, roleRates, config, plantRows }) {
  const workersById = Object.fromEntries((workers || []).map(w => [w.id, w]));
  const rows = applyFullTimeMinDay(timesheets || [], workersById, config || {});

  const headerSite = new Map();   // header_id → { clientKey, siteKey } so plant lands on the right row
  const byClient = new Map();
  const bucket = (clientKey, siteKey) => {
    let c = byClient.get(clientKey);
    if (!c) { c = { client: clientKey, ...zero(), sites: new Map() }; byClient.set(clientKey, c); }
    let s = c.sites.get(siteKey);
    if (!s) { s = { site: siteKey, ...zero() }; c.sites.set(siteKey, s); }
    return { c, s };
  };

  for (const ts of rows) {
    const worker = withRoleRate(workersById[ts.worker_id] || {}, ts.role, roleRates || []);
    const client = (ts.client_id && (clients || []).find(c => c.id === ts.client_id))
      || (clients || []).find(c => c.name === ts.client) || null;
    const { line, match } = client
      ? findRateLine((rateCards || []).filter(r => r.client_id === client.id), ts.role)
      : { line: null, match: 'none' };
    const pr = computePayrollRow(ts, { ...worker, name: ts.workers?.name || worker.name }, client, config || {}, line, match);
    const clientKey = client?.name || ts.client || '(no client)';
    const siteKey = ts.project || ts.site || '(no site)';
    const x = { hours: num(ts.charge_hours), charge: num(pr.charge_amount), pay: num(pr.total_pay), plant_hours: 0, plant_charge: 0, shifts: 1 };
    const { c, s } = bucket(clientKey, siteKey);
    add(c, x); add(s, x);
    if (ts.header_id && !headerSite.has(ts.header_id)) headerSite.set(ts.header_id, { clientKey, siteKey });
  }

  for (const p of plantRows || []) {
    const where = headerSite.get(p.header_id);
    if (!where) continue;   // plant on a sheet with no shift in range — not this period's margin
    const hrs = num(p.hours);
    const rate = num(p.plant_items?.hourly_charge);
    const x = { hours: 0, charge: 0, pay: 0, plant_hours: hrs, plant_charge: r2(hrs * rate), shifts: 0 };
    const { c, s } = bucket(where.clientKey, where.siteKey);
    add(c, x); add(s, x);
  }

  const out = [...byClient.values()]
    .sort((a, b) => a.client.localeCompare(b.client))
    .map(c => ({
      ...finish(c),
      sites: [...c.sites.values()].sort((a, b) => a.site.localeCompare(b.site)).map(finish),
    }));
  const totals = finish(out.reduce((acc, c) => add(acc, c), zero()));
  return { clients: out, totals };
}

export function marginReportCSVRows(report) {
  const row = (label, site, g) => ({
    'Client': label, 'Site': site, 'Shifts': g.shifts,
    'Hours': g.hours.toFixed(2), 'Plant hrs': g.plant_hours.toFixed(2),
    'Labour charge $': g.charge.toFixed(2), 'Plant charge $': g.plant_charge.toFixed(2),
    'Billable $': g.billable.toFixed(2), 'Pay $': g.pay.toFixed(2),
    'Margin $': g.margin.toFixed(2), 'Margin %': g.margin_pct.toFixed(1),
  });
  const out = [];
  for (const c of report.clients) {
    out.push(row(c.client, '(all sites)', c));
    for (const s of c.sites) out.push(row(c.client, s.site, s));
  }
  out.push(row('TOTAL', '', report.totals));
  return out;
}
