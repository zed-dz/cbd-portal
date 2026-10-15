import { Fragment, useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnPrimary, btnSmall } from '../../theme';
import { WORKER_SAFE_COLS } from '../../utils/workerCols';
import { todayISO, localISO, sydneyHHMM } from '../../utils/dates';
import { Spinner, EmptyState, Badge } from '../../components';

// Allocation Board — the office's weekly "who is where" sheet, modelled on
// Zeff's spreadsheet: every active worker grouped by type, Monday to Sunday,
// one cell per day showing the job (client · site · role · start) and whether
// the worker has accepted yet. Free days say "free" so a gap is obvious.
// Tap a name to open the person's profile (phone, email, tickets); tap
// "Allocate" to open Create Allocation with that worker pre-ticked.
//
// This is the minimal version. The full sheet (availability list, per-day
// notes per worker, contacts) comes later once the owner shares the full file.

const TYPE_ORDER = ['full-time', 'part-time', 'casual', 'subcontractor'];
const TYPE_LABEL = { 'full-time': 'Full time', 'part-time': 'Part time', casual: 'Casuals', subcontractor: 'Subcontractors', other: 'Other' };
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LIVE = ['pending', 'confirmed', 'completed'];

function mondayOf(iso) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localISO(d);
}
function addDays(iso, n) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return localISO(d); }
function shortDate(iso) { return new Date(iso + 'T12:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }); }
function daysUntil(iso) {
  if (!iso) return null;
  return Math.floor((new Date(iso + 'T12:00:00') - new Date(todayISO() + 'T12:00:00')) / 86400000);
}
function covers(a, day) {
  if (!a.start_date) return false;
  const end = a.end_date || a.start_date;
  return a.start_date <= day && end >= day;
}

const CELL = {
  pending:   { bg: 'rgba(234,179,8,0.14)',  border: 'rgba(234,179,8,0.45)',  fg: '#fde047', tag: 'waiting for accept' },
  confirmed: { bg: 'rgba(34,197,94,0.13)',  border: 'rgba(34,197,94,0.4)',   fg: '#86efac', tag: 'accepted' },
  completed: { bg: 'rgba(56,189,248,0.13)', border: 'rgba(56,189,248,0.4)',  fg: '#7dd3fc', tag: 'done' },
};

const th = { textAlign: 'left', padding: '10px 12px', fontSize: 11, fontFamily: MONO, letterSpacing: 1, textTransform: 'uppercase', color: C.textMuted, fontWeight: 700, whiteSpace: 'nowrap' };
const td = { padding: '10px 12px', fontSize: 13, color: C.text, verticalAlign: 'top' };

export function AllocationBoardPage({ showToast, onAllocate, isMobile, currentWorker }) {
  const [weekStart, setWeekStart] = useState(() => mondayOf(todayISO()));
  const [workers, setWorkers] = useState([]);
  const [allocs, setAllocs] = useState([]);
  const [tickets, setTickets] = useState({});       // worker_id → [{ name, expiry }]
  const [notes, setNotes] = useState('');
  const [savedNotes, setSavedNotes] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');   // '' | 'active' | 'onboarding'
  const [freeOn, setFreeOn] = useState('');               // '' | ISO day
  const [showWeekend, setShowWeekend] = useState(false);
  const [includeOffice, setIncludeOffice] = useState(false);
  const [expanded, setExpanded] = useState(null);

  const weekEnd = addDays(weekStart, 6);
  const today = todayISO();
  const days = useMemo(
    () => Array.from({ length: showWeekend ? 7 : 5 }, (_, i) => addDays(weekStart, i)),
    [weekStart, showWeekend],
  );

  const load = useCallback(async () => {
    setLoading(true);
    const [w, a, c1, c2, n] = await Promise.all([
      supabase.from('workers').select(WORKER_SAFE_COLS).is('archived_at', null).order('name'),
      supabase.from('allocations')
        .select('id, worker_id, client, site, project, role, status, start_date, end_date, start_time, group_id, allocation_groups(positions)')
        .lte('start_date', weekEnd)
        .or(`end_date.gte.${weekStart},and(end_date.is.null,start_date.gte.${weekStart})`),
      supabase.from('certifications').select('worker_id, cert_name, expiry'),
      supabase.from('worker_certificates').select('worker_id, name, expiry_date'),
      supabase.from('allocation_board_notes').select('notes').eq('week_start', weekStart).maybeSingle(),
    ]);
    if (w.error) showToast(w.error.message, 'error');
    if (a.error) showToast(a.error.message, 'error');
    setWorkers(w.data || []);
    setAllocs((a.data || []).filter(x => LIVE.includes(x.status)));
    const t = {};
    (c1.data || []).forEach(r => { (t[r.worker_id] = t[r.worker_id] || []).push({ name: r.cert_name, expiry: r.expiry }); });
    (c2.data || []).forEach(r => { (t[r.worker_id] = t[r.worker_id] || []).push({ name: r.name, expiry: r.expiry_date }); });
    setTickets(t);
    setNotes(n.data?.notes || '');
    setSavedNotes(n.data?.notes || '');
    setLoading(false);
  }, [weekStart, weekEnd, showToast]);

  useEffect(() => { load(); }, [load]);

  const byWorker = useMemo(() => {
    const m = {};
    allocs.forEach(a => { (m[a.worker_id] = m[a.worker_id] || []).push(a); });
    return m;
  }, [allocs]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return workers.filter(w => {
      if (!includeOffice && w.role === 'admin') return false;
      if (typeFilter && (TYPE_ORDER.includes(w.worker_type) ? w.worker_type : 'other') !== typeFilter) return false;
      const active = (w.app_status || '') === 'Active';
      if (statusFilter === 'active' && !active) return false;
      if (statusFilter === 'onboarding' && active) return false;
      if (freeOn && (byWorker[w.id] || []).some(a => covers(a, freeOn))) return false;
      if (q) {
        const hay = [w.name, w.job_title, w.licences, w.mobile, w.email, w.address, w.worker_type,
          (tickets[w.id] || []).map(t => t.name).join(' ')].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [workers, includeOffice, typeFilter, statusFilter, freeOn, search, byWorker, tickets]);

  const groups = useMemo(() => {
    const g = {};
    visible.forEach(w => {
      const k = TYPE_ORDER.includes(w.worker_type) ? w.worker_type : 'other';
      (g[k] = g[k] || []).push(w);
    });
    return [...TYPE_ORDER, 'other'].filter(k => g[k]?.length).map(k => ({ key: k, label: TYPE_LABEL[k], workers: g[k] }));
  }, [visible]);

  const stats = useMemo(() => {
    const pool = workers.filter(w => includeOffice || w.role !== 'admin');
    const allocated = new Set(allocs.map(a => a.worker_id));
    const pending = allocs.filter(a => a.status === 'pending').length;
    let expiring = 0;
    pool.forEach(w => (tickets[w.id] || []).forEach(t => { const d = daysUntil(t.expiry); if (d !== null && d <= 30) expiring += 1; }));
    return {
      total: pool.length,
      allocated: pool.filter(w => allocated.has(w.id)).length,
      free: pool.filter(w => !allocated.has(w.id)).length,
      onboarding: pool.filter(w => (w.app_status || '') !== 'Active').length,
      pending,
      expiring,
    };
  }, [workers, allocs, tickets, includeOffice]);

  const saveNotes = async () => {
    setSavingNotes(true);
    const { error } = await supabase.from('allocation_board_notes').upsert({
      week_start: weekStart, notes, updated_by: currentWorker?.name || null, updated_at: new Date().toISOString(),
    });
    setSavingNotes(false);
    if (error) showToast(error.message, 'error');
    else { setSavedNotes(notes); showToast('Week notes saved.', 'success'); }
  };

  const ticketSummary = (wid) => {
    const list = tickets[wid] || [];
    if (!list.length) return <span style={{ fontSize: 11, color: C.textDim }}>no tickets on file</span>;
    const expired = list.filter(t => { const d = daysUntil(t.expiry); return d !== null && d < 0; }).length;
    const soon = list.filter(t => { const d = daysUntil(t.expiry); return d !== null && d >= 0 && d <= 30; }).length;
    return (
      <span style={{ display: 'inline-flex', gap: 5, flexWrap: 'wrap' }}>
        <Badge label={`${list.length} ticket${list.length === 1 ? '' : 's'}`} color="gray" size="sm" />
        {expired > 0 && <Badge label={`${expired} expired`} color="red" size="sm" />}
        {soon > 0 && <Badge label={`${soon} expiring`} color="yellow" size="sm" />}
      </span>
    );
  };

  const dayCell = (w, day) => {
    const items = (byWorker[w.id] || []).filter(a => covers(a, day));
    if (!items.length) return <span style={{ fontSize: 11, color: C.textDim }}>free</span>;
    return items.map(a => {
      const s = CELL[a.status] || CELL.pending;
      const spots = a.allocation_groups?.positions;
      return (
        <div key={a.id} title={`${a.client || ''} ${a.site || ''} ${a.role || ''} — ${s.tag}`}
          style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 6, padding: '4px 7px', marginBottom: 4, fontSize: 11, lineHeight: 1.35 }}>
          <div style={{ fontWeight: 700, color: s.fg }}>{a.client || a.site || 'Job'}</div>
          {a.site && a.client && <div style={{ color: C.textMuted }}>{a.site}</div>}
          {(a.role || a.start_time) && (
            <div style={{ color: C.textMuted, fontFamily: MONO, fontSize: 10 }}>
              {[a.role, a.start_time ? sydneyHHMM(a.start_time) : null].filter(Boolean).join(' · ')}
            </div>
          )}
          {a.status === 'pending' && (
            <div style={{ color: s.fg, fontSize: 10 }}>⏳ {s.tag}{spots ? ` · ${spots} spot${spots === 1 ? '' : 's'}` : ''}</div>
          )}
        </div>
      );
    });
  };

  const profile = (w) => {
    const rows = [
      ['Mobile', w.mobile ? <a href={`tel:${String(w.mobile).replace(/[^\d+]/g, '')}`}>{w.mobile}</a> : '—'],
      ['Email', w.email ? <a href={`mailto:${w.email}`}>{w.email}</a> : '—'],
      ['Type', TYPE_LABEL[w.worker_type] || w.worker_type || '—'],
      ['Job title', w.job_title || '—'],
      ['App status', w.app_status || '—'],
      ['Availability', w.status || '—'],
      ['Address', w.address || '—'],
      ['Licences', w.licences || '—'],
      ['Onboarded', w.onboarding_completed_at ? shortDate(String(w.onboarding_completed_at).slice(0, 10)) : 'not finished'],
      ['Notify by', [w.notify_sms !== false ? 'SMS' : null, w.notify_email !== false ? 'email' : null].filter(Boolean).join(' + ') || '—'],
      ['Emergency', w.emergency_name ? `${w.emergency_name}${w.emergency_phone ? ` · ${w.emergency_phone}` : ''}` : '—'],
    ];
    const list = tickets[w.id] || [];
    return (
      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.md, padding: 14, display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '6px 18px', fontSize: 12.5 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'flex', gap: 8 }}>
            <span style={{ color: C.textDim, minWidth: 92, flexShrink: 0 }}>{k}</span>
            <span style={{ color: C.text, wordBreak: 'break-word', minWidth: 0 }}>{v}</span>
          </div>
        ))}
        <div style={{ gridColumn: '1 / -1', marginTop: 6 }}>
          <div style={{ fontSize: 10, color: C.textDim, textTransform: 'uppercase', letterSpacing: 1.2, fontFamily: MONO, marginBottom: 4, fontWeight: 700 }}>Tickets &amp; certificates</div>
          {list.length === 0 ? <div style={{ color: C.textDim }}>None on file.</div> : (
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <tbody>
                {list.map((t, i) => {
                  const d = daysUntil(t.expiry);
                  return (
                    <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}>
                      <td style={{ padding: '5px 6px 5px 0', color: C.text }}>{t.name || '—'}</td>
                      <td style={{ padding: '5px 6px', color: C.textMuted, fontFamily: MONO, whiteSpace: 'nowrap' }}>{t.expiry ? shortDate(t.expiry) : 'no expiry'}</td>
                      <td style={{ padding: '5px 0' }}>
                        {d === null ? <Badge label="no expiry" color="gray" size="sm" />
                          : d < 0 ? <Badge label="expired" color="red" size="sm" />
                          : d <= 30 ? <Badge label={`${d} days left`} color="yellow" size="sm" />
                          : <Badge label="valid" color="green" size="sm" />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  };

  const nameButton = (w) => (
    <button onClick={() => setExpanded(expanded === w.id ? null : w.id)}
      style={{ background: 'none', border: 'none', color: C.text, fontWeight: 700, fontSize: 13, cursor: 'pointer', padding: 0, textAlign: 'left' }}>
      {expanded === w.id ? '▾' : '▸'} {w.name}
    </button>
  );
  const subLine = (w) => (
    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
      {[w.job_title, (w.app_status || '') === 'Active' ? null : '⏳ still onboarding'].filter(Boolean).join(' · ')}
    </div>
  );

  const statChip = (label, value, color) => (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: R.md, padding: '8px 12px', minWidth: 0 }}>
      <div style={{ fontSize: 10, color: C.textDim, fontFamily: MONO, letterSpacing: 1, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: color || C.text, lineHeight: 1.2 }}>{value}</div>
    </div>
  );

  const toolbar = (
    <div style={{ display: 'grid', gap: 10, marginBottom: 16 }} data-area="board toolbar">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button style={btnSmall} onClick={() => setWeekStart(addDays(weekStart, -7))}>◀ Prev</button>
        <div style={{ fontWeight: 800, color: C.text, fontSize: isMobile ? 15 : 18 }}>Week of {shortDate(weekStart)} – {shortDate(weekEnd)}</div>
        <button style={btnSmall} onClick={() => setWeekStart(addDays(weekStart, 7))}>Next ▶</button>
        <button style={btnSmall} onClick={() => setWeekStart(mondayOf(today))}>Today</button>
        <label style={{ fontSize: 12, color: C.textMuted, display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={showWeekend} onChange={e => setShowWeekend(e.target.checked)} /> Weekend
        </label>
        <label style={{ fontSize: 12, color: C.textMuted, display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={includeOffice} onChange={e => setIncludeOffice(e.target.checked)} /> Office staff
        </label>
        <button style={{ ...btnPrimary, marginLeft: isMobile ? 0 : 'auto' }} onClick={() => onAllocate?.([], '')}>+ Create Allocation</button>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input style={{ ...inputStyle, flex: '1 1 200px', maxWidth: 340 }} placeholder="Search name, ticket, suburb, phone…"
          value={search} onChange={e => setSearch(e.target.value)} />
        <select style={{ ...inputStyle, width: 'auto' }} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
          <option value="">All types</option>
          {TYPE_ORDER.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          <option value="other">Other</option>
        </select>
        <select style={{ ...inputStyle, width: 'auto' }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">Active + onboarding</option>
          <option value="active">Active (onboarded)</option>
          <option value="onboarding">Still onboarding</option>
        </select>
        <select style={{ ...inputStyle, width: 'auto' }} value={freeOn} onChange={e => setFreeOn(e.target.value)}>
          <option value="">Free on… (any)</option>
          {days.map((d, i) => <option key={d} value={d}>Free on {DAY_NAMES[i]} {shortDate(d)}</option>)}
        </select>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(3, 1fr)' : 'repeat(6, minmax(0, 1fr))', gap: 8 }}>
        {statChip('Workers', stats.total)}
        {statChip('Allocated this week', stats.allocated, '#86efac')}
        {statChip('Free all week', stats.free, C.accent)}
        {statChip('Waiting to accept', stats.pending, '#fde047')}
        {statChip('Still onboarding', stats.onboarding)}
        {statChip('Tickets expiring', stats.expiring, stats.expiring ? '#fca5a5' : undefined)}
      </div>
    </div>
  );

  const groupHeader = (g, extraStyle = {}) => (
    <div style={{ padding: '8px 12px', background: 'rgba(249,115,22,0.08)', color: C.accent, fontFamily: MONO, fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase', fontWeight: 700, ...extraStyle }}>
      {g.label} · {g.workers.length}
    </div>
  );

  const table = (
    <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: R.lg, background: C.card }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }}>
        <thead>
          <tr style={{ background: C.bg }}>
            <th style={th}>Worker</th>
            {days.map((d, i) => (
              <th key={d} style={{ ...th, color: d === today ? C.accent : C.textMuted }}>
                {DAY_NAMES[i]} <span style={{ fontWeight: 400 }}>{shortDate(d)}</span>
              </th>
            ))}
            <th style={th} />
          </tr>
        </thead>
        <tbody>
          {groups.map(g => (
            <Fragment key={g.key}>
              <tr><td colSpan={days.length + 2} style={{ padding: 0 }}>{groupHeader(g)}</td></tr>
              {g.workers.map(w => (
                <Fragment key={w.id}>
                  <tr style={{ borderTop: `1px solid ${C.border}` }}>
                    <td style={{ ...td, minWidth: 210 }}>
                      {nameButton(w)}
                      {subLine(w)}
                      <div style={{ marginTop: 5 }}>{ticketSummary(w.id)}</div>
                    </td>
                    {days.map(d => (
                      <td key={d} style={{ ...td, minWidth: 118, background: d === today ? 'rgba(249,115,22,0.04)' : undefined }}>{dayCell(w, d)}</td>
                    ))}
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      <button style={btnSmall} onClick={() => onAllocate?.([w.id], '')}>Allocate</button>
                    </td>
                  </tr>
                  {expanded === w.id && (
                    <tr><td colSpan={days.length + 2} style={{ padding: '0 12px 12px' }}>{profile(w)}</td></tr>
                  )}
                </Fragment>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );

  const cards = (
    <div style={{ display: 'grid', gap: 14 }}>
      {groups.map(g => (
        <div key={g.key}>
          {groupHeader(g, { borderRadius: R.md, marginBottom: 8 })}
          {g.workers.map(w => (
            <div key={w.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: R.lg, padding: 12, marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}>
                  {nameButton(w)}
                  {subLine(w)}
                  <div style={{ marginTop: 5 }}>{ticketSummary(w.id)}</div>
                </div>
                <button style={{ ...btnSmall, flexShrink: 0 }} onClick={() => onAllocate?.([w.id], '')}>Allocate</button>
              </div>
              <div style={{ marginTop: 10, display: 'grid', gap: 4 }}>
                {days.map((d, i) => (
                  <div key={d} style={{ display: 'flex', gap: 8, fontSize: 12, alignItems: 'flex-start' }}>
                    <span style={{ minWidth: 66, color: d === today ? C.accent : C.textMuted, fontFamily: MONO, fontSize: 11, paddingTop: 2 }}>{DAY_NAMES[i]} {shortDate(d)}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>{dayCell(w, d)}</div>
                  </div>
                ))}
              </div>
              {expanded === w.id && <div style={{ marginTop: 10 }}>{profile(w)}</div>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );

  const notesBox = (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: R.lg, padding: 14, marginTop: 16 }} data-area="week notes">
      <div style={{ fontWeight: 700, color: C.text, marginBottom: 6 }}>📝 Notes for the week</div>
      <textarea style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }} value={notes}
        onChange={e => setNotes(e.target.value)} placeholder="Who is away, who to call first, site notes…" />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <button style={btnPrimary} disabled={savingNotes || notes === savedNotes} onClick={saveNotes}>
          {savingNotes ? 'Saving…' : notes === savedNotes ? 'Saved' : 'Save notes'}
        </button>
      </div>
    </div>
  );

  return (
    <div data-area="allocation board">
      {toolbar}
      {loading
        ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>
        : visible.length === 0
        ? <EmptyState message="No workers match these filters." />
        : (isMobile ? cards : table)}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10, fontSize: 11, color: C.textMuted }}>
        {Object.entries(CELL).map(([k, s]) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: s.bg, border: `1px solid ${s.border}`, display: 'inline-block' }} />
            {s.tag}
          </span>
        ))}
        <span>“free” = no live allocation that day</span>
      </div>
      {notesBox}
    </div>
  );
}
