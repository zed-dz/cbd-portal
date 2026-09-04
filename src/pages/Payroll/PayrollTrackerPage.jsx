import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnSecondary, btnSmall } from '../../theme';
import { fmtDate } from '../../utils/dates';
import { downloadCSV } from '../../utils/csv';
import { computePayrollRow, buildXeroCSV, buildPayBreakdownCSV, applyFullTimeMinDay, findRateLine } from '../../utils/payroll';
import { Spinner, TableWrap, Th, Td, EmptyState } from '../../components';

const XERO_AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
const XERO_CLIENT_ID = process.env.REACT_APP_XERO_CLIENT_ID || '';
const REDIRECT_URI = 'https://tsizneslellcqusjwtub.supabase.co/functions/v1/xero-callback';
const XERO_SCOPES = 'openid profile email offline_access payroll.employees payroll.payruns payroll.payslip accounting.contacts.read';

export function PayrollTrackerPage({ showToast }) {
  const [timesheets, setTimesheets] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [clients, setClients] = useState([]);
  const [rateCards, setRateCards] = useState([]);
  const [configMap, setConfigMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [filterWorker, setFilterWorker] = useState('all');
  const [xeroConnected, setXeroConnected] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [pushing, setPushing] = useState(false);

  // Check Xero connection status on mount
  useEffect(() => {
    checkXeroConnection();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkXeroConnection = async () => {
    const { data } = await supabase.from('xero_tokens').select('id, expires_at').eq('id', 1).single();
    setXeroConnected(!!data?.id);
  };

  const connectXero = () => {
    const state = Math.random().toString(36).slice(2);
    sessionStorage.setItem('xero_oauth_state', state);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id:     XERO_CLIENT_ID,
      redirect_uri:  REDIRECT_URI,
      scope:         XERO_SCOPES,
      state,
    });
    window.location.href = `${XERO_AUTH_URL}?${params}`;
  };

  const load = useCallback(async () => {
    setLoading(true);
    // Billable = admin-approved AND client-accepted. Legacy rows without a
    // daily-timesheet header predate the supervisor chain and stay billable.
    let q = supabase.from('timesheets').select('*, workers(name)')
      .eq('status', 'approved')
      .or('client_approved.eq.true,header_id.is.null')
      .order('date', { ascending: false });
    if (dateFrom) q = q.gte('date', dateFrom);
    if (dateTo) q = q.lte('date', dateTo);
    const [t, w, cl, cfg, rc] = await Promise.all([
      q,
      supabase.from('workers').select('id, name, worker_type, pay_rate_regular, pay_rate_overtime, subcontractor_abn').order('name'),
      supabase.from('clients').select('id, name, rate_a, rate_b, rate_c, rate_regular, rate_overtime, rate_night, rate_weekend').order('name'),
      supabase.from('payroll_config').select('config_key, config_value'),
      // Per-client Schedule of Rates. Charging bills column A/B/C off the line
      // that matches the timesheet's role, so a night shift is billed at the
      // loaded rate instead of the flat one.
      supabase.from('client_rate_cards').select('client_id, role_name, rate_a, rate_b, rate_c'),
    ]);
    if (t.error) showToast(t.error.message, 'error');
    else setTimesheets(t.data || []);
    if (w.data) setWorkers(w.data);
    if (cl.data) setClients(cl.data);
    if (rc.data) setRateCards(rc.data);
    if (cfg.data) {
      const map = {};
      cfg.data.forEach(r => { map[r.config_key] = r.config_value; });
      setConfigMap(map);
    }
    setLoading(false);
  }, [showToast, dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  // Full-timers on a short standard weekday are topped up to a full day's pay
  // (client still charged actual hours) before the per-row pay computation.
  const workersById = Object.fromEntries(workers.map(w => [w.id, w]));
  const payrollRows = applyFullTimeMinDay(timesheets, workersById, configMap).map(ts => {
    const worker = workers.find(w => w.id === ts.worker_id) || {};
    // Prefer the real foreign key. Falling back to the typed name is what caused
    // the wrong-rate bug: several clients share a name, differ only by site, and
    // carry different rate cards, so first-match-wins billed at whichever row
    // happened to sort first. Rows written before the ids existed still resolve by
    // name — correct for every client whose name is unique.
    const client = (ts.client_id && clients.find(c => c.id === ts.client_id))
      || clients.find(c => c.name === ts.client)
      || null;
    const { line: rateLine, match: rateMatch } = client
      ? findRateLine(rateCards.filter(r => r.client_id === client.id), ts.role)
      : { line: null, match: 'none' };
    return { ...computePayrollRow(ts, { ...worker, name: ts.workers?.name || worker.name }, client, configMap, rateLine, rateMatch), _id: ts.id, _worker_id: ts.worker_id, _xero_exported: ts.xero_exported };
  });

  // Only offer workers who actually have rows in the current range. A dropdown of
  // every worker ever hired is unusable during a pay run.
  const workersInRange = workers.filter(w => payrollRows.some(r => r._worker_id === w.id));

  const filtered = payrollRows.filter(r =>
    (filterType === 'all' || r.worker_type === filterType) &&
    (filterWorker === 'all' || r._worker_id === filterWorker)
  );

  const num = (v) => parseFloat(v) || 0;

  // Bucket hours and bucket dollars come straight off computePayrollRow, so these
  // totals cannot disagree with the per-row figures the way a re-derived
  // "pay - ot - rdo" sum could.
  const totals = filtered.reduce((acc, r) => ({
    pay_hours:      acc.pay_hours      + num(r.pay_hours),
    ordinary_hours: acc.ordinary_hours + num(r.ordinary_hours),
    ot15_hours:     acc.ot15_hours     + num(r.ot15_hours),
    ot2x_hours:     acc.ot2x_hours     + num(r.ot2x_hours),
    rdo_hours:      acc.rdo_hours      + num(r.rdo_hours),
    ordinary_pay:   acc.ordinary_pay   + num(r.ordinary_pay),
    ot15_pay:       acc.ot15_pay       + num(r.ot15_pay),
    ot2x_pay:       acc.ot2x_pay       + num(r.ot2x_pay),
    allowances:     acc.allowances     + num(r.travel_allowance) + num(r.meal_allowance),
    total_pay:      acc.total_pay      + num(r.total_pay),
    charge_amount:  acc.charge_amount  + num(r.charge_amount),
  }), { pay_hours: 0, ordinary_hours: 0, ot15_hours: 0, ot2x_hours: 0, rdo_hours: 0,
        ordinary_pay: 0, ot15_pay: 0, ot2x_pay: 0, allowances: 0, total_pay: 0, charge_amount: 0 });

  // One line per worker: the view the office actually pays from.
  const byWorker = Object.values(filtered.reduce((acc, r) => {
    const k = r._worker_id || r.worker_name;
    if (!acc[k]) acc[k] = { key: k, name: r.worker_name, type: r.worker_type, shifts: 0,
                            ordinary: 0, ot15: 0, ot2x: 0, rdo: 0, allowances: 0, pay: 0, charge: 0 };
    const a = acc[k];
    a.shifts     += 1;
    a.ordinary   += num(r.ordinary_hours);
    a.ot15       += num(r.ot15_hours);
    a.ot2x       += num(r.ot2x_hours);
    a.rdo        += num(r.rdo_hours);
    a.allowances += num(r.travel_allowance) + num(r.meal_allowance);
    a.pay        += num(r.total_pay);
    a.charge     += num(r.charge_amount);
    return acc;
  }, {})).sort((a, b) => b.pay - a.pay);

  const handleXeroExport = () => {
    const staffRows = filtered.filter(r => r.worker_type !== 'subcontractor');
    if (!staffRows.length) { showToast('No staff timesheets to export.', 'info'); return; }
    buildXeroCSV(staffRows, dateFrom || 'all', dateTo || 'dates', downloadCSV);
    showToast('Xero CSV exported', 'success');
  };

  // The pay-run export: every row with normal / 1.5x / 2x hours AND dollars, so the
  // office can see what each worker is owed without opening the portal.
  const handleBreakdownExport = () => {
    if (!filtered.length) { showToast('Nothing to export in this range.', 'info'); return; }
    buildPayBreakdownCSV(filtered, dateFrom || 'all', dateTo || 'dates', downloadCSV);
    showToast(`Pay breakdown exported (${filtered.length} rows)`, 'success');
  };

  const handleSubExport = () => {
    const subRows = filtered.filter(r => r.worker_type === 'subcontractor');
    if (!subRows.length) { showToast('No subcontractor timesheets.', 'info'); return; }
    const rows = subRows.map(r => ({
      worker_name: r.worker_name, date: r.date, site: r.site, client: r.client,
      pay_hours: r.pay_hours, total_pay: r.total_pay, awj_reference: r.awj_reference,
      scenario: r.scenario,
    }));
    downloadCSV(`subcontractors_${dateFrom || 'all'}.csv`, rows);
    showToast('Subcontractor CSV exported', 'success');
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const staffIds = filtered.filter(r => r.worker_type !== 'subcontractor').map(r => r._id);
    if (staffIds.every(id => selectedIds.has(id))) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(staffIds));
    }
  };

  // One-click: select all staff that haven't been pushed to Xero yet
  const selectAllUnexported = () => {
    const ids = filtered
      .filter(r => r.worker_type !== 'subcontractor' && !r._xero_exported)
      .map(r => r._id);
    setSelectedIds(new Set(ids));
  };

  // Stats for the push summary bar
  const selectedRows = filtered.filter(r => selectedIds.has(r._id));
  const selectedHours = selectedRows.reduce((s, r) => s + (parseFloat(r.pay_hours) || 0), 0);
  const selectedPay   = selectedRows.reduce((s, r) => s + (parseFloat(r.total_pay) || 0), 0);
  const unexportedCount = filtered.filter(r => r.worker_type !== 'subcontractor' && !r._xero_exported).length;

  const handlePushToXero = async () => {
    if (!selectedIds.size) { showToast('Select at least one timesheet to push.', 'info'); return; }
    if (!xeroConnected) { showToast('Connect Xero first.', 'error'); return; }
    if (!dateFrom || !dateTo) { showToast('Set a date range for the pay period first.', 'error'); return; }

    setPushing(true);
    showToast('Pushing to Xero…', 'info');

    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(
      'https://tsizneslellcqusjwtub.supabase.co/functions/v1/xero-push',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session?.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          timesheetIds: [...selectedIds],
          periodFrom: dateFrom,
          periodTo: dateTo,
        }),
      }
    );

    const result = await res.json();
    if (!res.ok) {
      showToast(result.error || 'Push failed', 'error');
    } else {
      showToast(`Pushed ${result.pushed} timesheets to Xero${result.skipped ? ` (${result.skipped} skipped — no matching Xero employee)` : ''}`, result.errors ? 'error' : 'success');
      if (result.pushed > 0) { setSelectedIds(new Set()); load(); }
    }
    setPushing(false);
  };

  return (
    <div>

      {/* ── Workflow guide ────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: 16, background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', flexWrap: 'wrap' }}>
        {[
          { n: '1', label: 'Approve timesheets', hint: 'Approve in Timesheets → the site supervisor accepts → billable here', done: true },
          { n: '2', label: 'Set pay period', hint: 'Pick From / To dates below', done: !!(dateFrom && dateTo) },
          { n: '3', label: 'Select staff', hint: `Click "Select Unexported" or tick rows`, done: selectedIds.size > 0 },
          { n: '4', label: 'Push to Xero', hint: xeroConnected ? 'Click the blue Push button' : 'Connect Xero first ↑', done: false },
        ].map((step, i) => (
          <div key={i} style={{
            flex: '1 1 140px', padding: '10px 14px',
            borderRight: i < 3 ? `1px solid ${C.border}` : 'none',
            background: step.done ? 'rgba(34,197,94,0.06)' : 'transparent',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <span style={{
                width: 20, height: 20, borderRadius: '50%', display: 'inline-flex',
                alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800,
                background: step.done ? C.success : C.border,
                color: step.done ? '#fff' : C.textMuted, flexShrink: 0,
              }}>{step.done ? '✓' : step.n}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: step.done ? C.success : C.text }}>{step.label}</span>
            </div>
            <div style={{ fontSize: 11, color: C.textMuted, paddingLeft: 26 }}>{step.hint}</div>
          </div>
        ))}
      </div>

      {/* ── Xero connection bar ───────────────────────────────────────────── */}
      <div style={{
        background: xeroConnected ? 'rgba(19,181,234,0.07)' : 'rgba(249,115,22,0.07)',
        border: `1px solid ${xeroConnected ? 'rgba(19,181,234,0.25)' : 'rgba(249,115,22,0.25)'}`,
        borderRadius: 10, padding: '10px 16px', marginBottom: 16,
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 13, color: xeroConnected ? '#13B5EA' : C.textMuted }}>
          {xeroConnected ? '✓ Xero connected' : '⚠ Xero not connected — connect before pushing'}
        </span>
        {!xeroConnected && (
          <button onClick={connectXero} disabled={!XERO_CLIENT_ID} style={{
            background: '#13B5EA', color: '#fff', border: 'none', borderRadius: 6,
            padding: '6px 14px', fontSize: 12, fontWeight: 700,
            cursor: XERO_CLIENT_ID ? 'pointer' : 'not-allowed', opacity: XERO_CLIENT_ID ? 1 : 0.5,
          }}>
            {XERO_CLIENT_ID ? 'Connect Xero' : 'Set REACT_APP_XERO_CLIENT_ID first'}
          </button>
        )}
        {xeroConnected && <button onClick={connectXero} style={{ ...btnSmall, fontSize: 11 }}>Reconnect</button>}
        {xeroConnected && unexportedCount > 0 && (
          <span style={{ fontSize: 12, color: C.textMuted }}>
            {unexportedCount} timesheet{unexportedCount !== 1 ? 's' : ''} ready to push
          </span>
        )}
        {xeroConnected && unexportedCount === 0 && !loading && filtered.length > 0 && (
          <span style={{ fontSize: 12, color: C.success }}>All timesheets in this range already pushed</span>
        )}
      </div>

      {/* ── Filters + totals ──────────────────────────────────────────────── */}
      <div style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: 18, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label style={{ color: C.textMuted, fontSize: 12, display: 'block', marginBottom: 4 }}>Pay period from</label>
            <input style={{ ...inputStyle, width: 155 }} type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          </div>
          <div>
            <label style={{ color: C.textMuted, fontSize: 12, display: 'block', marginBottom: 4 }}>Pay period to</label>
            <input style={{ ...inputStyle, width: 155 }} type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </div>
          <div>
            <label style={{ color: C.textMuted, fontSize: 12, display: 'block', marginBottom: 4 }}>Worker type</label>
            <select style={{ ...inputStyle, width: 170 }} value={filterType} onChange={e => setFilterType(e.target.value)}>
              <option value="all">All Types</option>
              <option value="full-time">Full-Time</option>
              <option value="casual">Casual</option>
              <option value="subcontractor">Subcontractor</option>
            </select>
          </div>
          <div>
            <label style={{ color: C.textMuted, fontSize: 12, display: 'block', marginBottom: 4 }}>Worker</label>
            <select style={{ ...inputStyle, width: 200 }} value={filterWorker} onChange={e => setFilterWorker(e.target.value)}>
              <option value="all">All workers ({workersInRange.length})</option>
              {workersInRange.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
          <button onClick={() => { setDateFrom(''); setDateTo(''); setFilterType('all'); setFilterWorker('all'); }} style={btnSecondary}>Clear</button>
          <div style={{ marginLeft: 'auto', background: C.bg, borderRadius: 8, padding: '10px 18px', border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.text }}>{totals.ordinary_hours.toFixed(1)}h</div>
            <div style={{ color: C.textMuted, fontSize: 11 }}>Normal time · ${totals.ordinary_pay.toFixed(2)}</div>
          </div>
          <div style={{ background: C.bg, borderRadius: 8, padding: '10px 18px', border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.warning }}>{totals.ot15_hours.toFixed(1)}h</div>
            <div style={{ color: C.textMuted, fontSize: 11 }}>OT 1.5× · ${totals.ot15_pay.toFixed(2)}</div>
          </div>
          <div style={{ background: C.bg, borderRadius: 8, padding: '10px 18px', border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.accent }}>{totals.ot2x_hours.toFixed(1)}h</div>
            <div style={{ color: C.textMuted, fontSize: 11 }}>OT 2× · ${totals.ot2x_pay.toFixed(2)}</div>
          </div>
          <div style={{ background: C.bg, borderRadius: 8, padding: '10px 18px', border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.success }}>{totals.rdo_hours.toFixed(1)}h</div>
            <div style={{ color: C.textMuted, fontSize: 11 }}>RDO accrued</div>
          </div>
          <div style={{ background: C.bg, borderRadius: 8, padding: '10px 18px', border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.success }}>${totals.total_pay.toFixed(2)}</div>
            <div style={{ color: C.textMuted, fontSize: 11 }}>Total pay amount</div>
          </div>
          <div style={{ background: C.bg, borderRadius: 8, padding: '10px 18px', border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.accent }}>${totals.charge_amount.toFixed(2)}</div>
            <div style={{ color: C.textMuted, fontSize: 11 }}>Total charge amount</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button onClick={handleXeroExport} style={{ ...btnSmall, color: '#93c5fd', borderColor: '#1e3a5f' }}>↓ Export Xero CSV (Staff)</button>
          <button onClick={handleBreakdownExport} style={{ ...btnSmall, color: '#86efac', borderColor: '#14532d' }}>↓ Export Pay Breakdown CSV</button>
          <button onClick={handleSubExport} style={{ ...btnSmall, color: '#fde047', borderColor: '#713f12' }}>↓ Export Subcontractors CSV</button>
        </div>
      </div>

      {/* ── Push action bar (shows when timesheets are selected) ──────────── */}
      {selectedIds.size > 0 && (
        <div style={{
          background: 'rgba(19,181,234,0.1)', border: '1px solid rgba(19,181,234,0.35)',
          borderRadius: 10, padding: '12px 18px', marginBottom: 16,
          display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
        }}>
          <div>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#13B5EA' }}>{selectedIds.size} timesheet{selectedIds.size !== 1 ? 's' : ''} selected</span>
            <span style={{ fontSize: 12, color: C.textMuted, marginLeft: 12 }}>{selectedHours.toFixed(1)} hrs · ${selectedPay.toFixed(2)} total pay</span>
            {dateFrom && dateTo && (
              <span style={{ fontSize: 12, color: C.textMuted, marginLeft: 12 }}>Pay period: {dateFrom} → {dateTo}</span>
            )}
          </div>
          {!dateFrom || !dateTo ? (
            <span style={{ fontSize: 12, color: C.warning, marginLeft: 'auto' }}>Set pay period dates first</span>
          ) : (
            <button onClick={handlePushToXero} disabled={pushing || !xeroConnected} style={{
              background: '#13B5EA', color: '#fff', border: 'none', borderRadius: 7,
              padding: '8px 20px', fontSize: 13, fontWeight: 700,
              cursor: xeroConnected ? 'pointer' : 'not-allowed', marginLeft: 'auto',
              opacity: xeroConnected ? 1 : 0.5,
            }}>
              {pushing ? 'Pushing to Xero…' : `↑ Push ${selectedIds.size} to Xero`}
            </button>
          )}
          <button onClick={() => setSelectedIds(new Set())} style={{ ...btnSmall, fontSize: 11 }}>Clear selection</button>
        </div>
      )}

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div> : filtered.length === 0 ? (
        <EmptyState message={dateFrom || dateTo ? 'No approved timesheets in this date range.' : 'No approved timesheets yet. Approve timesheets first, then come back here.'} />
      ) : (
        <>
          {/* Quick-select row above table */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
            {unexportedCount > 0 && (
              <button onClick={selectAllUnexported} style={{
                background: 'rgba(19,181,234,0.12)', border: '1px solid rgba(19,181,234,0.3)',
                color: '#13B5EA', borderRadius: 6, padding: '5px 12px', fontSize: 12,
                fontWeight: 600, cursor: 'pointer',
              }}>
                Select {unexportedCount} unexported staff
              </button>
            )}
            <button onClick={toggleSelectAll} style={{ ...btnSmall, fontSize: 11 }}>
              {filtered.filter(r => r.worker_type !== 'subcontractor').every(r => selectedIds.has(r._id)) ? 'Deselect all' : 'Select all staff'}
            </button>
            {selectedIds.size > 0 && (
              <span style={{ fontSize: 12, color: C.textMuted }}>{selectedIds.size} selected</span>
            )}
            <span style={{ fontSize: 12, color: C.textMuted, marginLeft: 'auto' }}>
              Rows with <span style={{ color: C.success }}>✓ sent</span> are already in Xero — you can skip those
            </span>
          </div>
        <TableWrap>
          <thead>
            <tr>
              <Th>
                <input type="checkbox"
                  onChange={toggleSelectAll}
                  checked={filtered.filter(r => r.worker_type !== 'subcontractor').length > 0 &&
                    filtered.filter(r => r.worker_type !== 'subcontractor').every(r => selectedIds.has(r._id))}
                  style={{ cursor: 'pointer' }}
                />
              </Th>
              <Th>Worker</Th><Th>Type</Th><Th>Date</Th><Th>Scenario</Th>
              <Th>Pay Hrs</Th><Th>Normal</Th><Th>OT 1.5×</Th><Th>OT 2×</Th><Th>Charge Hrs</Th>
              <Th>Allowances</Th><Th>Total Pay</Th><Th>Charge Amt</Th><Th>AWJ Ref</Th><Th>Xero</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={i} style={{ opacity: r._xero_exported ? 0.6 : 1 }}>
                <Td>
                  {r.worker_type !== 'subcontractor' && (
                    <input type="checkbox"
                      checked={selectedIds.has(r._id)}
                      onChange={() => toggleSelect(r._id)}
                      style={{ cursor: 'pointer' }}
                    />
                  )}
                </Td>
                <Td><strong>{r.worker_name}</strong></Td>
                <Td><span style={{ fontSize: 11, color: C.textMuted, fontFamily: '"DM Mono", monospace' }}>{r.worker_type}</span></Td>
                <Td>
                  <div style={{ whiteSpace: 'nowrap' }}>{r.day_name ? `${r.day_name.slice(0, 3)} ` : ''}{fmtDate(r.date)}</div>
                  {r.shift_times && (
                    <div style={{ fontSize: 10.5, color: C.textMuted, whiteSpace: 'nowrap' }}
                      title={r.break_minutes ? `${r.break_minutes} min break` : 'no break recorded'}>
                      {r.shift_times}{r.break_minutes ? ` · ${r.break_minutes}m` : ''}
                    </div>
                  )}
                </Td>
                <Td><span style={{ fontSize: 11, color: C.textMuted }}>{r.scenario}</span></Td>
                <Td><span style={{ fontWeight: 700 }}>{r.pay_hours}</span></Td>
                <Td title={`Normal time @ $${r.pay_rate}/hr`}>
                  {r.ordinary_hours > 0
                    ? <span>{r.ordinary_hours} <span style={{ fontSize: 10, color: C.textMuted }}>${r.ordinary_pay}</span></span>
                    : '—'}
                </Td>
                <Td title={`Overtime at 1.5x @ $${r.ot15_rate}/hr`}>
                  {r.ot15_hours > 0
                    ? <span style={{ color: C.warning }}>{r.ot15_hours} <span style={{ fontSize: 10, color: C.textMuted }}>${r.ot15_pay}</span></span>
                    : '—'}
                </Td>
                <Td title={`Overtime at 2x @ $${r.ot2x_rate}/hr`}>
                  {r.ot2x_hours > 0
                    ? <span style={{ color: C.accent }}>{r.ot2x_hours} <span style={{ fontSize: 10, color: C.textMuted }}>${r.ot2x_pay}</span></span>
                    : '—'}
                </Td>
                <Td>{r.charge_hours}</Td>
                <Td>
                  <div style={{ fontSize: 11, color: C.textMuted }}>
                    {r.travel_allowance > 0 && <span>T: ${r.travel_allowance} </span>}
                    {r.meal_allowance > 0 && <span>M: ${r.meal_allowance}</span>}
                    {r.rdo_hours > 0 && <span style={{ color: C.success }} title="Banked to the worker's RDO accrual — not paid in this run"> RDO +{r.rdo_hours}h</span>}
                    {r.min_day_topup > 0 && <span style={{ color: C.success }} title="Full-time minimum day: paid up to a full day, client charged actual hours"> +{r.min_day_topup}h min-day</span>}
                    {r.geo_loading && <span style={{ color: C.accent }}> GEO</span>}
                    {r.is_weekend && <span style={{ color: C.accent }}> WKD</span>}
                    {!r.travel_allowance && !r.meal_allowance && !r.min_day_topup && !r.geo_loading && !r.is_weekend && '—'}
                  </div>
                </Td>
                <Td><span style={{ fontWeight: 700, color: C.success }}>${r.total_pay}</span></Td>
                <Td>
                  <span style={{ color: C.warning }}>${r.charge_amount}</span>
                  {/* A row that never matched a priced line is billing the catch-all
                      rate, which can be well over or under the agreed price. Say so
                      rather than presenting it as the client's real rate. */}
                  {r.charge_rate_source === 'client-fallback' && (
                    <span title={`No Schedule of Rates line matches the role "${r.role || ''}" for ${r.client || 'this client'}. Billing the client's fallback A/B/C rate instead.`}
                      style={{ marginLeft: 6, fontSize: 10, color: C.textMuted, borderBottom: `1px dotted ${C.warning}`, cursor: 'help' }}>
                      fallback
                    </span>
                  )}
                  {r.charge_rate_source === 'legacy' && (
                    <span title="This client has no rate bands at all — billing the old single-rate column."
                      style={{ marginLeft: 6, fontSize: 10, color: C.danger || C.warning, cursor: 'help' }}>
                      ⚠ no rates
                    </span>
                  )}
                </Td>
                <Td><span style={{ fontSize: 11, color: C.textMuted }}>{r.awj_reference || '—'}</span></Td>
                <Td>
                  {r._xero_exported
                    ? <span style={{ fontSize: 11, color: C.success }}>✓ sent</span>
                    : <span style={{ fontSize: 11, color: C.textMuted }}>—</span>}
                </Td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td style={{ borderTop: `2px solid ${C.border}` }} />
              <td colSpan={4} style={{ padding: '10px 16px', color: C.textMuted, fontSize: 13, borderTop: `2px solid ${C.border}` }}>
                {filtered.length} records{totals.rdo_hours > 0 ? ` · RDO accrued ${totals.rdo_hours.toFixed(2)}h` : ''}
              </td>
              <td style={{ padding: '10px 16px', fontWeight: 700, color: C.text, borderTop: `2px solid ${C.border}`, whiteSpace: 'nowrap' }}>{totals.pay_hours.toFixed(2)}</td>
              <td style={{ padding: '10px 16px', fontWeight: 700, color: C.text, borderTop: `2px solid ${C.border}`, whiteSpace: 'nowrap' }}>
                {totals.ordinary_hours.toFixed(2)}
                <div style={{ fontSize: 10.5, fontWeight: 600, color: C.textMuted }}>${totals.ordinary_pay.toFixed(2)}</div>
              </td>
              <td style={{ padding: '10px 16px', fontWeight: 700, color: C.warning, borderTop: `2px solid ${C.border}`, whiteSpace: 'nowrap' }}>
                {totals.ot15_hours.toFixed(2)}
                <div style={{ fontSize: 10.5, fontWeight: 600, color: C.textMuted }}>${totals.ot15_pay.toFixed(2)}</div>
              </td>
              <td style={{ padding: '10px 16px', fontWeight: 700, color: C.accent, borderTop: `2px solid ${C.border}`, whiteSpace: 'nowrap' }}>
                {totals.ot2x_hours.toFixed(2)}
                <div style={{ fontSize: 10.5, fontWeight: 600, color: C.textMuted }}>${totals.ot2x_pay.toFixed(2)}</div>
              </td>
              <td colSpan={2} style={{ borderTop: `2px solid ${C.border}` }} />
              <td style={{ padding: '10px 16px', fontWeight: 700, color: C.success, borderTop: `2px solid ${C.border}` }}>${totals.total_pay.toFixed(2)}</td>
              <td style={{ padding: '10px 16px', fontWeight: 700, color: C.warning, borderTop: `2px solid ${C.border}` }}>${totals.charge_amount.toFixed(2)}</td>
              <td colSpan={2} style={{ borderTop: `2px solid ${C.border}` }} />
            </tr>
          </tfoot>
        </TableWrap>

        {/* Pay summary by worker: the pay run in one line per person - what they
            worked, in which bucket, and what they get paid. */}
        {byWorker.length > 0 && (
          <div style={{ marginTop: 22 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
              <h3 style={{ margin: 0, fontSize: 15, color: C.text }}>Pay summary by worker</h3>
              <span style={{ fontSize: 12, color: C.textMuted }}>
                {byWorker.length} worker{byWorker.length !== 1 ? 's' : ''} · what each person is owed for this period
              </span>
            </div>
            <TableWrap>
              <thead>
                <tr>
                  <Th>Worker</Th><Th>Type</Th><Th>Shifts</Th>
                  <Th>Normal</Th><Th>OT 1.5×</Th><Th>OT 2×</Th><Th>RDO</Th>
                  <Th>Allowances</Th><Th>Total Pay</Th><Th>Charge</Th>
                </tr>
              </thead>
              <tbody>
                {byWorker.map(w => (
                  <tr key={w.key}>
                    <Td><strong>{w.name}</strong></Td>
                    <Td><span style={{ fontSize: 11, color: C.textMuted, fontFamily: '"DM Mono", monospace' }}>{w.type}</span></Td>
                    <Td>{w.shifts}</Td>
                    <Td>{w.ordinary > 0 ? `${w.ordinary.toFixed(2)}h` : '—'}</Td>
                    <Td>{w.ot15 > 0 ? <span style={{ color: C.warning }}>{w.ot15.toFixed(2)}h</span> : '—'}</Td>
                    <Td>{w.ot2x > 0 ? <span style={{ color: C.accent }}>{w.ot2x.toFixed(2)}h</span> : '—'}</Td>
                    <Td>{w.rdo > 0 ? <span style={{ color: C.success }} title="Banked to the RDO accrual, not paid in this run">+{w.rdo.toFixed(2)}h</span> : '—'}</Td>
                    <Td>{w.allowances > 0 ? `$${w.allowances.toFixed(2)}` : '—'}</Td>
                    <Td><span style={{ fontWeight: 800, color: C.success }}>${w.pay.toFixed(2)}</span></Td>
                    <Td><span style={{ color: C.warning }}>${w.charge.toFixed(2)}</span></Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} style={{ padding: '10px 16px', color: C.textMuted, fontSize: 13, borderTop: `2px solid ${C.border}` }}>Totals</td>
                  <td style={{ padding: '10px 16px', fontWeight: 700, color: C.text, borderTop: `2px solid ${C.border}` }}>{totals.ordinary_hours.toFixed(2)}h</td>
                  <td style={{ padding: '10px 16px', fontWeight: 700, color: C.warning, borderTop: `2px solid ${C.border}` }}>{totals.ot15_hours.toFixed(2)}h</td>
                  <td style={{ padding: '10px 16px', fontWeight: 700, color: C.accent, borderTop: `2px solid ${C.border}` }}>{totals.ot2x_hours.toFixed(2)}h</td>
                  <td style={{ padding: '10px 16px', fontWeight: 700, color: C.success, borderTop: `2px solid ${C.border}` }}>{totals.rdo_hours.toFixed(2)}h</td>
                  <td style={{ padding: '10px 16px', fontWeight: 700, color: C.text, borderTop: `2px solid ${C.border}` }}>${totals.allowances.toFixed(2)}</td>
                  <td style={{ padding: '10px 16px', fontWeight: 800, color: C.success, borderTop: `2px solid ${C.border}` }}>${totals.total_pay.toFixed(2)}</td>
                  <td style={{ padding: '10px 16px', fontWeight: 700, color: C.warning, borderTop: `2px solid ${C.border}` }}>${totals.charge_amount.toFixed(2)}</td>
                </tr>
              </tfoot>
            </TableWrap>
          </div>
        )}
        </>
      )}
    </div>
  );
}
