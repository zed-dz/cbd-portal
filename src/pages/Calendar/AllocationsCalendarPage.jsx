import { Fragment, useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnSmall } from '../../theme';
import { Modal, Field, Spinner } from '../../components';

function getMondayOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getWeekDays(monday) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    return d.toISOString().split('T')[0];
  });
}

function isAllocOnDay(alloc, dayISO) {
  if (!alloc.start_date) return false;
  const start = alloc.start_date;
  const end = alloc.end_date || alloc.start_date;
  return start <= dayISO && end >= dayISO;
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ALLOC_COLORS = ['#f97316', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#eab308', '#06b6d4'];

const allocDefaults = {
  worker_id: '', site: '', client: '', project: '', address: '', site_manager: '',
  manager_phone: '', status: 'pending', start_date: '', end_date: '', notes: '',
};

export function AllocationsCalendarPage({ showToast }) {
  const [weekStart, setWeekStart] = useState(() => getMondayOfWeek(new Date()));
  const [allocations, setAllocations] = useState([]);
  const [allWorkers, setAllWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(allocDefaults);
  const [saving, setSaving] = useState(false);

  const weekDays = getWeekDays(weekStart);
  const weekEnd = weekDays[6];

  const load = useCallback(async () => {
    setLoading(true);
    const startDay = weekDays[0];
    const endDay = weekEnd;
    const [a, w] = await Promise.all([
      supabase.from('allocations')
        .select('*, workers(name, job_title)')
        .lte('start_date', endDay)
        .or(`end_date.is.null,end_date.gte.${startDay}`),
      supabase.from('workers').select('id, name, job_title').order('name'),
    ]);
    if (a.error) showToast(a.error.message, 'error');
    else setAllocations(a.data || []);
    if (w.data) setAllWorkers(w.data);
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showToast, weekStart]);

  useEffect(() => { load(); }, [load]);

  const openCreate = (prefill = {}) => {
    setForm({ ...allocDefaults, ...prefill });
    setModal('add');
  };
  const openEdit = (a) => {
    setForm({
      worker_id: a.worker_id || '', site: a.site || '', client: a.client || '',
      project: a.project || '', address: a.address || '', site_manager: a.site_manager || '',
      manager_phone: a.manager_phone || '', status: a.status, start_date: a.start_date || '',
      end_date: a.end_date || '', notes: a.notes || '',
    });
    setModal(a);
  };
  const closeModal = () => { setModal(null); setForm(allocDefaults); };

  const handleSave = async () => {
    if (!form.worker_id || !form.start_date) { showToast('Worker and start date are required.', 'error'); return; }
    setSaving(true);
    const payload = { ...form, end_date: form.end_date || null };
    if (modal === 'add') {
      const { error } = await supabase.from('allocations').insert([payload]);
      if (error) showToast(error.message, 'error');
      else { showToast('Allocation created', 'success'); closeModal(); load(); }
    } else {
      const { error } = await supabase.from('allocations').update(payload).eq('id', modal.id);
      if (error) showToast(error.message, 'error');
      else { showToast('Allocation updated', 'success'); closeModal(); load(); }
    }
    setSaving(false);
  };

  const prevWeek = () => { const d = new Date(weekStart); d.setDate(d.getDate() - 7); setWeekStart(d); };
  const nextWeek = () => { const d = new Date(weekStart); d.setDate(d.getDate() + 7); setWeekStart(d); };
  const goToday  = () => setWeekStart(getMondayOfWeek(new Date()));

  // Assign a stable color per worker
  const workerColorMap = {};
  allWorkers.forEach((w, i) => { workerColorMap[w.id] = ALLOC_COLORS[i % ALLOC_COLORS.length]; });

  // Workers who have at least one allocation this week
  const workerIds = [...new Set(allocations.map(a => a.worker_id))];
  const calWorkers = allWorkers.filter(w => workerIds.includes(w.id));

  const formatDayHeader = (iso) => {
    const d = new Date(iso + 'T00:00:00');
    return `${DAY_LABELS[d.getDay() === 0 ? 6 : d.getDay() - 1]} ${d.getDate()}/${d.getMonth() + 1}`;
  };

  const todayISO = new Date().toISOString().split('T')[0];

  return (
    <div>
      {/* Week navigation */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <button onClick={prevWeek} style={btnSecondary}>← Prev Week</button>
        <button onClick={goToday} style={btnSmall}>Today</button>
        <button onClick={nextWeek} style={btnSecondary}>Next Week →</button>
        <span style={{ color: C.textMuted, fontSize: 13, marginLeft: 8, fontFamily: '"DM Mono", monospace' }}>
          {weekDays[0]} — {weekEnd}
        </span>
        <button onClick={() => openCreate({ start_date: weekDays[0] })} style={{ ...btnPrimary, marginLeft: 'auto' }}>+ Add Allocation</button>
      </div>

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div> : (
        <div style={{ overflowX: 'auto' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: `160px repeat(7, 1fr)`,
            minWidth: 900,
            border: `1px solid ${C.border}`,
            borderRadius: 10,
            overflow: 'hidden',
          }}>
            {/* Header row */}
            <div style={{ background: C.bg, padding: '10px 12px', borderBottom: `1px solid ${C.border}`, borderRight: `1px solid ${C.border}`, fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>
              Worker
            </div>
            {weekDays.map(day => (
              <div key={day} style={{
                background: day === todayISO ? 'rgba(249,115,22,0.08)' : C.bg,
                padding: '10px 8px', borderBottom: `1px solid ${C.border}`,
                borderRight: `1px solid ${C.border}`, fontSize: 11,
                color: day === todayISO ? C.accent : C.textMuted,
                textAlign: 'center', fontWeight: day === todayISO ? 700 : 400,
                fontFamily: '"DM Mono", monospace',
              }}>
                {formatDayHeader(day)}
              </div>
            ))}

            {/* Worker rows */}
            {calWorkers.length === 0 ? (
              <div style={{ gridColumn: '1 / -1', padding: 24, textAlign: 'center', color: C.textMuted, fontSize: 13 }}>
                No allocations this week. Click a day cell or "+ Add Allocation" to create one.
              </div>
            ) : calWorkers.map(worker => (
              <Fragment key={worker.id}>
                {/* Worker name cell */}
                <div style={{
                  padding: '12px 12px', borderBottom: `1px solid ${C.border}`,
                  borderRight: `1px solid ${C.border}`, background: C.sidebar,
                }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: C.text }}>{worker.name}</div>
                  {worker.job_title && <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>{worker.job_title}</div>}
                </div>

                {/* Day cells */}
                {weekDays.map(day => {
                  const dayAllocs = allocations.filter(a => a.worker_id === worker.id && isAllocOnDay(a, day));
                  return (
                    <div key={day} onClick={() => !dayAllocs.length && openCreate({ worker_id: worker.id, start_date: day })} style={{
                      padding: 4, borderBottom: `1px solid ${C.border}`, borderRight: `1px solid ${C.border}`,
                      minHeight: 52, background: day === todayISO ? 'rgba(249,115,22,0.04)' : C.card,
                      cursor: dayAllocs.length ? 'default' : 'pointer',
                      transition: 'background 0.1s',
                    }}>
                      {dayAllocs.map(a => (
                        <div key={a.id} onClick={(e) => { e.stopPropagation(); openEdit(a); }} style={{
                          background: workerColorMap[a.worker_id] || C.accent,
                          color: '#fff', borderRadius: 4, padding: '3px 6px', fontSize: 11,
                          marginBottom: 2, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap', fontWeight: 500,
                        }}>
                          {a.client || a.site || 'Allocated'}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>
      )}

      {/* Also show all workers row for empty click to add */}
      {!loading && calWorkers.length === 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: `160px repeat(7, 1fr)`, minWidth: 900, marginTop: 2 }}>
          <div />
          {weekDays.map(day => (
            <div key={day} onClick={() => openCreate({ start_date: day })} style={{
              border: `1px dashed ${C.border}`, borderRadius: 4, margin: 4,
              minHeight: 48, display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: C.textMuted, fontSize: 11,
            }}>
              + Add
            </div>
          ))}
        </div>
      )}

      {modal && (
        <Modal title={modal === 'add' ? 'Create Allocation' : 'Edit Allocation'} onClose={closeModal} width={540}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Worker *">
                <select style={inputStyle} value={form.worker_id} onChange={e => setForm(f => ({ ...f, worker_id: e.target.value }))}>
                  <option value="">Select a worker…</option>
                  {allWorkers.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Start Date *"><input style={inputStyle} type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} /></Field>
            <Field label="End Date"><input style={inputStyle} type="date" value={form.end_date} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} /></Field>
            <Field label="Client"><input style={inputStyle} value={form.client} onChange={e => setForm(f => ({ ...f, client: e.target.value }))} /></Field>
            <Field label="Site"><input style={inputStyle} value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))} /></Field>
            <Field label="Project"><input style={inputStyle} value={form.project} onChange={e => setForm(f => ({ ...f, project: e.target.value }))} /></Field>
            <Field label="Site Manager"><input style={inputStyle} value={form.site_manager} onChange={e => setForm(f => ({ ...f, site_manager: e.target.value }))} /></Field>
            <Field label="Status">
              <select style={inputStyle} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                <option value="pending">Pending</option>
                <option value="confirmed">Confirmed</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Notes"><textarea style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></Field>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={closeModal} style={btnSecondary}>Cancel</button>
            <button onClick={handleSave} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
