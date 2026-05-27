import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnDanger, btnSmall } from '../../theme';
import { todayISO, fmtDate } from '../../utils/dates';
import { downloadCSV } from '../../utils/csv';
import { computeTimesheetHours, buildXeroCSV } from '../../utils/payroll';
import { SCENARIOS } from '../../constants/scenarios';
import { Spinner, Modal, Field, TableWrap, Th, Td, EmptyState, timesheetBadge } from '../../components';

const tsDefaults = {
  worker_id: '', client: '', site: '', date: '', scenario: 'standard',
  start_time: '', end_time: '', break_minutes: 0,
  pay_hours: '', charge_hours: '', overtime_hours: 0,
  is_weekend: false, is_night_shift: false, geo_loading: false,
  travel_allowance: 0, meal_allowance: 0,
  awj_reference: '', leave_reason: '', medical_cert_url: '',
  admin_override_hours: '', status: 'pending', notes: '',
};

export function TimesheetsPage({ showToast, refreshBadge }) {
  const [timesheets, setTimesheets] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [configMap, setConfigMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState('');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(tsDefaults);
  const [saving, setSaving] = useState(false);

  const [clients, setClients] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    const [t, w, cfg, c] = await Promise.all([
      supabase.from('timesheets').select('*, workers(name)').order('created_at', { ascending: false }),
      supabase.from('workers').select('id, name, worker_type, pay_rate_regular').is('archived_at', null).order('name'),
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
      start_time: ts.start_time ? ts.start_time.slice(0, 16) : '',
      end_time: ts.end_time ? ts.end_time.slice(0, 16) : '',
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
      start_time: computed.start_time || null, end_time: computed.end_time || null,
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

  const handleApprove = async (ts) => {
    const { error } = await supabase.from('timesheets').update({ status: 'approved' }).eq('id', ts.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Timesheet approved', 'success'); load(); refreshBadge?.(); }
  };

  const handleReject = async (ts) => {
    const { error } = await supabase.from('timesheets').update({ status: 'rejected' }).eq('id', ts.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Timesheet rejected', 'info'); load(); refreshBadge?.(); }
  };

  const handleApproveAll = async () => {
    const pending = timesheets.filter(ts => ts.status === 'pending');
    if (!pending.length) { showToast('No pending timesheets to approve.', 'info'); return; }
    if (!window.confirm(`Approve all ${pending.length} pending timesheets?`)) return;
    const { error } = await supabase.from('timesheets').update({ status: 'approved' }).in('id', pending.map(ts => ts.id));
    if (error) showToast(error.message, 'error');
    else { showToast(`${pending.length} timesheets approved`, 'success'); load(); refreshBadge?.(); }
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

  const filtered = timesheets.filter(ts => {
    const matchStatus = !filterStatus || ts.status === filterStatus;
    const matchSearch = !search || ts.workers?.name?.toLowerCase().includes(search.toLowerCase()) || (ts.client || '').toLowerCase().includes(search.toLowerCase()) || (ts.site || '').toLowerCase().includes(search.toLowerCase());
    return matchStatus && matchSearch;
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
          <thead><tr><Th>Worker</Th><Th>Date</Th><Th>Scenario</Th><Th>Pay Hrs</Th><Th>Charge Hrs</Th><Th>OT / Allowances</Th><Th>Status</Th><Th>Actions</Th></tr></thead>
          <tbody>
            {filtered.map(ts => (
              <tr key={ts.id}>
                <Td>{ts.workers?.name || '—'}</Td>
                <Td>{fmtDate(ts.date)}</Td>
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
                    {ts.status === 'pending' && <>
                      <button onClick={() => handleApprove(ts)} style={{ ...btnSmall, color: '#4ade80' }}>✓ Approve</button>
                      <button onClick={() => handleReject(ts)} style={{ ...btnSmall, color: '#fca5a5' }}>✗ Reject</button>
                    </>}
                    <button onClick={() => openEdit(ts)} style={btnSmall}>Edit</button>
                    <button onClick={() => handleDelete(ts)} style={btnDanger}>Delete</button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} style={{ padding: '10px 16px', color: C.textMuted, fontSize: 13, borderTop: `2px solid ${C.border}` }}>
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
