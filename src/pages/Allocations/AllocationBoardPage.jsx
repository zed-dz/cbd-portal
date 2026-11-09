import { Fragment, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnPrimary, btnSecondary, btnSmall } from '../../theme';
import { WORKER_SAFE_COLS } from '../../utils/workerCols';
import { todayISO, localISO } from '../../utils/dates';
import { Spinner, EmptyState, Badge, Modal } from '../../components';
import { requiredTicketsFor, ticketGaps, gapLabel } from '../../utils/ticketCheck';
import { ROLE_GROUPS, roleColor } from '../../constants/roles';
import { notifyAllocationCreated } from '../../utils/allocationNotify';
import { logActivity } from '../../utils/activity';
import { pickSupervisor } from '../../components/allocations/JobFileCard';
import { nswHoliday, plannedHours, clientColor, cellText, toCsv, downloadText, printWeekHtml, fetchRainChance } from '../../utils/boardExtras';

// Allocation Board v2 — Chris's allocation sheet, inside the portal (2026-11-09).
//
// One row per worker (grouped Full time / Part time / Casual / Subcontractor),
// one column per day Mon–Sun, one cell per worker-day showing "Client · Site".
// Tap a cell → the day editor: Client chips (NO ALLOCATION / SICK / A/L /
// INJURED / Public Holiday / RDO / every client), Site chips (that client's
// sites), Shift (Day / Night / 8hrs / Rain 4hrs / Rain day 8 hours / Rain day
// unpaid), Role, the Days to apply to (amber = already booked, saving moves
// them), Left early, and a Note for payroll. "Save this day" / "Apply to rest
// of week". Notes show as an orange dot on the cell and are listed under
// NOTES FOR PAYROLL so payroll reads them before processing.
//
// Data: allocations (work + status rows), allocation_day_notes (office-only),
// worker_unavailability ("Away…"), approved leave_requests, tickets.

const TYPE_ORDER = ['full-time', 'part-time', 'casual', 'subcontractor'];
const TYPE_LABEL = { 'full-time': 'Full time', 'part-time': 'Part time', casual: 'Casual', subcontractor: 'Subcontractor', other: 'Other' };
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LIVE = ['pending', 'confirmed', 'completed'];
const EDITABLE = ['pending', 'confirmed'];

// Non-work day types. The id is what allocation_type stores.
const STATUS_TYPES = [
  { id: 'personal_leave', label: 'SICK',           short: 'SICK',    color: '#eab308' },
  { id: 'annual_leave',   label: 'A/L',            short: 'A/L',     color: '#38bdf8' },
  { id: 'injured',        label: 'INJURED',        short: 'INJURED', color: '#ef4444' },
  { id: 'public_holiday', label: 'Public Holiday', short: 'PUB HOL', color: '#a855f7' },
  { id: 'rdo',            label: 'RDO',            short: 'RDO',     color: '#22c55e' },
];
const statusMeta = (id) => STATUS_TYPES.find(t => t.id === id);

const SHIFTS = [
  { id: 'day',         label: 'Day' },
  { id: 'night',       label: 'Night' },
  { id: '8hrs',        label: '8hrs' },
  { id: 'rain_4',      label: 'Rain 4hrs',          rain: true, tag: 'RAIN 4h' },
  { id: 'rain_8',      label: 'Rain day 8 hours',   rain: true, tag: 'RAIN 8h' },
  { id: 'rain_unpaid', label: 'Rain day – unpaid',  rain: true, tag: 'RAIN unpaid' },
];
const shiftMeta = (id) => SHIFTS.find(s => s.id === id);

function mondayOf(iso) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localISO(d);
}
function addDays(iso, n) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return localISO(d); }
function shortDate(iso) { return new Date(iso + 'T12:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }); }
function dayNum(iso) { return new Date(iso + 'T12:00:00').getDate(); }
function longDay(iso) { return new Date(iso + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }); }
function daysUntil(iso) {
  if (!iso) return null;
  return Math.floor((new Date(iso + 'T12:00:00') - new Date(todayISO() + 'T12:00:00')) / 86400000);
}
function covers(a, day) {
  if (!a.start_date) return false;
  const end = a.end_date || a.start_date;
  return a.start_date <= day && end >= day;
}
const isWork = (a) => (a.allocation_type || 'work') === 'work';
const noteKey = (wid, day) => `${wid}|${day}`;

// ── chips ────────────────────────────────────────────────────────────────────
const chipBase = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  padding: '9px 13px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  border: `1px solid ${C.border}`, background: C.bg, color: C.text, minHeight: 40,
  fontFamily: 'inherit', lineHeight: 1.1, textAlign: 'center',
};
function Chip({ on, amber, color, children, onClick, title, small }) {
  const accent = color || C.accent;
  return (
    <button type="button" title={title} onClick={onClick}
      style={{
        ...chipBase,
        ...(small ? { padding: '6px 10px', minHeight: 32, fontSize: 12 } : {}),
        ...(on ? { background: accent, borderColor: accent, color: '#fff' } : {}),
        ...(amber && !on ? { background: 'rgba(234,179,8,0.14)', borderColor: 'rgba(234,179,8,0.55)', color: '#fde047' } : {}),
        ...(amber && on ? { boxShadow: '0 0 0 2px rgba(234,179,8,0.6)' } : {}),
      }}>
      {children}
    </button>
  );
}
const sectionLabel = { fontSize: 10, color: C.accent, fontFamily: MONO, letterSpacing: 1.6, textTransform: 'uppercase', fontWeight: 700, margin: '14px 0 6px' };
const RainTag = ({ tag }) => (
  <span style={{ display: 'inline-block', padding: '0 5px', borderRadius: 4, fontSize: 9.5, fontWeight: 800, fontFamily: MONO, letterSpacing: 0.6, background: 'rgba(56,189,248,0.16)', color: '#7dd3fc', border: '1px solid rgba(56,189,248,0.45)', marginLeft: 0, verticalAlign: 'middle', whiteSpace: 'nowrap', flex: '0 0 auto' }}>
    {tag || 'RAIN'}
  </span>
);
const Dot = () => <span title="Has a note for payroll" style={{ position: 'absolute', top: 6, right: 6, width: 8, height: 8, borderRadius: '50%', background: C.accent, boxShadow: '0 0 0 2px rgba(249,115,22,0.25)' }} />;

export function AllocationBoardPage({ showToast, onAllocate, onNavigate, isMobile, currentWorker }) {
  const today = todayISO();
  const [weekStart, setWeekStart] = useState(() => mondayOf(today));
  const [view, setView] = useState(isMobile ? 'day' : 'week');     // 'week' | 'day' | 'notes'
  const [selDay, setSelDay] = useState(today);
  const gridRef = useRef(null);
  // Phone: the week grid scrolls sideways; keep the picked day in view.
  useEffect(() => {
    const el = gridRef.current; if (!el || !isMobile) return;
    const i = days.indexOf(selDay); if (i < 0) return;
    el.scrollTo({ left: Math.max(0, i * 112 - 8), behavior: 'smooth' });
  }, [selDay, view, isMobile]);  // eslint-disable-line react-hooks/exhaustive-deps
  const [workers, setWorkers] = useState([]);
  const [allocs, setAllocs] = useState([]);
  const [clients, setClients] = useState([]);
  const [sites, setSites] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [tickets, setTickets] = useState({});
  const [reqTickets, setReqTickets] = useState([]);
  const [away, setAway] = useState([]);
  const [leave, setLeave] = useState([]);
  const [dayNotes, setDayNotes] = useState([]);
  const [weekNotes, setWeekNotes] = useState('');
  const [savedWeekNotes, setSavedWeekNotes] = useState('');
  const [savingWeekNotes, setSavingWeekNotes] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [includeOffice, setIncludeOffice] = useState(false);
  const [editor, setEditor] = useState(null);
  const [saving, setSaving] = useState(false);
  const [profileId, setProfileId] = useState(null);
  const [awayForm, setAwayForm] = useState(null);
  const [filters, setFilters] = useState({ client: '', type: '', spareOnly: false });
  const [rain, setRain] = useState({});
  const [history, setHistory] = useState(null);     // null = not loaded
  const [copying, setCopying] = useState(null);     // {count, rows} preview for Copy last week
  const [swapTo, setSwapTo] = useState('');

  const weekEnd = addDays(weekStart, 6);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  useEffect(() => { if (selDay < weekStart || selDay > weekEnd) setSelDay(weekStart <= today && today <= weekEnd ? today : weekStart); }, [weekStart, weekEnd, selDay, today]);

  const load = useCallback(async () => {
    setLoading(true);
    const [w, a, cl, st, ct, c1, c2, rt, u, lv, dn, wn] = await Promise.all([
      supabase.from('workers').select(WORKER_SAFE_COLS).is('archived_at', null).order('name'),
      supabase.from('allocations')
        .select('id, worker_id, client, site, client_id, site_id, role, status, allocation_type, shift, left_early, start_date, end_date, start_time, address, map_link, site_manager, manager_phone, group_id, series_id, notes')
        .lte('start_date', weekEnd)
        .or(`end_date.gte.${weekStart},and(end_date.is.null,start_date.gte.${weekStart})`),
      supabase.from('clients').select('id, name, archived_at').is('archived_at', null).order('name'),
      supabase.from('v_client_sites_office').select('id, client_id, name, address, map_link, is_active').eq('is_active', true).order('name'),
      supabase.from('client_site_contacts').select('id, site_id, name, role, email, phone, is_primary, approves_timesheets'),
      supabase.from('certifications').select('worker_id, cert_name, issuer, expiry'),
      supabase.from('worker_certificates').select('worker_id, name, expiry_date'),
      supabase.from('role_required_tickets').select('*').is('archived_at', null),
      supabase.from('worker_unavailability').select('id, worker_id, from_date, to_date, reason').lte('from_date', weekEnd).gte('to_date', weekStart).order('from_date'),
      supabase.from('leave_requests').select('id, worker_id, from_date, to_date, reason, status').eq('status', 'approved').lte('from_date', weekEnd).gte('to_date', weekStart),
      supabase.from('allocation_day_notes').select('*').gte('day', weekStart).lte('day', weekEnd).order('day'),
      supabase.from('allocation_board_notes').select('notes').eq('week_start', weekStart).maybeSingle(),
    ]);
    [w, a, dn].forEach(r => { if (r.error) showToast(r.error.message, 'error'); });
    setWorkers(w.data || []);
    setAllocs((a.data || []).filter(x => LIVE.includes(x.status)));
    setClients(cl.data || []);
    setSites(st.data || []);
    setContacts(ct.data || []);
    const t = {};
    (c1.data || []).forEach(r => { (t[r.worker_id] = t[r.worker_id] || []).push({ name: r.cert_name, issuer: r.issuer, expiry: r.expiry }); });
    (c2.data || []).forEach(r => { (t[r.worker_id] = t[r.worker_id] || []).push({ name: r.name, expiry: r.expiry_date }); });
    setTickets(t);
    setReqTickets(rt.data || []);
    setAway(u.data || []);
    setLeave(lv.data || []);
    setDayNotes(dn.data || []);
    setWeekNotes(wn.data?.notes || '');
    setSavedWeekNotes(wn.data?.notes || '');
    setLoading(false);
  }, [weekStart, weekEnd, showToast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { let on = true; fetchRainChance(weekStart, weekEnd).then(r => { if (on) setRain(r); }); return () => { on = false; }; }, [weekStart, weekEnd]);
  const loadHistory = useCallback(async () => {
    const { data } = await supabase.from('activity_events').select('id, actor_name, verb, after, created_at')
      .eq('verb', 'board edit').gte('after->>day', weekStart).lte('after->>day', weekEnd).order('created_at', { ascending: false }).limit(200);
    setHistory(data || []);
  }, [weekStart, weekEnd]);
  useEffect(() => { if (view === 'history') loadHistory(); }, [view, loadHistory]);

  // ── lookups ──────────────────────────────────────────────────────────────
  const byWorker = useMemo(() => { const m = {}; allocs.forEach(a => { (m[a.worker_id] = m[a.worker_id] || []).push(a); }); return m; }, [allocs]);
  const noteMap = useMemo(() => { const m = {}; dayNotes.forEach(n => { m[noteKey(n.worker_id, n.day)] = n; }); return m; }, [dayNotes]);
  const awayOn = (wid, day) => away.find(r => r.worker_id === wid && r.from_date <= day && r.to_date >= day);
  const leaveOn = (wid, day) => leave.find(r => r.worker_id === wid && r.from_date <= day && r.to_date >= day);
  const cellAllocs = (wid, day) => (byWorker[wid] || []).filter(a => covers(a, day));
  const workOn = (wid, day) => cellAllocs(wid, day).filter(isWork);
  const statusOn = (wid, day) => cellAllocs(wid, day).find(a => !isWork(a));
  const siteOf = (id) => sites.find(s => s.id === id);
  const clientOf = (id) => clients.find(c => c.id === id);
  const expiredCount = (wid) => (tickets[wid] || []).filter(t => { const d = daysUntil(t.expiry); return d !== null && d < 0; }).length;
  const expiringCount = (wid) => (tickets[wid] || []).filter(t => { const d = daysUntil(t.expiry); return d !== null && d >= 0 && d <= 30; }).length;

  const pool = useMemo(() => workers.filter(w => includeOffice || w.role !== 'admin'), [workers, includeOffice]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return pool.filter(w => {
      const rows = byWorker[w.id] || [];
      if (filters.type && (w.worker_type || 'other') !== filters.type) return false;
      if (filters.client && !rows.some(a => isWork(a) && (a.client_id === filters.client || a.client === filters.client))) return false;
      if (filters.spareOnly && (rows.some(a => covers(a, selDay)) || leaveOn(w.id, selDay) || awayOn(w.id, selDay))) return false;
      if (!q) return true;
      const jobs = rows.map(a => `${a.client || ''} ${a.site || ''} ${a.role || ''}`).join(' ');
      return `${w.name} ${w.job_title || ''} ${w.worker_type || ''} ${jobs}`.toLowerCase().includes(q);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, search, byWorker, filters, selDay, leave, away]);
  const weekClients = useMemo(() => {
    const m = new Map();
    allocs.filter(isWork).forEach(a => { const k = a.client_id || a.client; if (k && !m.has(k)) m.set(k, a.client || clientOf(a.client_id)?.name || 'Client'); });
    return [...m.entries()].sort((x, y) => x[1].localeCompare(y[1]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allocs, clients]);
  const pendingOn = (day) => allocs.filter(a => isWork(a) && a.status === 'pending' && covers(a, day) && pool.some(w => w.id === a.worker_id));
  const weekHours = (wid) => days.reduce((n, d) => n + workOn(wid, d).reduce((m, a) => m + plannedHours(a), 0), 0);
  const weekDays = (wid) => days.filter(d => workOn(wid, d).length > 0).length;
  const groups = useMemo(() => {
    const g = {};
    visible.forEach(w => { const k = TYPE_ORDER.includes(w.worker_type) ? w.worker_type : 'other'; (g[k] = g[k] || []).push(w); });
    return [...TYPE_ORDER, 'other'].filter(k => g[k]?.length).map(k => ({ key: k, label: TYPE_LABEL[k], workers: g[k] }));
  }, [visible]);

  const dayStats = useCallback((day) => {
    const onSite = pool.filter(w => workOn(w.id, day).length > 0);
    const unavailable = pool.filter(w => !workOn(w.id, day).length && (statusOn(w.id, day) || leaveOn(w.id, day) || awayOn(w.id, day)));
    const spare = pool.filter(w => !onSite.includes(w) && !unavailable.includes(w));
    const expiredOnSite = onSite.filter(w => expiredCount(w.id) > 0);
    return { onSite, unavailable, spare, expiredOnSite };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, byWorker, leave, away, tickets]);
  const dayCount = (day) => pool.filter(w => workOn(w.id, day).length > 0).length;

  // ── editor ───────────────────────────────────────────────────────────────
  const openEditor = (wid, day) => {
    const w = workers.find(x => x.id === wid);
    const work = wid ? workOn(wid, day)[0] : null;
    const st = wid ? statusOn(wid, day) : null;
    const clientId = work ? (work.client_id || clients.find(c => c.name === work.client)?.id || '') : '';
    const siteId = work ? (work.site_id || sites.find(s => s.client_id === clientId && s.name === work.site)?.id || '') : '';
    setEditor({
      workerId: wid || '', workerName: w?.name || '', day,
      choice: work ? 'work' : st ? st.allocation_type : 'none',
      clientId, siteId,
      shift: work?.shift || 'day', role: work?.role || '',
      leftEarly: !!work?.left_early,
      days: [day],
      note: noteMap[noteKey(wid, day)]?.note || '',
      hasExisting: !!(work || st),
    });
  };
  const ed = (patch) => setEditor(e => ({ ...e, ...patch }));
  const toggleDay = (d) => setEditor(e => ({ ...e, days: e.days.includes(d) ? (e.days.length > 1 ? e.days.filter(x => x !== d) : e.days) : [...e.days, d].sort() }));

  // Split a multi-day allocation so `day` becomes its own row (or is freed).
  // Returns the single-day rows that sit exactly on `day` afterwards.
  const carve = async (a, day) => {
    const end = a.end_date || a.start_date;
    if (a.start_date === day && end === day) return [a];
    const base = { ...a }; delete base.id; delete base.group_id;
    if (a.start_date < day) {
      await supabase.from('allocations').update({ end_date: addDays(day, -1) }).eq('id', a.id);
      if (end > day) await supabase.from('allocations').insert([{ ...base, start_date: addDays(day, 1), end_date: end }]);
    } else {
      // starts on `day`, runs on afterwards
      await supabase.from('allocations').update({ start_date: addDays(day, 1) }).eq('id', a.id);
    }
    return [];
  };

  const applyDay = async (e, day) => {
    const worker = workers.find(w => w.id === e.workerId);
    const me = currentWorker?.name || null;
    let onDay = [];
    for (const a of cellAllocs(e.workerId, day)) {
      if (!EDITABLE.includes(a.status) && isWork(a)) { onDay.push(a); continue; }   // completed days are left alone
      onDay.push(...await carve(a, day));
    }
    const existingWork = onDay.find(a => isWork(a) && EDITABLE.includes(a.status));
    const existingStatus = onDay.filter(a => !isWork(a));
    const cancelWork = async () => { if (existingWork) await supabase.from('allocations').update({ status: 'cancelled' }).eq('id', existingWork.id); };
    const dropStatus = async (keepType) => {
      const ids = existingStatus.filter(a => a.allocation_type !== keepType).map(a => a.id);
      if (ids.length) await supabase.from('allocations').delete().in('id', ids);
    };
    let resultId = null;

    if (e.choice === 'none') {
      await cancelWork(); await dropStatus(null);
    } else if (e.choice !== 'work') {
      await cancelWork(); await dropStatus(e.choice);
      const kept = existingStatus.find(a => a.allocation_type === e.choice);
      if (kept) resultId = kept.id;
      else {
        const { data, error } = await supabase.from('allocations').insert([{
          worker_id: e.workerId, allocation_type: e.choice, status: 'confirmed',
          start_date: day, end_date: day, client: null, site: null, role: null,
        }]).select('id').single();
        if (error) throw error;
        resultId = data.id;
      }
    } else {
      await dropStatus(null);
      const client = clientOf(e.clientId);
      const site = e.siteId ? siteOf(e.siteId) : null;
      const sup = site ? pickSupervisor(contacts.filter(c => c.site_id === site.id)) : null;
      const fields = {
        client: client?.name || null, client_id: client?.id || null,
        site: site?.name || null, site_id: site?.id || null,
        role: e.role || null, shift: e.shift || null, left_early: !!e.leftEarly,
        address: site?.address || null, map_link: site?.map_link || null,
        site_manager: sup?.name || null, manager_phone: sup?.phone || null,
      };
      if (existingWork) {
        const moved = (existingWork.client_id || null) !== fields.client_id || (existingWork.site_id || null) !== fields.site_id;
        const patch = moved && existingWork.status === 'confirmed' ? { ...fields, status: 'pending' } : fields;
        const { error } = await supabase.from('allocations').update(patch).eq('id', existingWork.id);
        if (error) throw error;
        resultId = existingWork.id;
        if (moved) notifyAllocationCreated({ ...existingWork, ...fields, start_date: day }, worker, { showToast, adminQuiet: true });
      } else {
        const { data, error } = await supabase.from('allocations').insert([{
          ...fields, worker_id: e.workerId, allocation_type: 'work', status: 'pending',
          start_date: day, end_date: day,
        }]).select('id').single();
        if (error) throw error;
        resultId = data.id;
        notifyAllocationCreated({ ...fields, id: data.id, start_date: day }, worker, { showToast, adminQuiet: true });
      }
    }

    // The note for payroll (orange dot). Empty note on an existing row removes it.
    const existingNote = noteMap[noteKey(e.workerId, day)];
    const text = (e.note || '').trim();
    if (text) {
      if (existingNote) await supabase.from('allocation_day_notes').update({ note: text, allocation_id: resultId, updated_at: new Date().toISOString() }).eq('id', existingNote.id);
      else await supabase.from('allocation_day_notes').insert([{ worker_id: e.workerId, day, allocation_id: resultId, note: text, created_by: me }]);
    } else if (existingNote && day === e.day) {
      await supabase.from('allocation_day_notes').delete().eq('id', existingNote.id);
    }
    logActivity({
      verb: 'board edit', object_type: 'allocation', object_id: resultId,
      client_id: e.choice === 'work' ? (e.clientId || null) : null, site_id: e.choice === 'work' ? (e.siteId || null) : null,
      after: { worker: worker?.name || null, day, choice: e.choice, shift: e.choice === 'work' ? e.shift : null, left_early: !!e.leftEarly, note: text || null },
    });
  };

  const saveEditor = async (daysToApply) => {
    const e = editor;
    if (!e.workerId) { showToast('Pick a worker first.', 'error'); return; }
    if (e.choice === 'work' && !e.clientId) { showToast('Pick a client (or SICK / A/L / NO ALLOCATION).', 'error'); return; }
    setSaving(true);
    try {
      for (const d of daysToApply) await applyDay(e, d);
      showToast(daysToApply.length === 1 ? `${e.workerName || 'Worker'} — ${longDay(daysToApply[0])} saved.` : `${e.workerName || 'Worker'} — ${daysToApply.length} days saved.`, 'success');
      setEditor(null);
      load();
    } catch (err) {
      showToast(err.message || 'Could not save.', 'error');
    }
    setSaving(false);
  };
  const restOfWeek = () => {
    const i = days.indexOf(editor.day);
    const rest = days.slice(i, 5);   // this day through Friday
    return rest.length ? rest : [editor.day];
  };

  // ── toolbar actions ──────────────────────────────────────────────────────
  // Copy last week: every Mon–Fri work day from last week lands on the same
  // weekday this week, only where the cell is still empty. New rows are
  // pending and the worker gets the usual SMS to accept.
  const previewCopyLastWeek = async () => {
    const from = addDays(weekStart, -7), to = addDays(weekStart, -1);
    const { data, error } = await supabase.from('allocations')
      .select('id, worker_id, client, site, client_id, site_id, role, status, allocation_type, shift, start_date, end_date, address, map_link, site_manager, manager_phone')
      .lte('start_date', to).or(`end_date.gte.${from},and(end_date.is.null,start_date.gte.${from})`);
    if (error) { showToast(error.message, 'error'); return; }
    const rows = [];
    (data || []).filter(a => LIVE.includes(a.status) && isWork(a)).forEach(a => {
      for (let i = 0; i < 5; i++) {
        const src = addDays(from, i), dst = addDays(weekStart, i);
        if (!covers(a, src)) continue;
        if (!pool.some(w => w.id === a.worker_id)) continue;
        if (cellAllocs(a.worker_id, dst).length || leaveOn(a.worker_id, dst) || awayOn(a.worker_id, dst)) continue;
        if (rows.some(r => r.worker_id === a.worker_id && r.day === dst)) continue;
        rows.push({ worker_id: a.worker_id, day: dst, src: a });
      }
    });
    setCopying({ rows });
  };
  const runCopyLastWeek = async () => {
    const rows = copying?.rows || []; setCopying(null); if (!rows.length) return;
    setSaving(true);
    let ok = 0;
    for (const r of rows) {
      const a = r.src; const worker = workers.find(w => w.id === r.worker_id);
      const fields = { client: a.client, client_id: a.client_id, site: a.site, site_id: a.site_id, role: a.role, shift: a.shift, left_early: false, address: a.address, map_link: a.map_link, site_manager: a.site_manager, manager_phone: a.manager_phone };
      const { data, error } = await supabase.from('allocations').insert([{ ...fields, worker_id: r.worker_id, allocation_type: 'work', status: 'pending', start_date: r.day, end_date: r.day }]).select('id').single();
      if (error) { showToast(error.message, 'error'); continue; }
      ok++;
      notifyAllocationCreated({ ...fields, id: data.id, start_date: r.day }, worker, { showToast, adminQuiet: true });
      logActivity({ verb: 'board edit', object_type: 'allocation', object_id: data.id, client_id: a.client_id || null, site_id: a.site_id || null, after: { worker: worker?.name || null, day: r.day, choice: 'work', shift: a.shift, copied_from: a.start_date } });
    }
    setSaving(false);
    showToast(`${ok} day${ok === 1 ? '' : 's'} copied from last week.`, 'success');
    load();
  };
  // Nudge: re-send the accept SMS/email for every still-pending job on the day.
  const nudgePending = async () => {
    const rows = pendingOn(selDay); if (!rows.length) return;
    rows.forEach(a => notifyAllocationCreated({ ...a, start_date: selDay }, workers.find(w => w.id === a.worker_id), { showToast, adminQuiet: true }));
    logActivity({ verb: 'board nudge', object_type: 'allocation', object_id: null, after: { day: selDay, count: rows.length } });
    showToast(`Reminder sent to ${rows.length} worker${rows.length === 1 ? '' : 's'}.`, 'success');
  };
  const sheetRows = () => groups.map(g => ({
    label: g.label,
    rows: g.workers.map(w => ({
      name: w.name, sub: w.job_title || '',
      cells: days.map(d => {
        const st = statusOn(w.id, d); const lv = leaveOn(w.id, d); const aw = awayOn(w.id, d);
        const status = st ? (statusMeta(st.allocation_type)?.label || st.allocation_type) : lv ? 'A/L' : aw ? 'Away' : '';
        const txt = cellText(workOn(w.id, d), status, sh => shiftMeta(sh)?.label || '');
        return noteMap[noteKey(w.id, d)] ? `${txt}${txt ? ' · ' : ''}note` : txt;
      }),
    })),
  }));
  const exportCsv = () => {
    const head = ['Worker', 'Type', 'Job title', ...days.map((d, i) => `${DAY_NAMES[i]} ${dayNum(d)}`), 'Planned hours', 'Notes'];
    const out = [head];
    sheetRows().forEach(g => g.rows.forEach(r => {
      const w = groups.flatMap(x => x.workers).find(x => x.name === r.name) || {};
      const notes = dayNotes.filter(n => n.worker_id === w.id).map(n => `${shortDate(n.day)}: ${n.note}`).join(' | ');
      out.push([r.name, TYPE_LABEL[w.worker_type] || '', r.sub, ...r.cells, weekHours(w.id), notes]);
    }));
    downloadText(`allocations-${weekStart}.csv`, toCsv(out));
  };
  const printWeek = () => {
    const html = printWeekHtml({
      title: `Allocations ${shortDate(weekStart)} – ${shortDate(weekEnd)}`,
      dayHeads: days.map((d, i) => `${DAY_NAMES[i]} ${dayNum(d)}`),
      groups: sheetRows(),
      notes: notesList.map(r => ({ name: r.name, day: `${DAY_NAMES[days.indexOf(r.day)] || ''} ${dayNum(r.day)}`, text: r.text })),
    });
    const w = window.open('', '_blank'); if (!w) { showToast('Allow pop-ups to print.', 'error'); return; }
    w.document.write(html); w.document.close();
  };
  // Move this day's job to another (spare) worker: the new worker gets a
  // pending row + SMS, this worker's row is cancelled.
  const moveToWorker = async () => {
    const e = editor; if (!e || !swapTo) return;
    const target = workers.find(w => w.id === swapTo); if (!target) return;
    setSaving(true);
    try {
      await applyDay({ ...e, workerId: target.id, workerName: target.name, note: '' }, e.day);
      await applyDay({ ...e, choice: 'none', note: e.note }, e.day);
      showToast(`${longDay(e.day)}: moved to ${target.name}.`, 'success');
      setEditor(null); setSwapTo(''); load();
    } catch (err) { showToast(err.message || 'Could not move.', 'error'); }
    setSaving(false);
  };

  // ── away + week notes (kept from v1) ─────────────────────────────────────
  const saveAway = async () => {
    if (!awayForm?.from_date || !awayForm?.to_date) { showToast('Pick the first and last day.', 'error'); return; }
    if (awayForm.to_date < awayForm.from_date) { showToast('The last day is before the first day.', 'error'); return; }
    const { error } = await supabase.from('worker_unavailability').insert([{ worker_id: awayForm.worker_id, from_date: awayForm.from_date, to_date: awayForm.to_date, reason: awayForm.reason || null, created_by: currentWorker?.name || null }]);
    if (error) { showToast(error.message, 'error'); return; }
    showToast(`${awayForm.name} marked not available.`, 'success');
    setAwayForm(null); load();
  };
  const removeAway = async (r) => { await supabase.from('worker_unavailability').delete().eq('id', r.id); load(); };
  const saveWeekNotes = async () => {
    setSavingWeekNotes(true);
    const { error } = await supabase.from('allocation_board_notes').upsert({ week_start: weekStart, notes: weekNotes, updated_by: currentWorker?.name || null, updated_at: new Date().toISOString() });
    setSavingWeekNotes(false);
    if (error) showToast(error.message, 'error'); else { setSavedWeekNotes(weekNotes); showToast('Week notes saved.', 'success'); }
  };

  // ── cell ─────────────────────────────────────────────────────────────────
  const cellBody = (w, day, compact) => {
    const work = workOn(w.id, day);
    const st = statusOn(w.id, day);
    const lv = leaveOn(w.id, day);
    const aw = awayOn(w.id, day);
    if (work.length) {
      return work.map(a => {
        const sh = shiftMeta(a.shift);
        return (
          <div key={a.id} style={{ lineHeight: 1.25, marginBottom: 2, minWidth: 0 }}>
            {(() => {
              // Badges sit on the site line so the client name keeps its room;
              // when there is no site line they follow the client name.
              const badges = (sh?.rain || a.left_early || a.status === 'pending') && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flex: '0 0 auto' }}>
                  {sh?.rain && <RainTag tag={compact ? 'RAIN' : sh.tag} />}
                  {a.left_early && <span title="Left early" style={{ fontSize: 10, color: '#fde047', fontWeight: 800 }}>½</span>}
                  {a.status === 'pending' && <span title="Waiting for the worker to accept" style={{ fontSize: 10 }}>⏳</span>}
                </span>
              );
              const hasSite = !!(a.client && a.site);
              return (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                    <span title={a.client || a.site || 'Job'} style={{ fontWeight: 700, color: C.text, fontSize: compact ? 12 : 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flex: '1 1 auto' }}>{a.client || a.site || 'Job'}</span>
                  </div>
                  {(hasSite || badges) && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, marginTop: 1 }}>
                      {hasSite && <span title={a.site} style={{ color: C.textMuted, fontSize: compact ? 10.5 : 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flex: '1 1 auto' }}>{a.site}</span>}
                      {badges}
                    </div>
                  )}
                </>
              );
            })()}
            {!compact && a.role && <div title={a.role} style={{ fontSize: 10, fontFamily: MONO, color: roleColor(a.role), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.role}</div>}
          </div>
        );
      });
    }
    const chip = (label, color, title) => (
      <span title={title} style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 5, fontSize: 10.5, fontWeight: 800, fontFamily: MONO, letterSpacing: 0.5, background: `${color}22`, color, border: `1px solid ${color}66` }}>{label}</span>
    );
    if (st) { const m = statusMeta(st.allocation_type); return chip(m?.short || st.allocation_type, m?.color || C.textMuted); }
    if (lv) return chip('A/L ✓', '#38bdf8', lv.reason || 'Approved leave');
    if (aw) return chip('AWAY', '#f87171', aw.reason || 'Not available');
    return <span style={{ color: C.textDim }}>–</span>;
  };
  const cell = (w, day, compact = false) => {
    const note = noteMap[noteKey(w.id, day)];
    return (
      <button type="button" onClick={() => openEditor(w.id, day)} title={note ? `Note: ${note.note}` : 'Tap to allocate'}
        style={{ position: 'relative', display: 'block', width: '100%', minHeight: compact ? 44 : 50, textAlign: 'left', overflow: 'hidden', borderLeft: workOn(w.id, day)[0] ? `3px solid ${clientColor(workOn(w.id, day)[0].client || workOn(w.id, day)[0].site || '')}` : '3px solid transparent', background: day === today ? 'rgba(249,115,22,0.05)' : 'transparent', border: 'none', borderRadius: 6, padding: compact ? '6px 6px' : '7px 9px', cursor: 'pointer', color: C.text, fontFamily: 'inherit' }}
        onMouseEnter={e => { e.currentTarget.style.background = C.cardHover; }}
        onMouseLeave={e => { e.currentTarget.style.background = day === today ? 'rgba(249,115,22,0.05)' : 'transparent'; }}>
        {cellBody(w, day, compact)}
        {note && <Dot />}
      </button>
    );
  };

  // ── header pieces ────────────────────────────────────────────────────────
  // Layout rule (owner, 2026-11-09): nothing wraps, nothing explains itself.
  // Phone: date nav · segmented tabs · 7 day pills · search + "+" · one-line
  // count. Desktop adds the page title and a normal "Add allocation" button.
  const seg = (id, label, onClick) => {
    const on = view === id;
    return (
      <button key={id} type="button" onClick={onClick || (() => setView(id))}
        style={{ flex: '1 1 0', minWidth: 0, padding: isMobile ? '9px 0' : '9px 10px', border: 'none', borderRadius: 7, background: on ? C.text : 'transparent', color: on ? C.bg : C.textMuted, fontFamily: MONO, fontSize: isMobile ? 10.5 : 11.5, letterSpacing: isMobile ? 0.6 : 1.2, textTransform: 'uppercase', fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap' }}>
        {label}
      </button>
    );
  };
  const navBtn = (label, onClick, aria) => (
    <button type="button" style={{ ...btnSmall, padding: isMobile ? '7px 10px' : '7px 11px', fontSize: 13, lineHeight: 1 }} onClick={onClick} aria-label={aria}>{label}</button>
  );
  const dateNav = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: isMobile ? 0 : 'auto' }}>
      {navBtn('←', () => setWeekStart(addDays(weekStart, -7)), 'Previous week')}
      <div style={{ fontFamily: MONO, fontSize: isMobile ? 11.5 : 12, color: C.text, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', whiteSpace: 'nowrap', minWidth: isMobile ? 0 : 118, textAlign: 'center' }}>{shortDate(weekStart)} – {shortDate(weekEnd)}</div>
      {navBtn('→', () => setWeekStart(addDays(weekStart, 7)), 'Next week')}
      {navBtn('Today', () => { setWeekStart(mondayOf(today)); setSelDay(today); })}
    </div>
  );
  const addBtn = (
    <button type="button" onClick={() => openEditor('', selDay)} aria-label="Add allocation"
      style={{ ...btnPrimary, padding: isMobile ? '0 14px' : '0 16px', height: 42, fontFamily: MONO, letterSpacing: 1, textTransform: 'uppercase', fontWeight: 800, fontSize: 12, whiteSpace: 'nowrap', flex: '0 0 auto' }}>
      {isMobile ? '+' : '+ Add allocation'}
    </button>
  );
  const header = (
    <div style={{ display: 'grid', gap: 8, marginBottom: 10 }} data-area="board header">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: isMobile ? 'center' : 'flex-start' }}>
        {!isMobile && <div style={{ fontWeight: 900, color: C.text, fontSize: 24, letterSpacing: -0.5, textTransform: 'uppercase' }}>Allocations</div>}
        {dateNav}
      </div>
      <div style={{ display: 'flex', gap: 2, padding: 3, background: C.card, border: `1px solid ${C.border}`, borderRadius: 10 }}>
        {seg('day', 'Day')}
        {seg('week', 'Week')}
        {seg('notes', 'Notes')}
        {seg('leave', 'Leave', () => onNavigate?.('leave'))}
        {seg('sites', 'Sites', () => onNavigate?.('clients'))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4 }} data-area="day pills">
        {days.map((d, i) => {
          const on = selDay === d;
          return (
            <button key={d} type="button" onClick={() => { setSelDay(d); if (view === 'notes') setView('day'); }}
              style={{ padding: isMobile ? '6px 0 5px' : '7px 0 6px', borderRadius: 8, border: `1px solid ${on ? C.text : C.border}`, background: on ? C.text : C.card, color: on ? C.bg : C.text, cursor: 'pointer', textAlign: 'center', minWidth: 0, lineHeight: 1.1 }}>
              <div style={{ fontFamily: MONO, fontSize: isMobile ? 8.5 : 10, letterSpacing: 0.5, textTransform: 'uppercase', color: on ? C.bg : (d === today ? C.accent : C.textMuted), fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden' }}>{DAY_NAMES[i]} {dayNum(d)}</div>
              <div style={{ fontSize: isMobile ? 15 : 18, fontWeight: 900, marginTop: 2 }}>{dayCount(d)}</div>
              {(nswHoliday(d) || (rain[d]?.chance ?? 0) >= 40) && (
                <div style={{ display: 'flex', justifyContent: 'center', gap: 4, marginTop: 2, fontFamily: MONO, fontSize: isMobile ? 8 : 9, fontWeight: 800, letterSpacing: 0.3 }}>
                  {nswHoliday(d) && <span title={nswHoliday(d)} style={{ color: on ? C.bg : '#fde047' }}>PH</span>}
                  {(rain[d]?.chance ?? 0) >= 40 && <span title={`${rain[d].chance}% chance of rain${rain[d].mm != null ? ` · ${rain[d].mm} mm` : ''}`} style={{ color: on ? C.bg : '#7dd3fc' }}>☔{rain[d].chance}%</span>}
                </div>
              )}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input style={{ ...inputStyle, fontSize: 15, height: 42, flex: '1 1 auto', minWidth: 0 }} placeholder={isMobile ? 'Search' : 'Search a name, client, site or role'} value={search} onChange={e => setSearch(e.target.value)} />
        {addBtn}
      </div>
      {(() => {
        const s = dayStats(selDay);
        const part = (n, label, color) => <span style={{ whiteSpace: 'nowrap' }}><strong style={{ color: color || C.text }}>{n}</strong> {label}</span>;
        return (
          <div style={{ display: 'flex', gap: 10, fontSize: 12.5, color: C.textMuted, alignItems: 'center', overflowX: 'auto', whiteSpace: 'nowrap' }} data-area="day summary">
            <span style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: 1, textTransform: 'uppercase', color: C.textDim }}>{longDay(selDay)}</span>
            {part(s.onSite.length, 'on site')}
            {part(s.spare.length, 'spare', C.accent)}
            {s.unavailable.length > 0 && part(s.unavailable.length, 'off')}
            {s.expiredOnSite.length > 0 && part(s.expiredOnSite.length, 'expired ticket on site', '#fca5a5')}
            <button type="button" onClick={() => setIncludeOffice(v => !v)} title="Show office staff on the board"
              style={{ marginLeft: 'auto', background: includeOffice ? C.text : 'transparent', color: includeOffice ? C.bg : C.textMuted, border: `1px solid ${includeOffice ? C.text : C.border}`, borderRadius: 999, padding: '3px 10px', fontSize: 11, fontFamily: MONO, letterSpacing: 0.6, textTransform: 'uppercase', cursor: 'pointer', whiteSpace: 'nowrap' }}>
              Office staff
            </button>
          </div>
        );
      })()}
      {(() => {
        const chip = (label, onClick, { on = false, title } = {}) => (
          <button key={label} type="button" onClick={onClick} title={title}
            style={{ flex: '0 0 auto', background: on ? C.text : 'transparent', color: on ? C.bg : C.textMuted, border: `1px solid ${on ? C.text : C.border}`, borderRadius: 999, padding: '4px 10px', fontSize: 11, fontFamily: MONO, letterSpacing: 0.5, textTransform: 'uppercase', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            {label}
          </button>
        );
        const sel = (value, onChange, options, placeholder) => (
          <select value={value} onChange={onChange}
            style={{ flex: '0 0 auto', background: value ? C.text : 'transparent', color: value ? C.bg : C.textMuted, border: `1px solid ${value ? C.text : C.border}`, borderRadius: 999, padding: '4px 8px', fontSize: 11, fontFamily: MONO, letterSpacing: 0.5, textTransform: 'uppercase', cursor: 'pointer', maxWidth: 150 }}>
            <option value="">{placeholder}</option>
            {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        );
        const pend = pendingOn(selDay).length;
        return (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', overflowX: 'auto', paddingBottom: 2 }} data-area="board tools">
            {sel(filters.client, ev => setFilters(f => ({ ...f, client: ev.target.value })), weekClients, 'All clients')}
            {sel(filters.type, ev => setFilters(f => ({ ...f, type: ev.target.value })), TYPE_ORDER.map(t => [t, TYPE_LABEL[t]]), 'All types')}
            {chip('Spare', () => setFilters(f => ({ ...f, spareOnly: !f.spareOnly })), { on: filters.spareOnly, title: `Only people free on ${longDay(selDay)}` })}
            <span style={{ flex: '0 0 1px', height: 16, background: C.border }} />
            {chip('Copy last week', previewCopyLastWeek, { title: 'Repeat last week\'s Mon–Fri jobs into empty cells' })}
            {pend > 0 && chip(`Nudge ${pend}`, nudgePending, { title: 'Re-send the accept SMS to everyone still pending on this day' })}
            {chip('CSV', exportCsv)}
            {!isMobile && chip('Print', printWeek)}
            {chip('History', () => setView(v => (v === 'history' ? (isMobile ? 'day' : 'week') : 'history')), { on: view === 'history' })}
          </div>
        );
      })()}
    </div>
  );

  const groupHeader = (g) => (
    <div style={{ padding: '7px 10px', color: C.accent, fontFamily: MONO, fontSize: 11, letterSpacing: 1.8, textTransform: 'uppercase', fontWeight: 800, borderBottom: `2px solid ${C.accentBorder}` }}>
      {g.label} <span style={{ color: C.textMuted, marginLeft: 6 }}>{g.workers.length}</span>
    </div>
  );
  const shortName = (name) => { const p = String(name || '').trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : p[0] || ''; };
  const nameBtn = (w, oneLine = false) => (
    <button type="button" onClick={() => setProfileId(w.id)} title={w.name}
      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: C.text, fontWeight: 700, fontSize: 13, textAlign: 'left', fontFamily: 'inherit', lineHeight: 1.2, maxWidth: '100%', whiteSpace: oneLine ? 'nowrap' : 'normal', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>
      {oneLine ? shortName(w.name) : w.name}
      {expiredCount(w.id) > 0 && <span title={`${expiredCount(w.id)} expired ticket(s)`} style={{ marginLeft: 6, fontSize: 10, color: '#fca5a5', fontWeight: 800 }}>●</span>}
    </button>
  );

  // ── week grid ────────────────────────────────────────────────────────────
  const compact = isMobile;
  const NAME_W = compact ? 104 : 168;
  const DAY_W = compact ? 112 : 124;
  const weekGrid = (
    <div ref={gridRef} style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: R.lg, background: C.card, WebkitOverflowScrolling: 'touch' }} data-area="week grid">
      <table style={{ width: compact ? NAME_W + DAY_W * 7 : '100%', minWidth: NAME_W + DAY_W * 7, borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: compact ? NAME_W : '14%' }} />
          {days.map(d => <col key={d} style={{ width: compact ? DAY_W : `${(86 / 7).toFixed(3)}%` }} />)}
        </colgroup>
        <thead>
          <tr style={{ background: C.accent }}>
            <th style={{ position: 'sticky', left: 0, zIndex: 2, background: C.accent, color: '#fff', textAlign: 'left', padding: '8px 10px', fontFamily: MONO, fontSize: 10.5, letterSpacing: 1.5, textTransform: 'uppercase' }}>Worker</th>
            {days.map((d, i) => (
              <th key={d} style={{ color: '#fff', textAlign: 'left', padding: '8px 8px', fontFamily: MONO, fontSize: 10.5, letterSpacing: 1.5, textTransform: 'uppercase', opacity: i >= 5 ? 0.75 : 1, background: d === selDay ? 'rgba(0,0,0,0.18)' : 'transparent', whiteSpace: 'nowrap' }}>{DAY_NAMES[i]} {dayNum(d)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map(g => (
            <Fragment key={g.key}>
              <tr><td colSpan={8} style={{ padding: 0 }}>{groupHeader(g)}</td></tr>
              {g.workers.map(w => (
                <tr key={w.id} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ position: 'sticky', left: 0, zIndex: 1, background: C.card, padding: '8px 10px', borderBottom: `1px solid ${C.border}`, verticalAlign: 'top', borderRight: `1px solid ${C.border}`, overflow: 'hidden' }}>
                    {nameBtn(w, compact)}
                    {!compact && <div style={{ fontSize: 10.5, color: C.textDim, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.job_title || ''}</div>}
                    {weekDays(w.id) > 0 && <div title="Days on site · planned hours this week" style={{ fontSize: 10, fontFamily: MONO, color: weekHours(w.id) > 40 ? '#fde047' : C.textDim, marginTop: 2, whiteSpace: 'nowrap' }}>{weekDays(w.id)}d · {weekHours(w.id)}h</div>}
                  </td>
                  {days.map(d => (
                    <td key={d} style={{ padding: 2, borderBottom: `1px solid ${C.border}`, verticalAlign: 'top' }}>{cell(w, d, compact)}</td>
                  ))}
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );

  // ── day view ─────────────────────────────────────────────────────────────
  const dayView = (() => {
    const s = dayStats(selDay);
    const bySite = {};
    s.onSite.forEach(w => workOn(w.id, selDay).forEach(a => {
      const k = `${a.client || 'Job'}|${a.site || ''}`;
      (bySite[k] = bySite[k] || { client: a.client || 'Job', site: a.site || '', rows: [] }).rows.push({ w, a });
    }));
    const row = (w, sub, right) => {
      const note = noteMap[noteKey(w.id, selDay)];
      return (
        <button key={w.id} type="button" onClick={() => openEditor(w.id, selDay)}
          style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderTop: `1px solid ${C.border}`, padding: '9px 12px', paddingRight: note ? 22 : 12, cursor: 'pointer', color: C.text, fontFamily: 'inherit', minHeight: 48 }}>
          <span style={{ flex: '1 1 auto', minWidth: 0 }}>
            <span style={{ display: 'block', fontWeight: 700, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.name}</span>
            {sub && <span style={{ display: 'block', fontSize: 11, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</span>}
          </span>
          {right && <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: C.textMuted, whiteSpace: 'nowrap', flex: '0 0 auto' }}>{right}</span>}
          {note && <Dot />}
        </button>
      );
    };
    const box = (title, count, children, color) => (
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: R.lg, overflow: 'hidden' }}>
        <div style={{ padding: '8px 12px', fontFamily: MONO, fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase', fontWeight: 800, color: color || C.accent, display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span><span style={{ color: C.textMuted }}>{count}</span>
        </div>
        {children}
      </div>
    );
    return (
      <div style={{ display: 'grid', gap: 12 }} data-area="day view">
        {Object.values(bySite).sort((a, b) => a.client.localeCompare(b.client)).map(g => box(
          <span><span style={{ color: C.text }}>{g.client}</span>{g.site && <span style={{ color: C.textMuted, fontWeight: 500, textTransform: 'none', letterSpacing: 0, fontFamily: 'inherit', fontSize: 12 }}> · {g.site}</span>}</span>,
          g.rows.length,
          g.rows.map(({ w, a }) => row(w,
            a.role ? <span style={{ color: roleColor(a.role), fontFamily: MONO, fontSize: 10.5 }}>{a.role}</span> : null,
            <>{shiftMeta(a.shift)?.rain && <RainTag tag={shiftMeta(a.shift).tag} />}{a.left_early && <span title="Left early" style={{ color: '#fde047', fontWeight: 800 }}>½</span>}{a.status === 'pending' && <span title="Waiting for the worker to accept">⏳</span>}</>)),
        ))}
        {!Object.keys(bySite).length && <EmptyState message={`Nobody on site ${longDay(selDay)}.`} />}
        {box('Spare', s.spare.length, s.spare.map(w => row(w, <span style={{ color: C.textDim }}>{w.job_title || TYPE_LABEL[w.worker_type] || ''}</span>, null)), C.textMuted)}
        {box('Unavailable', s.unavailable.length, s.unavailable.map(w => {
          const st = statusOn(w.id, selDay); const lv = leaveOn(w.id, selDay); const aw = awayOn(w.id, selDay);
          return row(w, <span style={{ color: C.textMuted }}>{st ? statusMeta(st.allocation_type)?.label || st.allocation_type : lv ? `A/L approved${lv.reason ? ` · ${lv.reason}` : ''}` : `Away${aw?.reason ? ` · ${aw.reason}` : ''}`}</span>, null);
        }), '#f87171')}
      </div>
    );
  })();

  // ── notes for payroll ────────────────────────────────────────────────────
  const notesList = (() => {
    const rows = [];
    dayNotes.forEach(n => {
      const w = workers.find(x => x.id === n.worker_id);
      const a = (byWorker[n.worker_id] || []).filter(x => covers(x, n.day))[0];
      const tag = a ? (isWork(a) ? [a.client, a.site].filter(Boolean).join(' · ') : (statusMeta(a.allocation_type)?.label || a.allocation_type)) : '';
      rows.push({ key: n.id, day: n.day, name: w?.name || 'Worker', text: n.note, tag, by: n.created_by });
    });
    // Days flagged without a written note still matter to payroll.
    allocs.forEach(a => {
      days.filter(d => covers(a, d)).forEach(d => {
        if (noteMap[noteKey(a.worker_id, d)]) return;
        const w = workers.find(x => x.id === a.worker_id);
        const sh = shiftMeta(a.shift);
        const flags = [];
        if (!isWork(a)) flags.push(statusMeta(a.allocation_type)?.label || a.allocation_type);
        if (sh?.rain) flags.push(sh.label);
        if (a.left_early) flags.push('Left early');
        if (a.shift === 'night') flags.push('Night shift');
        if (!flags.length) return;
        rows.push({ key: `${a.id}|${d}`, day: d, name: w?.name || 'Worker', text: flags.join(' · '), tag: isWork(a) ? [a.client, a.site].filter(Boolean).join(' · ') : '', auto: true });
      });
    });
    rows.sort((x, y) => x.day.localeCompare(y.day) || x.name.localeCompare(y.name));
    return rows;
  })();
  const notesPanel = (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: R.lg, padding: 14 }} data-area="notes for payroll">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <div style={{ fontFamily: MONO, fontWeight: 800, color: C.accent, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1.6 }}>Notes for payroll</div>
        <div style={{ fontFamily: MONO, fontSize: 11, color: C.textMuted }}>{notesList.length}</div>
      </div>
      {notesList.length === 0 && <div style={{ fontSize: 12.5, color: C.textDim }}>No notes this week.</div>}
      <div style={{ display: 'grid', gap: 8 }}>
        {notesList.map(r => (
          <div key={r.key} style={{ borderLeft: `3px solid ${r.auto ? C.border : C.accent}`, background: C.bg, borderRadius: 8, padding: '9px 12px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{ fontWeight: 700, color: C.text, fontSize: 13.5 }}>{r.name}</div>
              <div style={{ color: r.auto ? C.textMuted : C.text, fontSize: 13, marginTop: 2 }}>{r.text}</div>
            </div>
            <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: 1, textTransform: 'uppercase', color: C.accent, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
              {DAY_NAMES[days.indexOf(r.day)] || ''} {dayNum(r.day)}{r.tag ? ` · ${r.tag}` : ''}
            </div>
          </div>
        ))}
      </div>
      <div style={{ ...sectionLabel, marginTop: 18 }}>Week notes</div>
      <textarea style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }} value={weekNotes} onChange={e => setWeekNotes(e.target.value)} placeholder="Who to call first, site notes, anything for the week…" />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <button style={btnPrimary} disabled={savingWeekNotes || weekNotes === savedWeekNotes} onClick={saveWeekNotes}>{savingWeekNotes ? 'Saving…' : weekNotes === savedWeekNotes ? 'Saved' : 'Save week notes'}</button>
      </div>
      {away.length > 0 && (
        <>
          <div style={{ ...sectionLabel, marginTop: 18 }}>Marked away</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {away.map(r => {
              const w = workers.find(x => x.id === r.worker_id);
              return (
                <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12.5, flexWrap: 'wrap' }}>
                  <strong style={{ color: C.text }}>{w?.name || 'Worker'}</strong>
                  <span style={{ color: C.textMuted, fontFamily: MONO, fontSize: 11 }}>{shortDate(r.from_date)}{r.to_date !== r.from_date ? ` – ${shortDate(r.to_date)}` : ''}</span>
                  {r.reason && <span style={{ color: C.textMuted }}>{r.reason}</span>}
                  <button style={{ ...btnSmall, marginLeft: 'auto', color: C.textMuted }} onClick={() => removeAway(r)}>Remove</button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );

  // ── editor modal ─────────────────────────────────────────────────────────
  const editorModal = editor && (() => {
    const e = editor;
    const w = workers.find(x => x.id === e.workerId);
    const clientSites = sites.filter(s => s.client_id === e.clientId);
    const exp = e.workerId ? expiredCount(e.workerId) : 0;
    const soon = e.workerId ? expiringCount(e.workerId) : 0;
    const gaps = e.workerId && e.role ? ticketGaps(tickets[e.workerId] || [], requiredTicketsFor(reqTickets, e.role), today) : [];
    const dayLabel = (d) => {
      if (!e.workerId) return 'Spare';
      const wk = workOn(e.workerId, d)[0]; const st = statusOn(e.workerId, d);
      if (wk) return `${wk.client || ''}${wk.site ? ` ${wk.site}` : ''}`.trim() || 'Booked';
      if (st) return statusMeta(st.allocation_type)?.label || st.allocation_type;
      if (leaveOn(e.workerId, d)) return 'A/L';
      if (awayOn(e.workerId, d)) return 'Away';
      return 'Spare';
    };
    return (
      <Modal title={`${e.workerName || 'New allocation'} — ${longDay(e.day)}`} onClose={() => setEditor(null)} width={720}>
        <div data-area="day editor" style={{ fontSize: 13 }}>
          {!e.workerId && (
            <>
              <div style={sectionLabel}>Worker</div>
              <select style={{ ...inputStyle, fontSize: 15 }} value={e.workerId} onChange={ev => { const wid = ev.target.value; const ww = workers.find(x => x.id === wid); ed({ workerId: wid, workerName: ww?.name || '' }); }}>
                <option value="">Pick a worker…</option>
                {groups.flatMap(g => g.workers).map(x => <option key={x.id} value={x.id}>{x.name}{x.worker_type ? ` · ${TYPE_LABEL[x.worker_type] || x.worker_type}` : ''}</option>)}
              </select>
            </>
          )}
          {(exp > 0 || soon > 0 || gaps.length > 0) && (
            <div style={{ border: `1px solid ${exp || gaps.length ? 'rgba(239,68,68,0.45)' : 'rgba(234,179,8,0.45)'}`, background: exp || gaps.length ? C.errorSoft : C.warningSoft, borderRadius: R.md, padding: '9px 12px', marginBottom: 6 }}>
              <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', fontWeight: 800, color: exp || gaps.length ? '#fca5a5' : '#fde047' }}>
                {exp ? `${exp} expired` : ''}{exp && soon ? ' · ' : ''}{soon ? `${soon} expiring` : ''}
              </div>
              <div style={{ color: C.textMuted, fontSize: 12, marginTop: 2 }}>
                {exp ? 'A ticket on file has expired. ' : ''}{soon ? 'A ticket falls due within 30 days. ' : ''}{gaps.length ? `Missing for ${e.role}: ${gaps.map(gapLabel).join(', ')}.` : ''}
                {' '}<button type="button" onClick={() => setProfileId(e.workerId)} style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', padding: 0, fontSize: 12, fontWeight: 700 }}>See tickets</button>
              </div>
            </div>
          )}

          <div style={sectionLabel}>Client</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Chip on={e.choice === 'none'} color={C.textMuted} onClick={() => ed({ choice: 'none' })}>NO ALLOCATION</Chip>
            {STATUS_TYPES.map(t => <Chip key={t.id} on={e.choice === t.id} color={t.color} onClick={() => ed({ choice: t.id })}>{t.label}</Chip>)}
            {clients.map(c => {
              const only = sites.filter(s => s.client_id === c.id);
              return <Chip key={c.id} on={e.choice === 'work' && e.clientId === c.id} onClick={() => ed({ choice: 'work', clientId: c.id, siteId: only.length === 1 ? only[0].id : (e.clientId === c.id ? e.siteId : '') })}>{c.name}</Chip>;
            })}
          </div>
          {clients.length === 0 && <div style={{ color: C.textDim, fontSize: 12, marginTop: 4 }}>No clients yet — add them under Clients.</div>}

          {e.choice === 'work' && (
            <>
              <div style={sectionLabel}>Site</div>
              {clientSites.length === 0
                ? <div style={{ color: C.textDim, fontSize: 12 }}>This client has no sites yet. <button type="button" onClick={() => onNavigate?.('clients')} style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', padding: 0, fontWeight: 700 }}>Add one under Clients</button>. You can still save with the client only.</div>
                : <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{clientSites.map(s => <Chip key={s.id} on={e.siteId === s.id} onClick={() => ed({ siteId: e.siteId === s.id ? '' : s.id })}>{s.name}</Chip>)}</div>}

              <div style={sectionLabel}>Shift</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{SHIFTS.map(s => <Chip key={s.id} on={e.shift === s.id} onClick={() => ed({ shift: s.id })}>{s.label}</Chip>)}</div>

              <div style={sectionLabel}>Role</div>
              {ROLE_GROUPS.map(g => (
                <div key={g.category} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 10, fontFamily: MONO, color: g.color, letterSpacing: 1, textTransform: 'uppercase', minWidth: 62 }}>{g.category}</span>
                  {g.roles.map(r => <Chip key={r.name} small color={g.color} on={e.role === r.name} onClick={() => ed({ role: e.role === r.name ? '' : r.name })}>{r.name.replace(/^(Operator|Skilled Labourer) - /, '')}</Chip>)}
                </div>
              ))}

              <div style={sectionLabel}>Left early</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <Chip on={!e.leftEarly} color={C.textMuted} onClick={() => ed({ leftEarly: false })}>On site all day</Chip>
                <Chip on={e.leftEarly} color="#eab308" onClick={() => ed({ leftEarly: true })}>Left early</Chip>
              </div>
            </>
          )}

          <div style={sectionLabel}>Days</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 5 }}>
            {days.map((d, i) => {
              const on = e.days.includes(d);
              const booked = e.workerId ? (workOn(e.workerId, d).length > 0 || !!statusOn(e.workerId, d)) : false;
              return (
                <button key={d} type="button" onClick={() => toggleDay(d)}
                  style={{ padding: '7px 3px', borderRadius: 8, border: `1px solid ${on ? C.accent : booked ? 'rgba(234,179,8,0.6)' : C.border}`, background: on ? C.accent : booked ? 'rgba(234,179,8,0.12)' : C.bg, color: on ? '#fff' : C.text, cursor: 'pointer', minWidth: 0, textAlign: 'center' }}>
                  <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 0.8, fontWeight: 800 }}>{DAY_NAMES[i].toUpperCase()} {dayNum(d)}</div>
                  <div style={{ fontSize: 9.5, color: on ? 'rgba(255,255,255,0.85)' : C.textMuted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d === e.day ? 'This day' : dayLabel(d)}</div>
                </button>
              );
            })}
          </div>
          {e.choice === 'work' && e.workerId && e.days.some(d => leaveOn(e.workerId, d) || awayOn(e.workerId, d)) && (
            <div style={{ marginTop: 6, border: '1px solid rgba(239,68,68,0.45)', background: C.errorSoft, borderRadius: R.md, padding: '8px 12px', fontSize: 12, color: '#fca5a5' }}>
              {e.workerName} is on {e.days.filter(d => leaveOn(e.workerId, d) || awayOn(e.workerId, d)).map(d => `${DAY_NAMES[days.indexOf(d)]} ${dayNum(d)} (${leaveOn(e.workerId, d) ? 'approved leave' : (awayOn(e.workerId, d)?.reason || 'away')})`).join(', ')}. Saving still books them.
            </div>
          )}
          {e.hasExisting && e.choice === 'work' && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
              <select value={swapTo} onChange={ev => setSwapTo(ev.target.value)} style={{ ...inputStyle, flex: '1 1 180px', fontSize: 13 }}>
                <option value="">Move this day to another worker…</option>
                {dayStats(e.day).spare.filter(x => x.id !== e.workerId).map(x => <option key={x.id} value={x.id}>{x.name}{x.job_title ? ` · ${x.job_title}` : ''}</option>)}
              </select>
              <button type="button" disabled={!swapTo || saving} onClick={moveToWorker} style={{ ...btnSmall, opacity: swapTo ? 1 : 0.5 }}>Move</button>
            </div>
          )}

          <div style={sectionLabel}>Note for payroll</div>
          <textarea style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }} value={e.note} onChange={ev => ed({ note: ev.target.value })}
            placeholder="Anything worth remembering — “Sent home early due to rain – charge 4, pay 8”, “Called in 5:46am”…" />

          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <button type="button" disabled={saving} onClick={() => saveEditor(e.days)}
              style={{ ...btnPrimary, flex: '1 1 200px', padding: '13px', fontFamily: MONO, letterSpacing: 1.4, textTransform: 'uppercase', fontWeight: 800 }}>
              {saving ? 'Saving…' : e.days.length > 1 ? `Save ${e.days.length} days` : 'Save this day'}
            </button>
            <button type="button" disabled={saving} onClick={() => saveEditor([...new Set([...e.days, ...restOfWeek()])].sort())}
              style={{ ...btnSecondary, flex: '1 1 200px', padding: '13px', fontFamily: MONO, letterSpacing: 1.4, textTransform: 'uppercase', fontWeight: 800 }}>
              Apply to rest of week
            </button>
            <button type="button" disabled={saving} onClick={() => setEditor(null)} style={{ ...btnSmall, flex: '0 0 auto' }}>Cancel</button>
          </div>
          {w && <div style={{ fontSize: 11, color: C.textDim, marginTop: 8 }}>A new or moved job sends {w.name} an SMS + email to accept. Sick, leave and rain marks do not.</div>}
        </div>
      </Modal>
    );
  })();

  // ── profile modal ────────────────────────────────────────────────────────
  const profileModal = profileId && (() => {
    const w = workers.find(x => x.id === profileId);
    if (!w) return null;
    const list = [...(tickets[w.id] || [])].sort((a, b) => (a.expiry || '9999').localeCompare(b.expiry || '9999'));
    const valid = list.filter(t => { const d = daysUntil(t.expiry); return d === null || d > 30; }).length;
    const tel = w.mobile ? String(w.mobile).replace(/[^\d+]/g, '') : '';
    const statusBadge = (t) => {
      const d = daysUntil(t.expiry);
      if (d === null) return <Badge label="held" color="gray" size="sm" />;
      if (d < 0) return <Badge label="expired" color="red" size="sm" />;
      if (d <= 30) return <Badge label="expiring" color="yellow" size="sm" />;
      return <Badge label="current" color="green" size="sm" />;
    };
    return (
      <Modal title={w.name} onClose={() => setProfileId(null)} width={640} dismissible>
        <div style={{ fontSize: 13 }} data-area="worker profile">
          <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 1.4, textTransform: 'uppercase', color: C.textMuted }}>
            {[TYPE_LABEL[w.worker_type] || w.worker_type, w.job_title, (w.app_status || '') === 'Active' ? null : 'still onboarding'].filter(Boolean).join(' · ')}
          </div>
          <div style={{ display: 'flex', gap: 8, margin: '12px 0', flexWrap: 'wrap' }}>
            {tel ? <a href={`tel:${tel}`} style={{ ...btnPrimary, textDecoration: 'none', fontFamily: MONO, letterSpacing: 1.4, textTransform: 'uppercase', fontWeight: 800 }}>Call</a> : null}
            {tel ? <a href={`sms:${tel}`} style={{ ...btnSecondary, textDecoration: 'none', fontFamily: MONO, letterSpacing: 1.4, textTransform: 'uppercase', fontWeight: 800 }}>Text</a> : null}
            <button type="button" style={btnSecondary} onClick={() => { setProfileId(null); openEditor(w.id, selDay); }}>Allocate {longDay(selDay)}</button>
            <button type="button" style={btnSmall} onClick={() => setAwayForm({ worker_id: w.id, name: w.name, from_date: selDay, to_date: selDay, reason: '' })}>Away…</button>
          </div>
          {awayForm?.worker_id === w.id && (
            <div style={{ padding: 10, background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.md, display: 'grid', gap: 8, marginBottom: 10 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <label style={{ fontSize: 11, color: C.textMuted }}>From<br /><input type="date" style={{ ...inputStyle, width: 'auto' }} value={awayForm.from_date} onChange={ev => setAwayForm(f => ({ ...f, from_date: ev.target.value }))} /></label>
                <label style={{ fontSize: 11, color: C.textMuted }}>To<br /><input type="date" style={{ ...inputStyle, width: 'auto' }} value={awayForm.to_date} onChange={ev => setAwayForm(f => ({ ...f, to_date: ev.target.value }))} /></label>
                <label style={{ fontSize: 11, color: C.textMuted, flex: '1 1 140px' }}>Reason<br /><input style={inputStyle} value={awayForm.reason} placeholder="holiday, other job…" onChange={ev => setAwayForm(f => ({ ...f, reason: ev.target.value }))} /></label>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button style={btnSmall} onClick={() => setAwayForm(null)}>Cancel</button>
                <button style={btnPrimary} onClick={saveAway}>Save</button>
              </div>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 6 }}>
            {[['Current', valid, C.success], ['Expiring', expiringCount(w.id), C.warning], ['Expired', expiredCount(w.id), C.error]].map(([k, v, col]) => (
              <div key={k} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.md, padding: '8px 10px' }}>
                <div style={{ fontSize: 20, fontWeight: 900, color: v ? col : C.textDim }}>{v}</div>
                <div style={{ fontSize: 10, fontFamily: MONO, letterSpacing: 1, textTransform: 'uppercase', color: C.textMuted }}>{k}</div>
              </div>
            ))}
          </div>
          <div style={sectionLabel}>Tickets &amp; competencies</div>
          {list.length === 0 ? <div style={{ color: C.textDim }}>None on file.</div> : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead><tr style={{ background: C.accent, color: '#fff' }}>
                  {['Ticket', 'Issuer', 'Expiry', 'Status'].map(h => <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontFamily: MONO, fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase' }}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {list.map((t, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}>
                      <td style={{ padding: '7px 8px', color: C.text, fontWeight: 600 }}>{t.name || '—'}</td>
                      <td style={{ padding: '7px 8px', color: C.textMuted }}>{t.issuer || '—'}</td>
                      <td style={{ padding: '7px 8px', color: C.textMuted, fontFamily: MONO, whiteSpace: 'nowrap' }}>{t.expiry ? shortDate(t.expiry) : 'No expiry'}</td>
                      <td style={{ padding: '7px 8px' }}>{statusBadge(t)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={sectionLabel}>This week</div>
          <div style={{ display: 'grid', gap: 3 }}>
            {days.map((d, i) => (
              <button key={d} type="button" onClick={() => { setProfileId(null); openEditor(w.id, d); }}
                style={{ display: 'flex', gap: 10, alignItems: 'center', background: 'transparent', border: 'none', borderTop: `1px solid ${C.border}`, padding: '7px 4px', cursor: 'pointer', textAlign: 'left', color: C.text, fontFamily: 'inherit' }}>
                <span style={{ fontFamily: MONO, fontSize: 10.5, color: d === today ? C.accent : C.textMuted, minWidth: 54, textTransform: 'uppercase', letterSpacing: 0.8 }}>{DAY_NAMES[i]} {dayNum(d)}</span>
                <span style={{ flex: 1, fontSize: 12.5 }}>{cellBody(w, d, true)}</span>
                {noteMap[noteKey(w.id, d)] && <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.accent, display: 'inline-block' }} />}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap', fontSize: 12, color: C.textMuted }}>
            {w.mobile && <span>📱 {w.mobile}</span>}{w.email && <span>✉ {w.email}</span>}
            <button type="button" onClick={() => onNavigate?.('workers')} style={{ ...btnSmall, marginLeft: 'auto' }}>Open in Workers</button>
          </div>
        </div>
      </Modal>
    );
  })();

  return (
    <div data-area="allocation board" style={{ paddingBottom: 72 }}>
      {header}
      {loading
        ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>
        : view === 'notes' ? notesPanel
        : view === 'history' ? (
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: R.lg, padding: 14 }} data-area="board history">
            <div style={{ fontFamily: MONO, fontWeight: 800, color: C.accent, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1.6, marginBottom: 10 }}>Changes this week <span style={{ color: C.textMuted }}>{history ? history.length : ''}</span></div>
            {history === null && <Spinner />}
            {history && history.length === 0 && <div style={{ fontSize: 12.5, color: C.textDim }}>No board changes this week.</div>}
            <div style={{ display: 'grid', gap: 6 }}>
              {(history || []).map(h => {
                const a = h.after || {};
                const what = a.choice === 'none' ? 'cleared' : a.choice === 'work' ? `${a.shift ? shiftMeta(a.shift)?.label || a.shift : 'Day'}${a.copied_from ? ' (copied from last week)' : ''}` : (statusMeta(a.choice)?.label || a.choice || '');
                return (
                  <div key={h.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 12.5, borderTop: `1px solid ${C.border}`, paddingTop: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.textDim, whiteSpace: 'nowrap' }}>{new Date(h.created_at).toLocaleString('en-AU', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Sydney' })}</span>
                    <strong style={{ color: C.text }}>{a.worker || 'Worker'}</strong>
                    <span style={{ color: C.textMuted }}>{a.day ? `${DAY_NAMES[days.indexOf(a.day)] || ''} ${dayNum(a.day)}` : ''} · {what}{a.left_early ? ' · left early' : ''}{a.note ? ' · note' : ''}</span>
                    <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 10.5, color: C.textDim, whiteSpace: 'nowrap' }}>{h.actor_name || ''}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )
        : view === 'day' ? dayView
        : visible.length === 0 ? <EmptyState message="No workers match this search." />
        : <>{weekGrid}<div style={{ marginTop: 14 }}>{notesPanel}</div></>}
      {!loading && view === 'week' && (
        <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 11, color: C.textDim, overflowX: 'auto', whiteSpace: 'nowrap' }}>
          <span>⏳ to accept</span><span>½ left early</span><span><RainTag /> rain</span><span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: C.accent, verticalAlign: 'middle' }} /> payroll note</span>
        </div>
      )}
      {editorModal}
      {profileModal}
      {copying && (
        <Modal title="Copy last week" onClose={() => setCopying(null)} width={520}>
          <div style={{ fontSize: 13, color: C.text }}>
            {copying.rows.length === 0
              ? <div style={{ color: C.textMuted }}>Nothing to copy: every Mon–Fri cell with a job last week is already filled this week.</div>
              : <>
                  <div><strong>{copying.rows.length}</strong> job{copying.rows.length === 1 ? '' : 's'} will be added to empty cells this week as pending. Each worker gets the usual SMS to accept.</div>
                  <div style={{ display: 'grid', gap: 4, marginTop: 10, maxHeight: 260, overflowY: 'auto' }}>
                    {copying.rows.map(r => <div key={`${r.worker_id}|${r.day}`} style={{ fontSize: 12, color: C.textMuted }}><strong style={{ color: C.text }}>{workers.find(w => w.id === r.worker_id)?.name}</strong> · {DAY_NAMES[days.indexOf(r.day)]} {dayNum(r.day)} · {r.src.client}{r.src.site ? ` · ${r.src.site}` : ''}</div>)}
                  </div>
                </>}
            <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
              <button type="button" style={btnSecondary} onClick={() => setCopying(null)}>Cancel</button>
              {copying.rows.length > 0 && <button type="button" style={btnPrimary} disabled={saving} onClick={runCopyLastWeek}>{saving ? 'Copying…' : `Copy ${copying.rows.length}`}</button>}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
