import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnSmall, btnDanger } from '../../theme';
import { todayISO, isTakeFiveDay, sydneyHHMM, sydneyInstant, sydneyTime } from '../../utils/dates';
import {
  dayFromDate, computeLineTotalHours, computeLineRegularHours, autoMealAllowance, SHIFT_TYPES,
  splitDailyHours,
} from '../../utils/payroll';
import { Field } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { SignaturePad } from '../ui/SignaturePad';
import { Take5Form } from '../take5/Take5Form';
import { calcPortalLine } from '../../utils/hoursCalc';
import { logActivity } from '../../utils/activity';
import { addAdminNotification, normaliseAUMobile, sendWorkerSms } from '../../utils/notify';
import { approveTimesheet } from '../../utils/approve';
import { sendTimesheetForClientApproval, markClientApprovedManually } from '../../utils/clientApproval';
import { ROLE_GROUPS, ALL_ROLE_NAMES, roleChipStyle } from '../../constants/roles';
import { checkFatigue, fatigueKey, weekBounds } from '../../utils/fatigue';
import { enqueue, isNetworkError } from '../../utils/offlineQueue';
import { persistTimesheet } from '../../utils/saveTimesheet';
import {
  resizeImage, blobToDataUrl, uploadTimesheetPhotos, listTimesheetPhotos, removeTimesheetPhoto, MAX_PHOTOS,
} from '../../utils/timesheetPhotos';
import { PlantUsedBlock, savePlantHours } from './PlantUsedBlock';
// Draft on the phone (crew feedback via Chris, 2026-10-28: the Take 5 popped up and
// the whole timesheet had to be typed again). Everything typed — hours, tasks, both
// signatures, plant — is kept in localStorage per worker until the sheet is saved.
const draftKey = (wid) => `ts-draft:${wid}`;
function loadDraft(wid) { try { const j = JSON.parse(localStorage.getItem(draftKey(wid)) || 'null'); return j && j.form && j.form.hours_lines ? j : null; } catch { return null; } }
function saveDraft(wid, d) { try { localStorage.setItem(draftKey(wid), JSON.stringify(d)); } catch { /* storage full or blocked: the form still works */ } }
function clearDraft(wid) { try { localStorage.removeItem(draftKey(wid)); } catch { /* ignore */ } }


const BREAK_OPTIONS = [0, 0.5, 0.75, 1];

const emptyHoursLine = () => ({
  date: todayISO(), shift_type: 'Day', start_time: '', end_time: '',
  total_break_hours: 0, total_hours: 0, regular_hours: 0,
  meal_allowance: 0, meal_allowance_override: false,
});

export const blankDaily = () => ({
  id: null,
  client: '', project: '', role: '',
  wet_hire: false, comments: '', client_signature: '', worker_signature: '',
  // 'Did you finish work early?' — null until the worker answers (required).
  finished_early: null, finished_early_reason: '',
  status: 'pending',
  hours_lines: [emptyHoursLine()],
});

// Map a loaded header (+ its timesheet line rows) into editable form state.
export function dailyFromHeader(header, lineRows) {
  return {
    id: header.id,
    client: header.client || '', project: header.project || '', role: header.role || '',
    wet_hire: !!header.wet_hire, comments: header.comments || '',
    finished_early: header.finished_early == null ? null : !!header.finished_early,
    finished_early_reason: header.finished_early_reason || '',
    client_signature: header.client_signature || '',
    worker_signature: header.worker_signature || '',
    status: header.status || 'pending',
    hours_lines: (lineRows || []).map(r => ({
      date: r.date || '',
      shift_type: r.shift_type || 'Day',
      start_time: r.start_time ? sydneyHHMM(r.start_time) : '',
      end_time: r.end_time ? sydneyHHMM(r.end_time) : '',
      total_break_hours: r.total_break_hours ?? 0,
      total_hours: r.total_hours ?? 0,
      regular_hours: r.regular_hours ?? 0,
      meal_allowance: r.meal_allowance ?? 0,
      meal_allowance_override: !!r.meal_allowance_override,
      scenario: r.scenario || 'standard',
      original_start_time: r.original_start_time || null,
      original_end_time: r.original_end_time || null,
      original_break_minutes: r.original_break_minutes ?? null,
      adjusted_by: r.adjusted_by || null,
      adjusted_at: r.adjusted_at || null,
    })).concat((lineRows || []).length ? [] : [emptyHoursLine()]),
  };
}

// Build the {date, start_time, end_time, ...} ISO payload for the RPC.
// meal_allowance is AUTO-computed from hours here for an immediate echo, but the
// DB triggers are authoritative on save (admin overrides are passed through).
//
// Times MUST be converted to real UTC instants via the browser's timezone.
// Sending naive "YYYY-MM-DDTHH:MM" strings made Postgres store them as UTC and
// every display then shifted +10h (7:00 am showed as 5:00 pm — the "portal
// changed my hours" bug). An end time at/before the start means the shift ran
// past midnight, so the end rolls to the next day.
function lineInstant(date, time, rollAfter = null) {
  if (!date || !time) return '';
  // Sydney wall-clock regardless of the browser's own timezone — an overseas
  // admin editing a sheet must never shift the crew's hours.
  let iso = sydneyInstant(date, time);
  if (!iso) return '';
  if (rollAfter && new Date(iso) <= rollAfter) iso = new Date(new Date(iso).getTime() + 24 * 3600 * 1000).toISOString();
  return iso;
}

function buildLinesPayload(form, config) {
  return form.hours_lines
    .filter(l => l.date)
    .map(l => {
      const startISO = lineInstant(l.date, l.start_time);
      const endISO = lineInstant(l.date, l.end_time, startISO ? new Date(startISO) : null);
      return ({
      date: l.date,
      shift_type: l.shift_type,
      scenario: l.scenario || 'standard',
      start_time: startISO,
      end_time: endISO,
      total_break_hours: parseFloat(l.total_break_hours) || 0,
      total_hours: parseFloat(l.total_hours) || 0,
      regular_hours: parseFloat(l.regular_hours) || 0,
      meal_allowance: l.meal_allowance_override
        ? (parseFloat(l.meal_allowance) || 0)
        : autoMealAllowance(l.total_hours, config),
      meal_allowance_override: !!l.meal_allowance_override,
      });
    });
}

// Shared Daily Timesheet form. `workerId` is the subject worker.
// `allowAdmin` shows the status selector + worker picker for admin editing.
// `allowReview` (manager Edit/Approve) adds Approve / Reject actions in the
// footer so approval only happens after opening + reviewing the timesheet.
// `onGoToTake5` lets the worker jump to the Take 5 tab when one is required.
export function DailyTimesheetForm({
  initial, workerId, onSaved, onCancel, showToast, allowAdmin = false,
  allowReview = false, onGoToTake5,
  workers = [], onWorkerChange,
}) {
  const draftRef = useRef(!allowAdmin && !initial && workerId ? loadDraft(workerId) : null);
  const [form, setForm] = useState(() => initial || draftRef.current?.form || blankDaily());
  const [plantUsed, setPlantUsed] = useState(draftRef.current?.plantUsed || []);   // [{ plant_id, hours, notes }] — saved to plant_hours after the header
  const [clients, setClients] = useState([]);
  const [roles, setRoles] = useState([]);
  const [projects, setProjects] = useState([]);
  const [config, setConfig] = useState({});
  const [saving, setSaving] = useState(false);
  const [taskError, setTaskError] = useState('');
  const [take5Block, setTake5Block] = useState(null);   // { dates:[…] } when a Tue/Thu Take 5 is missing
  const [take5Modal, setTake5Modal] = useState(false);  // "Do it now" — Take 5 inside the timesheet flow
  const [workerType, setWorkerType] = useState(null);   // drives the ordinary/RDO/OT split display
  const [prefillNote, setPrefillNote] = useState(null); // 'allocation' when today's allocation seeded the form
  const [copying, setCopying] = useState(false);
  // On-site client signature (worker flow only): signer name + company captured
  // beside the pad — the drawn PNG itself lives in form.client_signature.
  // `touched` = drawn THIS session; a signature loaded from an old sheet must
  // not re-trigger the approve-on-the-spot flow (it was recorded back then).
  const [sig, setSig] = useState(draftRef.current?.sig || { name: '', company: '', email: '', touched: false });
  // Fatigue context from the DB: when the worker's last saved shift ended and
  // how many hours are already saved for this Mon–Sun week (other sheets).
  const [fatigueCtx, setFatigueCtx] = useState({ previousEndMs: null, otherWeekHours: 0 });
  const [fatigueConfirmed, setFatigueConfirmed] = useState(!!draftRef.current?.fatigueConfirmed);
  // Photos: new ones wait in memory until the header id exists (post-save);
  // saved ones come back from timesheet_photos with signed URLs.
  const [photos, setPhotos] = useState([]);
  const [savedPhotos, setSavedPhotos] = useState([]);
  const [photoBusy, setPhotoBusy] = useState(false);

  useEffect(() => { setForm(initial || draftRef.current?.form || blankDaily()); }, [initial]);

  // Keep the draft fresh while the worker types; drop it once the sheet is saved.
  const [restored, setRestored] = useState(!!draftRef.current);
  const [padEpoch, setPadEpoch] = useState(0);   // remounts the signature pads on Start fresh
  const draftDone = useRef(false);
  useEffect(() => {
    if (allowAdmin || initial || !workerId || draftDone.current) return undefined;
    const t = setTimeout(() => saveDraft(workerId, { form, sig, plantUsed, fatigueConfirmed, at: Date.now() }), 400);
    return () => clearTimeout(t);
  }, [form, sig, plantUsed, fatigueConfirmed, allowAdmin, initial, workerId]);
  const startFresh = () => {
    clearDraft(workerId); draftRef.current = null; setRestored(false);
    setForm(blankDaily()); setSig({ name: '', company: '', email: '', touched: false }); setPlantUsed([]); setFatigueConfirmed(false);
    setPadEpoch(e => e + 1);
  };
  // Tue/Thu: ask for the Take 5 the moment the sheet opens, not after it is filled in.
  useEffect(() => {
    if (allowAdmin || initial || !workerId) return;
    const today = todayISO();
    if (!isTakeFiveDay(today)) return;
    supabase.from('take5').select('id').eq('worker_id', workerId).eq('work_date', today).limit(1)
      .then(({ data, error }) => { if (!error && data && data.length === 0) setTake5Block({ dates: [today], early: true }); });
  }, [allowAdmin, initial, workerId]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const [c, r, j, s, cfg] = await Promise.all([
        supabase.from('clients').select('id, name, award_profile').order('name'),
        supabase.from('job_roles').select('name').is('archived_at', null).order('name'),
        supabase.from('client_jobs').select('name, client_id').order('name'),
        supabase.from('client_sites').select('id, name, client_id, is_active').order('name'),
        // v_payroll_config hides the client charge-rate defaults from workers.
        supabase.from('v_payroll_config').select('config_key, config_value'),
      ]);
      if (!mounted) return;
      if (c.data) setClients(c.data);
      if (r.data) setRoles(r.data.map(x => x.name).filter(Boolean));
      // Client and Project are PICK-ONLY on this form: the office maintains the
      // libraries (Clients & Rates → Sites), and a misspelt client can no longer
      // reach review. Sites are offered per selected client.
      setProjects([
        ...((s.data || []).filter(x => x.is_active !== false).map(x => ({ name: x.name, client_id: x.client_id, site_id: x.id }))),
        ...((j.data || []).map(x => ({ name: x.name, client_id: x.client_id, site_id: null }))),
      ].filter(x => x.name));
      if (cfg.data) {
        const map = {};
        cfg.data.forEach(row => { map[row.config_key] = row.config_value; });
        setConfig(map);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Which hour rules apply is the CLIENT's setting (owner, 2026-09-27):
  // A/B/C = the Dashpivot formulas clients signed ~4,700 timesheets on;
  // PORTAL = the legacy 7.6h + RDO model. The server recomputes the same split
  // at save time (split_shift_hours_v2), so this is a live preview, not truth.
  const clientProfile = (clients.find(c => c.name === form.client)?.award_profile || 'PORTAL').toUpperCase();

  // Recompute Day + Total + Regular + auto Meal Allowance for a single hours line.
  // `profileOverride` covers the one case where the client just changed in the
  // same state update (Copy last shift) and the closure profile is stale.
  const recalcLine = useCallback((line, profileOverride) => {
    let total = computeLineTotalHours(line.start_time, line.end_time, line.total_break_hours);
    let regular = computeLineRegularHours(total, config);
    const dp = calcPortalLine(line, profileOverride || clientProfile);
    if (dp) {
      // Dashpivot rounds to 0.25h — store the same total the split is built on.
      total = dp.total;
      regular = dp.regular;
    }
    const meal = line.meal_allowance_override
      ? (parseFloat(line.meal_allowance) || 0)
      : autoMealAllowance(total, config);
    return {
      ...line,
      day: dayFromDate(line.date),
      total_hours: total,
      regular_hours: regular,
      meal_allowance: meal,
    };
  }, [config, clientProfile]);

  // Per-line split for display: Dashpivot buckets when the client is on A/B/C,
  // else the legacy portal split. `blocked` = day shift starting at/after 5pm.
  const lineSplit = useCallback((l) => {
    const dp = calcPortalLine(l, clientProfile);
    if (dp) {
      return {
        regular: dp.regular, rdo: 0, overtime: dp.ot15 + dp.ot20,
        ot15: dp.ot15, ot20: dp.ot20,
        blocked: l.start_time && l.end_time && dp.total === 0 && dp.warnings.length > 0,
      };
    }
    const sp = splitDailyHours(l.total_hours, workerType, l.date, config);
    return { regular: l.regular_hours, rdo: sp.rdo, overtime: sp.overtime, ot15: null, ot20: null, blocked: false };
  }, [clientProfile, workerType, config]);

  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const setHoursLine = (idx, updates) => setForm(f => {
    const lines = f.hours_lines.map((l, i) => i === idx ? recalcLine({ ...l, ...updates }) : l);
    return { ...f, hours_lines: lines };
  });
  const addHoursLine = () => setForm(f => ({ ...f, hours_lines: [...f.hours_lines, emptyHoursLine()] }));
  const removeHoursLine = (idx) => setForm(f => ({
    ...f, hours_lines: f.hours_lines.length > 1 ? f.hours_lines.filter((_, i) => i !== idx) : f.hours_lines,
  }));

  const totals = useMemo(() => {
    const totalHours = form.hours_lines.reduce((s, l) => s + (parseFloat(l.total_hours) || 0), 0);
    const totalReg = form.hours_lines.reduce((s, l) => s + (parseFloat(l.regular_hours) || 0), 0);
    let totalRdo = 0, totalOt = 0;
    form.hours_lines.forEach(l => {
      const sp = lineSplit(l);
      totalRdo += sp.rdo; totalOt += sp.overtime;
    });
    const totalMeal = form.hours_lines.reduce((s, l) => {
      const meal = l.meal_allowance_override
        ? (parseFloat(l.meal_allowance) || 0)
        : autoMealAllowance(l.total_hours, config);
      return s + meal;
    }, 0);
    return { totalHours, totalReg, totalRdo, totalOt, totalMeal };
  }, [form, config, lineSplit]);

  const targetWorker = workerId || form.worker_id;

  useEffect(() => {
    let mounted = true;
    if (!targetWorker) { setWorkerType(null); return undefined; }
    supabase.from('workers').select('worker_type').eq('id', targetWorker).maybeSingle()
      .then(({ data }) => { if (mounted) setWorkerType(data?.worker_type || null); });
    return () => { mounted = false; };
  }, [targetWorker]);

  // NEW worker sheet: seed Client / Project / Role from the allocation covering
  // today (start_date <= today <= end_date-or-start_date, still live). The
  // functional-updater blank check makes the async fetch safe: anything the
  // worker typed before it lands is never overwritten.
  useEffect(() => {
    if (allowAdmin || initial?.id || !targetWorker) return undefined;
    let mounted = true;
    (async () => {
      const today = todayISO();
      const { data: allocs } = await supabase.from('allocations')
        .select('client, site, project, role, start_date, end_date, status')
        .eq('worker_id', targetWorker)
        .in('status', ['pending', 'confirmed'])
        .lte('start_date', today)
        .order('start_date', { ascending: false })
        .limit(10);
      const hit = (allocs || []).find(a => a.start_date && (a.end_date || a.start_date) >= today);
      if (!mounted || !hit || !(hit.client || hit.site || hit.role)) return;
      setForm(f => {
        if (f.client || f.project || f.role) return f;
        setPrefillNote('allocation');
        return { ...f, client: hit.client || '', project: hit.site || hit.project || '', role: hit.role || '' };
      });
    })();
    return () => { mounted = false; };
  }, [allowAdmin, initial, targetWorker]);

  // ---- Fatigue (owner brief 2026-10-19) --------------------------------------
  // Earliest shift on the sheet drives the two DB lookups: the worker's last
  // line ending before it (rest gap) and the other lines in its Mon–Sun week.
  const firstShift = useMemo(() => {
    const ls = form.hours_lines.filter(l => l.date && l.start_time)
      .map(l => ({ date: l.date, start: l.start_time }))
      .sort((a, b) => `${a.date}T${a.start}`.localeCompare(`${b.date}T${b.start}`));
    return ls[0] || null;
  }, [form.hours_lines]);
  const firstKey = firstShift ? `${firstShift.date}|${firstShift.start}` : '';

  useEffect(() => {
    let mounted = true;
    if (!targetWorker || !firstShift) { setFatigueCtx({ previousEndMs: null, otherWeekHours: 0 }); return undefined; }
    (async () => {
      const startISO = sydneyInstant(firstShift.date, firstShift.start);
      const wk = weekBounds(firstShift.date);
      const own = form.id || null;
      const [p, w] = await Promise.all([
        supabase.from('timesheets').select('end_time, header_id').eq('worker_id', targetWorker)
          .not('end_time', 'is', null).lt('start_time', startISO).order('end_time', { ascending: false }).limit(5),
        wk ? supabase.from('timesheets').select('total_hours, hours, header_id').eq('worker_id', targetWorker)
          .gte('date', wk.from).lte('date', wk.to) : Promise.resolve({ data: [] }),
      ]);
      if (!mounted) return;
      const prev = (p.data || []).find(r => !own || r.header_id !== own);
      const other = (w.data || []).filter(r => !own || r.header_id !== own)
        .reduce((s, r) => s + (parseFloat(r.total_hours ?? r.hours) || 0), 0);
      setFatigueCtx({ previousEndMs: prev?.end_time ? Date.parse(prev.end_time) : null, otherWeekHours: +other.toFixed(2) });
    })();
    return () => { mounted = false; };
    // firstShift is derived from firstKey; re-query only when the worker, the
    // earliest shift or the header id changes — not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetWorker, firstKey, form.id]);

  const fatigue = useMemo(() => checkFatigue({
    lines: form.hours_lines,
    previousEndMs: fatigueCtx.previousEndMs,
    otherWeekHours: fatigueCtx.otherWeekHours,
    // Sydney-pinned instants so a stored UTC end_time compares with typed times.
    toInstant: (d, t) => { const iso = sydneyInstant(d, t); return iso ? Date.parse(iso) : NaN; },
  }), [form.hours_lines, fatigueCtx]);
  const fKey = fatigueKey(fatigue.breaches);
  // A changed breach set needs a fresh tick.
  useEffect(() => { setFatigueConfirmed(false); }, [fKey]);

  // ---- Photos ----------------------------------------------------------------
  useEffect(() => {
    let mounted = true;
    if (!form.id) { setSavedPhotos([]); return undefined; }
    listTimesheetPhotos(form.id).then(rows => { if (mounted) setSavedPhotos(rows); });
    return () => { mounted = false; };
  }, [form.id]);

  const photoCount = photos.length + savedPhotos.length;
  const addPhotos = async (fileList) => {
    const files = Array.from(fileList || []).filter(f => f.type && f.type.startsWith('image/'));
    if (!files.length) return;
    const room = MAX_PHOTOS - photoCount;
    if (room <= 0) { showToast(`Up to ${MAX_PHOTOS} photos per timesheet.`, 'error'); return; }
    setPhotoBusy(true);
    try {
      const next = [];
      for (const f of files.slice(0, room)) {
        try {
          const blob = await resizeImage(f);
          next.push({ key: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, blob, preview: URL.createObjectURL(blob), caption: '' });
        } catch (e) {
          showToast(`Could not add ${f.name}: ${e.message}`, 'error');
        }
      }
      setPhotos(p => [...p, ...next]);
      if (files.length > room) showToast(`Only ${room} more photo${room === 1 ? '' : 's'} fit — max ${MAX_PHOTOS} per timesheet.`, 'info');
    } finally {
      setPhotoBusy(false);
    }
  };
  const removePhoto = (key) => setPhotos(p => {
    const hit = p.find(x => x.key === key);
    if (hit) { try { URL.revokeObjectURL(hit.preview); } catch { /* already gone */ } }
    return p.filter(x => x.key !== key);
  });
  const removeSavedPhoto = async (row) => {
    if (!window.confirm('Remove this photo from the timesheet?')) return;
    const r = await removeTimesheetPhoto(row);
    if (!r.ok) { showToast(r.error, 'error'); return; }
    setSavedPhotos(s => s.filter(x => x.id !== row.id));
  };

  // Network failure on a worker submit: park the exact save payload on the
  // phone. Photos ride along as data URLs when they fit the quota.
  const queueForLater = async (payload, followUp) => {
    const firstDate = payload.rpcArgs.p_lines?.[0]?.date || todayISO();
    const label = [form.client || 'Timesheet', form.project, firstDate].filter(Boolean).join(' · ');
    let photoData = [];
    try {
      photoData = await Promise.all(photos.map(async p => ({ dataUrl: await blobToDataUrl(p.blob), caption: p.caption || '' })));
    } catch { photoData = []; }
    const r = enqueue({ label, payload, photos: photoData, followUp });
    if (!r.ok) return false;
    showToast('Saved on your phone — it will send when you are back online.', 'info');
    if (r.droppedPhotos) showToast('The photos could not be kept offline. Add them again from My Timesheets once it has sent.', 'error');
    photos.forEach(p => { try { URL.revokeObjectURL(p.preview); } catch { /* already gone */ } });
    setPhotos([]);
    draftDone.current = true; clearDraft(workerId);
    onSaved?.(null);
    return true;
  };

  // "Copy last shift": client, project, role, shift type, start, end, break
  // from the most recent header + its first line. NEVER the date, comments or
  // signatures (they belong to the old day).
  const copyLastShift = async () => {
    if (!targetWorker || copying) return;
    setCopying(true);
    try {
      const { data: hs } = await supabase.from('timesheet_headers')
        .select('id, client, project, role')
        .eq('worker_id', targetWorker)
        .order('created_at', { ascending: false }).limit(1);
      const h = hs?.[0];
      if (!h) { showToast('No previous timesheet to copy from yet.', 'info'); return; }
      const { data: ls } = await supabase.from('timesheets')
        .select('shift_type, start_time, end_time, total_break_hours')
        .eq('header_id', h.id).order('date').limit(1);
      const line = ls?.[0];
      const prof = (clients.find(c => c.name === h.client)?.award_profile || 'PORTAL').toUpperCase();
      setForm(f => ({
        ...f,
        client: h.client || '', project: h.project || '', role: h.role || '',
        hours_lines: f.hours_lines.map((l, i) => i === 0 ? recalcLine({
          ...l,
          shift_type: line?.shift_type || l.shift_type,
          start_time: line?.start_time ? sydneyHHMM(line.start_time) : l.start_time,
          end_time: line?.end_time ? sydneyHHMM(line.end_time) : l.end_time,
          total_break_hours: line?.total_break_hours ?? l.total_break_hours,
        }, prof) : l),
      }));
      showToast('Copied your last shift — check the times, then submit.', 'success');
    } finally {
      setCopying(false);
    }
  };

  // Resolve the picked names to master-data ids (Dashpivot 1.1). Same shape as
  // AllocationsPage: the site pins the client when several clients share a name.
  const resolveMasterIds = () => {
    const cs = clients.filter(c => c.name === form.client);
    const site = projects.find(p => p.site_id && p.name === form.project && cs.some(c => c.id === p.client_id)) || null;
    const client = site ? cs.find(c => c.id === site.client_id) : (cs.length === 1 ? cs[0] : null);
    return { clientId: client?.id || null, siteId: site?.site_id || null };
  };

  // Master role list is the primary source; keep any library roles (job_roles)
  // or a pre-existing legacy value so nothing already saved gets dropped.
  const extraRoles = useMemo(() => {
    const known = new Set(ALL_ROLE_NAMES);
    const extra = new Set();
    roles.forEach(r => { if (r && !known.has(r)) extra.add(r); });
    if (form.role && !known.has(form.role)) extra.add(form.role);
    return [...extra];
  }, [roles, form.role]);

  // A value already saved on the sheet stays selectable even if it has since
  // left the library, so old timesheets still open and save unchanged.
  const clientNames = useMemo(() => {
    const seen = new Set(clients.map(c => c.name).filter(Boolean));
    if (form.client) seen.add(form.client);
    return [...seen].sort();
  }, [clients, form.client]);

  const projectOptions = useMemo(() => {
    const ids = new Set(clients.filter(c => c.name === form.client).map(c => c.id));
    const names = new Set(projects.filter(p => !p.client_id || ids.has(p.client_id)).map(p => p.name));
    if (form.project) names.add(form.project);
    return [...names].sort();
  }, [clients, projects, form.client, form.project]);

  // Phone layout: the wide hours table forced sideways scrolling and the crew
  // kept missing the End/Break cells. Under 640px each hours line renders as a
  // stacked card — Start, End and Break sit directly under the Date.
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const onChange = (e) => setNarrow(e.matches);
    if (mq.addEventListener) mq.addEventListener('change', onChange); else mq.addListener(onChange);
    return () => { if (mq.removeEventListener) mq.removeEventListener('change', onChange); else mq.removeListener(onChange); };
  }, []);

  // A rejection must reach the worker, not just flip a status they never look
  // at: bell row + SMS carrying the reason so they can fix and resubmit the
  // same day. Safe columns only — pay_rate_* is column-locked on workers.
  const notifyWorkerRejected = async (reason) => {
    try {
      const { data: w } = await supabase.from('workers').select('name, mobile').eq('id', targetWorker).maybeSingle();
      const workerName = w?.name || 'Worker';
      addAdminNotification({
        type: 'timesheet_rejected',
        title: `${workerName}: timesheet rejected`,
        body: reason || null,
        worker_id: targetWorker,
      });
      const to = normaliseAUMobile(w?.mobile);
      if (to) {
        sendWorkerSms(to, `Your timesheet for ${form.client || 'your client'} was rejected${reason ? `: ${reason}` : ''}. Please fix and resubmit in the portal.`);
      }
    } catch { /* fire-and-forget — never blocks the reject itself */ }
  };

  // statusOverride (from the manager Approve/Reject buttons) forces the saved
  // status; otherwise the form's own status is used. `rejectReason` rides along
  // only on the reject path and lands on timesheet_headers.rejection_reason.
  // Double-tap guard (audit P1): the real save below awaits a Take 5 query
  // before it flips `saving`, so two quick taps on Submit used to create two
  // identical timesheets. The lock is taken synchronously, before any await.
  const saveLock = useRef(false);
  const handleSave = async (statusOverride, rejectReason) => {
    if (saveLock.current) return;
    saveLock.current = true;
    try { await handleSaveInner(statusOverride, rejectReason); }
    finally { saveLock.current = false; }
  };

  const handleSaveInner = async (statusOverride, rejectReason) => {
    const overriding = statusOverride === 'approved' || statusOverride === 'rejected';
    if (!targetWorker) { showToast('No worker selected for this timesheet.', 'error'); return; }
    if (!form.client) { showToast('Client is required.', 'error'); return; }
    if (!form.project) { showToast('Project is required.', 'error'); return; }
    if (!form.role) { showToast('Role is required.', 'error'); return; }
    // Owner (2026-10-19): the early-finish question must be answered before a
    // sheet can go in; a Yes needs a short reason ("Rained off", "Sick"…).
    if (form.finished_early !== true && form.finished_early !== false) { showToast('Please answer "Did you finish work early?" (Yes or No).', 'error'); return; }
    if (form.finished_early === true && !String(form.finished_early_reason || '').trim()) { showToast('Please give a short reason for finishing early (e.g. Rained off, Sick, Sent home).', 'error'); return; }
    const validLines = form.hours_lines.filter(l => l.date && l.start_time && l.end_time);
    if (!validLines.length) { showToast('Add at least one hours line with date, start and end.', 'error'); return; }

    // AM/PM mix-up guard: a "22-hour shift" is almost always 7:00pm typed
    // instead of 7:00am. Block submission until the times are corrected.
    const suspicious = validLines.map(recalcLine).filter(l => (parseFloat(l.total_hours) || 0) > 16);
    if (suspicious.length) {
      showToast(`Check the start/finish times on ${suspicious.map(l => `${l.date} (${Number(l.total_hours).toFixed(2)}h)`).join(', ')} — more than 16 hours in one shift usually means an AM/PM mix-up. Fix the times, then submit.`, 'error');
      return;
    }

    // Dashpivot rule (A/B/C clients): a Day shift can't start at or after
    // 5:00 pm — the signed formulas return 0 hours for it. Block the save.
    if (clientProfile !== 'PORTAL') {
      const lateDay = validLines.filter(l => l.shift_type !== 'Night'
        && (l.scenario || 'standard') === 'standard'
        && parseInt(l.start_time.split(':')[0], 10) >= 17);
      if (lateDay.length) {
        showToast(`${lateDay.map(l => l.date).join(', ')}: a Day shift can't start at or after 5:00 pm — change the Shift Type to Night.`, 'error');
        return;
      }
    }

    // On-site client signature (worker flow): drawn signature needs the
    // signer's name, or the approval note would say nobody signed.
    const signedOnSite = !allowAdmin && sig.touched && String(form.client_signature || '').startsWith('data:image');
    if (signedOnSite && !String(sig.name).trim()) {
      showToast("Add the supervisor's name next to their signature — or clear the signature to use the text-a-link flow.", 'error');
      return;
    }
    if (signedOnSite && String(sig.email).trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(sig.email).trim())) {
      showToast("That supervisor email doesn't look right.", 'error');
      return;
    }
    // The worker signs their own sheet (Zeff, 2026-10-26: client AND worker signature on the docket).
    if (!allowAdmin && !String(form.worker_signature || '').startsWith('data:image')) {
      showToast('Sign your timesheet in the "Your signature" box before submitting.', 'error');
      return;
    }

    // "Tasks Completed" is mandatory for a worker submitting their own sheet.
    // Managers editing/approving legacy sheets aren't hard-blocked on it.
    if (!allowAdmin && !String(form.comments || '').trim()) {
      setTaskError('Please describe the tasks you completed today.');
      showToast('Tasks Completed is required.', 'error');
      return;
    }

    // Take 5 gate: on Tue/Thu (AEST) a worker must have a Take 5 for that same
    // work date before their timesheet can be submitted. Managers are exempt.
    if (!allowAdmin) {
      const t5Dates = [...new Set(validLines.map(l => l.date))].filter(isTakeFiveDay);
      if (t5Dates.length) {
        const { data: t5rows, error: t5err } = await supabase.from('take5')
          .select('work_date').eq('worker_id', targetWorker).in('work_date', t5Dates);
        // No signal: the check cannot be made, so it must not block — the sheet
        // is parked on the phone by the offline queue below, like any other.
        const t5Unknown = (typeof navigator !== 'undefined' && navigator.onLine === false)
          || (t5err && isNetworkError(t5err));
        const have = new Set((t5rows || []).map(r => r.work_date));
        const missing = t5Unknown ? [] : t5Dates.filter(d => !have.has(d));
        if (missing.length) {
          setTake5Block({ dates: missing });
          showToast('A Take 5 is required on Tue/Thu before submitting your timesheet.', 'error');
          return;
        }
      }
      setTake5Block(null);
    }

    // Fatigue check: never a hard block — the office decides — but the person
    // submitting must tick that the hours are right when a limit is breached.
    if (fatigue.breaches.length && !fatigueConfirmed) {
      showToast('Fatigue check: tick "I confirm these hours are correct" under the totals before submitting.', 'error');
      return;
    }

    const approving = statusOverride === 'approved';
    // Office approval happens AFTER the save, via the approve-timesheet edge
    // function (server recomputes the split, locks, emails the PDF). Saving
    // 'approved' directly bypassed the drift check and the lock (review #5).
    const statusToUse = overriding ? (approving ? 'pending' : 'rejected') : (form.status || 'pending');
    const recalced = validLines.map(recalcLine);
    // Meal allowance is auto-derived from each day's hours (DB triggers are
    // authoritative; this payload keeps the header allowance_lines in sync).
    const allowancePayload = recalced
      .filter(l => l.date && (parseFloat(l.meal_allowance) || 0) > 0)
      .map(l => ({ date: l.date, meal_allowance: parseFloat(l.meal_allowance) || 0 }));

    setSaving(true);
    // One payload for the live save AND the offline replay (saveTimesheet.js):
    // the RPC args plus the post-save patch — master-data ids + name snapshots
    // (Dashpivot 1.1), the early-finish answer and the fatigue flags. The
    // patch is AWAITED inside persistTimesheet: the approval paths below can
    // lock the header, and these columns are not in the lock's allowed set.
    const { clientId, siteId } = resolveMasterIds();
    const payload = {
      rpcArgs: {
        p_header_id: form.id || null,
        p_worker_id: targetWorker,
        p_client: form.client,
        p_project: form.project,
        p_role: form.role,
        p_wet_hire: !!form.wet_hire,
        p_comments: form.comments || null,
        p_client_signature: form.client_signature || null,
        p_allowance_lines: allowancePayload,
        p_status: statusToUse,
        p_lines: buildLinesPayload({ ...form, hours_lines: recalced }, config),
      },
      headerPatch: {
        client_id: clientId, site_id: siteId,
        finished_early: form.finished_early === true,
        finished_early_reason: form.finished_early === true ? String(form.finished_early_reason || '').trim().slice(0, 40) : null,
        client_name_snapshot: form.client || null,
        site_name_snapshot: form.project || null,
        role_name_snapshot: form.role || null,
        fatigue_flags: fatigue.breaches.length ? fatigue.breaches : null,
        worker_signature: String(form.worker_signature || '').startsWith('data:image') ? form.worker_signature : null,
        client_signer_email: signedOnSite ? (String(sig.email || '').trim().toLowerCase() || null) : null,
        client_signer_company: signedOnSite ? (String(sig.company || '').trim() || null) : null,
        signed_on_site_at: signedOnSite ? new Date().toISOString() : null,
      },
      linePatch: { client_id: clientId, site_id: siteId },
    };
    const signedWho = signedOnSite
      ? `${sig.name.trim()}${String(sig.company).trim() ? ` (${String(sig.company).trim()})` : ''} — signed on site`
      : null;

    const saved = await persistTimesheet(payload);
    if (!saved.ok) {
      setSaving(false);
      // No signal: a worker's own submission is parked on the phone and sent
      // later through the same path. Office edits/approvals are never queued.
      if (!allowAdmin && !overriding && (saved.network || isNetworkError(saved.error))) {
        const queued = await queueForLater(payload, { signedOnSite, who: signedWho, supervisor: true });
        if (queued) return;
      }
      showToast(saved.error?.message || String(saved.error), 'error');
      return;
    }
    saved.warnings.forEach(w => showToast(`Timesheet saved, but the ${w}`, 'error'));
    const data = saved.data;
    // A fatigue breach the worker confirmed must reach the office NOW, not sit as
    // a badge until someone opens the list. Server builds the text; fire-and-forget.
    const savedHeaderId = saved.headerId;
    if (fatigue.breaches.length && !allowAdmin && savedHeaderId) {
      supabase.functions.invoke('notify-admins-ops', { body: { kind: 'fatigue_flagged', id: savedHeaderId } }).catch(() => {});
    }

    // Reject keeps the direct status write (nothing locks on reject). The
    // reason is stored on the header and pushed to the worker (bell + SMS).
    if (overriding && !approving) {
      if (savedHeaderId) {
        await supabase.from('timesheet_headers').update({ status: 'rejected', rejection_reason: rejectReason || null }).eq('id', savedHeaderId);
        await supabase.from('timesheets').update({ status: 'rejected' }).eq('header_id', savedHeaderId);
      }
      notifyWorkerRejected(rejectReason);
    }

    // Photos need the header id, so they upload after the save. A failed
    // upload never fails the timesheet — the hours are already in.
    let photosUploaded = 0;
    if (savedHeaderId && photos.length) {
      const up = await uploadTimesheetPhotos({ workerId: targetWorker, headerId: savedHeaderId, photos });
      photosUploaded = up.uploaded.length;
      if (up.errors.length) showToast(`${up.errors.length} photo${up.errors.length === 1 ? '' : 's'} failed to upload — open the timesheet and add ${up.errors.length === 1 ? 'it' : 'them'} again.`, 'error');
      photos.forEach(p => { try { URL.revokeObjectURL(p.preview); } catch { /* already gone */ } });
      setPhotos([]);
      if (up.uploaded.length) setSavedPhotos(s => [...s, ...up.uploaded.map(r => ({ ...r, url: null }))]);
    }

    // Plant used → plant_hours, BEFORE any approve path locks the header.
    if (savedHeaderId && (plantUsed.length || form.id)) {
      const pr = await savePlantHours(savedHeaderId, plantUsed);
      if (!pr.ok) showToast(`Timesheet saved, but the plant lines failed: ${pr.error}`, 'error');
    }

    let approveFailed = null;
    if (approving && savedHeaderId) {
      // One approve path for every admin surface (review #5): the server
      // recomputes the split, refuses drift, locks and emails the PDF.
      const r = await approveTimesheet(savedHeaderId);
      if (!r.ok) approveFailed = r.error;
    }

    setSaving(false);
    const msg = overriding
      ? (approving
          ? (approveFailed ? `Saved, but NOT approved: ${approveFailed}` : 'Timesheet approved, locked and the client PDF is on its way.')
          : 'Timesheet rejected')
      : (form.id ? 'Daily timesheet updated' : 'Daily timesheet submitted');
    showToast(msg, approveFailed ? 'error' : (statusOverride === 'rejected' ? 'info' : 'success'));
    logActivity({
      verb: overriding ? (approving ? (approveFailed ? 'edited' : 'approved') : 'rejected') : (form.id ? 'edited' : 'submitted'),
      object_type: 'timesheet_header', object_id: savedHeaderId,
      after: {
        client: form.client, project: form.project, total_hours: totals.totalHours,
        fatigue_flags: fatigue.breaches.length || 0, photos_added: photosUploaded,
      },
    });

    // Autonomous sign-off: a submission goes to the site supervisor UNLESS a
    // client signature was captured on the phone (approves on the spot), and
    // not on reject / office-approve (the office path already emailed the PDF).
    if (statusOverride !== 'rejected' && !approving) {
      if (savedHeaderId && signedOnSite) {
        const who = signedWho;
        markClientApprovedManually(savedHeaderId, who).then(r => {
          if (r.ok) showToast('Client signed on site — timesheet approved and the PDF copy is on its way.', 'success');
          else showToast(`Signed on site, but approval could not be recorded: ${r.error}`, 'error');
        });
      } else if (savedHeaderId) {
        sendTimesheetForClientApproval(savedHeaderId).then(r => {
          if (r.ok) showToast(`Sent to the site supervisor for sign-off — ${r.sentTo}`, 'success');
          else if (!r.alreadySent && allowAdmin) showToast(`Supervisor sign-off link NOT sent: ${r.error}`, 'error');
        });
      }
    }
    draftDone.current = true; clearDraft(workerId);
    onSaved?.(data);
  };

  const cellInput = { ...inputStyle, padding: '6px 8px', fontSize: 13 };
  const roInput = { ...cellInput, background: C.cardHover, color: C.textMuted };

  return (
    <div>
      {restored && (
        <div data-area="draft restored" style={{ background: C.cardHover, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px', margin: '0 0 12px', fontSize: 12, color: C.textMuted, display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span>↩ We kept what you typed last time. Check it and press Submit.</span>
          <button type="button" onClick={startFresh} style={{ ...btnSecondary, padding: '4px 10px', fontSize: 11 }}>Start fresh</button>
        </div>
      )}
      {/* Header */}
      {allowAdmin && (
        <Field label="Worker *">
          <select style={inputStyle} value={targetWorker || ''} onChange={e => onWorkerChange?.(e.target.value)}>
            <option value="">Select a worker…</option>
            {workers.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </Field>
      )}
      {!allowAdmin && !form.id && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
          <button type="button" onClick={copyLastShift} disabled={copying} style={{ ...btnSmall, opacity: copying ? 0.6 : 1 }}
            title="Pre-fills client, project, role, shift type, start, end and break from your most recent timesheet. Never copies the date, comments or signatures.">
            {copying ? 'Copying…' : '⧉ Copy last shift'}
          </button>
        </div>
      )}
      {prefillNote === 'allocation' && (
        <div style={{ fontSize: 12, color: C.textMuted, margin: '0 0 8px' }}>
          📌 Pre-filled from your allocation — change it if you worked elsewhere.
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 12px' }}>
        <Field label="Client *">
          <select style={inputStyle} value={form.client}
            onChange={e => {
              const v = e.target.value;
              // Hour rules follow the client — recompute every line under the
              // new profile so the preview matches what the server will store.
              const prof = (clients.find(c => c.name === v)?.award_profile || 'PORTAL').toUpperCase();
              setForm(f => ({ ...f, client: v, project: '', hours_lines: f.hours_lines.map(l => recalcLine(l, prof)) }));
            }}>
            <option value="">Select…</option>
            {clientNames.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Project / site *">
          <select style={inputStyle} value={form.project} disabled={!form.client}
            onChange={e => setField('project', e.target.value)}>
            <option value="">{form.client ? 'Select…' : 'Pick a client first'}</option>
            {projectOptions.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          {form.client && projectOptions.length === 0 && (
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
              No sites on file for this client yet — ask the office to add it.
            </div>
          )}
        </Field>
        <Field label="Role performed *">
          <select style={inputStyle} value={form.role} onChange={e => setField('role', e.target.value)}>
            <option value="">Select…</option>
            {ROLE_GROUPS.map(g => (
              <optgroup key={g.category} label={g.category}>
                {g.roles.map(r => <option key={r.name} value={r.name}>{r.name}{r.code ? ` (${r.code})` : ''}</option>)}
              </optgroup>
            ))}
            {extraRoles.length > 0 && (
              <optgroup label="Other (library)">
                {extraRoles.map(r => <option key={r} value={r}>{r}</option>)}
              </optgroup>
            )}
          </select>
          {form.role
            ? <div style={{ marginTop: 6 }}><span style={roleChipStyle(form.role)}>{form.role}</span></div>
            : <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Pick the role you actually performed — change it if it differed from your allocation.</div>}
        </Field>
      </div>

      {/* Did you finish work early? — asked BEFORE the hours (owner, 2026-10-19). */}
      <Field label="Did you finish work early? *" hint={form.finished_early === true ? 'A few words is enough.' : 'Answer before entering your hours.'}><div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }} data-area="finished early question">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: C.text, fontSize: 14, cursor: 'pointer', minHeight: 36 }}>
            <input type="radio" name="finishedearly" checked={form.finished_early === false} onChange={() => setForm(f => ({ ...f, finished_early: false, finished_early_reason: '' }))} /> No
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: C.text, fontSize: 14, cursor: 'pointer', minHeight: 36 }}>
            <input type="radio" name="finishedearly" checked={form.finished_early === true} onChange={() => setField('finished_early', true)} /> Yes
          </label>
        </div>
        {form.finished_early === true && (
          <input
            style={{ ...inputStyle, marginTop: 8, maxWidth: 360 }}
            value={form.finished_early_reason}
            maxLength={40}
            placeholder="Reason — e.g. Rained off, Sick, Sent home"
            onChange={e => setField('finished_early_reason', e.target.value.slice(0, 40))}
            autoFocus
          />
        )}
      </Field>

      {/* Hours worked */}
      <div style={{ fontSize: 13, fontWeight: 700, color: C.text, margin: '8px 0 8px' }}>Hours worked</div>
      {/* One wrapping row per shift at EVERY width — the old desktop table
          forced sideways scrolling inside the modal (owner: "in-line instead
          of scroll"). Inputs wrap naturally; computed hours sit underneath. */}
      <div style={{ display: 'grid', gap: 10 }}>
        {form.hours_lines.map((l, i) => {
          const autoMeal = autoMealAllowance(l.total_hours, config);
          const mealVal = l.meal_allowance_override ? (parseFloat(l.meal_allowance) || 0) : autoMeal;
          const split = lineSplit(l);
          const breakOpts = BREAK_OPTIONS.includes(parseFloat(l.total_break_hours) || 0)
            ? BREAK_OPTIONS
            : [...BREAK_OPTIONS, parseFloat(l.total_break_hours) || 0].sort((a, b) => a - b);
          const smallLabel = { fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 };
          return (
            <div key={i} style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', background: C.card }}>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div>
                  <div style={smallLabel}>Date · {dayFromDate(l.date) || '—'}</div>
                  {/* max=today: a shift can't be logged before it happens. */}
                  <input type="date" max={todayISO()} style={{ ...cellInput, width: 130 }} value={l.date}
                    onChange={e => setHoursLine(i, { date: e.target.value > todayISO() ? todayISO() : e.target.value })} />
                </div>
                <div>
                  <div style={smallLabel}>Shift type</div>
                  {/* "Training" is a scenario, not a real shift type — it maps to
                      scenario=training_day (FT paid, casual unpaid, never billed). */}
                  <select style={{ ...cellInput, width: 120 }}
                    value={l.scenario === 'training_day' ? 'Training' : l.shift_type}
                    onChange={e => setHoursLine(i, e.target.value === 'Training'
                      ? { shift_type: 'Day', scenario: 'training_day' }
                      : { shift_type: e.target.value, ...(l.scenario === 'training_day' ? { scenario: 'standard' } : {}) })}>
                    {(clientProfile !== 'PORTAL' ? ['Day', 'Night', 'Public Holiday'] : SHIFT_TYPES).map(s => <option key={s} value={s}>{s}</option>)}
                    <option value="Training">Training</option>
                  </select>
                </div>
                <div>
                  <div style={smallLabel}>Start *</div>
                  <input type="time" step={900} style={{ ...cellInput, width: 100 }} value={l.start_time}
                    onChange={e => setHoursLine(i, { start_time: e.target.value })} />
                </div>
                <div>
                  <div style={smallLabel}>End *</div>
                  <input type="time" step={900} style={{ ...cellInput, width: 100 }} value={l.end_time}
                    onChange={e => setHoursLine(i, { end_time: e.target.value })} />
                </div>
                <div>
                  <div style={smallLabel}>Break</div>
                  <select style={{ ...cellInput, width: 92 }} value={String(parseFloat(l.total_break_hours) || 0)}
                    onChange={e => setHoursLine(i, { total_break_hours: parseFloat(e.target.value) })}>
                    {breakOpts.map(b => <option key={b} value={String(b)}>{b === 0 ? 'No break' : `${b} hr`}</option>)}
                  </select>
                </div>
                {allowAdmin && (
                  <div>
                    <div style={smallLabel}>Meal ($)</div>
                    {l.meal_allowance_override
                      ? <input type="number" step="0.01" min="0" style={{ ...cellInput, width: 80 }} value={l.meal_allowance}
                          onChange={e => setHoursLine(i, { meal_allowance: e.target.value })} title="Admin override amount" />
                      : <input readOnly style={{ ...roInput, width: 80 }} value={mealVal.toFixed(2)} />}
                    <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: C.textMuted, marginTop: 2, cursor: 'pointer' }} title="Admin override of the auto meal allowance">
                      <input type="checkbox" checked={!!l.meal_allowance_override}
                        onChange={e => setHoursLine(i, { meal_allowance_override: e.target.checked, ...(e.target.checked ? {} : { meal_allowance: autoMeal }) })} />
                      override
                    </label>
                  </div>
                )}
                {form.hours_lines.length > 1 && (
                  <button type="button" onClick={() => removeHoursLine(i)} style={{ ...btnDanger, padding: '4px 9px', marginLeft: 'auto' }}>×</button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 12, color: C.textMuted, flexWrap: 'wrap' }}>
                <span>Total <strong style={{ color: C.text }}>{Number(l.total_hours).toFixed(2)}h</strong></span>
                <span>Normal {Number(l.regular_hours).toFixed(2)}h</span>
                {split.rdo > 0 && <span style={{ color: C.success }} title="Banked to the RDO accrual (full-time weekday shifts)">RDO {split.rdo.toFixed(2)}h</span>}
                {split.overtime > 0 && <span style={{ color: C.warning }}>OT {split.overtime.toFixed(2)}h</span>}
                {!allowAdmin && mealVal > 0 && <span>Meal ${mealVal.toFixed(2)}</span>}
              </div>
            </div>
          );
        })}
      </div>
      <button type="button" onClick={addHoursLine} style={{ ...btnSmall, marginTop: 8 }}>+ Add hours row</button>

      {form.hours_lines.some(l => l.scenario === 'training_day') && (
        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>
          🎓 Training: paid for full-time staff, unpaid for casuals — the client is never billed for it.
        </div>
      )}

      {/* Night-shift suggestion — suggest only, never auto-switch (owner call) */}
      {form.hours_lines.some(l => l.start_time && parseInt(l.start_time.split(':')[0], 10) >= 14 && l.shift_type === 'Day') && (
        <div style={{ background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.3)', borderRadius: 8, padding: '8px 12px', marginTop: 8 }}>
          {form.hours_lines.map((l, i) => (
            l.start_time && parseInt(l.start_time.split(':')[0], 10) >= 14 && l.shift_type === 'Day' ? (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12, color: C.textMuted }}>
                <span>🌙 {l.date || `Row ${i + 1}`} starts at {l.start_time} — shifts starting 2:00 pm or later are usually night shift.</span>
                <button type="button" onClick={() => setHoursLine(i, { shift_type: 'Night' })}
                  style={{ ...btnSmall, padding: '3px 10px', fontSize: 11, color: '#93c5fd', borderColor: '#1e3a5f' }}>
                  Mark as Night
                </button>
              </div>
            ) : null
          ))}
        </div>
      )}
      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>
        Meal allowance is calculated automatically: a day of {parseFloat(config.meal_allowance_trigger ?? 9.5)}h or more
        earns ${parseFloat(config.meal_allowance_amount ?? 18.70).toFixed(2)}.
        {allowAdmin ? ' Tick “override” on a row to set it manually.' : ''}
      </div>

      {/* Totals preview */}
      <div style={{ background: C.accentSoft, border: `1px solid ${C.accentBorder}`, borderRadius: 8, padding: '10px 16px', margin: '16px 0', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div><div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>Total Hours</div><div style={{ fontSize: 20, fontWeight: 800, color: C.accent }}>{totals.totalHours.toFixed(2)}</div></div>
        <div><div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>Normal Hours</div><div style={{ fontSize: 20, fontWeight: 800, color: C.text }}>{totals.totalReg.toFixed(2)}</div></div>
        <div><div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>RDO Accrued</div><div style={{ fontSize: 20, fontWeight: 800, color: totals.totalRdo > 0 ? C.success : C.textMuted }}>{totals.totalRdo.toFixed(2)}</div></div>
        <div><div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>Overtime</div><div style={{ fontSize: 20, fontWeight: 800, color: totals.totalOt > 0 ? C.warning : C.textMuted }}>{totals.totalOt.toFixed(2)}</div></div>
        <div><div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>Meal Allowance</div><div style={{ fontSize: 20, fontWeight: 800, color: C.text }}>${totals.totalMeal.toFixed(2)}</div></div>
      </div>

      {/* Fatigue check — amber, never a hard block. Lists every breach; the
          tick is required before Submit and resets when the breaches change. */}
      {fatigue.breaches.length > 0 && (
        <div data-area="fatigue check" style={{ background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.45)', borderRadius: 8, padding: '10px 14px', marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fbbf24' }}>⚠ Fatigue check</div>
          <ul style={{ margin: '6px 0 6px', paddingLeft: 18, fontSize: 12, color: C.text, lineHeight: 1.5 }}>
            {fatigue.breaches.map(b => <li key={`${b.type}|${b.date}`}>{b.text}</li>)}
          </ul>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6 }}>
            Week so far: {fatigue.weekHours.toFixed(2)}h. You can still submit — the office will review it.
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.text, cursor: 'pointer', minHeight: 36 }}>
            <input type="checkbox" checked={fatigueConfirmed} onChange={e => setFatigueConfirmed(e.target.checked)} style={{ width: 18, height: 18 }} />
            I confirm these hours are correct
          </label>
        </div>
      )}

      {/* Adjustment audit trail — original submitted times always stay on record */}
      {form.hours_lines.some(l => l.adjusted_at) && (
        <div style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.warning, marginBottom: 4 }}>✎ Hours were adjusted after submission</div>
          {form.hours_lines.filter(l => l.adjusted_at).map((l, i) => (
            <div key={i} style={{ fontSize: 12, color: C.textMuted }}>
              {l.date}: originally submitted {sydneyTime(l.original_start_time)} – {sydneyTime(l.original_end_time)} · adjusted by {l.adjusted_by || 'admin'}
            </div>
          ))}
        </div>
      )}

      {/* Wet hire + comments */}
      <Field label="Was there any Wet Hire?">
        <div style={{ display: 'flex', gap: 18 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: C.text, fontSize: 14, cursor: 'pointer' }}>
            <input type="radio" name="wethire" checked={form.wet_hire === true} onChange={() => setField('wet_hire', true)} /> Yes
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: C.text, fontSize: 14, cursor: 'pointer' }}>
            <input type="radio" name="wethire" checked={form.wet_hire === false} onChange={() => setField('wet_hire', false)} /> No
          </label>
        </div>
      </Field>
      <PlantUsedBlock headerId={form.id} value={plantUsed} onChange={setPlantUsed} />
      <Field label="Tasks Completed *" hint="Briefly describe the tasks you completed today." error={taskError}>
        <textarea
          style={{ ...inputStyle, minHeight: 70, resize: 'vertical', ...(taskError ? { borderColor: 'rgba(239,68,68,0.5)' } : {}) }}
          value={form.comments}
          placeholder="Briefly describe the tasks you completed today"
          onChange={e => { setField('comments', e.target.value); if (taskError) setTaskError(''); }}
        />
      </Field>

      {/* Photos — dockets / plant hour meters. Resized on the phone to ≤1600px,
          uploaded after the save (needs the header id). Never on the client PDF. */}
      <div data-area="timesheet photos" style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px', margin: '4px 0 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>📷 Photos (optional)</div>
          <div style={{ fontSize: 12, color: C.textMuted, flex: 1, minWidth: 160 }}>Dockets, plant hour meters — up to {MAX_PHOTOS}. Not sent to the client.</div>
          <label style={{ ...btnSmall, minHeight: 36, display: 'inline-flex', alignItems: 'center', cursor: photoBusy || photoCount >= MAX_PHOTOS ? 'default' : 'pointer', opacity: photoBusy || photoCount >= MAX_PHOTOS ? 0.5 : 1 }}>
            {photoBusy ? 'Adding…' : '📷 Add photo'}
            <input type="file" accept="image/*" capture="environment" multiple style={{ display: 'none' }}
              disabled={photoBusy || photoCount >= MAX_PHOTOS}
              onChange={e => { addPhotos(e.target.files); e.target.value = ''; }} />
          </label>
        </div>
        {photoCount > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            {savedPhotos.map(p => (
              <div key={p.id} style={{ position: 'relative', width: 76, height: 76, borderRadius: 8, overflow: 'hidden', border: `1px solid ${C.border}`, background: C.card }}>
                {p.url
                  ? <a href={p.url} target="_blank" rel="noopener noreferrer"><img src={p.url} alt={p.caption || 'Docket'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /></a>
                  : <span style={{ fontSize: 10, color: C.textMuted, padding: 6, display: 'block' }}>Saved ✓</span>}
                <button type="button" onClick={() => removeSavedPhoto(p)} title="Remove photo"
                  style={{ position: 'absolute', top: 2, right: 2, width: 22, height: 22, borderRadius: 11, border: 'none', background: 'rgba(0,0,0,0.65)', color: '#fff', cursor: 'pointer', fontSize: 13, lineHeight: '22px', padding: 0 }}>×</button>
              </div>
            ))}
            {photos.map(p => (
              <div key={p.key} style={{ position: 'relative', width: 76, height: 76, borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(96,165,250,0.5)', background: C.card }}>
                <img src={p.preview} alt="Docket (new)" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                <button type="button" onClick={() => removePhoto(p.key)} title="Remove photo"
                  style={{ position: 'absolute', top: 2, right: 2, width: 22, height: 22, borderRadius: 11, border: 'none', background: 'rgba(0,0,0,0.65)', color: '#fff', cursor: 'pointer', fontSize: 13, lineHeight: '22px', padding: 0 }}>×</button>
              </div>
            ))}
          </div>
        )}
        {photos.length > 0 && (
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>
            {photos.length} new photo{photos.length === 1 ? '' : 's'} will upload when you press {form.id ? 'Save changes' : 'Submit'}.
          </div>
        )}
      </div>

      {allowAdmin && (
        <Field label="Status">
          <select style={inputStyle} value={form.status} onChange={e => setField('status', e.target.value)}>
            <option value="pending">Pending</option>
            {/* Approval only through the Approve button (server locks + emails the PDF). */}
            {form.status === 'approved' && <option value="approved">Approved (locked)</option>}
            <option value="rejected">Rejected</option>
          </select>
        </Field>
      )}

      {/* X4 — client signs on the worker's phone. Optional: signed = approved on
          the spot (markClientApprovedManually) and the supervisor link is
          skipped; left blank = the usual text-a-link flow, unchanged. */}
      {!allowAdmin && (
        <div data-area="worker signature" style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px', margin: '4px 0 12px' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>✍️ Your signature *</div>
          <div style={{ fontSize: 12, color: C.textMuted, margin: '2px 0 10px' }}>Sign with your finger. It goes on the docket next to the supervisor's signature.</div>
          <SignaturePad key={`w${padEpoch}`}
            value={String(form.worker_signature || '').startsWith('data:image') ? form.worker_signature : ''}
            onChange={v => setField('worker_signature', v)}
            height={120}
          />
        </div>
      )}

      {!allowAdmin && (
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px', margin: '4px 0 12px' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>✍️ Supervisor signature (optional)</div>
          <div style={{ fontSize: 12, color: C.textMuted, margin: '2px 0 10px' }}>
            Supervisor with you? Get them to sign now, with their name and email: the sheet is approved on the spot and they get the PDF. Otherwise we text them a link.
          </div>
          <SignaturePad key={`c${padEpoch}`}
            value={String(form.client_signature || '').startsWith('data:image') ? form.client_signature : ''}
            onChange={v => { setField('client_signature', v); setSig(s => ({ ...s, touched: !!v })); }}
            height={130}
          />
          {sig.touched && String(form.client_signature || '').startsWith('data:image') && (
            <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : '1fr 1fr', gap: '0 12px', marginTop: 8 }}>
              <Field label="Supervisor name *">
                <input style={inputStyle} value={sig.name}
                  onChange={e => setSig(s => ({ ...s, name: e.target.value }))}
                  placeholder="Who signed" />
              </Field>
              <Field label="Company">
                <input style={inputStyle} value={sig.company}
                  onChange={e => setSig(s => ({ ...s, company: e.target.value }))}
                  placeholder="e.g. MLC Civil" />
              </Field>
              <Field label="Supervisor email" hint="They get the signed PDF straight away.">
                <input style={inputStyle} type="email" inputMode="email" autoCapitalize="off" value={sig.email}
                  onChange={e => setSig(s => ({ ...s, email: e.target.value }))}
                  placeholder="name@client.com.au" />
              </Field>
            </div>
          )}
        </div>
      )}

      {take5Block && (
        <div style={{ background: C.warningSoft, border: `1px solid ${C.warning}`, borderRadius: 8, padding: '12px 16px', margin: '4px 0 12px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ color: C.text, fontSize: 13, flex: 1, minWidth: 220 }}>
            <strong>{take5Block.early ? '✋ Today is a Take 5 day.' : '⚠ A Take 5 is required on Tue/Thu before submitting your timesheet.'}</strong>
            <div style={{ color: C.textMuted, fontSize: 12, marginTop: 3 }}>
              {take5Block.early
                ? 'Do it now (about a minute), then fill in your hours. Nothing you type is lost.'
                : `Missing for: ${take5Block.dates.join(', ')}. Press Do it now — when the Take 5 is in, this timesheet submits by itself. Nothing you typed is lost.`}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => setTake5Modal(true)} style={{ ...btnPrimary, background: C.warning, color: '#1a1a1a' }}>
              ✋ Do it now
            </button>
            {onGoToTake5 && (
              <button type="button" onClick={() => onGoToTake5()} style={btnSecondary}>
                Go to Take 5 →
              </button>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={onCancel} style={btnSecondary}>Cancel</button>
        <button type="button" onClick={() => handleSave()} disabled={saving} style={allowReview ? btnSecondary : btnPrimary}>
          {saving ? 'Saving…' : form.id ? 'Save changes' : 'Submit'}
        </button>
        {allowReview && (
          <>
            <button type="button" disabled={saving}
              onClick={() => {
                // The reason is worker-facing: it lands in their notification
                // + SMS, so cancel here means no reject at all.
                const reason = window.prompt('Why is this timesheet being rejected? The worker will see this.');
                if (reason === null) return;
                handleSave('rejected', reason.trim());
              }}
              style={{ ...btnSecondary, color: '#fca5a5', borderColor: 'rgba(239,68,68,0.32)' }}>
              ✗ Reject
            </button>
            <button type="button" onClick={() => handleSave('approved')} disabled={saving}
              style={{ ...btnPrimary, background: C.success }}>
              ✓ Approve
            </button>
          </>
        )}
      </div>

      {/* Take 5 without leaving the timesheet: submitting it clears the gate,
          the modal closes, and the half-filled sheet is untouched — the worker
          just presses Submit again. Prefilled with the blocked date + job. */}
      {take5Modal && (
        <Modal title="✋ Take 5 — pre-start safety check" onClose={() => setTake5Modal(false)} width={640}>
          <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 12 }}>
            Complete this Take 5. Your timesheet keeps everything you typed{take5Block?.early ? '' : ' and submits by itself when the Take 5 is in'}.
          </div>
          <Take5Form
            workerId={targetWorker}
            showToast={showToast}
            prefill={{
              work_date: take5Block?.dates?.[0] || todayISO(),
              site: [form.client, form.project].filter(Boolean).join(' — '),
            }}
            onSubmitted={() => {
              const wasEarly = !!take5Block?.early;
              setTake5Modal(false); setTake5Block(null);
              // "submit, submit": the Take 5 is in, so the sheet goes in on its own.
              if (!wasEarly) setTimeout(() => handleSave(), 150);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
