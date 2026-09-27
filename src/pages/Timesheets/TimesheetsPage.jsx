import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, inputStyle, btnPrimary, btnSecondary, btnDanger, btnSmall } from '../../theme';
import { todayISO, fmtDate, sydneyTime, sydneyDateTimeInput, sydneyInstant } from '../../utils/dates';
import { downloadCSV } from '../../utils/csv';
import { computeTimesheetHours, buildXeroCSV } from '../../utils/payroll';
import { SCENARIOS } from '../../constants/scenarios';
import { Spinner, Modal, Field, TableWrap, Th, Td, EmptyState, timesheetBadge, DailyTimesheetForm, dailyFromHeader, blankDaily, TimesheetDetailView, DateRangeFilter, printTimesheetBatch } from '../../components';
import { sendTimesheetForClientApproval, markClientApprovedManually } from '../../utils/clientApproval';
import { approveTimesheet } from '../../utils/approve';

// Sticky filters: every access is try/catch'd because localStorage throws in
// private windows and when site data is blocked — the page must still work.
const readStore = (key) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; } };
const writeStore = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage unavailable — filters just won't stick */ } };

// Sydney-pinned: rendering in the viewer's browser zone put the same shift
// 9 hours apart between Timesheets and Payroll for an overseas viewer (QA #1).
const fmtTime = (iso) => sydneyTime(iso);

// Approve goes through the approve-timesheet edge function, never a direct
// status update: the server recomputes the hours split, locks the sheet and
// emails the client PDF. Surfaces the function's own error body (e.g. the
// 409 hours-mismatch message) instead of the generic invoke error.
async function invokeApprove(headerId) {
  const { data, error } = await supabase.functions.invoke('approve-timesheet', { body: { header_id: headerId } });
  if (!error && !data?.error) return { ok: true, data };
  let msg = data?.error || error?.message || 'Approval failed';
  if (error?.context) {
    try { const j = await error.context.json(); msg = j.error || msg; } catch { /* keep msg */ }
  }
  return { ok: false, error: msg };
}

// datetime-local <-> instant conversion for the Line-tab editor. Times are
// edited as local wall-clock but stored as true UTC instants — same contract
// as the daily form (naive strings used to shift every display +10h).
const toLocalInput = (iso) => sydneyDateTimeInput(iso);
const toInstant = (local) => {
  if (!local) return null;
  const [d, t] = String(local).split('T');
  const iso = sydneyInstant(d, t);
  return iso || null;
};

// Date-range filter. The preset list now lives in the DateRangeFilter component;
// rangeBounds() below only has to resolve an explicit custom range.

function rangeBounds(preset, from, to) {
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const monday = d => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
  switch (preset) {
    case 'this_week': { const m = monday(today); const e = new Date(m); e.setDate(e.getDate() + 6); return [iso(m), iso(e)]; }
    case 'last_week': { const m = monday(today); m.setDate(m.getDate() - 7); const e = new Date(m); e.setDate(e.getDate() + 6); return [iso(m), iso(e)]; }
    case 'past7': { const s = new Date(today); s.setDate(s.getDate() - 6); return [iso(s), iso(today)]; }
    case 'this_month': { const s = new Date(today.getFullYear(), today.getMonth(), 1); const e = new Date(today.getFullYear(), today.getMonth() + 1, 0); return [iso(s), iso(e)]; }
    case 'custom': return [from || null, to || null];
    default: return [null, null];
  }
}
const dateInRange = (dateStr, lo, hi) => !!dateStr && (!lo || dateStr >= lo) && (!hi || dateStr <= hi);

const tsDefaults = {
  worker_id: '', client: '', site: '', date: '', scenario: 'standard',
  start_time: '', end_time: '', break_minutes: 0,
  pay_hours: '', charge_hours: '', overtime_hours: 0,
  is_weekend: false, is_night_shift: false, geo_loading: false,
  travel_allowance: 0, meal_allowance: 0,
  awj_reference: '', leave_reason: '', medical_cert_url: '',
  admin_override_hours: '', status: 'pending', notes: '',
};

export function TimesheetsPage({ showToast, refreshBadge, isMobile }) {
  const [view, setView] = useState('daily');
  const tabBtn = (id, label) => (
    <button key={id} onClick={() => setView(id)} style={{
      padding: '8px 16px', background: view === id ? C.accentSoft : 'transparent',
      border: `1px solid ${view === id ? C.accentBorder : C.border}`, borderRadius: 8,
      color: view === id ? C.accent : C.textMuted, fontSize: 13, fontWeight: 600, cursor: 'pointer',
    }}>{label}</button>
  );
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {tabBtn('daily', 'Daily Timesheets')}
        {tabBtn('line', 'Line Timesheets')}
      </div>
      {view === 'daily'
        ? <DailyTimesheetsAdmin showToast={showToast} refreshBadge={refreshBadge} isMobile={isMobile} />
        : <LineTimesheetsPage showToast={showToast} refreshBadge={refreshBadge} />}
    </div>
  );
}

const LINE_FILTER_KEY = 'cbd_ts_line_filters';

function LineTimesheetsPage({ showToast, refreshBadge }) {
  const [timesheets, setTimesheets] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [configMap, setConfigMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState(() => readStore(LINE_FILTER_KEY)?.status || '');
  const [search, setSearch] = useState(() => readStore(LINE_FILTER_KEY)?.search || '');
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(tsDefaults);
  const [saving, setSaving] = useState(false);
  // Default to the current pay week; a stored choice (incl. "all") wins.
  const [range, setRange] = useState(() => readStore(LINE_FILTER_KEY)?.range || { preset: 'this_week', from: '', to: '' });

  useEffect(() => {
    writeStore(LINE_FILTER_KEY, { status: filterStatus, search, range });
  }, [filterStatus, search, range]);

  const [clients, setClients] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    const [t, w, cfg, c] = await Promise.all([
      supabase.from('timesheets').select('*, workers(name)').order('created_at', { ascending: false }),
      supabase.from('workers').select('id, name, worker_type').is('archived_at', null).order('name'),
      supabase.from('payroll_config').select('config_key, config_value'),
      supabase.from('clients').select('id, name').order('name'),
    ]);
    if (t.error) showToast(t.error.message, 'error');
    else setTimesheets(t.data || []);
    if (w.data) setWorkers(w.data);
    if (cfg.data) {
      const map = {};
      cfg.data.forEach(r => { map[r.config_key] = r.config_value; });
      setConfigMap(map);
    }
    if (c.data) setClients(c.data);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const recompute = (f) => {
    const worker = workers.find(w => w.id === f.worker_id);
    const workerType = worker?.worker_type || 'casual';
    const result = computeTimesheetHours(f, workerType, configMap);
    return { ...f, ...result };
  };

  const openAdd = () => { setForm(tsDefaults); setModal('add'); };
  const openEdit = (ts) => {
    setForm({
      worker_id: ts.worker_id || '', client: ts.client || '', site: ts.site || '',
      date: ts.date || '', scenario: ts.scenario || 'standard',
      start_time: toLocalInput(ts.start_time),
      end_time: toLocalInput(ts.end_time),
      break_minutes: ts.break_minutes || 0,
      pay_hours: ts.pay_hours ?? ts.hours ?? '',
      charge_hours: ts.charge_hours ?? '',
      overtime_hours: ts.overtime_hours || 0,
      is_weekend: ts.is_weekend || false,
      is_night_shift: ts.is_night_shift || false,
      geo_loading: ts.geo_loading || false,
      travel_allowance: ts.travel_allowance || 0,
      meal_allowance: ts.meal_allowance || 0,
      awj_reference: ts.awj_reference || '',
      leave_reason: ts.leave_reason || '',
      medical_cert_url: ts.medical_cert_url || '',
      admin_override_hours: ts.admin_override_hours ?? '',
      status: ts.status, notes: ts.notes || '',
    });
    setModal(ts);
  };
  const closeModal = () => { setModal(null); setForm(tsDefaults); };

  const handleSave = async () => {
    if (!form.worker_id || !form.date) { showToast('Worker and date are required.', 'error'); return; }
    if (form.scenario === 'personal_leave' && !form.leave_reason) { showToast('Leave reason is required for personal leave.', 'error'); return; }
    setSaving(true);

    const computed = recompute(form);
    const payload = {
      worker_id: computed.worker_id, client: computed.client, site: computed.site,
      date: computed.date, scenario: computed.scenario,
      start_time: toInstant(computed.start_time), end_time: toInstant(computed.end_time),
      break_minutes: computed.break_minutes || 0,
      pay_hours: computed.pay_hours !== '' ? parseFloat(computed.pay_hours) : null,
      charge_hours: computed.charge_hours !== '' ? parseFloat(computed.charge_hours) : null,
      overtime_hours: computed.overtime_hours || 0,
      is_weekend: computed.is_weekend || false,
      is_night_shift: computed.is_night_shift || false,
      geo_loading: computed.geo_loading || false,
      travel_allowance: computed.travel_allowance || 0,
      meal_allowance: computed.meal_allowance || 0,
      awj_reference: computed.awj_reference || null,
      leave_reason: computed.leave_reason || null,
      medical_cert_url: computed.medical_cert_url || null,
      admin_override_hours: computed.admin_override_hours !== '' ? parseFloat(computed.admin_override_hours) : null,
      status: computed.status, notes: computed.notes || null,
      // Mirror pay_hours → hours for backward compat
      hours: computed.pay_hours !== '' ? parseFloat(computed.pay_hours) : null,
      // total_hours must be set: the auto-meal DB trigger reads it, and with it
      // NULL it coalesced to 0 and forced the meal allowance to $0 on every save
      // from this form — even a 10-hour day.
      total_hours: computed.pay_hours !== '' ? parseFloat(computed.pay_hours) : null,
    };

    if (modal === 'add') {
      const { error } = await supabase.from('timesheets').insert([payload]);
      if (error) showToast(error.message, 'error');
      else { showToast('Timesheet created successfully', 'success'); closeModal(); load(); refreshBadge?.(); }
    } else {
      const { error } = await supabase.from('timesheets').update(payload).eq('id', modal.id);
      if (error) showToast(error.message, 'error');
      else { showToast('Timesheet updated successfully', 'success'); closeModal(); load(); refreshBadge?.(); }
    }
    setSaving(false);
  };

  const handleDelete = async (ts) => {
    if (!window.confirm('Delete this timesheet?')) return;
    const { error } = await supabase.from('timesheets').delete().eq('id', ts.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Timesheet deleted', 'success'); load(); refreshBadge?.(); }
  };

  const handleApproveAll = async () => {
    const pending = timesheets.filter(ts => ts.status === 'pending');
    if (!pending.length) { showToast('No pending timesheets to approve.', 'info'); return; }
    if (!window.confirm(`Approve all ${pending.length} pending timesheets? Daily-sheet rows are re-checked and locked on the server, and the client PDF is emailed.`)) return;
    // Rows belonging to a daily sheet go through the server (recompute + lock
    // + PDF). Legacy header-less line rows have nothing to lock — they keep
    // the old direct update.
    const headerIds = [...new Set(pending.map(ts => ts.header_id).filter(Boolean))];
    const legacy = pending.filter(ts => !ts.header_id);
    let failed = 0;
    for (const id of headerIds) {
      const r = await invokeApprove(id);
      if (!r.ok) { failed++; showToast(r.error, 'error'); }
    }
    if (legacy.length) {
      const { error } = await supabase.from('timesheets').update({ status: 'approved' }).in('id', legacy.map(ts => ts.id));
      if (error) { failed++; showToast(error.message, 'error'); }
    }
    if (!failed) showToast(`${pending.length} timesheets approved`, 'success');
    else showToast('Some approvals failed — see the errors above; the rest went through.', 'info');
    load(); refreshBadge?.();
  };

  const handleXeroExport = () => {
    const approved = filtered.filter(ts => ts.status === 'approved');
    if (!approved.length) { showToast('No approved timesheets to export.', 'info'); return; }
    const rows = approved.map(ts => {
      const w = workers.find(w => w.id === ts.worker_id) || {};
      return {
        worker_name: ts.workers?.name || '', worker_type: w.worker_type || '',
        date: ts.date, scenario: ts.scenario || 'standard', site: ts.site || '', client: ts.client || '',
        pay_hours: ts.pay_hours ?? ts.hours ?? 0, charge_hours: ts.charge_hours ?? 0,
        overtime_hours: ts.overtime_hours || 0, is_weekend: ts.is_weekend || false,
        geo_loading: ts.geo_loading || false, travel_allowance: ts.travel_allowance || 0,
        meal_allowance: ts.meal_allowance || 0, awj_reference: ts.awj_reference || '',
        xero_pay_item: w.worker_type === 'subcontractor' ? 'SubcontractorFee' : 'OrdinaryTime',
        total_pay: '', base_pay: '', charge_amount: '',
      };
    });
    const today = todayISO();
    buildXeroCSV(rows, today, today, downloadCSV);
    showToast('Xero CSV exported', 'success');
  };

  const [lineLo, lineHi] = rangeBounds(range.preset, range.from, range.to);
  const filtered = timesheets.filter(ts => {
    const matchStatus = !filterStatus || ts.status === filterStatus;
    const matchSearch = !search || ts.workers?.name?.toLowerCase().includes(search.toLowerCase()) || (ts.client || '').toLowerCase().includes(search.toLowerCase()) || (ts.site || '').toLowerCase().includes(search.toLowerCase());
    const matchRange = range.preset === 'all' || dateInRange(ts.date, lineLo, lineHi);
    return matchStatus && matchSearch && matchRange;
  });
  const totalPayHours = filtered.reduce((sum, ts) => sum + (parseFloat(ts.pay_hours ?? ts.hours) || 0), 0);

  // Live preview computation for modal
  const preview = form.worker_id ? recompute(form) : null;

  const handleFormChange = (updates) => {
    const newForm = { ...form, ...updates };
    setForm(newForm);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', flex: 1 }}>
          <input style={{ ...inputStyle, maxWidth: 220 }} placeholder="Search worker, client, site…" value={search} onChange={e => setSearch(e.target.value)} />
          <select style={{ ...inputStyle, maxWidth: 180 }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
          <DateRangeFilter
            from={range.preset === 'all' ? null : lineLo}
            to={range.preset === 'all' ? null : lineHi}
            onApply={({ from, to }) => setRange({ preset: (from || to) ? 'custom' : 'all', from: from || '', to: to || '' })}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={handleApproveAll} style={{ ...btnSmall, color: '#4ade80', borderColor: '#16653a' }}>✓ Approve All Pending</button>
          <button onClick={handleXeroExport} style={{ ...btnSmall, color: '#93c5fd', borderColor: '#1e3a5f' }}>↓ Export Xero CSV</button>
          <button onClick={openAdd} style={btnPrimary}>+ Add Timesheet</button>
        </div>
      </div>

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div> : filtered.length === 0 ? (
        <EmptyState message="No timesheets found." />
      ) : (
        <TableWrap>
          <thead><tr><Th>Worker</Th><Th>Date</Th><Th>Start</Th><Th>Finish</Th><Th>Scenario</Th><Th>Pay Hrs</Th><Th>Charge Hrs</Th><Th>OT / Allowances</Th><Th>Status</Th><Th>Actions</Th></tr></thead>
          <tbody>
            {filtered.map(ts => (
              <tr key={ts.id}>
                <Td>{ts.workers?.name || '—'}</Td>
                <Td>{fmtDate(ts.date)}</Td>
                <Td>{fmtTime(ts.start_time)}</Td>
                <Td>{fmtTime(ts.end_time)}</Td>
                <Td>
                  <span style={{ fontSize: 11, color: C.textMuted, fontFamily: '"DM Mono", monospace' }}>
                    {ts.scenario || 'standard'}
                  </span>
                </Td>
                <Td><span style={{ fontWeight: 700 }}>{ts.pay_hours ?? ts.hours ?? '—'}</span></Td>
                <Td>{ts.charge_hours ?? '—'}</Td>
                <Td>
                  <div style={{ fontSize: 11, color: C.textMuted }}>
                    {ts.overtime_hours > 0 && <span>OT: {ts.overtime_hours}h </span>}
                    {ts.travel_allowance > 0 && <span>T: ${ts.travel_allowance} </span>}
                    {ts.meal_allowance > 0 && <span>M: ${ts.meal_allowance}</span>}
                    {ts.geo_loading && <span style={{ color: C.warning }}> GEO</span>}
                    {ts.is_weekend && <span style={{ color: C.accent }}> WKD</span>}
                  </div>
                </Td>
                <Td>{timesheetBadge(ts.status)}</Td>
                <Td>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button onClick={() => openEdit(ts)} style={{ ...btnSmall, color: '#4ade80', borderColor: '#16653a' }}>Edit / Approve</button>
                    <button onClick={() => handleDelete(ts)} style={btnDanger}>Delete</button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5} style={{ padding: '10px 16px', color: C.textMuted, fontSize: 13, borderTop: `2px solid ${C.border}` }}>
                {filtered.length} record{filtered.length !== 1 ? 's' : ''}
              </td>
              <td style={{ padding: '10px 16px', fontWeight: 700, color: C.text, fontSize: 14, borderTop: `2px solid ${C.border}` }}>
                {totalPayHours.toFixed(2)} hrs
              </td>
              <td colSpan={4} style={{ borderTop: `2px solid ${C.border}` }} />
            </tr>
          </tfoot>
        </TableWrap>
      )}

      {modal && (
        <Modal title={modal === 'add' ? 'Add Timesheet' : 'Edit Timesheet'} onClose={closeModal} width={560}>
          <Field label="Scenario">
            <select style={inputStyle} value={form.scenario} onChange={e => handleFormChange({ scenario: e.target.value })}>
              {SCENARIOS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </Field>
          <Field label="Worker *">
            <select style={inputStyle} value={form.worker_id} onChange={e => handleFormChange({ worker_id: e.target.value })}>
              <option value="">Select a worker…</option>
              {workers.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <Field label="Client">
              <>
                <input style={inputStyle} list="ts-clients-list" value={form.client} onChange={e => handleFormChange({ client: e.target.value })} placeholder="Type or select…" />
                <datalist id="ts-clients-list">
                  {clients.map(c => <option key={c.id} value={c.name} />)}
                </datalist>
              </>
            </Field>
            <Field label="Site"><input style={inputStyle} value={form.site} onChange={e => handleFormChange({ site: e.target.value })} /></Field>
            <Field label="Date *">
              <input style={inputStyle} type="date" value={form.date} onChange={e => handleFormChange({ date: e.target.value })} />
            </Field>
            <Field label="Break">
              <select style={inputStyle} value={form.break_minutes} onChange={e => handleFormChange({ break_minutes: parseInt(e.target.value) || 0 })}>
                <option value={0}>No break</option>
                <option value={15}>15 min</option>
                <option value={30}>30 min</option>
                <option value={45}>45 min</option>
                <option value={60}>60 min</option>
              </select>
            </Field>
            <Field label="Start Time">
              <input style={inputStyle} type="datetime-local" value={form.start_time} onChange={e => handleFormChange({ start_time: e.target.value })} />
            </Field>
            <Field label="End Time">
              <input style={inputStyle} type="datetime-local" value={form.end_time} onChange={e => handleFormChange({ end_time: e.target.value })} />
            </Field>
          </div>

          {/* Pay/Charge preview */}
          {preview && (
            <div style={{ background: 'rgba(249,115,22,0.08)', border: '1px solid rgba(249,115,22,0.25)', borderRadius: 8, padding: '10px 16px', marginBottom: 16, display: 'flex', gap: 20, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>Pay</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: C.accent }}>{preview.pay_hours != null ? `${preview.pay_hours}h` : '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>Charge</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: C.text }}>{preview.charge_hours != null ? `${preview.charge_hours}h` : '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>OT</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: C.warning }}>{preview.overtime_hours || 0}h</div>
              </div>
              {preview.is_weekend && <div style={{ alignSelf: 'center', fontSize: 11, color: C.accent, fontWeight: 600 }}>WEEKEND/PH</div>}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 20, marginBottom: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: C.text, fontSize: 14 }}>
                <input type="checkbox" checked={form.is_night_shift} onChange={e => handleFormChange({ is_night_shift: e.target.checked })} />
                Night Shift (1.5x / 2x after 8h)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: C.text, fontSize: 14 }}>
                <input type="checkbox" checked={form.geo_loading} onChange={e => handleFormChange({ geo_loading: e.target.checked })} />
                Geographic Loading (+10%)
              </label>
            </div>
            <Field label="Work Order / Job Ref">
              <input style={inputStyle} value={form.awj_reference} onChange={e => handleFormChange({ awj_reference: e.target.value })} placeholder="e.g. AWJ-2025-001" />
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>Internal job reference — used to match this timesheet in Xero</div>
            </Field>
            <Field label="Admin Override Hours">
              <input style={inputStyle} type="number" step="0.25" min="0" value={form.admin_override_hours} onChange={e => handleFormChange({ admin_override_hours: e.target.value })} placeholder="Overrides computed hours" />
            </Field>
          </div>

          {form.scenario === 'personal_leave' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <Field label="Leave Reason *">
                  <textarea style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }} value={form.leave_reason} onChange={e => handleFormChange({ leave_reason: e.target.value })} />
                </Field>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <Field label="Medical Certificate URL">
                  <input style={inputStyle} value={form.medical_cert_url} onChange={e => handleFormChange({ medical_cert_url: e.target.value })} placeholder="https://…" />
                </Field>
              </div>
            </div>
          )}

          <Field label="Status">
            <select style={inputStyle} value={form.status} onChange={e => handleFormChange({ status: e.target.value })}>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          </Field>
          <Field label="Notes"><textarea style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }} value={form.notes} onChange={e => handleFormChange({ notes: e.target.value })} /></Field>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={closeModal} style={btnSecondary}>Cancel</button>
            <button onClick={handleSave} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// The supervisor chase queue: the link went out, nobody has accepted, and the
// sheet isn't dead. Cuts across status (a sheet can be admin-approved yet
// still waiting on the client), so it's a derived bucket, not a status value.
const withSupervisor = (h) =>
  !!h.client_approval_sent_at && !h.client_approved && h.status !== 'rejected';
const daysWaiting = (iso) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
const autoApproveDate = (iso) => new Date(new Date(iso).getTime() + 7 * 86400000);

// X3 — kanban columns. "PDF sent" is derived from pdf_emailed_at, not a
// status of its own: an approved sheet whose PDF has gone out lives there.
// "With supervisor" claims its cards first so every card lives in ONE column.
const KANBAN_COLS = [
  { id: 'pending',         label: 'Pending',         color: '#eab308', match: h => h.status === 'pending' && !withSupervisor(h) },
  { id: 'with_supervisor', label: 'With supervisor', color: '#38bdf8', match: withSupervisor },
  { id: 'approved',        label: 'Approved',        color: '#4ade80', match: h => h.status === 'approved' && !h.pdf_emailed_at && !withSupervisor(h) },
  { id: 'rejected',        label: 'Rejected',        color: '#f87171', match: h => h.status === 'rejected' },
  { id: 'sent',            label: 'PDF sent',        color: '#93c5fd', match: h => h.status === 'approved' && !!h.pdf_emailed_at && !withSupervisor(h) },
];

// ---- Daily Timesheets (detailed) admin: list + full edit of submitted ones ----
const DAILY_FILTER_KEY = 'cbd_ts_daily_filters';

function DailyTimesheetsAdmin({ showToast, refreshBadge, isMobile }) {
  const [headers, setHeaders] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState(() => readStore(DAILY_FILTER_KEY)?.status || '');
  const [search, setSearch] = useState(() => readStore(DAILY_FILTER_KEY)?.search || '');
  const [layout, setLayout] = useState('table'); // 'table' | 'kanban' (X3)
  const [approving, setApproving] = useState(false);
  const [modal, setModal] = useState(null);      // 'add' | header object | null
  const [viewing, setViewing] = useState(null);  // header (with embedded lines) shown in the full view
  const [selected, setSelected] = useState(() => new Set()); // header ids ticked for bulk download
  const [bulkApprove, setBulkApprove] = useState(null);   // { done, total } while the loop runs
  const [bulkFailures, setBulkFailures] = useState([]);   // [{ worker, date, error }]
  const [resendingId, setResendingId] = useState(null);

  const toggleOne = (id) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const [editInitial, setEditInitial] = useState(null);
  const [editWorkerId, setEditWorkerId] = useState('');
  const [loadingForm, setLoadingForm] = useState(false);
  // Default to the current pay week; a stored choice (incl. "all") wins.
  const [range, setRange] = useState(() => readStore(DAILY_FILTER_KEY)?.range || { preset: 'this_week', from: '', to: '' });

  useEffect(() => {
    writeStore(DAILY_FILTER_KEY, { status: filterStatus, search, range });
  }, [filterStatus, search, range]);

  const load = useCallback(async () => {
    setLoading(true);
    const [h, w] = await Promise.all([
      supabase.from('timesheet_headers').select('*, workers(name), timesheets(*)').order('created_at', { ascending: false }),
      supabase.from('workers').select('id, name').is('archived_at', null).order('name'),
    ]);
    if (h.error) showToast(h.error.message, 'error');
    else setHeaders(h.data || []);
    if (w.data) setWorkers(w.data);
    setLoading(false);
  }, [showToast]);

  // Per-header line summary for the table: dates, start/finish, normal + OT split.
  const lineInfo = (h) => {
    const lines = [...(h.timesheets || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const total = lines.reduce((s, l) => s + (parseFloat(l.total_hours) || 0), 0);
    const reg   = lines.reduce((s, l) => s + (parseFloat(l.regular_hours ?? l.total_hours) || 0), 0);
    return { lines, total, reg, ot: Math.max(0, +(total - reg).toFixed(2)), adjusted: lines.some(l => l.adjusted_at) };
  };

  useEffect(() => { load(); }, [load]);

  const openAdd = () => {
    setEditInitial(blankDaily());
    setEditWorkerId('');
    setModal('add');
  };

  // Admin edit: pull the header + its line rows, hydrate the shared form.
  const openEdit = async (header) => {
    setLoadingForm(true);
    setModal(header);
    setEditWorkerId(header.worker_id || '');
    const { data: lines, error } = await supabase.from('timesheets').select('*')
      .eq('header_id', header.id).order('date');
    if (error) showToast(error.message, 'error');
    setEditInitial(dailyFromHeader(header, lines || []));
    setLoadingForm(false);
  };

  const closeModal = () => { setModal(null); setEditInitial(null); setEditWorkerId(''); };
  const onSaved = () => { closeModal(); load(); refreshBadge?.(); };

  const handleDelete = async (header) => {
    if (!window.confirm('Delete this daily timesheet and all its line rows?')) return;
    // line rows cascade via FK on delete
    const { error } = await supabase.from('timesheet_headers').delete().eq('id', header.id);
    if (error) { showToast(error.message, 'error'); return; }
    showToast('Daily timesheet deleted', 'success');
    load(); refreshBadge?.();
  };

  const [rangeLo, rangeHi] = rangeBounds(range.preset, range.from, range.to);
  const filtered = headers.filter(h => {
    const matchStatus = !filterStatus
      || (filterStatus === 'with_supervisor' ? withSupervisor(h) : h.status === filterStatus);
    const q = search.toLowerCase();
    const matchSearch = !search || (h.workers?.name || '').toLowerCase().includes(q)
      || (h.client || '').toLowerCase().includes(q) || (h.project || '').toLowerCase().includes(q);
    const lineDates = (h.timesheets || []).map(l => l.date).filter(Boolean);
    const matchRange = range.preset === 'all'
      || (lineDates.length
        ? lineDates.some(d => dateInRange(d, rangeLo, rangeHi))
        : dateInRange((h.created_at || '').slice(0, 10), rangeLo, rangeHi));
    return matchStatus && matchSearch && matchRange;
  });

  // ── Bulk selection ────────────────────────────────────────────────────────
  // Selection is stored as header ids but always intersected with what's on
  // screen, so narrowing the filter can never leave a hidden row silently
  // included in a download.
  const selectedSheets     = filtered.filter(h => selected.has(h.id));
  const allShownSelected   = filtered.length > 0 && filtered.every(h => selected.has(h.id));
  const selectedTotalHours = selectedSheets.reduce(
    (sum, h) => sum + (h.timesheets || []).reduce((s, l) => s + (parseFloat(l.total_hours) || 0), 0), 0);

  const toggleAllShown = () => setSelected(prev => {
    const next = new Set(prev);
    if (allShownSelected) filtered.forEach(h => next.delete(h.id));
    else filtered.forEach(h => next.add(h.id));
    return next;
  });

  // Bulk approve: PENDING selections only, one at a time through the
  // approveTimesheet util (server recompute + lock + PDF) — never a direct
  // status update, and sequential so one failure can't hide the others.
  const selectedPending = selectedSheets.filter(h => h.status === 'pending');
  const handleBulkApprove = async () => {
    const targets = selectedPending;
    if (!targets.length) return;
    if (!window.confirm(`Approve ${targets.length} pending timesheet${targets.length === 1 ? '' : 's'}? Each is re-checked and locked on the server, and the client PDF is emailed.`)) return;
    setBulkFailures([]);
    showToast(`Approving ${targets.length} timesheet${targets.length === 1 ? '' : 's'}…`, 'info');
    let ok = 0;
    const fails = [];
    for (let i = 0; i < targets.length; i++) {
      const h = targets[i];
      setBulkApprove({ done: i, total: targets.length });
      const r = await approveTimesheet(h.id);
      if (r.ok) ok++;
      else {
        const info = lineInfo(h);
        fails.push({
          id: h.id,
          worker: h.workers?.name || '—',
          date: info.lines.length ? fmtDate(info.lines[0].date) : fmtDate(h.created_at),
          error: r.error,
        });
      }
    }
    setBulkApprove(null);
    setBulkFailures(fails);
    showToast(`${ok} approved, ${fails.length} failed`, fails.length ? (ok ? 'info' : 'error') : 'success');
    setSelected(new Set());
    load(); refreshBadge?.();
  };

  const handleResendLink = async (h) => {
    setResendingId(h.id);
    const r = await sendTimesheetForClientApproval(h.id, { force: true });
    setResendingId(null);
    if (r.ok) { showToast(`Approval link resent — ${r.sentTo}`, 'success'); load(); }
    else showToast(r.error || 'Resend failed', 'error');
  };

  // One row per shift line so the CSV can be pivoted in Excel.
  const downloadSelectedCSV = () => {
    if (!selectedSheets.length) return;
    const rows = selectedSheets.flatMap(h =>
      [...(h.timesheets || [])]
        .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
        .map(l => ({
          Worker:            h.workers?.name || '',
          Date:              l.date || '',
          Day:               l.date ? new Date(l.date + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'long' }) : '',
          Client:            h.client || '',
          Project:           h.project || '',
          Role:              h.role || '',
          Shift:             l.shift_type || 'Day',
          Start:             fmtTime(l.start_time),
          Finish:            fmtTime(l.end_time),
          'Break (h)':       l.total_break_hours ?? '',
          'Total hours':     Number(l.total_hours || 0).toFixed(2),
          Status:            h.status || '',
          'Approved by':     h.approved_by || h.client_approved_by || '',
          'Approved at':     h.approved_at || h.client_approved_at || '',
          'Tasks completed': h.comments || '',
        })));
    if (!rows.length) { showToast('The selected timesheets have no shift lines.', 'info'); return; }
    downloadCSV(`timesheets_${todayISO()}.csv`, rows);
    showToast(`${rows.length} shift line${rows.length === 1 ? '' : 's'} exported`, 'success');
  };

  const downloadSelectedPDF = () => {
    if (!selectedSheets.length) return;
    printTimesheetBatch({
      sheets: selectedSheets.map(h => ({
        header: h,
        lines: [...(h.timesheets || [])].sort((a, b) => (a.date || '').localeCompare(b.date || '')),
        workerName: h.workers?.name || '',
      })),
    });
  };

  // Client-ready timesheet report for the current filter: hours per shift with
  // the supervisor sign-off (who accepted + when). Opens print → Save as PDF.
  const openReport = () => {
    const rows = filtered.flatMap(h => {
      const lines = [...(h.timesheets || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      return lines
        .filter(l => range.preset === 'all' || dateInRange(l.date, rangeLo, rangeHi))
        .map(l => ({ h, l }));
    });
    if (!rows.length) { showToast('No timesheet lines in the current filter.', 'info'); return; }
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const num = (v) => Number(v || 0);
    const t = rows.reduce((a, { l }) => ({
      total: a.total + num(l.total_hours), reg: a.reg + num(l.regular_hours ?? l.total_hours),
      rdo: a.rdo + num(l.rdo_hours), ot: a.ot + num(l.overtime_hours),
    }), { total: 0, reg: 0, ot: 0, rdo: 0 });
    const label = range.preset === 'all' ? 'All dates' : `${rangeLo || '…'} to ${rangeHi || '…'}`;
    const body = rows.map(({ h, l }) => `
      <tr>
        <td>${esc(h.workers?.name)}</td><td>${esc(h.client)}</td><td>${esc(h.project)}</td>
        <td>${esc(fmtDate(l.date))}</td><td>${esc(fmtTime(l.start_time))}</td><td>${esc(fmtTime(l.end_time))}</td>
        <td>${l.total_break_hours ? l.total_break_hours + 'h' : '—'}</td>
        <td><b>${num(l.total_hours).toFixed(2)}</b></td>
        <td>${esc(h.status)}</td>
        <td>${h.client_approved ? esc(`${h.client_approved_by || 'Client'} · ${h.client_approved_at ? new Date(h.client_approved_at).toLocaleString('en-AU') : ''}`) : 'awaiting'}</td>
      </tr>`).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Timesheet report ${esc(label)}</title>
    <style>
      body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #111827; margin: 26px; }
      h1 { font-size: 18px; margin: 0 0 2px; } .sub { color: #6b7280; font-size: 11.5px; margin-bottom: 14px; }
      table { width: 100%; border-collapse: collapse; }
      th { text-align: left; font-size: 9.5px; text-transform: uppercase; letter-spacing: .5px; color: #6b7280; border-bottom: 2px solid #e5e7eb; padding: 5px 6px; }
      td { font-size: 11px; border-bottom: 1px solid #f3f4f6; padding: 5px 6px; }
      tfoot td { border-top: 2px solid #e5e7eb; border-bottom: none; font-weight: 700; }
      @media print { body { margin: 10mm; } }
    </style></head><body>
      <h1>Timesheet report</h1>
      <div class="sub">Range: ${esc(label)} · ${rows.length} shift line${rows.length !== 1 ? 's' : ''} · generated ${new Date().toLocaleString('en-AU')}</div>
      <table>
        <thead><tr><th>Worker</th><th>Client</th><th>Project</th><th>Date</th><th>Start</th><th>Finish</th><th>Break</th><th>Total</th><th>Status</th><th>Approved by</th></tr></thead>
        <tbody>${body}</tbody>
        <tfoot><tr><td colspan="7">Totals</td><td>${t.total.toFixed(2)}</td><td colspan="2"></td></tr></tfoot>
      </table>
      <script>window.onload = function () { window.print(); };</script>
    </body></html>`;
    const w = window.open('', '_blank', 'width=1000,height=700');
    if (!w) return;
    w.document.write(html);
    w.document.close();
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', flex: 1 }}>
          <input style={{ ...inputStyle, maxWidth: 240 }} placeholder="Search worker, client, project…" value={search} onChange={e => setSearch(e.target.value)} />
          <select style={{ ...inputStyle, maxWidth: 180 }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="with_supervisor">With supervisor</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
          <DateRangeFilter
            from={range.preset === 'all' ? null : rangeLo}
            to={range.preset === 'all' ? null : rangeHi}
            onApply={({ from, to }) => setRange({ preset: (from || to) ? 'custom' : 'all', from: from || '', to: to || '' })}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', border: `1px solid ${C.border}`, borderRadius: R.md, overflow: 'hidden' }}
            title="Cards move via the Approve / Reject actions — drag is disabled">
            {[['table', '☰ Table'], ['kanban', '▦ Kanban']].map(([id, label]) => (
              <button key={id} onClick={() => setLayout(id)} style={{
                padding: '7px 12px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                background: layout === id ? C.accentSoft : 'transparent',
                color: layout === id ? C.accent : C.textMuted,
              }}>{label}</button>
            ))}
          </div>
          <button onClick={openReport} style={{ ...btnSmall, color: '#93c5fd', borderColor: '#1e3a5f' }}>📄 Timesheet report</button>
          <button onClick={openAdd} style={btnPrimary}>+ Add Daily Timesheet</button>
        </div>
      </div>

      {/* Bulk actions. Appears only once something is ticked, so the page stays
          quiet in normal use. "Download PDF" opens one document containing every
          selected timesheet, one per page — the browser's Save-as-PDF turns that
          into a single file instead of dozens of separate downloads. */}
      {selectedSheets.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          background: C.accentSoft, border: `1px solid ${C.accentBorder}`,
          borderRadius: R.md, padding: '10px 14px', marginBottom: 12,
        }}>
          <strong style={{ color: C.text, fontSize: 13 }}>
            {selectedSheets.length} timesheet{selectedSheets.length === 1 ? '' : 's'} selected
          </strong>
          <span style={{ color: C.textMuted, fontSize: 12.5, fontFamily: '"DM Mono", monospace' }}>
            {selectedTotalHours.toFixed(2)} hrs
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {selectedPending.length > 0 && (
              <button onClick={handleBulkApprove} disabled={!!bulkApprove}
                style={{ ...btnSmall, color: '#4ade80', borderColor: '#16653a', fontWeight: 700 }}>
                {bulkApprove
                  ? `Approving ${bulkApprove.done + 1}/${bulkApprove.total}…`
                  : `✓ Approve selected (${selectedPending.length})`}
              </button>
            )}
            <button onClick={downloadSelectedCSV} style={{ ...btnSmall, color: '#4ade80', borderColor: '#16653a' }}>📄 Download CSV</button>
            <button onClick={downloadSelectedPDF} style={{ ...btnSmall, color: '#93c5fd', borderColor: '#1e3a5f' }}>🖨 Download PDF</button>
            <button onClick={() => setSelected(new Set())} style={btnSmall}>Clear</button>
          </div>
        </div>
      )}

      {/* Failures from the last bulk approve stay visible until dismissed — a
          toast alone disappears before anyone can act on which sheets failed. */}
      {bulkFailures.length > 0 && (
        <div style={{
          background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.25)',
          borderRadius: R.md, padding: '10px 14px', marginBottom: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <strong style={{ color: '#f87171', fontSize: 13 }}>
              {bulkFailures.length} approval{bulkFailures.length === 1 ? '' : 's'} failed
            </strong>
            <button onClick={() => setBulkFailures([])} style={{ ...btnSmall, marginLeft: 'auto' }}>Dismiss</button>
          </div>
          {bulkFailures.map(f => (
            <div key={f.id} style={{ fontSize: 12, color: C.text, padding: '2px 0' }}>
              <strong>{f.worker}</strong>
              <span style={{ color: C.textMuted, fontFamily: '"DM Mono", monospace', margin: '0 6px' }}>{f.date}</span>
              <span style={{ color: '#fca5a5' }}>{f.error}</span>
            </div>
          ))}
        </div>
      )}

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div> : filtered.length === 0 ? (
        <EmptyState message="No daily timesheets found." />
      ) : layout === 'kanban' ? (
        /* X3 — kanban view. Cards move between columns via the Approve/Reject
           actions only (drag deliberately disabled); click opens the View
           modal. Columns stack to one per row on phones. */
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : `repeat(${KANBAN_COLS.length}, minmax(0, 1fr))`, gap: 12, alignItems: 'start' }}>
          {KANBAN_COLS.map(col => {
            const cards = filtered.filter(col.match);
            return (
              <div key={col.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: R.md, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: `1px solid ${C.border}` }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: col.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: C.text, textTransform: 'uppercase', letterSpacing: 1 }}>{col.label}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, fontFamily: '"DM Mono", monospace', color: C.textMuted }}>{cards.length}</span>
                </div>
                <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {cards.length === 0 && <div style={{ fontSize: 12, color: C.textMuted, textAlign: 'center', padding: '14px 0' }}>—</div>}
                  {cards.map(h => {
                    const info = lineInfo(h);
                    const first = info.lines[0];
                    const last = info.lines[info.lines.length - 1];
                    return (
                      <div key={h.id} onClick={() => setViewing(h)} style={{
                        background: C.bg, border: `1px solid ${C.border}`, borderLeft: `3px solid ${col.color}`,
                        borderRadius: 8, padding: '10px 12px', cursor: 'pointer', minWidth: 0,
                      }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{h.workers?.name || '—'}</div>
                        <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {h.client || '—'}{h.project ? ` · ${h.project}` : ''}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 6, fontSize: 11.5, fontFamily: '"DM Mono", monospace', color: C.textMuted }}>
                          <span>
                            {info.lines.length === 0 ? fmtDate(h.created_at)
                              : info.lines.length === 1 ? fmtDate(first.date)
                              : `${fmtDate(first.date)} – ${fmtDate(last.date)}`}
                          </span>
                          <span style={{ color: C.text, fontWeight: 700 }}>{info.total.toFixed(2)}h</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <TableWrap>
          <thead><tr><Th><input type="checkbox" checked={allShownSelected} onChange={toggleAllShown} title="Select all shown" style={{ accentColor: C.accent, width: 15, height: 15, cursor: 'pointer' }} /></Th><Th>Worker</Th><Th>Date</Th><Th>Client</Th><Th>Project</Th><Th>Role</Th><Th>Start</Th><Th>Finish</Th><Th>Normal</Th><Th>OT</Th><Th>Status</Th><Th>Actions</Th></tr></thead>
          <tbody>
            {filtered.map(h => {
              const info = lineInfo(h);
              const first = info.lines[0];
              const last = info.lines[info.lines.length - 1];
              const single = info.lines.length === 1;
              return (
              <tr key={h.id} style={{ background: selected.has(h.id) ? C.accentSoft : undefined }}>
                <Td><input type="checkbox" checked={selected.has(h.id)} onChange={() => toggleOne(h.id)} onClick={e => e.stopPropagation()} style={{ accentColor: C.accent, width: 15, height: 15, cursor: 'pointer' }} /></Td>
                <Td>{h.workers?.name || '—'}</Td>
                <Td>
                  {info.lines.length === 0 ? fmtDate(h.created_at)
                    : single ? fmtDate(first.date)
                    : `${fmtDate(first.date)} – ${fmtDate(last.date)}`}
                  {info.adjusted && <span title="Hours were adjusted after submission — open View for the original times" style={{ color: C.warning, marginLeft: 4 }}>✎</span>}
                </Td>
                <Td>{h.client || '—'}</Td>
                <Td>{h.project || '—'}</Td>
                <Td>{h.role || '—'}</Td>
                <Td>{single ? fmtTime(first.start_time) : info.lines.length ? `${info.lines.length} shifts` : '—'}</Td>
                <Td>{single ? fmtTime(first.end_time) : '—'}</Td>
                <Td><span style={{ fontWeight: 700 }}>{info.reg.toFixed(2)}</span></Td>
                <Td>{info.ot > 0 ? <span style={{ color: C.warning, fontWeight: 700 }}>{info.ot.toFixed(2)}</span> : '—'}</Td>
                <Td>
                  {timesheetBadge(h.status)}
                  {h.status === 'approved' && (
                    <div style={{ fontSize: 10, marginTop: 3, color: h.client_approved ? C.success : C.warning }}
                      title={h.client_approved ? `Accepted by the client${h.client_approved_by ? ` (${h.client_approved_by})` : ''}` : (h.client_approval_sent_at ? `Awaiting supervisor — sent to ${h.client_approval_sent_to || 'site contact'}` : 'Not yet sent to the site supervisor')}>
                      {h.client_approved ? '✓ client accepted' : h.client_approval_sent_at ? '⏳ with supervisor' : '⚠ not sent to client'}
                    </div>
                  )}
                  {withSupervisor(h) && (
                    <div style={{ fontSize: 10, marginTop: 3, color: '#38bdf8', fontFamily: '"DM Mono", monospace' }}
                      title={`Sent to ${h.client_approval_sent_to || 'site contact'} on ${fmtDate(h.client_approval_sent_at)} — auto-approves after 7 days with no response`}>
                      {daysWaiting(h.client_approval_sent_at)}d waiting · auto ✓ {fmtDate(autoApproveDate(h.client_approval_sent_at))}
                    </div>
                  )}
                </Td>
                <Td>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button onClick={() => setViewing(h)} style={{ ...btnSmall, color: '#93c5fd', borderColor: '#1e3a5f' }}>View</button>
                    <button onClick={() => openEdit(h)} style={{ ...btnSmall, color: '#4ade80', borderColor: '#16653a' }}>Edit / Approve</button>
                    {withSupervisor(h) && (
                      <button onClick={() => handleResendLink(h)} disabled={resendingId === h.id}
                        style={{ ...btnSmall, color: '#38bdf8', borderColor: '#1e3a5f' }}
                        title="Resend the approval link to the site supervisor">
                        {resendingId === h.id ? 'Sending…' : '↻ Resend link'}
                      </button>
                    )}
                    <button onClick={() => handleDelete(h)} style={btnDanger}>Delete</button>
                  </div>
                </Td>
              </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}

      {viewing && (
        <Modal title="Timesheet" onClose={() => setViewing(null)} width={880}>
          <TimesheetDetailView
            header={viewing}
            lines={[...(viewing.timesheets || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''))}
            workerName={viewing.workers?.name}
            onClose={() => setViewing(null)}
            onEdit={() => { const h = viewing; setViewing(null); openEdit(h); }}
          />
          {viewing.status === 'pending' && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
              <button disabled={approving} style={{ ...btnPrimary, background: '#16a34a' }} onClick={async () => {
                if (!window.confirm('Approve this timesheet? The server re-checks the hours split, locks the sheet, and emails the hours-only PDF to the client.')) return;
                setApproving(true);
                const r = await invokeApprove(viewing.id);
                setApproving(false);
                if (r.ok) {
                  showToast(r.data?.pdf?.ok
                    ? 'Approved and locked — PDF emailed to the client'
                    : 'Approved and locked — PDF email pending (the bell lights up if it fails)', 'success');
                  setViewing(null); load(); refreshBadge?.();
                } else showToast(r.error, 'error');
              }}>{approving ? 'Approving…' : '✓ Approve, lock & email PDF'}</button>
            </div>
          )}
          {viewing.locked && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 14,
              background: 'rgba(234,179,8,0.06)', border: '1px solid rgba(234,179,8,0.25)',
              borderRadius: 8, padding: '10px 14px',
            }}>
              <span style={{ fontSize: 12.5, color: C.textMuted }}>
                🔒 This sheet is locked. Resetting reopens the workflow so it can be edited and re-approved — the reason is logged.
              </span>
              <button style={{ ...btnSmall, color: '#fbbf24', borderColor: '#78350f', marginLeft: 'auto' }} onClick={async () => {
                const reason = window.prompt('Reset this locked timesheet — enter the reason (required, it is logged):');
                if (reason == null) return;
                if (!reason.trim()) { showToast('A reason is required to reset the workflow.', 'error'); return; }
                const { error } = await supabase.rpc('reset_timesheet_workflow', {
                  p_header_id: viewing.id, p_reason: reason.trim(),
                });
                if (error) showToast(error.message, 'error');
                else {
                  showToast('Workflow reset — the sheet is editable again', 'success');
                  setViewing(null); load(); refreshBadge?.();
                }
              }}>
                🔓 Reset workflow (admin)
              </button>
            </div>
          )}
          {viewing.status !== 'rejected' && (
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 16px', marginTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Supervisor sign-off</div>
              <div style={{ fontSize: 13, color: viewing.client_approved ? C.success : C.text, marginBottom: 10 }}>
                {viewing.client_approved
                  ? `✓ Signed off${viewing.client_approved_by ? ` by ${viewing.client_approved_by}` : ''}${viewing.client_approved_at ? ` on ${fmtDate(viewing.client_approved_at)}` : ''} — approved and billable in Payroll.`
                  : viewing.client_approval_sent_at
                    ? `⏳ Awaiting the site supervisor — sent to ${viewing.client_approval_sent_to || 'site contact'} on ${fmtDate(viewing.client_approval_sent_at)}. Auto-approves on ${fmtDate(new Date(new Date(viewing.client_approval_sent_at).getTime() + 7 * 86400000))} if there's no response.`
                    : `⚠ Not yet sent to the site supervisor — check the project has a site contact, then Send below. Auto-approves on ${fmtDate(new Date(new Date(viewing.created_at).getTime() + 7 * 86400000))} regardless.`}
              </div>
              {!viewing.client_approved && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button style={{ ...btnSmall, color: '#93c5fd', borderColor: '#1e3a5f' }} onClick={async () => {
                    const r = await sendTimesheetForClientApproval(viewing.id, { force: true });
                    if (r.ok) { showToast(`Sent to site supervisor — ${r.sentTo}`, 'success'); load(); setViewing(null); }
                    else showToast(r.error, 'error');
                  }}>
                    {viewing.client_approval_sent_at ? '↻ Resend to supervisor' : '→ Send to supervisor'}
                  </button>
                  <button style={{ ...btnSmall, color: '#4ade80', borderColor: '#16653a' }} onClick={async () => {
                    if (!window.confirm('Mark this timesheet as accepted by the client (e.g. approved verbally/by phone)? It becomes billable immediately.')) return;
                    const r = await markClientApprovedManually(viewing.id, 'Marked by admin (verbal/phone approval)');
                    if (r.ok) { showToast('Marked client-accepted — now billable', 'success'); load(); setViewing(null); }
                    else showToast(r.error, 'error');
                  }}>
                    ✓ Mark accepted (verbal)
                  </button>
                </div>
              )}
            </div>
          )}
        </Modal>
      )}

      {modal && (
        <Modal title={modal === 'add' ? 'Add Daily Timesheet' : 'Edit Daily Timesheet'} onClose={closeModal} width={820}>
          {loadingForm || !editInitial ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner /></div>
          ) : (
            <DailyTimesheetForm
              initial={editInitial}
              workerId={editWorkerId}
              workers={workers}
              allowAdmin
              allowReview={modal !== 'add'}
              onWorkerChange={setEditWorkerId}
              onSaved={onSaved}
              onCancel={closeModal}
              showToast={showToast}
            />
          )}
        </Modal>
      )}
    </div>
  );
}
