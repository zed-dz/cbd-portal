import { Fragment, useState, useEffect } from 'react';
import { supabase } from '../../supabaseClient';
import { WORKER_SAFE_COLS } from '../../utils/workerCols';
import { C, MONO, btnPrimary, btnSecondary, btnSmall } from '../../theme';
import { todayISO } from '../../utils/dates';
import { downloadCSV } from '../../utils/csv';
import { buildMarginReport, marginReportCSVRows } from '../../utils/marginReport';
import { DateField, Spinner, TableWrap, Th, Td, EmptyState, presetBounds } from '../../components';

// Labour margin per client / site — ADMIN ONLY. Charge and pay come from the
// same payroll utils as the Payroll page (over approved + client-accepted
// sheets), so the two screens always agree. Everything money lives behind
// the admin views (v_workers_admin, v_clients_admin, v_plant_items_admin).
function MarginReport({ showToast }) {
  const [from, setFrom] = useState(() => presetBounds('this_week')[0]);
  const [to, setTo] = useState(() => presetBounds('this_week')[1]);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(() => new Set());

  const run = async () => {
    if (!from || !to) { showToast?.('Pick a from and to date first.', 'error'); return; }
    setLoading(true);
    try {
      const [t, w, cl, cfg, rc, rr] = await Promise.all([
        supabase.from('timesheets').select('*, workers(name)')
          .eq('status', 'approved').or('client_approved.eq.true,header_id.is.null')
          .gte('date', from).lte('date', to).order('date'),
        supabase.from('v_workers_admin').select('id, name, worker_type, pay_rate_regular, pay_rate_overtime, subcontractor_abn'),
        supabase.from('v_clients_admin').select('id, name, rate_a, rate_b, rate_c, rate_regular, rate_overtime, rate_night, rate_weekend'),
        supabase.from('v_payroll_config').select('config_key, config_value'),
        supabase.from('client_rate_cards').select('client_id, role_name, rate_a, rate_b, rate_c'),
        supabase.from('worker_role_rates').select('worker_id, role_name, rate_normal, rate_overtime').is('archived_at', null),
      ]);
      const err = [t, w, cl, cfg, rc, rr].find(r => r.error)?.error;
      if (err) throw err;
      const config = {};
      (cfg.data || []).forEach(r => { config[r.config_key] = r.config_value; });
      // Plant hours on the sheets in range, priced from the admin plant view.
      const headerIds = [...new Set((t.data || []).map(x => x.header_id).filter(Boolean))];
      let plantRows = [];
      if (headerIds.length) {
        const [ph, pi] = await Promise.all([
          supabase.from('plant_hours').select('header_id, plant_id, hours').in('header_id', headerIds),
          supabase.from('v_plant_items_admin').select('id, name, hourly_charge'),
        ]);
        const byId = Object.fromEntries((pi.data || []).map(p => [p.id, p]));
        plantRows = (ph.data || []).map(p => ({ ...p, plant_items: byId[p.plant_id] || null }));
      }
      setReport(buildMarginReport({ timesheets: t.data || [], workers: w.data || [], clients: cl.data || [], rateCards: rc.data || [], roleRates: rr.data || [], config, plantRows }));
      setOpen(new Set());
    } catch (e) {
      showToast?.(e.message, 'error');
    }
    setLoading(false);
  };

  const toggle = (name) => setOpen(prev => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  const money = (n) => `$${Number(n || 0).toFixed(2)}`;
  const marginColor = (pct) => (pct >= 25 ? C.success : pct >= 10 ? C.warning : C.error);
  const exportCSV = () => {
    if (!report?.clients?.length) return;
    downloadCSV(`labour_margin_${from}_to_${to}.csv`, marginReportCSVRows(report));
    showToast?.('Margin report exported', 'success');
  };

  return (
    <div data-area="labour margin report" style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: 20, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <h3 style={{ color: C.text, margin: 0, fontSize: 15 }}>Labour margin</h3>
        <span style={{ fontSize: 12, color: C.textMuted }}>admin only · approved + client-accepted sheets · charge vs pay per client, expandable per site</span>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 12 }}>
        <div>
          <label style={{ color: C.textMuted, fontSize: 13, display: 'block', marginBottom: 4 }}>From</label>
          <div style={{ width: 190 }}><DateField value={from} onChange={setFrom} placeholder="Start date…" /></div>
        </div>
        <div>
          <label style={{ color: C.textMuted, fontSize: 13, display: 'block', marginBottom: 4 }}>To</label>
          <div style={{ width: 190 }}><DateField value={to} onChange={setTo} placeholder="End date…" /></div>
        </div>
        <button onClick={run} disabled={loading} style={{ ...btnPrimary, minHeight: 36 }}>{loading ? 'Calculating…' : '▶ Run report'}</button>
        <button onClick={exportCSV} disabled={!report?.clients?.length} style={{ ...btnSecondary, minHeight: 36, opacity: report?.clients?.length ? 1 : 0.5 }}>↓ Export CSV</button>
      </div>

      {loading && <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><Spinner /></div>}
      {!loading && report && !report.clients.length && <div style={{ marginTop: 14 }}><EmptyState message="No approved, client-accepted shifts in that range." icon="📉" /></div>}
      {!loading && report && report.clients.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <TableWrap>
            <thead>
              <tr><Th>Client / site</Th><Th>Shifts</Th><Th>Hours</Th><Th>Plant hrs</Th><Th>Charge (billable)</Th><Th>Pay</Th><Th>Margin $</Th><Th>Margin %</Th></tr>
            </thead>
            <tbody>
              {report.clients.map(c => (
                <Fragment key={c.client}>
                  <tr style={{ cursor: 'pointer' }} onClick={() => toggle(c.client)}>
                    <Td>
                      <button type="button" aria-label={open.has(c.client) ? 'Collapse sites' : 'Expand sites'} style={{ ...btnSmall, fontSize: 10, padding: '2px 7px', marginRight: 8 }}>
                        {open.has(c.client) ? '▾' : '▸'}
                      </button>
                      <strong>{c.client}</strong>
                      <span style={{ fontSize: 11, color: C.textMuted, marginLeft: 6 }}>{c.sites.length} site{c.sites.length === 1 ? '' : 's'}</span>
                    </Td>
                    <Td>{c.shifts}</Td>
                    <Td style={{ fontFamily: MONO }}>{c.hours.toFixed(2)}</Td>
                    <Td style={{ fontFamily: MONO }}>{c.plant_hours > 0 ? c.plant_hours.toFixed(2) : '—'}</Td>
                    <Td style={{ fontFamily: MONO, color: C.warning }}>
                      {money(c.billable)}
                      {c.plant_charge > 0 && <div style={{ fontSize: 10, color: C.textMuted }}>incl. plant {money(c.plant_charge)}</div>}
                    </Td>
                    <Td style={{ fontFamily: MONO, color: C.success }}>{money(c.pay)}</Td>
                    <Td style={{ fontFamily: MONO, fontWeight: 700, color: c.margin >= 0 ? C.text : C.error }}>{money(c.margin)}</Td>
                    <Td><span style={{ fontFamily: MONO, fontWeight: 700, color: marginColor(c.margin_pct) }}>{c.margin_pct.toFixed(1)}%</span></Td>
                  </tr>
                  {open.has(c.client) && c.sites.map(s => (
                    <tr key={`${c.client}|${s.site}`} style={{ background: C.bg }}>
                      <Td><span style={{ paddingLeft: 34, color: C.textMuted }}>↳ {s.site}</span></Td>
                      <Td>{s.shifts}</Td>
                      <Td style={{ fontFamily: MONO }}>{s.hours.toFixed(2)}</Td>
                      <Td style={{ fontFamily: MONO }}>{s.plant_hours > 0 ? s.plant_hours.toFixed(2) : '—'}</Td>
                      <Td style={{ fontFamily: MONO, color: C.warning }}>{money(s.billable)}</Td>
                      <Td style={{ fontFamily: MONO, color: C.success }}>{money(s.pay)}</Td>
                      <Td style={{ fontFamily: MONO, color: s.margin >= 0 ? C.text : C.error }}>{money(s.margin)}</Td>
                      <Td><span style={{ fontFamily: MONO, color: marginColor(s.margin_pct) }}>{s.margin_pct.toFixed(1)}%</span></Td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td style={{ padding: '10px 16px', color: C.textMuted, fontSize: 13, borderTop: `2px solid ${C.border}` }}>Totals · {report.clients.length} client{report.clients.length === 1 ? '' : 's'}</td>
                <td style={{ padding: '10px 16px', fontWeight: 700, borderTop: `2px solid ${C.border}` }}>{report.totals.shifts}</td>
                <td style={{ padding: '10px 16px', fontWeight: 700, fontFamily: MONO, borderTop: `2px solid ${C.border}` }}>{report.totals.hours.toFixed(2)}</td>
                <td style={{ padding: '10px 16px', fontWeight: 700, fontFamily: MONO, borderTop: `2px solid ${C.border}` }}>{report.totals.plant_hours > 0 ? report.totals.plant_hours.toFixed(2) : '—'}</td>
                <td style={{ padding: '10px 16px', fontWeight: 700, fontFamily: MONO, color: C.warning, borderTop: `2px solid ${C.border}` }}>{money(report.totals.billable)}</td>
                <td style={{ padding: '10px 16px', fontWeight: 700, fontFamily: MONO, color: C.success, borderTop: `2px solid ${C.border}` }}>{money(report.totals.pay)}</td>
                <td style={{ padding: '10px 16px', fontWeight: 800, fontFamily: MONO, color: report.totals.margin >= 0 ? C.text : C.error, borderTop: `2px solid ${C.border}` }}>{money(report.totals.margin)}</td>
                <td style={{ padding: '10px 16px', fontWeight: 800, fontFamily: MONO, color: marginColor(report.totals.margin_pct), borderTop: `2px solid ${C.border}` }}>{report.totals.margin_pct.toFixed(1)}%</td>
              </tr>
            </tfoot>
          </TableWrap>
          <div style={{ fontSize: 11, color: C.textDim, marginTop: 8 }}>
            Charge = the client's Schedule of Rates (A/B/C bands) + plant hours × hourly charge. Pay = worker pay incl. penalties and allowances (subcontractor rates as typed). Training days bill nothing.
          </div>
        </div>
      )}
    </div>
  );
}

export function ReportsPage({ showToast, currentWorker }) {
  const isAdmin = currentWorker?.access_level === 'admin';
  const [counts, setCounts] = useState({});
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [exporting, setExporting] = useState({});

  useEffect(() => {
    (async () => {
      const [w, a, t, c, cl] = await Promise.all([
        supabase.from('workers').select('id', { count: 'exact' }),
        supabase.from('allocations').select('id', { count: 'exact' }),
        supabase.from('timesheets').select('id', { count: 'exact' }),
        supabase.from('certifications').select('id', { count: 'exact' }),
        supabase.from('clients').select('id', { count: 'exact' }),
      ]);
      setCounts({ workers: w.count || 0, allocations: a.count || 0, timesheets: t.count || 0, certifications: c.count || 0, clients: cl.count || 0 });
    })();
  }, []);

  const doExport = async (type) => {
    setExporting(e => ({ ...e, [type]: true }));
    try {
      if (type === 'workers') {
        // Admins export everything incl. pay via the definer view; managers get
        // the safe-column export (the DB refuses them the pay columns anyway).
        let { data, error } = await supabase.from('v_workers_admin').select('*');
        if (!error && (data || []).length === 0) {
          ({ data, error } = await supabase.from('workers').select(WORKER_SAFE_COLS));
        }
        if (error) throw error;
        downloadCSV(`workers_export_${todayISO()}.csv`, data);
      } else if (type === 'allocations') {
        const { data, error } = await supabase.from('allocations').select('*, workers(name)');
        if (error) throw error;
        const rows = data.map(({ workers, ...r }) => ({ worker_name: workers?.name, ...r }));
        downloadCSV(`allocations_export_${todayISO()}.csv`, rows);
      } else if (type === 'timesheets') {
        let q = supabase.from('timesheets').select('*, workers(name)');
        if (dateFrom) q = q.gte('date', dateFrom);
        if (dateTo) q = q.lte('date', dateTo);
        const { data, error } = await q;
        if (error) throw error;
        const rows = data.map(({ workers, ...r }) => ({ worker_name: workers?.name, ...r }));
        downloadCSV(`timesheets_export_${todayISO()}.csv`, rows);
      } else if (type === 'certifications') {
        const { data, error } = await supabase.from('certifications').select('*, workers(name)');
        if (error) throw error;
        const rows = data.map(({ workers, ...r }) => ({ worker_name: workers?.name, ...r }));
        downloadCSV(`certifications_export_${todayISO()}.csv`, rows);
      } else if (type === 'clients') {
        // Admins get money columns through the view; others get the safe columns.
        let { data, error } = await supabase.from('v_clients_admin').select('*');
        if (error || !data?.length) ({ data, error } = await supabase.from('clients').select('id, name, site, contact, contact_email, contact_phone, notes, created_at, email_domains, rate_set_id, award_profile, archived_at'));
        if (error) throw error;
        downloadCSV(`clients_export_${todayISO()}.csv`, data);
      }
      showToast(`${type} exported successfully`, 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
    setExporting(e => ({ ...e, [type]: false }));
  };

  const exports = [
    { key: 'workers', label: 'Workers Export', desc: 'All worker records' },
    { key: 'allocations', label: 'Allocations Export', desc: 'All allocations with worker names' },
    { key: 'timesheets', label: 'Timesheets Export', desc: 'All timesheets with worker names (use date filter)' },
    { key: 'certifications', label: 'Certifications Export', desc: 'All certifications with worker names' },
    { key: 'clients', label: 'Clients Export', desc: 'All client records with rates and contacts' },
  ];

  return (
    <div>
      {isAdmin && <MarginReport showToast={showToast} />}
      <div style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: 20, marginBottom: 20 }}>
        <h3 style={{ color: C.text, marginBottom: 12, fontSize: 15 }}>Date Range Filter (for Timesheets & Allocations)</h3>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <label style={{ color: C.textMuted, fontSize: 13, display: 'block', marginBottom: 4 }}>From</label>
            <div style={{ width: 190 }}><DateField value={dateFrom} onChange={setDateFrom} placeholder="Start date…" /></div>
          </div>
          <div>
            <label style={{ color: C.textMuted, fontSize: 13, display: 'block', marginBottom: 4 }}>To</label>
            <div style={{ width: 190 }}><DateField value={dateTo} onChange={setDateTo} placeholder="End date…" /></div>
          </div>
          <button onClick={() => { setDateFrom(''); setDateTo(''); }} style={{ ...btnSecondary, alignSelf: 'flex-end' }}>Clear</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        {exports.map(exp => (
          <div key={exp.key} style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: 24 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 4 }}>{exp.label}</div>
            <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 16 }}>{exp.desc}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: C.textMuted, fontSize: 13 }}>{counts[exp.key] ?? '…'} records</span>
              <button onClick={() => doExport(exp.key)} disabled={exporting[exp.key]} style={btnPrimary}>
                {exporting[exp.key] ? 'Exporting…' : '↓ Export CSV'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
