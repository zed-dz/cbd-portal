// "Auto from portal data" for a partner placement period (spec 6/7).
// Revenue collected = what the client actually PAID on invoices covering the
// period (client_invoices.amount_paid). Cost + hours come from the same margin
// maths the Reports page uses (buildMarginReport over approved timesheets), so
// the number here can never disagree with the Labour margin report. Money
// views only — the caller is already behind isMoneyUser.
import { buildMarginReport } from './marginReport';

const num = (v) => parseFloat(v) || 0;
const r2 = (n) => Math.round(n * 100) / 100;

// Overlap of [a1,a2] with [b1,b2] in days (inclusive), 0 when disjoint.
export function overlapDays(a1, a2, b1, b2) {
  const s = a1 > b1 ? a1 : b1, e = a2 < b2 ? a2 : b2;
  if (!s || !e || s > e) return 0;
  return Math.round((new Date(e + 'T00:00:00Z') - new Date(s + 'T00:00:00Z')) / 86400000) + 1;
}

// Share of each invoice's paid amount that falls inside the period, pro-rata
// by days when the invoice period straddles the edges.
export function collectedInPeriod(invoices, from, to) {
  let total = 0;
  const used = [];
  for (const inv of invoices || []) {
    const paid = num(inv.amount_paid);
    if (paid <= 0) continue;
    const f = inv.period_from || inv.period_to, t = inv.period_to || inv.period_from;
    if (!f || !t) continue;
    const span = overlapDays(f, t, f, t), inside = overlapDays(f, t, from, to);
    if (!inside) continue;
    const share = r2(paid * inside / span);
    total += share;
    used.push({ id: inv.id, number: inv.xero_invoice_number || null, paid, share, period_from: f, period_to: t });
  }
  return { collected: r2(total), invoices: used };
}

// Pulls everything for one client + period and returns the numbers to fill in.
export async function autoFromPortal(supabase, { clientId, clientName, from, to }) {
  if (!from || !to) throw new Error('Pick the period first.');
  const [t, w, cl, cfg, rc, rr, inv] = await Promise.all([
    supabase.from('timesheets').select('*, workers(name)').eq('status', 'approved').or('client_approved.eq.true,header_id.is.null').gte('date', from).lte('date', to).order('date'),
    supabase.from('v_workers_admin').select('id, name, worker_type, pay_rate_regular, pay_rate_overtime, subcontractor_abn'),
    supabase.from('v_clients_admin').select('id, name, rate_a, rate_b, rate_c, rate_regular, rate_overtime, rate_night, rate_weekend'),
    supabase.from('v_payroll_config').select('config_key, config_value'),
    supabase.from('client_rate_cards').select('client_id, role_name, rate_a, rate_b, rate_c'),
    supabase.from('worker_role_rates').select('worker_id, role_name, rate_normal, rate_overtime').is('archived_at', null),
    clientId
      ? supabase.from('client_invoices').select('id, client_id, client, period_from, period_to, amount_paid, total, xero_invoice_number, status, xero_status').eq('client_id', clientId).lte('period_from', to).gte('period_to', from)
      : Promise.resolve({ data: [] }),
  ]);
  const err = [t, w, cl, cfg, rc, rr, inv].find(x => x?.error)?.error;
  if (err) throw err;
  const config = {};
  (cfg.data || []).forEach(r => { config[r.config_key] = r.config_value; });
  // Only this client's shifts.
  const sheets = (t.data || []).filter(ts => clientId ? (ts.client_id === clientId || (!ts.client_id && clientName && ts.client === clientName)) : (clientName && ts.client === clientName));
  const headerIds = [...new Set(sheets.map(x => x.header_id).filter(Boolean))];
  let plantRows = [];
  if (headerIds.length) {
    const [ph, pi] = await Promise.all([
      supabase.from('plant_hours').select('header_id, plant_id, hours').in('header_id', headerIds),
      supabase.from('v_plant_items_admin').select('id, name, hourly_charge'),
    ]);
    const byId = Object.fromEntries((pi.data || []).map(p => [p.id, p]));
    plantRows = (ph.data || []).map(p => ({ ...p, plant_items: byId[p.plant_id] || null }));
  }
  const report = buildMarginReport({ timesheets: sheets, workers: w.data || [], clients: cl.data || [], rateCards: rc.data || [], roleRates: rr.data || [], config, plantRows });
  const { collected, invoices } = collectedInPeriod(inv.data || [], from, to);
  return {
    hours: report.totals.hours,
    revenue_billed: report.totals.billable,
    revenue_collected: collected,
    cost: report.totals.pay,
    shifts: report.totals.shifts,
    invoices,
    note: `Auto from portal ${from} → ${to}: ${report.totals.shifts} approved shifts, ${report.totals.hours.toFixed(2)} h billed ${report.totals.billable.toFixed(2)}, pay ${report.totals.pay.toFixed(2)}; collected from ${invoices.length} paid invoice(s).`,
  };
}
