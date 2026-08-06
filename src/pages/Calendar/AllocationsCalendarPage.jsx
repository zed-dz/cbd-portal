import { Fragment, useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnPrimary, btnSecondary, btnSmall } from '../../theme';
import { Modal, Field, Spinner, EmptyState, DateField } from '../../components';
import { PUBLIC_HOLIDAYS } from '../../utils/payroll';
import { localISO } from '../../utils/dates';

// Calendar entry types — RDO / leave days get their own colours instead of the
// per-worker colour, so the roster reads at a glance.
const ALLOCATION_TYPES = [
  { id: 'work', label: 'Work shift', color: null },
  { id: 'rdo', label: 'RDO day', color: '#16a34a' },
  { id: 'personal_leave', label: 'Personal / Sick leave', color: '#ca8a04' },
  { id: 'annual_leave', label: 'Annual leave', color: '#0284c7' },
];
const typeMeta = (a) => ALLOCATION_TYPES.find(t => t.id === (a.allocation_type || 'work')) || ALLOCATION_TYPES[0];
const isNightAlloc = (a) => !!a.start_time && new Date(a.start_time).getHours() >= 14;
const PH_TINT = 'rgba(168,85,247,0.12)';

function CalendarLegend() {
  const chip = (bg, label) => (
    <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: C.textMuted }}>
      <span style={{ width: 10, height: 10, borderRadius: 3, background: bg, display: 'inline-block' }} />{label}
    </span>
  );
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', margin: '2px 0 10px' }}>
      {chip(C.accent, 'Work (worker colour)')}
      {chip('#16a34a', 'RDO day')}
      {chip('#ca8a04', 'Personal / Sick')}
      {chip('#0284c7', 'Annual leave')}
      {chip(PH_TINT, 'Public holiday')}
      <span style={{ fontSize: 11, color: C.textMuted }}>🌙 night shift (starts 2pm+)</span>
      <span style={{ fontSize: 11, color: C.textMuted }}>✓ faded = timesheet approved</span>
    </div>
  );
}

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
    return localISO(d);
  });
}

function isAllocOnDay(alloc, dayISO) {
  if (!alloc.start_date) return false;
  const start = alloc.start_date;
  const end = alloc.end_date || alloc.start_date;
  return start <= dayISO && end >= dayISO;
}

// Local date, not UTC — toISOString() on a local-midnight Date lands on the
// previous day in AEST/AEDT, which shifted every cell in the calendar by one.
function isoFromDate(d) { return localISO(d); }

function getMonthGrid(year, month /* 0-indexed */) {
  // Returns a 6-row × 7-col grid of { iso, inMonth, dow } cells starting on Monday.
  const first = new Date(year, month, 1);
  const firstDow = first.getDay(); // 0 = Sun
  const offset = firstDow === 0 ? 6 : firstDow - 1;
  const start = new Date(year, month, 1 - offset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return {
      iso: isoFromDate(d),
      day: d.getDate(),
      inMonth: d.getMonth() === month,
      dow: d.getDay(), // 0 = Sun
      date: d,
    };
  });
}

function countBusinessDaysInMonth(year, month) {
  const last = new Date(year, month + 1, 0).getDate();
  let count = 0;
  for (let i = 1; i <= last; i++) {
    const dow = new Date(year, month, i).getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ALLOC_COLORS = ['#f97316', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#eab308', '#06b6d4'];

const allocDefaults = {
  worker_id: '', site: '', client: '', project: '', address: '', site_manager: '',
  manager_phone: '', status: 'pending', start_date: '', end_date: '', notes: '',
  allocation_type: 'work',
};

export function AllocationsCalendarPage({ showToast }) {
  const [view, setView] = useState('weekly'); // 'weekly' | 'monthly'
  const [weekStart, setWeekStart] = useState(() => getMondayOfWeek(new Date()));
  const [monthDate, setMonthDate] = useState(() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; });
  const [selectedWorkerId, setSelectedWorkerId] = useState(null);
  const [allocations, setAllocations] = useState([]);
  const [allWorkers, setAllWorkers] = useState([]);
  const [approvedSet, setApprovedSet] = useState(() => new Set()); // "workerId|date" with an approved timesheet
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(allocDefaults);
  const [saving, setSaving] = useState(false);

  const weekDays = getWeekDays(weekStart);
  const weekEnd = weekDays[6];

  // Date range we fetch — wide enough for whichever view is active so toggling
  // doesn't re-fetch on every switch.
  const rangeStart = view === 'weekly'
    ? weekDays[0]
    : isoFromDate(new Date(monthDate.getFullYear(), monthDate.getMonth(), 1 - 7));
  const rangeEnd = view === 'weekly'
    ? weekEnd
    : isoFromDate(new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 7));

  const load = useCallback(async () => {
    setLoading(true);
    const [a, w, t] = await Promise.all([
      supabase.from('allocations')
        .select('*, workers(name, job_title)')
        .lte('start_date', rangeEnd)
        .or(`end_date.is.null,end_date.gte.${rangeStart}`),
      supabase.from('workers').select('id, name, job_title').is('archived_at', null).order('name'),
      supabase.from('timesheets').select('worker_id, date')
        .eq('status', 'approved').gte('date', rangeStart).lte('date', rangeEnd),
    ]);
    if (a.error) showToast(a.error.message, 'error');
    else setAllocations(a.data || []);
    if (w.data) setAllWorkers(w.data);
    setApprovedSet(new Set((t.data || []).map(r => `${r.worker_id}|${r.date}`)));
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showToast, rangeStart, rangeEnd]);

  useEffect(() => { load(); }, [load]);

  // Default the monthly view to the first worker with allocations.
  useEffect(() => {
    if (view !== 'monthly' || selectedWorkerId) return;
    const first = allWorkers.find(w => allocations.some(a => a.worker_id === w.id)) || allWorkers[0];
    if (first) setSelectedWorkerId(first.id);
  }, [view, allWorkers, allocations, selectedWorkerId]);

  const openCreate = (prefill = {}) => { setForm({ ...allocDefaults, ...prefill }); setModal('add'); };
  const openEdit = (a) => {
    setForm({
      worker_id: a.worker_id || '', site: a.site || '', client: a.client || '',
      project: a.project || '', address: a.address || '', site_manager: a.site_manager || '',
      manager_phone: a.manager_phone || '', status: a.status, start_date: a.start_date || '',
      end_date: a.end_date || '', notes: a.notes || '',
      allocation_type: a.allocation_type || 'work',
    });
    setModal(a);
  };
  const closeModal = () => { setModal(null); setForm(allocDefaults); };

  const handleSave = async () => {
    if (!form.worker_id || !form.start_date) { showToast('Worker and start date are required.', 'error'); return; }

    // JIT conflict check — the in-memory `allocations` is range-filtered for
    // the visible calendar window, so an out-of-view clash could slip through.
    // Hit the DB for any live overlap on this worker's date range.
    const winStart = form.start_date;
    const winEnd   = form.end_date || form.start_date;
    const { data: existing } = await supabase
      .from('allocations')
      .select('id, client, site, start_date, end_date, status')
      .eq('worker_id', form.worker_id)
      .in('status', ['pending', 'confirmed'])
      .lte('start_date', winEnd)
      .or(`end_date.is.null,end_date.gte.${winStart}`);
    const clashes = (existing || []).filter(a => modal === 'add' || a.id !== modal.id);
    if (clashes.length > 0) {
      const workerName = allWorkers.find(w => w.id === form.worker_id)?.name || 'This worker';
      const summary = clashes.slice(0, 3).map(c =>
        `• ${c.client || c.site || 'Allocated'} (${c.start_date}${c.end_date && c.end_date !== c.start_date ? ` → ${c.end_date}` : ''}, ${c.status})`
      ).join('\n');
      const extra = clashes.length > 3 ? `\n…and ${clashes.length - 3} more.` : '';
      const ok = window.confirm(
        `⚠ ${workerName} is already allocated during this period:\n\n${summary}${extra}\n\nContinue anyway?`
      );
      if (!ok) return;
    }

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

  const prevWeek  = () => { const d = new Date(weekStart); d.setDate(d.getDate() - 7); setWeekStart(d); };
  const nextWeek  = () => { const d = new Date(weekStart); d.setDate(d.getDate() + 7); setWeekStart(d); };
  const goToday   = () => setWeekStart(getMondayOfWeek(new Date()));
  const prevMonth = () => { const d = new Date(monthDate); d.setMonth(d.getMonth() - 1); setMonthDate(d); };
  const nextMonth = () => { const d = new Date(monthDate); d.setMonth(d.getMonth() + 1); setMonthDate(d); };
  const goThisMonth = () => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); setMonthDate(d); };

  const workerColorMap = {};
  allWorkers.forEach((w, i) => { workerColorMap[w.id] = ALLOC_COLORS[i % ALLOC_COLORS.length]; });

  const ViewToggle = (
    <div style={{
      display: 'inline-flex', borderRadius: R.md, border: `1px solid ${C.border}`,
      overflow: 'hidden', background: C.card,
    }}>
      {[
        { id: 'weekly',  label: 'Weekly'  },
        { id: 'monthly', label: 'Monthly' },
      ].map(t => {
        const active = view === t.id;
        return (
          <button key={t.id} onClick={() => setView(t.id)} style={{
            background: active ? C.cardHover : 'transparent',
            color: active ? C.text : C.textMuted,
            border: 'none', padding: '7px 16px', cursor: 'pointer',
            fontSize: 12.5, fontWeight: active ? 600 : 500,
            borderLeft: t.id === 'monthly' ? `1px solid ${C.border}` : 'none',
          }}>{t.label}</button>
        );
      })}
    </div>
  );

  if (view === 'monthly') {
    return (
      <MonthlyWorkerView
        workers={allWorkers}
        allocations={allocations}
        approvedSet={approvedSet}
        loading={loading}
        monthDate={monthDate}
        prevMonth={prevMonth}
        nextMonth={nextMonth}
        goThisMonth={goThisMonth}
        selectedWorkerId={selectedWorkerId}
        setSelectedWorkerId={setSelectedWorkerId}
        workerColorMap={workerColorMap}
        viewToggle={ViewToggle}
        openCreate={openCreate}
        openEdit={openEdit}
        modal={modal}
        form={form}
        setForm={setForm}
        closeModal={closeModal}
        handleSave={handleSave}
        saving={saving}
      />
    );
  }

  // ── Weekly view ──────────────────────────────────────────────────────────
  const workerIds = [...new Set(allocations.map(a => a.worker_id))];
  const calWorkers = allWorkers.filter(w => workerIds.includes(w.id));

  const formatDayHeader = (iso) => {
    const d = new Date(iso + 'T00:00:00');
    return `${DAY_LABELS[d.getDay() === 0 ? 6 : d.getDay() - 1]} ${d.getDate()}/${d.getMonth() + 1}`;
  };

  const todayISO = localISO();

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        {ViewToggle}
        <div style={{ width: 8 }} />
        <button onClick={prevWeek} style={btnSecondary}>← Prev Week</button>
        <button onClick={goToday} style={btnSmall}>Today</button>
        <button onClick={nextWeek} style={btnSecondary}>Next Week →</button>
        <span style={{ color: C.textMuted, fontSize: 13, marginLeft: 8, fontFamily: MONO }}>
          {weekDays[0]} — {weekEnd}
        </span>
        <button onClick={() => openCreate({ start_date: weekDays[0] })} style={{ ...btnPrimary, marginLeft: 'auto' }}>+ Add Allocation</button>
      </div>

      <CalendarLegend />

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
            <div style={{ background: C.bg, padding: '10px 12px', borderBottom: `1px solid ${C.border}`, borderRight: `1px solid ${C.border}`, fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>
              Worker
            </div>
            {weekDays.map(day => (
              <div key={day} style={{
                background: PUBLIC_HOLIDAYS.has(day) ? PH_TINT : (day === todayISO ? 'rgba(249,115,22,0.08)' : C.bg),
                padding: '10px 8px', borderBottom: `1px solid ${C.border}`,
                borderRight: `1px solid ${C.border}`, fontSize: 11,
                color: day === todayISO ? C.accent : C.textMuted,
                textAlign: 'center', fontWeight: day === todayISO ? 700 : 400,
                fontFamily: MONO,
              }}>
                {formatDayHeader(day)}
              </div>
            ))}

            {calWorkers.length === 0 ? (
              <div style={{ gridColumn: '1 / -1', padding: 24, textAlign: 'center', color: C.textMuted, fontSize: 13 }}>
                No allocations this week. Click a day cell or "+ Add Allocation" to create one.
              </div>
            ) : calWorkers.map(worker => (
              <Fragment key={worker.id}>
                <div
                  onClick={() => { setSelectedWorkerId(worker.id); setView('monthly'); }}
                  title="Open monthly view for this worker"
                  style={{
                    padding: '12px 12px', borderBottom: `1px solid ${C.border}`,
                    borderRight: `1px solid ${C.border}`, background: C.sidebar,
                    cursor: 'pointer', transition: 'background 120ms',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = C.cardHover}
                  onMouseLeave={e => e.currentTarget.style.background = C.sidebar}
                >
                  <div style={{ fontWeight: 600, fontSize: 13, color: C.text }}>{worker.name}</div>
                  {worker.job_title && <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>{worker.job_title}</div>}
                  <div style={{ fontSize: 9.5, color: C.accent, marginTop: 4, fontFamily: MONO, letterSpacing: 0.4 }}>→ month view</div>
                </div>

                {weekDays.map(day => {
                  const dayAllocs = allocations.filter(a => a.worker_id === worker.id && isAllocOnDay(a, day));
                  return (
                    <div key={day} onClick={() => !dayAllocs.length && openCreate({ worker_id: worker.id, start_date: day })} style={{
                      padding: 4, borderBottom: `1px solid ${C.border}`, borderRight: `1px solid ${C.border}`,
                      minHeight: 52,
                      background: PUBLIC_HOLIDAYS.has(day) ? PH_TINT : (day === todayISO ? 'rgba(249,115,22,0.04)' : C.card),
                      cursor: dayAllocs.length ? 'default' : 'pointer',
                      transition: 'background 0.1s',
                    }}>
                      {dayAllocs.map(a => {
                        const tm = typeMeta(a);
                        const done = approvedSet.has(`${a.worker_id}|${day}`);
                        return (
                          <div key={a.id} onClick={(e) => { e.stopPropagation(); openEdit(a); }}
                            title={`${tm.label}${isNightAlloc(a) ? ' · night shift' : ''}${done ? ' · timesheet approved ✓' : ''}`}
                            style={{
                              background: tm.color || workerColorMap[a.worker_id] || C.accent,
                              color: '#fff', borderRadius: 4, padding: '3px 6px', fontSize: 11,
                              marginBottom: 2, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap', fontWeight: 500,
                              opacity: done ? 0.55 : 1,
                              outline: done ? '1px solid rgba(34,197,94,0.9)' : 'none',
                            }}>
                            {done ? '✓ ' : ''}{isNightAlloc(a) ? '🌙 ' : ''}{tm.id === 'work' ? (a.client || a.site || 'Allocated') : tm.label}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>
      )}

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

      {modal && <AllocationModal {...{ modal, form, setForm, closeModal, handleSave, saving, allWorkers }} />}
    </div>
  );
}

// ── Monthly per-worker view ────────────────────────────────────────────────

function MonthlyWorkerView({
  workers, allocations, approvedSet, loading, monthDate, prevMonth, nextMonth, goThisMonth,
  selectedWorkerId, setSelectedWorkerId, workerColorMap, viewToggle,
  openCreate, openEdit, modal, form, setForm, closeModal, handleSave, saving,
}) {
  const year  = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const monthLabel = monthDate.toLocaleString('en-AU', { month: 'long', year: 'numeric' });
  const todayISO = localISO();

  const grid = useMemo(() => getMonthGrid(year, month), [year, month]);

  const workerAllocs = useMemo(
    () => allocations.filter(a => a.worker_id === selectedWorkerId),
    [allocations, selectedWorkerId]
  );

  const selectedWorker = workers.find(w => w.id === selectedWorkerId);

  // Build day→allocations map within current month
  const inMonthIsoSet = useMemo(() => new Set(grid.filter(c => c.inMonth).map(c => c.iso)), [grid]);

  const dayAllocs = useMemo(() => {
    const m = new Map();
    for (const iso of inMonthIsoSet) m.set(iso, []);
    for (const a of workerAllocs) {
      for (const iso of inMonthIsoSet) {
        if (isAllocOnDay(a, iso)) m.get(iso).push(a);
      }
    }
    return m;
  }, [workerAllocs, inMonthIsoSet]);

  // KPIs
  const workingDays = countBusinessDaysInMonth(year, month);
  let allocatedDays = 0;
  let totalHours = 0;
  for (const [iso, allocs] of dayAllocs.entries()) {
    if (!allocs.length) continue;
    const dow = new Date(iso + 'T00:00:00').getDay();
    if (dow !== 0 && dow !== 6) allocatedDays++;
    // Approximate hours: 8 per day per allocation segment (we don't store per-day
    // hours on allocations — they're confirmed against timesheets later).
    totalHours += 8;
  }
  const unallocatedDays = Math.max(0, workingDays - allocatedDays);
  const clientsThisMonth = [...new Set(workerAllocs.flatMap(a => {
    const start = a.start_date;
    const end = a.end_date || a.start_date;
    return [...inMonthIsoSet].some(iso => start <= iso && end >= iso) && a.client ? [a.client] : [];
  }))];

  // Allocation summary — collapse contiguous same-client spans into one row
  const summaryRows = useMemo(() => {
    const rows = [];
    const sorted = [...workerAllocs].sort((a, b) => (a.start_date || '').localeCompare(b.start_date || ''));
    for (const a of sorted) {
      const start = a.start_date;
      const end = a.end_date || a.start_date;
      // Trim to current month
      const monthStart = isoFromDate(new Date(year, month, 1));
      const monthEnd = isoFromDate(new Date(year, month + 1, 0));
      if (end < monthStart || start > monthEnd) continue;
      const visStart = start < monthStart ? monthStart : start;
      const visEnd   = end > monthEnd ? monthEnd : end;
      const days = Math.max(0, (new Date(visEnd) - new Date(visStart)) / 86400000 + 1);
      // Count business days within span
      let bDays = 0;
      for (let i = 0; i < days; i++) {
        const d = new Date(visStart);
        d.setDate(d.getDate() + i);
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) bDays++;
      }
      rows.push({
        id: a.id,
        client: a.client || a.site || '—',
        start: visStart,
        end: visEnd,
        days,
        hours: bDays * 8,
        status: a.status,
        raw: a,
      });
    }
    return rows;
  }, [workerAllocs, year, month]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        {viewToggle}
        <div style={{ width: 8 }} />
        <button onClick={prevMonth} style={btnSecondary}>← Prev Month</button>
        <button onClick={goThisMonth} style={btnSmall}>This Month</button>
        <button onClick={nextMonth} style={btnSecondary}>Next Month →</button>
        <span style={{ color: C.textMuted, fontSize: 13, marginLeft: 8, fontFamily: MONO }}>{monthLabel}</span>
        {selectedWorker && (
          <button
            onClick={() => openCreate({ worker_id: selectedWorker.id, start_date: isoFromDate(new Date(year, month, 1)) })}
            style={{ ...btnPrimary, marginLeft: 'auto' }}
          >
            + Add Allocation
          </button>
        )}
      </div>

      <CalendarLegend />

      {/* Worker tabs */}
      {workers.length > 0 && (
        <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}`, marginBottom: 18, overflowX: 'auto', paddingBottom: 1 }}>
          {workers.map(w => {
            const active = w.id === selectedWorkerId;
            const hasAlloc = allocations.some(a => a.worker_id === w.id);
            return (
              <button key={w.id} onClick={() => setSelectedWorkerId(w.id)} style={{
                background: 'none', border: 'none',
                borderBottom: active ? `2px solid ${C.accent}` : '2px solid transparent',
                color: active ? C.text : (hasAlloc ? C.textMuted : C.textDim),
                padding: '8px 14px', cursor: 'pointer', fontSize: 13,
                fontWeight: active ? 600 : 500, whiteSpace: 'nowrap', marginBottom: -1,
              }}>
                {w.name}
                {hasAlloc && !active && <span style={{ marginLeft: 5, fontSize: 9, color: C.success }}>●</span>}
              </button>
            );
          })}
        </div>
      )}

      {!selectedWorker ? (
        <EmptyState message="Select a worker above to see their monthly schedule." />
      ) : loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>
      ) : (
        <>
          {/* Header with worker info */}
          <div style={{
            background: C.card, border: `1px solid ${C.border}`, borderRadius: R.lg,
            padding: '16px 20px', marginBottom: 14, display: 'flex',
            alignItems: 'center', gap: 14,
          }}>
            <div style={{
              width: 44, height: 44, borderRadius: '50%', background: workerColorMap[selectedWorker.id] || C.accent,
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 15, fontWeight: 700, letterSpacing: 0.5, flexShrink: 0,
            }}>
              {selectedWorker.name.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 18, fontWeight: 700, color: C.text }}>{selectedWorker.name}</div>
              {selectedWorker.job_title && <div style={{ fontSize: 12, color: C.textMuted }}>{selectedWorker.job_title}</div>}
            </div>
          </div>

          {/* KPI cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
            <KpiCard label="Allocated Days" value={allocatedDays} sub={`of ${workingDays} working days`} color={C.success} />
            <KpiCard label="Unallocated" value={unallocatedDays} sub={unallocatedDays > 0 ? 'days need work' : 'fully booked'} color={unallocatedDays > 0 ? C.warning : C.success} />
            <KpiCard label="Total Hours" value={`${totalHours}h`} sub="est. this month" color={C.info} />
            <KpiCard
              label="Client"
              value={clientsThisMonth[0] || '—'}
              sub={clientsThisMonth.length > 1 ? `+${clientsThisMonth.length - 1} more` : (clientsThisMonth.length === 1 ? '1 project' : 'no client set')}
              color={C.accent}
            />
          </div>

          {/* Calendar grid */}
          <div style={{
            background: C.card, border: `1px solid ${C.border}`, borderRadius: R.lg,
            padding: 14, marginBottom: 14,
          }}>
            <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 14, fontWeight: 700, color: C.text, textAlign: 'center', marginBottom: 10 }}>
              {monthLabel}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 4 }}>
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
                <div key={d} style={{
                  textAlign: 'center', fontSize: 10.5, color: C.textMuted,
                  textTransform: 'uppercase', letterSpacing: 1.5, padding: '4px 0',
                  fontFamily: MONO, fontWeight: 600,
                }}>{d}</div>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
              {grid.map(cell => {
                const allocs = cell.inMonth ? dayAllocs.get(cell.iso) || [] : [];
                const isToday = cell.iso === todayISO;
                const isWeekend = cell.dow === 0 || cell.dow === 6;
                return (
                  <div
                    key={cell.iso}
                    onClick={() => {
                      if (!cell.inMonth) return;
                      if (allocs[0]) openEdit(allocs[0]);
                      else openCreate({ worker_id: selectedWorker.id, start_date: cell.iso });
                    }}
                    style={{
                      position: 'relative',
                      minHeight: 78, padding: 6, borderRadius: R.md,
                      background: !cell.inMonth ? 'transparent'
                        : (isToday ? 'rgba(249,115,22,0.08)'
                        : (PUBLIC_HOLIDAYS.has(cell.iso) ? PH_TINT : C.bg)),
                      border: isToday ? `1px solid ${C.accent}` : `1px solid ${cell.inMonth ? C.border : 'transparent'}`,
                      cursor: cell.inMonth ? 'pointer' : 'default',
                      opacity: cell.inMonth ? 1 : 0.25,
                      transition: 'background 140ms',
                    }}
                  >
                    <div style={{
                      fontSize: 11, color: isToday ? C.accent : (isWeekend ? C.textDim : C.textMuted),
                      fontWeight: isToday ? 700 : 500, marginBottom: 4, fontFamily: MONO,
                    }}>
                      {cell.day}
                    </div>
                    {allocs.map(a => {
                      const tm = typeMeta(a);
                      const done = approvedSet.has(`${a.worker_id}|${cell.iso}`);
                      return (
                        <div key={a.id}
                          title={`${tm.label}${isNightAlloc(a) ? ' · night shift' : ''}${done ? ' · timesheet approved ✓' : ''}`}
                          style={{
                            background: tm.color || workerColorMap[a.worker_id] || C.accent,
                            color: '#fff', borderRadius: R.sm, padding: '2px 6px', fontSize: 10.5,
                            marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap', fontWeight: 500,
                            opacity: done ? 0.55 : 1,
                            outline: done ? '1px solid rgba(34,197,94,0.9)' : 'none',
                          }}>
                          {done ? '✓ ' : ''}{isNightAlloc(a) ? '🌙 ' : ''}{tm.id === 'work' ? (a.client || a.site || 'Allocated') : tm.label}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Summary table */}
          <div style={{
            background: C.card, border: `1px solid ${C.border}`, borderRadius: R.lg, padding: 18,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 14, fontWeight: 700, color: C.text }}>
                Allocation summary — {monthLabel}
              </div>
              <span style={{ fontSize: 11, color: C.textDim, fontFamily: MONO, letterSpacing: 0.3 }}>
                Click any day to edit
              </span>
            </div>
            {summaryRows.length === 0 ? (
              <div style={{ color: C.textMuted, fontSize: 13, padding: '10px 0' }}>
                No allocations for this worker in {monthLabel}.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {summaryRows.map(row => (
                  <div key={row.id}
                    onClick={() => openEdit(row.raw)}
                    style={{
                      display: 'grid', gridTemplateColumns: '160px 1fr 80px 110px',
                      gap: 14, alignItems: 'center', padding: '8px 12px',
                      background: C.bg, borderRadius: R.md, cursor: 'pointer',
                      transition: 'background 140ms',
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = C.cardHover}
                    onMouseLeave={e => e.currentTarget.style.background = C.bg}
                  >
                    <span style={{ fontSize: 12, color: C.textMuted, fontFamily: MONO }}>
                      {fmtRange(row.start, row.end)}
                    </span>
                    <span style={{ fontSize: 13, color: C.text, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.client}
                    </span>
                    <span style={{ fontSize: 12, fontFamily: MONO, color: C.textMuted, textAlign: 'right' }}>
                      {row.hours}h
                    </span>
                    <span style={{ textAlign: 'right' }}>
                      <StatusPill status={row.status} />
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {modal && <AllocationModal {...{ modal, form, setForm, closeModal, handleSave, saving, allWorkers: workers }} />}
    </div>
  );
}

function KpiCard({ label, value, sub, color }) {
  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`,
      borderRadius: R.lg, padding: '16px 18px',
    }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1.4, color: C.textMuted, fontFamily: MONO, fontWeight: 600, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 26, fontWeight: 800, color, lineHeight: 1, letterSpacing: -0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: C.textDim, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function StatusPill({ status }) {
  const map = {
    pending:   { bg: 'rgba(234,179,8,0.15)',  fg: '#fde047' },
    confirmed: { bg: 'rgba(56,189,248,0.15)', fg: '#7dd3fc' },
    completed: { bg: 'rgba(34,197,94,0.15)',  fg: '#86efac' },
    cancelled: { bg: 'rgba(239,68,68,0.13)',  fg: '#fca5a5' },
  };
  const s = map[status] || { bg: C.cardHover, fg: C.textMuted };
  return (
    <span style={{
      background: s.bg, color: s.fg, fontFamily: MONO, fontSize: 10.5,
      fontWeight: 600, padding: '2px 8px', borderRadius: 999, textTransform: 'capitalize',
    }}>{status || '—'}</span>
  );
}

function fmtRange(start, end) {
  if (start === end) {
    const d = new Date(start + 'T00:00:00');
    return `${d.getDate()}/${d.getMonth() + 1}`;
  }
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  const sameMonth = s.getMonth() === e.getMonth();
  return sameMonth
    ? `${s.getDate()}–${e.getDate()}/${s.getMonth() + 1}`
    : `${s.getDate()}/${s.getMonth() + 1}–${e.getDate()}/${e.getMonth() + 1}`;
}

function AllocationModal({ modal, form, setForm, closeModal, handleSave, saving, allWorkers }) {
  return (
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
        <div style={{ gridColumn: '1 / -1' }}>
          <Field label="Type" hint="RDO / leave days show in their own colour on the calendar.">
            <select style={inputStyle} value={form.allocation_type || 'work'} onChange={e => setForm(f => ({ ...f, allocation_type: e.target.value }))}>
              {ALLOCATION_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Start Date *"><DateField value={form.start_date} onChange={v => setForm(f => ({ ...f, start_date: v }))} /></Field>
        <Field label="End Date" hint="Leave empty for a single day."><DateField value={form.end_date} onChange={v => setForm(f => ({ ...f, end_date: v }))} /></Field>
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
  );
}
