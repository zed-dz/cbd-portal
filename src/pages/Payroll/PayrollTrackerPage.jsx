import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnSecondary, btnSmall } from '../../theme';
import { fmtDate } from '../../utils/dates';
import { downloadCSV } from '../../utils/csv';
import { computePayrollRow, buildXeroCSV, applyFullTimeMinDay } from '../../utils/payroll';
import { Spinner, TableWrap, Th, Td, EmptyState } from '../../components';

const XERO_AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
const XERO_CLIENT_ID = process.env.REACT_APP_XERO_CLIENT_ID || '';
const REDIRECT_URI = 'https://tsizneslellcqusjwtub.supabase.co/functions/v1/xero-callback';
const XERO_SCOPES = 'openid profile email offline_access payroll.employees payroll.payruns payroll.payslip accounting.contacts.read';

export function PayrollTrackerPage({ showToast }) {
  const [timesheets, setTimesheets] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [clients, setClients] = useState([]);
  const [configMap, setConfigMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [filterType, setFilterType] = useState('all');
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
    const [t, w, cl, cfg] = await Promise.all([
      q,
      supabase.from('workers').select('id, name, worker_type, pay_rate_regular, pay_rate_overtime, subcontractor_abn').order('name'),
      supabase.from('clients').select('id, name, rate_regular, rate_overtime, rate_night, rate_weekend').order('name'),
      supabase.from('payroll_config').select('config_key, config_value'),
    ]);
    if (t.error) showToast(t.error.message, 'error');
    else setTimesheets(t.data || []);
    if (w.data) setWorkers(w.data);
    if (cl.data) setClients(cl.data);
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
    const client = clients.find(c => c.name === ts.client) || null;
    return { ...computePayrollRow(ts, { ...worker, name: ts.workers?.name || worker.name }, client, configMap), _id: ts.id, _xero_exported: ts.xero_exported };
  });

  const filtered = filterType === 'all' ? payrollRows : payrollRows.filter(r => r.worker_type === filterType);

  const totals = filtered.reduce((acc, r) => {
    const ot = parseFloat(r.overtime_hours) || 0;
    const rdo = parseFloat(r.rdo_hours) || 0;
    const pay = parseFloat(r.pay_hours) || 0;
    return {
      pay_hours: acc.pay_hours + pay,
      ordinary_hours: acc.ordinary_hours + Math.max(0, pay - ot - rdo),
      ot_hours: acc.ot_hours + ot,
      rdo_hours: acc.rdo_hours + rdo,
      total_pay: acc.total_pay + (parseFloat(r.total_pay) || 0),
      charge_amount: acc.charge_amount + (parseFloat(r.charge_amount) || 0),
    };
  }, { pay_hours: 0, ordinary_hours: 0, ot_hours: 0, rdo_hours: 0, total_pay: 0, charge_amount: 0 });

  const handleXeroExport = () => {
    const staffRows = filtered.filter(r => r.worker_type !== 'subcontractor');
    if (!staffRows.length) { showToast('No staff timesheets to export.', 'info'); return; }
    buildXeroCSV(staffRows, dateFrom || 'all', dateTo || 'dates', downloadCSV);
    showToast('Xero CSV exported', 'success');
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
          <button onClick={() => { setDateFrom(''); setDateTo(''); }} style={btnSecondary}>Clear</button>
          <div style={{ marginLeft: 'auto', background: C.bg, borderRadius: 8, padding: '10px 18px', border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.text }}>{totals.ordinary_hours.toFixed(1)}h</div>
            <div style={{ color: C.textMuted, fontSize: 11 }}>Ordinary hours</div>
          </div>
          <div style={{ background: C.bg, borderRadius: 8, padding: '10px 18px', border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.warning }}>{totals.ot_hours.toFixed(1)}h</div>
            <div style={{ color: C.textMuted, fontSize: 11 }}>Overtime hours</div>
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
              <Th>Pay Hrs</Th><Th>Charge Hrs</Th><Th>OT Hrs</Th>
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
                <Td>{fmtDate(r.date)}</Td>
                <Td><span style={{ fontSize: 11, color: C.textMuted }}>{r.scenario}</span></Td>
                <Td><span style={{ fontWeight: 700 }}>{r.pay_hours}</span></Td>
                <Td>{r.charge_hours}</Td>
                <Td>{r.overtime_hours > 0 ? <span style={{ color: C.warning }}>{r.overtime_hours}</span> : '—'}</Td>
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
                <Td><span style={{ color: C.warning }}>${r.charge_amount}</span></Td>
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
              <td colSpan={4} style={{ padding: '10px 16px', color: C.textMuted, fontSize: 13, borderTop: `2px solid ${C.border}` }}>{filtered.length} records</td>
              <td style={{ padding: '10px 16px', fontWeight: 700, color: C.text, borderTop: `2px solid ${C.border}`, whiteSpace: 'nowrap' }}>
                {totals.pay_hours.toFixed(2)}
                <div style={{ fontSize: 10.5, fontWeight: 600, color: C.textMuted }}>
                  ord {totals.ordinary_hours.toFixed(2)} · OT {totals.ot_hours.toFixed(2)}{totals.rdo_hours > 0 ? ` · RDO ${totals.rdo_hours.toFixed(2)}` : ''}
                </div>
              </td>
              <td colSpan={3} style={{ borderTop: `2px solid ${C.border}` }} />
              <td style={{ padding: '10px 16px', fontWeight: 700, color: C.success, borderTop: `2px solid ${C.border}` }}>${totals.total_pay.toFixed(2)}</td>
              <td style={{ padding: '10px 16px', fontWeight: 700, color: C.warning, borderTop: `2px solid ${C.border}` }}>${totals.charge_amount.toFixed(2)}</td>
              <td colSpan={2} style={{ borderTop: `2px solid ${C.border}` }} />
            </tr>
          </tfoot>
        </TableWrap>
        </>
      )}
    </div>
  );
}
