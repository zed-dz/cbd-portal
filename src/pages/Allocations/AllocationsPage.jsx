import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, inputStyle, btnPrimary, btnSecondary, btnDanger, btnSmall } from '../../theme';
import { fmtDate, fmtDateTime, sydneyHHMM, sydneyInstant, todayISO } from '../../utils/dates';
import { normaliseAUMobile, sendWorkerSms, addAdminNotification, allocationSmsBody, broadcastAdminSms, adminCreateSmsBody, sendAdminEmail, sendWorkerAllocationEmail, notifyWorkerSwapDecision } from '../../utils/notify';
import { logActivity } from '../../utils/activity';
import { Spinner, Modal, Field, TableWrap, Th, Td, EmptyState, Badge, allocationBadge, DateField, ClockField } from '../../components';
import { ROLE_GROUPS, ALL_ROLE_NAMES, roleChipStyle } from '../../constants/roles';
import { isLikelyMapLink } from '../../utils/mapLink';
import { requiredTicketsFor, ticketGaps, gapLabel, certsByWorker } from '../../utils/ticketCheck';
import { seriesDates, weekdayIndex, addDays, dayDiff, newSeriesId, WEEKDAY_NAMES } from '../../utils/series';

// Find allocations for a given worker that overlap a [start, end] date range
// AND are still live (pending/confirmed). Used to warn the admin before
// double-booking. Excludes the current allocation when editing.
function findConflicts(allAllocations, workerId, startISO, endISO, currentId) {
  if (!workerId || !startISO) return [];
  const winStart = startISO;
  const winEnd   = endISO || startISO;
  return allAllocations.filter(a => {
    if (a.worker_id !== workerId) return false;
    if (currentId && a.id === currentId) return false;
    if (!['pending', 'confirmed'].includes(a.status)) return false;
    const otherStart = a.start_date;
    const otherEnd   = a.end_date || a.start_date;
    if (!otherStart) return false;
    return otherStart <= winEnd && otherEnd >= winStart;
  });
}

const allocDefaults = {
  worker_id: '', role: '', site: '', client: '', project: '', address: '', site_supervisor: '',
  manager_phone: '', status: 'pending', start_date: '', end_date: '',
  arrival_time: '', notes: '', map_link: '',
};
const repeatDefaults = { mode: 'none', weeks: 4, weekdays: [] };

const warnChip = {
  display: 'inline-block', padding: '1px 7px', borderRadius: 5, fontSize: 11, fontWeight: 600,
  background: 'rgba(234,179,8,0.14)', color: '#fde047', border: '1px solid rgba(234,179,8,0.4)', whiteSpace: 'nowrap',
};

export function AllocationsPage({ showToast, prefill = null, onPrefillUsed }) {
  const [allocations, setAllocations] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [clients, setClients] = useState([]);
  const [sites, setSites] = useState([]);
  const [siteContacts, setSiteContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState('');
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(allocDefaults);
  const [saving, setSaving] = useState(false);
  // Create-mode crew picker: whole crews go out to a site in one hit, so add
  // mode is a multi-select checklist (one allocation row per ticked worker).
  // Edit mode keeps the single select — an existing row has exactly one worker.
  const [selectedWorkerIds, setSelectedWorkerIds] = useState([]);
  const [workerSearch, setWorkerSearch] = useState('');
  // Quick-add for a brand-new site while allocating — clients text new sites in
  // monthly, and leaving the modal to add one loses the half-filled allocation.
  const [quickSite, setQuickSite] = useState(null);
  // "How many do you need?" for a multi-worker offer. '' = everyone ticked is
  // needed (one position per worker — the old crew behaviour). Fewer than the
  // ticked count turns it into a first-to-accept offer.
  const [positions, setPositions] = useState('');
  const needCount = Math.min(
    Math.max(1, parseInt(positions, 10) || selectedWorkerIds.length || 1),
    Math.max(1, selectedWorkerIds.length),
  );
  // 2026-10-19 — ticket check, repeating allocations, swap requests.
  const [reqTickets, setReqTickets] = useState([]);     // role_required_tickets (live rows)
  const [certs, setCerts] = useState({});               // worker_id → [{ name, expiry }]
  const [isAdmin, setIsAdmin] = useState(false);
  const [meId, setMeId] = useState(null);
  const [ticketEditor, setTicketEditor] = useState(null); // { role, newTicket }
  const [repeat, setRepeat] = useState(repeatDefaults);
  const [swaps, setSwaps] = useState([]);
  const [showDecided, setShowDecided] = useState(false);
  const [deciding, setDeciding] = useState(null);
  const today = todayISO();

  const saveQuickSite = async () => {
    const clientRow = clients.find(c => c.name === form.client);
    if (!clientRow) { showToast('Pick a client first.', 'error'); return; }
    if (!quickSite.name.trim()) { showToast('Site name is required.', 'error'); return; }
    const { data, error } = await supabase.from('client_sites').insert([{
      client_id: clientRow.id,
      name: quickSite.name.trim(),
      address: quickSite.address || null,
      map_link: quickSite.map_link || null,
      is_active: true,
    }]).select().single();
    if (error) { showToast(error.message, 'error'); return; }
    setSites(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
    setForm(f => ({
      ...f, site: data.name,
      ...(data.address ? { address: data.address } : {}),
      ...(data.map_link ? { map_link: data.map_link } : {}),
    }));
    setQuickSite(null);
    showToast(`Site "${data.name}" added to ${form.client}.`, 'success');
  };

  const load = useCallback(async () => {
    setLoading(true);
    const [a, w, c, s, k, rt, c1, c2, sw, adm, me] = await Promise.all([
      supabase.from('allocations').select('*, workers(name, job_title), allocation_groups(positions, filled_at)').order('created_at', { ascending: false }),
      supabase.from('workers').select('id, name, mobile, email').is('archived_at', null).order('name'),
      supabase.from('clients').select('id, name').order('name'),
      // A client can run several jobs at once, so sites are their own list and the
      // Site picker below narrows to the chosen client rather than being free text.
      supabase.from('client_sites').select('id, client_id, name, address, map_link').eq('is_active', true).order('name'),
      supabase.from('client_site_contacts').select('id, site_id, name, role, email, phone, is_primary').order('name'),
      supabase.from('role_required_tickets').select('*').is('archived_at', null).order('role_name'),
      supabase.from('certifications').select('worker_id, cert_name, expiry'),
      supabase.from('worker_certificates').select('worker_id, name, expiry_date'),
      supabase.from('shift_swap_requests').select('*').order('created_at', { ascending: false }).limit(60),
      supabase.rpc('is_portal_admin'),
      supabase.rpc('current_worker_id'),
    ]);
    if (a.error) showToast(a.error.message, 'error');
    else setAllocations(a.data || []);
    if (w.data) setWorkers(w.data);
    if (c.data) setClients(c.data);
    if (s.data) setSites(s.data);
    if (k.data) setSiteContacts(k.data);
    setReqTickets(rt.data || []);
    setCerts(certsByWorker(c1.data, c2.data));
    setSwaps(sw.data || []);
    setIsAdmin(adm.data === true);
    setMeId(me.data || null);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  // Opened from the Allocation Board with workers (and maybe a day) pre-ticked.
  useEffect(() => {
    if (!prefill) return;
    setForm({ ...allocDefaults, start_date: prefill.date || '' });
    setSelectedWorkerIds(prefill.workerIds || []);
    setPositions('');
    setWorkerSearch('');
    setRepeat(repeatDefaults);
    setModal('add');
    onPrefillUsed?.();
  }, [prefill, onPrefillUsed]);

  const openAdd = () => { setForm(allocDefaults); setSelectedWorkerIds([]); setPositions(''); setWorkerSearch(''); setRepeat(repeatDefaults); setModal('add'); };

  // ⧉ Duplicate: same job details, dates + arrival CLEARED — the whole point is
  // re-sending the same job on a new day, so stale dates must not survive the
  // copy. Opens as a fresh Create (status pending, worker pre-ticked).
  const openDuplicate = (a) => {
    setForm({
      worker_id: a.worker_id || '', role: a.role || '', site: a.site || '', client: a.client || '',
      project: a.project || '', address: a.address || '',
      site_supervisor: a.site_manager || a.site_supervisor || '',
      manager_phone: a.manager_phone || '',
      status: 'pending', start_date: '', end_date: '', arrival_time: '',
      notes: a.notes || '', map_link: a.map_link || '',
    });
    setSelectedWorkerIds(a.worker_id ? [a.worker_id] : []);
    setPositions('');
    setWorkerSearch('');
    setRepeat(repeatDefaults);
    setModal('add');
  };

  const openEdit = (a) => {
    setForm({
      worker_id: a.worker_id || '', role: a.role || '', site: a.site || '', client: a.client || '',
      project: a.project || '', address: a.address || '',
      site_supervisor: a.site_manager || a.site_supervisor || '',
      manager_phone: a.manager_phone || '', status: a.status, start_date: a.start_date || '',
      end_date: a.end_date || '',
      // Extract time-only from stored datetime
      // Stored instants render back as LOCAL wall-clock (same tz contract as
      // timesheets — slicing the raw string showed UTC and drifted +10h).
      // Sydney wall-clock, whatever zone the admin's browser is in (audit P2).
      arrival_time: a.start_time ? sydneyHHMM(a.start_time) : '',
      notes: a.notes || '',
      map_link: a.map_link || '',
    });
    setModal(a);
  };
  const closeModal = () => { setModal(null); setForm(allocDefaults); setSelectedWorkerIds([]); setPositions(''); setWorkerSearch(''); setRepeat(repeatDefaults); };

  // One group per worker with clashes — add mode checks every ticked worker,
  // edit mode just the form's single worker (same shape either way).
  const conflictGroups = useMemo(() => {
    if (!modal) return [];
    const ids = modal === 'add' ? selectedWorkerIds : (form.worker_id ? [form.worker_id] : []);
    return ids
      .map(wid => ({
        workerId: wid,
        name: workers.find(w => w.id === wid)?.name || 'This worker',
        conflicts: findConflicts(allocations, wid, form.start_date, form.end_date, modal === 'add' ? null : modal.id),
      }))
      .filter(gr => gr.conflicts.length > 0);
  }, [allocations, selectedWorkerIds, form.worker_id, form.start_date, form.end_date, modal, workers]);

  // Ticket check — per ticked worker, which required tickets for the chosen
  // role are missing or expired. Empty until a role is chosen.
  const requiredForRole = useMemo(() => requiredTicketsFor(reqTickets, form.role), [reqTickets, form.role]);
  const gapsByWorker = useMemo(() => {
    if (!modal || !requiredForRole.length) return {};
    const ids = modal === 'add' ? selectedWorkerIds : (form.worker_id ? [form.worker_id] : []);
    const m = {};
    ids.forEach(wid => {
      const g = ticketGaps(certs[wid] || [], requiredForRole, today);
      if (g.length) m[wid] = g;
    });
    return m;
  }, [modal, selectedWorkerIds, form.worker_id, requiredForRole, certs, today]);

  const visibleWorkers = useMemo(
    () => workers.filter(w => (w.name || '').toLowerCase().includes(workerSearch.trim().toLowerCase())),
    [workers, workerSearch]
  );

  // Repeat preview — the weekday defaults to the start date's own weekday.
  const effectiveWeekdays = repeat.weekdays.length ? repeat.weekdays : (form.start_date ? [weekdayIndex(form.start_date)] : []);
  const occurrencePreview = useMemo(
    () => (modal === 'add' && repeat.mode === 'weekly' && form.start_date ? seriesDates(form.start_date, repeat.weeks, effectiveWeekdays) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modal, repeat.mode, repeat.weeks, form.start_date, effectiveWeekdays.join(',')],
  );

  // One occurrence → rows. Reuses the single / crew insert paths exactly as
  // before; `extra` carries series_id for repeating allocations.
  const insertOccurrence = async (p, ids) => {
    if (ids.length === 1) {
      const { data: inserted, error } = await supabase.from('allocations').insert([{ ...p, worker_id: ids[0] }]).select().single();
      if (error) { showToast(error.message, 'error'); return null; }
      return [inserted];
    }
    // Crew / open offer: one row per ticked worker, linked by a group that
    // says how many positions there are. Fewer positions than workers =
    // the first to accept get them, the rest see "Position filled".
    const { data: grp, error: gErr } = await supabase.from('allocation_groups').insert([{
      positions: needCount,
      client: p.client || null, site: p.site || null,
      role: p.role || null, start_date: p.start_date,
    }]).select().single();
    if (gErr) { showToast(gErr.message, 'error'); return null; }
    const { data: insertedRows, error } = await supabase.from('allocations')
      .insert(ids.map(wid => ({ ...p, worker_id: wid, group_id: grp.id }))).select();
    if (error) { showToast(error.message, 'error'); return null; }
    return insertedRows || [];
  };

  const handleSave = async () => {
    const ids = modal === 'add' ? selectedWorkerIds : (form.worker_id ? [form.worker_id] : []);
    if (!ids.length) { showToast(modal === 'add' ? 'Please tick at least one worker.' : 'Please select a worker.', 'error'); return; }
    const totalConflicts = conflictGroups.reduce((s, gr) => s + gr.conflicts.length, 0);
    if (totalConflicts > 0) {
      const lines = [];
      conflictGroups.forEach(gr => gr.conflicts.slice(0, 3).forEach(c => lines.push(
        `• ${conflictGroups.length > 1 ? `${gr.name}: ` : ''}${c.client || c.site || 'Allocated'} (${c.start_date}${c.end_date && c.end_date !== c.start_date ? ` → ${c.end_date}` : ''}, ${c.status})`
      )));
      const extra = totalConflicts > lines.length ? `\n…and ${totalConflicts - lines.length} more.` : '';
      const who = conflictGroups.length === 1
        ? `${conflictGroups[0].name} is`
        : `${conflictGroups.length} of these workers are`;
      const ok = window.confirm(
        `⚠ ${who} already allocated during this period:\n\n${lines.join('\n')}${extra}\n\nContinue and create ${ids.length === 1 ? 'a clashing allocation' : 'clashing allocations'} anyway?`
      );
      if (!ok) return;
    }
    // Ticket check — explicit "Allocate anyway" listing every problem.
    const gapEntries = Object.entries(gapsByWorker).map(([wid, gaps]) => ({
      worker: workers.find(w => w.id === wid)?.name || 'Worker', gaps: gaps.map(gapLabel),
    }));
    if (gapEntries.length) {
      const lines = gapEntries.map(e => `• ${e.worker}: ${e.gaps.join(', ')}`);
      const ok = window.confirm(
        `⚠ Ticket check for "${form.role}":\n\n${lines.join('\n')}\n\nAllocate anyway? (this is logged)`
      );
      if (!ok) return;
    }
    setSaving(true);
    const payload = {
      worker_id: form.worker_id,
      role: form.role || null,
      site: form.site, client: form.client, project: form.project,
      // Names stay as the human record of what was typed; the ids are what payroll
      // bills off, so a client that exists once per site can no longer be resolved
      // to the wrong rate card. Resolved here rather than trusted from state so a
      // hand-typed site that happens to match still links up.
      ...(() => {
        const cs = clients.filter(c => c.name === form.client);
        const site = sites.find(s => cs.some(c => c.id === s.client_id) && s.name === form.site) || null;
        const client = site ? cs.find(c => c.id === site.client_id) : (cs.length === 1 ? cs[0] : null);
        return { site_id: site?.id || null, client_id: client?.id || null };
      })(),
      address: form.address,
      site_manager: form.site_supervisor,   // DB column stays site_manager
      manager_phone: form.manager_phone,
      status: form.status,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      // Combine date + time into full timestamp
      // Real UTC instant from the local date+time (naive strings shifted +10h).
      start_time: form.arrival_time && form.start_date
        ? sydneyInstant(form.start_date, form.arrival_time) : null,
      // Finish time removed from allocations (owner: "we don't know when they
      // finish") — actual hours come from the worker's timesheet.
      end_time: null,
      notes: form.notes || null,
      map_link: form.map_link || null,
    };
    if (modal === 'add') {
      // Occurrences: one (today's behaviour) or a weekly series. Each occurrence
      // shifts start/end/arrival by the same delta so a 2-day job stays 2 days.
      const occurrences = occurrencePreview.length ? occurrencePreview : [form.start_date || null];
      const isSeries = occurrences.length > 1;
      const seriesId = isSeries ? newSeriesId() : null;
      const span = form.start_date && form.end_date ? Math.max(0, dayDiff(form.start_date, form.end_date)) : 0;
      const allRows = [];
      for (const occ of occurrences) {
        const p = { ...payload };
        if (isSeries) {
          p.start_date = occ;
          p.end_date = form.end_date ? addDays(occ, span) : null;
          p.start_time = form.arrival_time ? sydneyInstant(occ, form.arrival_time) : null;
          p.series_id = seriesId;
        }
        const rows = await insertOccurrence(p, ids);
        if (!rows) { setSaving(false); if (allRows.length) load(); return; }
        allRows.push(...rows);
      }
      const names = ids.map(id => workers.find(w => w.id === id)?.name || 'Worker');
      const where = payload.client || payload.site || 'a job';
      const need = `${needCount} position${needCount === 1 ? '' : 's'}`;
      // Each worker gets their own SMS + email per occurrence; the admin team
      // gets ONE summary for a crew offer or a whole series.
      const quietAdmin = isSeries || ids.length > 1;
      allRows.forEach(r => notifyOnCreate(r, r.worker_id, { adminQuiet: quietAdmin }));
      if (quietAdmin) {
        const datesTxt = isSeries ? `${occurrences.length} dates (${occurrences[0]} → ${occurrences[occurrences.length - 1]})` : (payload.start_date ? `starts ${payload.start_date}` : '');
        const title = isSeries
          ? `Repeating allocation — ${names.length === 1 ? names[0] : `${names.length} workers`} × ${occurrences.length} dates — ${where}`
          : `Offer sent to ${names.length} workers — ${where}`;
        const body = isSeries
          ? `${payload.role ? `${payload.role} · ` : ''}${datesTxt}${ids.length > 1 ? ` · ${need} per date` : ''}.`
          : `${need}${payload.role ? ` · ${payload.role}` : ''}${payload.start_date ? ` — starts ${payload.start_date}` : ''}. First to accept get it.`;
        addAdminNotification({ type: 'allocation_sent', title, body, allocation_id: allRows[0]?.id || null, worker_id: null })
          .then(() => window.dispatchEvent(new CustomEvent('cbd:notify')));
        broadcastAdminSms(isSeries
          ? `CBD: repeating allocation — ${names.join(', ')} → ${where}, ${datesTxt}${ids.length > 1 ? ` (${need} per date)` : ''}.`
          : `CBD: offer sent to ${names.length} workers for ${where}${payload.start_date ? ` on ${payload.start_date}` : ''} (${need}). First to accept get it.`);
        sendAdminEmail(
          isSeries ? `Admin update — repeating allocation for ${where}` : `Admin update — ${names.length} workers offered ${where}`,
          isSeries
            ? `FYI for the admin team (no action needed): ${names.join(', ')} ${names.length === 1 ? 'has' : 'have'} been allocated to ${where}${payload.role ? ` as ${payload.role}` : ''} on ${datesTxt}${ids.length > 1 ? ` — ${need} per date, first to accept get it` : ''}. Each date has been sent for acceptance by SMS and email.`
            : `FYI for the admin team (no action needed): ${names.join(', ')} were offered ${where}${payload.role ? ` as ${payload.role}` : ''}${payload.start_date ? ` starting ${payload.start_date}` : ''}. ${need} — the first to accept get it; everyone after that sees "Position filled". Each worker has been notified by SMS and email.`
        );
      }
      if (gapEntries.length) {
        logActivity({
          verb: 'allocated despite missing ticket', object_type: 'allocation', object_id: allRows[0]?.id || null,
          client_id: payload.client_id, site_id: payload.site_id,
          after: { role: payload.role, client: payload.client, site: payload.site, start_date: payload.start_date, workers: gapEntries, allocation_ids: allRows.map(r => r.id) },
        });
      }
      showToast(isSeries
        ? `${allRows.length} allocations created — ${occurrences.length} dates${ids.length > 1 ? ` × ${ids.length} workers` : ''}.`
        : needCount < ids.length
        ? `Offer sent to ${ids.length} workers — the first ${needCount} to accept get the job.`
        : ids.length > 1 ? `${allRows.length} allocations created — one per worker` : 'Allocation created successfully', 'success');
      closeModal();
      load();
    } else {
      const { error } = await supabase.from('allocations').update(payload).eq('id', modal.id);
      if (error) showToast(error.message, 'error');
      else {
        if (gapEntries.length) {
          logActivity({
            verb: 'allocated despite missing ticket', object_type: 'allocation', object_id: modal.id,
            client_id: payload.client_id, site_id: payload.site_id,
            after: { role: payload.role, client: payload.client, site: payload.site, start_date: payload.start_date, workers: gapEntries },
          });
        }
        showToast('Allocation updated successfully', 'success'); closeModal(); load();
      }
    }
    setSaving(false);
  };

  // After an allocation is created: text the worker + drop an admin notification.
  // Fire-and-forget — never blocks the UI. `inserted` is the new allocation row;
  // `workerIdArg` pins the subject worker (crew saves call this once per worker).
  const notifyOnCreate = (inserted, workerIdArg, opts = {}) => {
    const wid = workerIdArg || inserted?.worker_id || form.worker_id;
    const worker = workers.find(w => w.id === wid);
    const name = worker?.name || 'Worker';
    const client = inserted?.client || form.client || '';
    const site = inserted?.site || form.site || '';
    const startDate = inserted?.start_date || form.start_date || null;
    const role = inserted?.role || form.role || '';

    // (a) SMS the worker.
    const to = normaliseAUMobile(worker?.mobile);
    if (!to) {
      showToast(`${name} has no mobile on file — SMS skipped.`, 'info');
    } else {
      sendWorkerSms(to, allocationSmsBody({ name, client, site, start_date: startDate, role })).then(r => {
        if (r.ok) showToast(`SMS sent to ${name} (${r.status || 'queued'}).`, 'success');
        else showToast(`SMS to ${name} failed: ${r.error || 'unknown error'}`, 'error');
      });
    }

    // (a2) Email the worker too — belt-and-braces so a stale mobile number can
    // never silently hide an allocation (how zeff's SMS ended up with Nick).
    sendWorkerAllocationEmail(worker, { client, site, role, start_date: startDate }).then(r => {
      if (r.ok) showToast(`Email sent to ${name}.`, 'success');
    });

    logActivity({
      verb: opts.logVerb || 'created', object_type: 'allocation', object_id: inserted?.id || null,
      after: { worker: name, client, site, role, start_date: startDate, ...(inserted?.series_id ? { series_id: inserted.series_id } : {}) },
    });

    // Group offers / series send ONE admin summary from the caller instead.
    if (opts.adminQuiet) return;

    // (b) Admin in-app notification.
    addAdminNotification({
      type: 'allocation_sent',
      title: `Allocation sent to ${name}`,
      body: `${client || site || 'New job'}${role ? ` · ${role}` : ''}${startDate ? ` — starts ${startDate}` : ''}`,
      allocation_id: inserted?.id || null,
      worker_id: wid || null,
    }).then(() => window.dispatchEvent(new CustomEvent('cbd:notify')));

    // (c) Broadcast the same event to every admin by SMS + email.
    //     Fire-and-forget — the worker SMS above is the only worker-facing text.
    const where = client || site || '';
    broadcastAdminSms(adminCreateSmsBody({ worker: name, client: where, start_date: startDate, role }));
    // Clearly an FYI — admins were reading "New allocation: X" personalised
    // with their own name as the allocation being sent to the wrong person.
    sendAdminEmail(
      `Admin update — ${name} allocated to ${where || 'client'}`,
      `FYI for the admin team (no action needed): ${name} has been allocated to ${where || 'a new job'}${role ? ` as ${role}` : ''}${startDate ? ` starting ${startDate}` : ''}. The worker has been notified by SMS and email to accept it in the portal.`
    );
  };

  const handleDelete = async (a) => {
    if (!window.confirm('Delete this allocation?')) return;
    const { error } = await supabase.from('allocations').delete().eq('id', a.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Allocation deleted', 'success'); load(); }
  };

  // ── Repeating series ───────────────────────────────────────────────────────
  // "1 of 6" per row, counted over every row that shares the series_id (sorted
  // by start date, cancelled rows included so the numbering never shifts).
  const seriesStats = useMemo(() => {
    const by = {};
    allocations.forEach(a => { if (a.series_id) (by[a.series_id] = by[a.series_id] || []).push(a); });
    const m = {};
    Object.values(by).forEach(rows => {
      const ordered = [...rows].sort((x, y) => `${x.start_date || ''}${x.worker_id}`.localeCompare(`${y.start_date || ''}${y.worker_id}`));
      const dates = [...new Set(ordered.map(r => r.start_date || ''))];
      ordered.forEach(r => { m[r.id] = { i: dates.indexOf(r.start_date || '') + 1, n: dates.length }; });
    });
    return m;
  }, [allocations]);

  const restOfSeries = (a) => allocations.filter(x =>
    x.series_id && x.series_id === a.series_id && x.status === 'pending' && (x.start_date || '') >= (a.start_date || ''));

  const cancelRestOfSeries = async (a) => {
    const rows = restOfSeries(a);
    if (!rows.length) return;
    if (!window.confirm(`Cancel the rest of this series?\n\n${rows.length} pending allocation${rows.length === 1 ? '' : 's'} from ${a.start_date} onward will be marked cancelled. Accepted ones are left alone.`)) return;
    const { error } = await supabase.from('allocations').update({ status: 'cancelled' }).in('id', rows.map(r => r.id));
    if (error) { showToast(error.message, 'error'); return; }
    logActivity({
      verb: 'cancelled rest of series', object_type: 'allocation', object_id: a.id,
      client_id: a.client_id || null, site_id: a.site_id || null,
      after: { series_id: a.series_id, from: a.start_date, cancelled: rows.length, client: a.client, site: a.site },
    });
    showToast(`${rows.length} allocation${rows.length === 1 ? '' : 's'} cancelled.`, 'success');
    load();
  };

  // ── Swap requests (office side) ───────────────────────────────────────────
  const pendingSwaps = swaps.filter(s => s.status === 'pending');
  const decidedSwaps = swaps.filter(s => s.status !== 'pending').slice(0, 8);
  const workerName = (id) => workers.find(w => w.id === id)?.name || 'Worker';
  const jobLabel = (alloc) => alloc
    ? `${[alloc.client, alloc.site].filter(Boolean).join(' — ') || 'a job'}${alloc.role ? ` (${alloc.role})` : ''}${alloc.start_date ? ` on ${alloc.start_date}` : ''}`
    : 'a job';
  const meName = workers.find(w => w.id === meId)?.name || null;

  const decideSwap = async (r, patch) => {
    const { error } = await supabase.from('shift_swap_requests').update({
      ...patch, decided_by: meId, decided_by_name: meName, decided_at: new Date().toISOString(),
    }).eq('id', r.id).eq('status', 'pending');
    if (error) showToast(error.message, 'error');
    return !error;
  };

  const approveSwap = async (r) => {
    const alloc = allocations.find(a => a.id === r.allocation_id);
    if (!alloc) { showToast('That allocation no longer exists.', 'error'); return; }
    const fromW = workers.find(w => w.id === r.from_worker_id);
    const toW = r.to_worker_id ? workers.find(w => w.id === r.to_worker_id) : null;
    const job = jobLabel(alloc);
    setDeciding(r.id);
    if (toW) {
      if (!window.confirm(`Approve: move ${job} from ${workerName(r.from_worker_id)} to ${toW.name}?\n\n${toW.name} gets an SMS + email to accept it. ${workerName(r.from_worker_id)} is told the swap was approved.`)) { setDeciding(null); return; }
      const { error } = await supabase.from('allocations').update({ worker_id: toW.id, status: 'pending' }).eq('id', alloc.id);
      if (error) { showToast(error.message, 'error'); setDeciding(null); return; }
      if (!(await decideSwap(r, { status: 'approved' }))) { setDeciding(null); return; }
      logActivity({
        verb: 'approved swap', object_type: 'allocation', object_id: alloc.id,
        client_id: alloc.client_id || null, site_id: alloc.site_id || null,
        before: { worker: workerName(r.from_worker_id) },
        after: { worker: toW.name, request_id: r.id, reason: r.reason, client: alloc.client, site: alloc.site, start_date: alloc.start_date },
      });
      notifyOnCreate({ ...alloc, worker_id: toW.id, status: 'pending' }, toW.id, { adminQuiet: true, logVerb: 'reassigned' });
      notifyWorkerSwapDecision(fromW, { approved: true, job, mateName: toW.name });
      showToast(`Swap approved — ${toW.name} has been offered ${alloc.client || alloc.site || 'the job'}.`, 'success');
      setDeciding(null);
      load();
      return;
    }
    if (!window.confirm(`Approve: ${workerName(r.from_worker_id)} is taken off ${job} (allocation cancelled) and Create Allocation opens so you can pick someone else now.`)) { setDeciding(null); return; }
    const { error } = await supabase.from('allocations').update({ status: 'cancelled' }).eq('id', alloc.id);
    if (error) { showToast(error.message, 'error'); setDeciding(null); return; }
    if (!(await decideSwap(r, { status: 'approved' }))) { setDeciding(null); return; }
    logActivity({
      verb: 'approved swap', object_type: 'allocation', object_id: alloc.id,
      client_id: alloc.client_id || null, site_id: alloc.site_id || null,
      before: { worker: workerName(r.from_worker_id), status: alloc.status },
      after: { status: 'cancelled', request_id: r.id, reason: r.reason, client: alloc.client, site: alloc.site, start_date: alloc.start_date, replacement: 'office to pick' },
    });
    notifyWorkerSwapDecision(fromW, { approved: true, job });
    showToast(`Swap approved — pick a replacement for ${alloc.client || alloc.site || 'the job'}.`, 'success');
    setDeciding(null);
    // Create Allocation, prefilled with the job (no worker ticked).
    setForm({
      worker_id: '', role: alloc.role || '', site: alloc.site || '', client: alloc.client || '',
      project: alloc.project || '', address: alloc.address || '',
      site_supervisor: alloc.site_manager || '', manager_phone: alloc.manager_phone || '',
      status: 'pending', start_date: alloc.start_date || '', end_date: alloc.end_date || '',
      arrival_time: alloc.start_time ? sydneyHHMM(alloc.start_time) : '',
      notes: alloc.notes || '', map_link: alloc.map_link || '',
    });
    setSelectedWorkerIds([]); setPositions(''); setWorkerSearch(''); setRepeat(repeatDefaults);
    setModal('add');
    load();
  };

  const declineSwap = async (r) => {
    const alloc = allocations.find(a => a.id === r.allocation_id);
    const note = window.prompt(`Decline ${workerName(r.from_worker_id)}'s swap request for ${jobLabel(alloc)}?\n\nNote for the worker (sent by SMS + email):`, '');
    if (note === null) return;
    setDeciding(r.id);
    if (!(await decideSwap(r, { status: 'declined', decision_note: note.trim() || null }))) { setDeciding(null); return; }
    logActivity({
      verb: 'declined swap', object_type: 'allocation', object_id: r.allocation_id,
      client_id: alloc?.client_id || null, site_id: alloc?.site_id || null,
      after: { worker: workerName(r.from_worker_id), request_id: r.id, reason: r.reason, note: note.trim() || null },
    });
    notifyWorkerSwapDecision(workers.find(w => w.id === r.from_worker_id), { approved: false, job: jobLabel(alloc), note: note.trim() });
    showToast('Swap request declined — the worker has been told.', 'info');
    setDeciding(null);
    load();
  };

  // ── Required tickets editor (admin write, office read) ────────────────────
  const editorRoles = useMemo(() => {
    const extra = [...new Set(reqTickets.map(r => r.role_name).filter(n => n && n !== '*' && !ALL_ROLE_NAMES.includes(n)))].sort();
    return [{ name: '*', label: 'Every role' }, ...ALL_ROLE_NAMES.map(n => ({ name: n, label: n })), ...extra.map(n => ({ name: n, label: `${n} (custom)` }))];
  }, [reqTickets]);

  const addRequiredTicket = async () => {
    const name = (ticketEditor?.newTicket || '').trim();
    if (!name) return;
    const { error } = await supabase.from('role_required_tickets').insert([{ role_name: ticketEditor.role, ticket_name: name }]);
    if (error) { showToast(error.code === '42501' ? 'Only admins can change required tickets.' : error.message, 'error'); return; }
    logActivity({ verb: 'added required ticket', object_type: 'role', after: { role: ticketEditor.role, ticket: name } });
    setTicketEditor(e => ({ ...e, newTicket: '' }));
    const { data } = await supabase.from('role_required_tickets').select('*').is('archived_at', null).order('role_name');
    setReqTickets(data || []);
  };
  const removeRequiredTicket = async (row) => {
    const { error } = await supabase.from('role_required_tickets').update({ archived_at: new Date().toISOString() }).eq('id', row.id);
    if (error) { showToast(error.code === '42501' ? 'Only admins can change required tickets.' : error.message, 'error'); return; }
    logActivity({ verb: 'removed required ticket', object_type: 'role', before: { role: row.role_name, ticket: row.ticket_name } });
    setReqTickets(prev => prev.filter(r => r.id !== row.id));
  };

  const filtered = allocations.filter(a => !filterStatus || a.status === filterStatus);

  // "2 / 3 filled · 8 offered" per multi-worker group.
  const groupStats = useMemo(() => {
    const m = {};
    allocations.forEach(a => {
      if (!a.group_id) return;
      const g = (m[a.group_id] = m[a.group_id] || { total: 0, confirmed: 0, positions: a.allocation_groups?.positions || 1 });
      g.total += 1;
      if (a.status === 'confirmed') g.confirmed += 1;
    });
    return m;
  }, [allocations]);

  const swapCard = (r, pending) => {
    const alloc = allocations.find(a => a.id === r.allocation_id);
    return (
      <div key={r.id} style={{ background: C.bg, border: `1px solid ${pending ? 'rgba(234,179,8,0.4)' : C.border}`, borderRadius: R.md, padding: '10px 12px', display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong style={{ color: C.text, fontSize: 13.5 }}>{workerName(r.from_worker_id)}</strong>
          <span style={{ color: C.textMuted, fontSize: 12.5 }}>can't make {jobLabel(alloc)}</span>
          {!pending && <Badge label={r.status} color={r.status === 'approved' ? 'green' : r.status === 'declined' ? 'red' : 'gray'} size="sm" />}
          <span style={{ marginLeft: 'auto', fontSize: 11, color: C.textDim, whiteSpace: 'nowrap' }}>{fmtDateTime(r.created_at)}</span>
        </div>
        {r.reason && <div style={{ fontSize: 12.5, color: C.text }}>“{r.reason}”</div>}
        <div style={{ fontSize: 12, color: C.textMuted }}>
          Suggests: <strong style={{ color: r.to_worker_id ? C.text : C.textDim }}>{r.to_worker_id ? workerName(r.to_worker_id) : 'nobody — office to pick'}</strong>
          {alloc && <span> · job is <span style={{ textTransform: 'capitalize' }}>{alloc.status}</span></span>}
          {!alloc && <span style={{ color: '#fca5a5' }}> · allocation no longer exists</span>}
          {!pending && r.decided_by_name && <span> · {r.status} by {r.decided_by_name}</span>}
          {!pending && r.decision_note && <span> · “{r.decision_note}”</span>}
        </div>
        {pending && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => approveSwap(r)} disabled={deciding === r.id || !alloc}
              style={{ ...btnPrimary, background: C.success, minHeight: 36, padding: '7px 14px' }}>
              ✓ Approve{r.to_worker_id ? ` → ${workerName(r.to_worker_id)}` : ' + pick someone'}
            </button>
            <button onClick={() => declineSwap(r)} disabled={deciding === r.id}
              style={{ ...btnSecondary, minHeight: 36, padding: '7px 14px', color: '#fca5a5', borderColor: 'rgba(239,68,68,0.32)' }}>
              ✕ Decline…
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      {/* Swap requests — pending ones first, always at the top of the page. */}
      {(pendingSwaps.length > 0 || decidedSwaps.length > 0) && (
        <div data-area="swap requests" style={{ background: C.card, border: `1px solid ${pendingSwaps.length ? 'rgba(234,179,8,0.45)' : C.border}`, borderRadius: R.lg, padding: 14, marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: pendingSwaps.length ? 10 : 0 }}>
            <span style={{ fontWeight: 700, color: C.text }}>🔁 Swap requests</span>
            {pendingSwaps.length > 0
              ? <Badge label={`${pendingSwaps.length} pending`} color="yellow" size="sm" />
              : <span style={{ fontSize: 12, color: C.textDim }}>none pending</span>}
            {decidedSwaps.length > 0 && (
              <button onClick={() => setShowDecided(s => !s)} style={{ ...btnSmall, marginLeft: 'auto', color: C.textMuted }}>
                {showDecided ? 'Hide decided' : `Show decided (${decidedSwaps.length})`}
              </button>
            )}
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            {pendingSwaps.map(r => swapCard(r, true))}
            {showDecided && decidedSwaps.map(r => swapCard(r, false))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <select style={{ ...inputStyle, maxWidth: 200 }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="confirmed">Confirmed</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
          <option value="declined">Declined</option>
          <option value="filled">Position filled</option>
        </select>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setTicketEditor({ role: '*', newTicket: '' })} style={btnSecondary} title="Which tickets each role needs">🪪 Required tickets</button>
          <button onClick={openAdd} style={btnPrimary}>+ Create Allocation</button>
        </div>
      </div>

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div> : filtered.length === 0 ? (
        <EmptyState message="No allocations found." />
      ) : (
        <TableWrap>
          <thead><tr><Th>Worker</Th><Th>Role</Th><Th>Client</Th><Th>Project / Site</Th><Th>Site Supervisor</Th><Th>Start Date</Th><Th>End Date</Th><Th>Status</Th><Th>Actions</Th></tr></thead>
          <tbody>
            {filtered.map(a => (
              <tr key={a.id}>
                <Td>{a.workers?.name || '—'}</Td>
                <Td>
                  {a.role
                    ? <span style={roleChipStyle(a.role)}>{a.role}</span>
                    : a.workers?.job_title
                    ? <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 5, fontSize: 11, fontWeight: 600, background: 'rgba(249,115,22,0.12)', color: '#f97316', fontFamily: '"DM Mono", monospace' }}>{a.workers.job_title}</span>
                    : <span style={{ color: C.textMuted }}>—</span>}
                </Td>
                <Td>{a.client || '—'}</Td>
                <Td>
                  <div>{a.project || a.site || '—'}</div>
                  {a.project && a.site && a.project !== a.site && <div style={{ fontSize: 12, color: C.textMuted }}>{a.site}</div>}
                </Td>
                <Td>
                  <div>{a.site_manager || '—'}</div>
                  {a.manager_phone && <div style={{ fontSize: 12, color: C.textMuted }}>{a.manager_phone}</div>}
                </Td>
                <Td>{a.start_date ? fmtDate(a.start_date) : fmtDateTime(a.start_time)}</Td>
                <Td>{a.end_date ? fmtDate(a.end_date) : '—'}</Td>
                <Td>
                  {allocationBadge(a.status)}
                  {a.group_id && groupStats[a.group_id] && (
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3, whiteSpace: 'nowrap' }}>
                      {groupStats[a.group_id].confirmed} / {groupStats[a.group_id].positions} filled · {groupStats[a.group_id].total} offered
                    </div>
                  )}
                  {a.series_id && seriesStats[a.id] && (
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3, whiteSpace: 'nowrap' }} title="Part of a repeating allocation">
                      🔁 repeats · {seriesStats[a.id].i} of {seriesStats[a.id].n}
                    </div>
                  )}
                </Td>
                <Td>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button onClick={() => openEdit(a)} style={btnSmall}>Edit</button>
                    <button onClick={() => openDuplicate(a)} style={btnSmall}
                      title="Duplicate — same job details, pick a new date">⧉</button>
                    {a.series_id && restOfSeries(a).length > 0 && (
                      <button onClick={() => cancelRestOfSeries(a)} style={{ ...btnSmall, color: '#fca5a5' }}
                        title="Cancel rest of series — every pending date from this one onward">Cancel rest</button>
                    )}
                    <button onClick={() => handleDelete(a)} style={btnDanger}>Delete</button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      {modal && (
        <Modal title={modal === 'add' ? 'Create Allocation' : 'Edit Allocation'} onClose={closeModal} width={560}>
          {conflictGroups.length > 0 && (() => {
            const flat = conflictGroups.flatMap(gr => gr.conflicts.map(c => ({ gr, c })));
            return (
              <div style={{
                background: 'rgba(234,179,8,0.10)',
                border: '1px solid rgba(234,179,8,0.45)',
                borderRadius: 8, padding: '10px 14px', marginBottom: 14,
                fontSize: 12.5, color: '#fde68a',
              }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>
                  ⚠ {conflictGroups.length === 1
                    ? `${conflictGroups[0].name} is already allocated during this date range`
                    : `${conflictGroups.length} of the ticked workers are already allocated during this date range`}
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.55 }}>
                  {flat.slice(0, 4).map(({ gr, c }) => (
                    <li key={`${gr.workerId}-${c.id}`} style={{ fontSize: 12 }}>
                      {conflictGroups.length > 1 && <strong>{gr.name} · </strong>}
                      <strong>{c.client || c.site || 'Allocated'}</strong>
                      {' · '}
                      <span style={{ fontFamily: '"DM Mono", monospace' }}>
                        {c.start_date}{c.end_date && c.end_date !== c.start_date ? ` → ${c.end_date}` : ''}
                      </span>
                      {' · '}
                      <span style={{ textTransform: 'capitalize' }}>{c.status}</span>
                    </li>
                  ))}
                </ul>
                {flat.length > 4 && (
                  <div style={{ marginTop: 4, fontSize: 11, opacity: 0.8 }}>…and {flat.length - 4} more.</div>
                )}
                <div style={{ marginTop: 8, fontSize: 11, color: '#fde68a', opacity: 0.85 }}>
                  You can still save — you'll get a confirm prompt first.
                </div>
              </div>
            );
          })()}
          {Object.keys(gapsByWorker).length > 0 && (
            <div data-area="ticket check" style={{ background: 'rgba(234,179,8,0.10)', border: '1px solid rgba(234,179,8,0.45)', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 12.5, color: '#fde68a' }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>⚠ Ticket check — {form.role}</div>
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.55 }}>
                {Object.entries(gapsByWorker).map(([wid, gaps]) => (
                  <li key={wid} style={{ fontSize: 12 }}>
                    <strong>{workers.find(w => w.id === wid)?.name || 'Worker'}</strong>: {gaps.map(gapLabel).join(', ')}
                  </li>
                ))}
              </ul>
              <div style={{ marginTop: 8, fontSize: 11, opacity: 0.85 }}>
                Needs: {requiredForRole.map(r => r.ticket_name).join(', ')}. You can still save — "Allocate anyway" is asked first and logged.
              </div>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              {modal === 'add' ? (<>
                <Field label={`Workers * (${selectedWorkerIds.length} selected)`}
                  hint="Tick everyone going to this job — one allocation is created per worker.">
                  <>
                    <input style={{ ...inputStyle, marginBottom: 6 }} value={workerSearch}
                      placeholder="Search workers…" onChange={e => setWorkerSearch(e.target.value)} />
                    <div style={{ maxHeight: 170, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 8, padding: '4px 10px', background: C.bg }}>
                      {visibleWorkers.map(w => (
                        <label key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', color: C.text, fontSize: 13, cursor: 'pointer', flexWrap: 'wrap' }}>
                          <input type="checkbox" checked={selectedWorkerIds.includes(w.id)}
                            onChange={() => setSelectedWorkerIds(prev =>
                              prev.includes(w.id) ? prev.filter(x => x !== w.id) : [...prev, w.id])} />
                          {w.name}
                          {gapsByWorker[w.id]?.map(g => <span key={g.ticket} style={warnChip}>⚠ {gapLabel(g)}</span>)}
                        </label>
                      ))}
                      {visibleWorkers.length === 0 && (
                        <div style={{ color: C.textMuted, fontSize: 12, padding: '6px 0' }}>No workers match "{workerSearch}".</div>
                      )}
                    </div>
                  </>
                </Field>
                {selectedWorkerIds.length > 1 && (
                  <Field label="How many do you need?"
                    hint={needCount < selectedWorkerIds.length
                      ? `${selectedWorkerIds.length} people get the offer. The first ${needCount} to tap Accept get the job; everyone after that sees "Position filled".`
                      : 'Everyone ticked is needed (one position each). Lower this number to send an open offer where the first to accept win the spots.'}>
                    <input type="number" min={1} max={selectedWorkerIds.length} step={1}
                      style={{ ...inputStyle, maxWidth: 140 }}
                      value={positions === '' ? selectedWorkerIds.length : positions}
                      onChange={e => setPositions(e.target.value)} />
                  </Field>
                )}
              </>) : (
                <Field label="Worker *">
                  <>
                    <select style={inputStyle} value={form.worker_id} onChange={e => setForm(f => ({ ...f, worker_id: e.target.value }))}>
                      <option value="">Select a worker…</option>
                      {workers.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                    {gapsByWorker[form.worker_id] && (
                      <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {gapsByWorker[form.worker_id].map(g => <span key={g.ticket} style={warnChip}>⚠ {gapLabel(g)}</span>)}
                      </div>
                    )}
                  </>
                </Field>
              )}
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Role to be performed"
                hint={form.role && requiredForRole.length ? `Needs: ${requiredForRole.map(r => r.ticket_name).join(', ')}` : undefined}>
                <select style={inputStyle} value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                  <option value="">Select a role…</option>
                  {ROLE_GROUPS.map(g => (
                    <optgroup key={g.category} label={g.category}>
                      {g.roles.map(r => <option key={r.name} value={r.name}>{r.name}{r.code ? ` (${r.code})` : ''}</option>)}
                    </optgroup>
                  ))}
                </select>
                {form.role && <div style={{ marginTop: 6 }}><span style={roleChipStyle(form.role)}>{form.role}</span></div>}
              </Field>
            </div>
            <Field label="Client">
              {/* Pick-only: free-typed client names produced duplicates and $0
                  billing. New clients are added under Clients & Rates. */}
              <>
                <select style={inputStyle} value={form.client}
                  onChange={e => setForm(f => ({ ...f, client: e.target.value, site: '', address: '', map_link: '' }))}>
                  <option value="">Select a client…</option>
                  {[...new Set(clients.map(c => c.name).filter(Boolean))].map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                  {form.client && !clients.some(c => c.name === form.client) && (
                    <option value={form.client}>{form.client}</option>
                  )}
                </select>
                {clients.filter(c => c.name === form.client).length > 1 && (
                  <div style={{ fontSize: 11, color: C.warning, marginTop: 4 }}>
                    ⚠ {clients.filter(c => c.name === form.client).length} clients share this name (different sites).
                    Check the Site field below — rates can differ between them.
                  </div>
                )}
              </>
            </Field>
            <Field label="Project"><input style={inputStyle} value={form.project} onChange={e => setForm(f => ({ ...f, project: e.target.value }))} /></Field>
            <Field label="Site" hint={(() => {
              const cs = clients.filter(c => c.name === form.client).map(c => c.id);
              const n = sites.filter(s => cs.includes(s.client_id)).length;
              return n ? `${n} site${n === 1 ? '' : 's'} on file for this client` : 'No sites on file yet — add one with + New site below';
            })()}>
              <>
                <select style={inputStyle} value={form.site} disabled={!form.client}
                  onChange={e => {
                    const v = e.target.value;
                    const cs = clients.filter(c => c.name === form.client).map(c => c.id);
                    const hit = sites.find(s => cs.includes(s.client_id) && s.name === v);
                    // Picking a known site fills the supervisor from that site's
                    // approving contact, so the person who signs off the timesheet
                    // is the one who actually runs that job.
                    const contact = hit
                      ? siteContacts.find(k => k.site_id === hit.id && k.is_primary)
                        || siteContacts.find(k => k.site_id === hit.id)
                      : null;
                    setForm(f => ({
                      ...f,
                      site: v,
                      ...(hit?.address && !f.address ? { address: hit.address } : {}),
                      ...(hit?.map_link && !f.map_link ? { map_link: hit.map_link } : {}),
                      ...(contact && !f.site_supervisor ? { site_supervisor: contact.name } : {}),
                      ...(contact?.phone && !f.manager_phone ? { manager_phone: contact.phone } : {}),
                    }));
                  }}>
                  <option value="">{form.client ? 'Select a site…' : 'Pick a client first'}</option>
                  {(() => {
                    const cs = clients.filter(c => c.name === form.client).map(c => c.id);
                    return sites.filter(s => cs.includes(s.client_id))
                      .map(s => <option key={s.id} value={s.name}>{s.name}</option>);
                  })()}
                  {form.site && !sites.some(s => s.name === form.site) && (
                    <option value={form.site}>{form.site}</option>
                  )}
                </select>
                {form.client && (
                  <button type="button" onClick={() => setQuickSite({ name: '', address: '', map_link: '' })}
                    style={{ ...btnSmall, marginTop: 6, padding: '4px 10px', fontSize: 11 }}>
                    + New site for {form.client}
                  </button>
                )}
              </>
            </Field>
            <Field label="Site Address"><input style={inputStyle} value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} /></Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Map link (pin drop)" hint="Paste the Google/Apple Maps link the client texted. The worker gets a tappable Open Map button on their allocation.">
                <div style={{ display: 'flex', gap: 8 }}>
                  <input style={{ ...inputStyle, flex: 1 }} value={form.map_link}
                    onChange={e => setForm(f => ({ ...f, map_link: e.target.value }))}
                    placeholder="https://maps.app.goo.gl/…" />
                  {form.map_link && (
                    <a href={form.map_link} target="_blank" rel="noreferrer"
                      style={{ ...btnSecondary, padding: '9px 14px', textDecoration: 'none', whiteSpace: 'nowrap' }}>
                      📍 Test
                    </a>
                  )}
                </div>
                {form.map_link && !isLikelyMapLink(form.map_link) && (
                  <div style={{ fontSize: 11, color: C.warning, marginTop: 4 }}>
                    ⚠ Doesn't look like a Google/Apple Maps link — it will still save, but tap 📍 Test to check it opens a map.
                  </div>
                )}
              </Field>
            </div>
            <Field label="Site Supervisor"><input style={inputStyle} value={form.site_supervisor} onChange={e => setForm(f => ({ ...f, site_supervisor: e.target.value }))} /></Field>
            <Field label="Supervisor Phone"><input style={inputStyle} value={form.manager_phone} onChange={e => setForm(f => ({ ...f, manager_phone: e.target.value }))} /></Field>
            <Field label="Start Date *"><DateField value={form.start_date} onChange={v => setForm(f => ({ ...f, start_date: v }))} /></Field>
            <Field label="End Date" hint="Leave empty for a single day."><DateField value={form.end_date} onChange={v => setForm(f => ({ ...f, end_date: v }))} /></Field>
            {modal === 'add' && (
              <div style={{ gridColumn: '1 / -1' }} data-area="repeat">
                <Field label="Repeat"
                  hint={repeat.mode === 'weekly'
                    ? (occurrencePreview.length
                        ? `${occurrencePreview.length} allocation${occurrencePreview.length === 1 ? '' : 's'} per worker: ${occurrencePreview.slice(0, 6).join(', ')}${occurrencePreview.length > 6 ? ', …' : ''}`
                        : 'Pick a start date to see the dates.')
                    : 'One allocation only. Choose "Every week" for a roster that repeats.'}>
                  <>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <select style={{ ...inputStyle, width: 'auto', minWidth: 150 }} value={repeat.mode}
                        onChange={e => setRepeat(r => ({ ...r, mode: e.target.value }))}>
                        <option value="none">None</option>
                        <option value="weekly">Every week</option>
                      </select>
                      {repeat.mode === 'weekly' && (
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: C.textMuted }}>
                          for
                          <input type="number" min={2} max={12} step={1} style={{ ...inputStyle, width: 70 }} value={repeat.weeks}
                            onChange={e => setRepeat(r => ({ ...r, weeks: Math.min(12, Math.max(2, parseInt(e.target.value, 10) || 2)) }))} />
                          weeks
                        </label>
                      )}
                    </div>
                    {repeat.mode === 'weekly' && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                        {WEEKDAY_NAMES.map((d, i) => {
                          const on = effectiveWeekdays.includes(i);
                          return (
                            <button type="button" key={d} onClick={() => setRepeat(r => {
                              const cur = effectiveWeekdays;
                              const next = cur.includes(i) ? cur.filter(x => x !== i) : [...cur, i];
                              return { ...r, weekdays: next };
                            })}
                              style={{ ...btnSmall, minHeight: 36, minWidth: 44, fontWeight: 700,
                                background: on ? C.accentSoft : 'transparent', color: on ? C.accent : C.textMuted,
                                borderColor: on ? C.accentBorder : C.border }}>
                              {d}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </>
                </Field>
              </div>
            )}
            <Field label="Status">
              <select style={inputStyle} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                <option value="pending">Pending</option>
                <option value="confirmed">Confirmed</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
                <option value="declined">Declined</option>
                <option value="filled">Position filled</option>
              </select>
            </Field>
            <Field label="Arrival Time">
              <ClockField value={form.arrival_time} onChange={v => setForm(f => ({ ...f, arrival_time: v }))} />
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>Date is taken from Start Date above. No finish time — actual hours come from the timesheet.</div>
            </Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Notes"><textarea style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></Field>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={closeModal} style={btnSecondary}>Cancel</button>
            <button onClick={handleSave} disabled={saving} style={btnPrimary}>
              {saving ? 'Saving…' : occurrencePreview.length > 1 ? `Save ${occurrencePreview.length} dates` : 'Save'}
            </button>
          </div>

          {quickSite && (
            <Modal title={`New site — ${form.client}`} onClose={() => setQuickSite(null)} width={440}>
              <Field label="Site / project name *">
                <input style={inputStyle} value={quickSite.name} autoFocus
                  onChange={e => setQuickSite(q => ({ ...q, name: e.target.value }))}
                  placeholder="e.g. Jordan Springs Stage 4" />
              </Field>
              <Field label="Address">
                <input style={inputStyle} value={quickSite.address}
                  onChange={e => setQuickSite(q => ({ ...q, address: e.target.value }))}
                  placeholder="Street, Suburb" />
              </Field>
              <Field label="Map link (pin drop)">
                <input style={inputStyle} value={quickSite.map_link}
                  onChange={e => setQuickSite(q => ({ ...q, map_link: e.target.value }))}
                  placeholder="https://maps.app.goo.gl/…" />
                {quickSite.map_link && !isLikelyMapLink(quickSite.map_link) && (
                  <div style={{ fontSize: 11, color: C.warning, marginTop: 4 }}>
                    ⚠ Doesn't look like a Google/Apple Maps link — it will still save, but check it opens a map.
                  </div>
                )}
              </Field>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
                <button style={btnSecondary} onClick={() => setQuickSite(null)}>Cancel</button>
                <button style={btnPrimary} onClick={saveQuickSite}>Add site</button>
              </div>
            </Modal>
          )}
        </Modal>
      )}

      {ticketEditor && (
        <Modal title="Required tickets" onClose={() => setTicketEditor(null)} width={520} dismissible>
          <div data-area="required tickets">
            <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
              When a role is picked on Create Allocation, every ticked worker is checked against these tickets
              (name match, case-insensitive; expired = expiry on or before today). "Every role" applies to all roles.
              {!isAdmin && <span style={{ color: '#fde68a' }}> Admins can change this list; you can read it.</span>}
            </div>
            <Field label="Role">
              <select style={inputStyle} value={ticketEditor.role} onChange={e => setTicketEditor(t => ({ ...t, role: e.target.value, newTicket: '' }))}>
                {editorRoles.map(r => <option key={r.name} value={r.name}>{r.label}</option>)}
              </select>
            </Field>
            {ticketEditor.role !== '*' && reqTickets.some(r => r.role_name === '*') && (
              <div style={{ fontSize: 12, color: C.textDim, marginBottom: 8 }}>
                Every role also needs: {reqTickets.filter(r => r.role_name === '*').map(r => r.ticket_name).join(', ')}
              </div>
            )}
            <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
              {reqTickets.filter(r => r.role_name === ticketEditor.role).map(r => (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.md, padding: '8px 10px', fontSize: 13, color: C.text }}>
                  <span style={{ flex: 1 }}>🪪 {r.ticket_name}</span>
                  {isAdmin && <button onClick={() => removeRequiredTicket(r)} style={{ ...btnSmall, color: '#fca5a5', minHeight: 32 }}>Remove</button>}
                </div>
              ))}
              {!reqTickets.some(r => r.role_name === ticketEditor.role) && (
                <div style={{ fontSize: 12.5, color: C.textDim }}>No tickets required for this role{ticketEditor.role === '*' ? '' : ' (beyond the "Every role" list)'}.</div>
              )}
            </div>
            {isAdmin && (
              <div style={{ display: 'flex', gap: 8 }}>
                <input style={{ ...inputStyle, flex: 1 }} value={ticketEditor.newTicket} placeholder="e.g. Excavator ticket"
                  onChange={e => setTicketEditor(t => ({ ...t, newTicket: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') addRequiredTicket(); }} />
                <button onClick={addRequiredTicket} style={{ ...btnPrimary, whiteSpace: 'nowrap' }}>+ Add</button>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
              <button onClick={() => setTicketEditor(null)} style={btnSecondary}>Close</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
