import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnSmall, btnDanger } from '../../theme';
import { todayISO, isTakeFiveDay, sydneyHHMM, sydneyInstant } from '../../utils/dates';
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

const BREAK_OPTIONS = [0, 0.5, 0.75, 1];

const emptyHoursLine = () => ({
  date: todayISO(), shift_type: 'Day', start_time: '', end_time: '',
  total_break_hours: 0, total_hours: 0, regular_hours: 0,
  meal_allowance: 0, meal_allowance_override: false,
});

export const blankDaily = () => ({
  id: null,
  client: '', project: '', role: '',
  wet_hire: false, comments: '', client_signature: '',
  status: 'pending',
  hours_lines: [emptyHoursLine()],
});

// Map a loaded header (+ its timesheet line rows) into editable form state.
export function dailyFromHeader(header, lineRows) {
  return {
    id: header.id,
    client: header.client || '', project: header.project || '', role: header.role || '',
    wet_hire: !!header.wet_hire, comments: header.comments || '',
    client_signature: header.client_signature || '',
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
  const [form, setForm] = useState(initial || blankDaily());
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
  const [sig, setSig] = useState({ name: '', company: '', touched: false });

  useEffect(() => { setForm(initial || blankDaily()); }, [initial]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const [c, r, j, s, cfg] = await Promise.all([
        supabase.from('clients').select('id, name, award_profile').order('name'),
        supabase.from('job_roles').select('name').order('name'),
        supabase.from('client_jobs').select('name, client_id').order('name'),
        supabase.from('client_sites').select('id, name, client_id, is_active').order('name'),
        supabase.from('payroll_config').select('config_key, config_value'),
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
  const handleSave = async (statusOverride, rejectReason) => {
    const overriding = statusOverride === 'approved' || statusOverride === 'rejected';
    if (!targetWorker) { showToast('No worker selected for this timesheet.', 'error'); return; }
    if (!form.client) { showToast('Client is required.', 'error'); return; }
    if (!form.project) { showToast('Project is required.', 'error'); return; }
    if (!form.role) { showToast('Role is required.', 'error'); return; }
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
        const { data: t5rows } = await supabase.from('take5')
          .select('work_date').eq('worker_id', targetWorker).in('work_date', t5Dates);
        const have = new Set((t5rows || []).map(r => r.work_date));
        const missing = t5Dates.filter(d => !have.has(d));
        if (missing.length) {
          setTake5Block({ dates: missing });
          showToast('A Take 5 is required on Tue/Thu before submitting your timesheet.', 'error');
          return;
        }
      }
      setTake5Block(null);
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
    const { data, error } = await supabase.rpc('save_daily_timesheet', {
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
    });
    if (error) { setSaving(false); showToast(error.message, 'error'); return; }

    // Reject keeps the direct status write (nothing locks on reject). The
    // reason is stored on the header and pushed to the worker (bell + SMS).
    if (overriding && !approving) {
      const rejectId = form.id || data;
      if (rejectId) {
        await supabase.from('timesheet_headers').update({ status: 'rejected', rejection_reason: rejectReason || null }).eq('id', rejectId);
        await supabase.from('timesheets').update({ status: 'rejected' }).eq('header_id', rejectId);
      }
      notifyWorkerRejected(rejectReason);
    }

    const savedHeaderId = form.id || data;

    // Master-data ids + name snapshots (Dashpivot 1.1) — stamped right after
    // the RPC and AWAITED: the approval paths below can lock the header, and
    // these columns are not in the lock's allowed set (review #10 race).
    if (savedHeaderId) {
      const { clientId, siteId } = resolveMasterIds();
      const { error: e1 } = await supabase.from('timesheet_headers').update({
        client_id: clientId, site_id: siteId,
        client_name_snapshot: form.client || null,
        site_name_snapshot: form.project || null,
        role_name_snapshot: form.role || null,
      }).eq('id', savedHeaderId);
      if (e1) showToast(`Timesheet saved, but the client/site link failed: ${e1.message}`, 'error');
      if (clientId || siteId) {
        const { error: e2 } = await supabase.from('timesheets').update({ client_id: clientId, site_id: siteId })
          .eq('header_id', savedHeaderId);
        if (e2) showToast(`Timesheet saved, but the line client/site link failed: ${e2.message}`, 'error');
      }
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
      after: { client: form.client, project: form.project, total_hours: totals.totalHours },
    });

    // Autonomous sign-off: a submission goes to the site supervisor UNLESS a
    // client signature was captured on the phone (approves on the spot), and
    // not on reject / office-approve (the office path already emailed the PDF).
    if (statusOverride !== 'rejected' && !approving) {
      if (savedHeaderId && signedOnSite) {
        const who = `${sig.name.trim()}${String(sig.company).trim() ? ` (${String(sig.company).trim()})` : ''} — signed on site`;
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
    onSaved?.(data);
  };

  const cellInput = { ...inputStyle, padding: '6px 8px', fontSize: 13 };
  const roInput = { ...cellInput, background: C.cardHover, color: C.textMuted };

  return (
    <div>
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

      {/* Adjustment audit trail — original submitted times always stay on record */}
      {form.hours_lines.some(l => l.adjusted_at) && (
        <div style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.warning, marginBottom: 4 }}>✎ Hours were adjusted after submission</div>
          {form.hours_lines.filter(l => l.adjusted_at).map((l, i) => (
            <div key={i} style={{ fontSize: 12, color: C.textMuted }}>
              {l.date}: originally submitted {l.original_start_time ? new Date(l.original_start_time).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }) : '—'} – {l.original_end_time ? new Date(l.original_end_time).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }) : '—'} · adjusted by {l.adjusted_by || 'admin'}
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
      <Field label="Tasks Completed *" hint="Briefly describe the tasks you completed today." error={taskError}>
        <textarea
          style={{ ...inputStyle, minHeight: 70, resize: 'vertical', ...(taskError ? { borderColor: 'rgba(239,68,68,0.5)' } : {}) }}
          value={form.comments}
          placeholder="Briefly describe the tasks you completed today"
          onChange={e => { setField('comments', e.target.value); if (taskError) setTaskError(''); }}
        />
      </Field>

      {allowAdmin && (
        <Field label="Status">
          <select style={inputStyle} value={form.status} onChange={e => setField('status', e.target.value)}>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
        </Field>
      )}

      {/* X4 — client signs on the worker's phone. Optional: signed = approved on
          the spot (markClientApprovedManually) and the supervisor link is
          skipped; left blank = the usual text-a-link flow, unchanged. */}
      {!allowAdmin && (
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px', margin: '4px 0 12px' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>✍️ Client signature (optional)</div>
          <div style={{ fontSize: 12, color: C.textMuted, margin: '2px 0 10px' }}>
            Supervisor with you? Get them to sign now — otherwise we text them a link.
          </div>
          <SignaturePad
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
            </div>
          )}
        </div>
      )}

      {take5Block && (
        <div style={{ background: C.warningSoft, border: `1px solid ${C.warning}`, borderRadius: 8, padding: '12px 16px', margin: '4px 0 12px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ color: C.text, fontSize: 13, flex: 1, minWidth: 220 }}>
            <strong>⚠ A Take 5 is required on Tue/Thu before submitting your timesheet.</strong>
            <div style={{ color: C.textMuted, fontSize: 12, marginTop: 3 }}>
              Missing for: {take5Block.dates.join(', ')}. Complete a Take 5 for that date, then submit again.
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
            Complete this Take 5, then press Submit on your timesheet again — everything you typed is still there.
          </div>
          <Take5Form
            workerId={targetWorker}
            showToast={showToast}
            prefill={{
              work_date: take5Block?.dates?.[0] || todayISO(),
              site: [form.client, form.project].filter(Boolean).join(' — '),
            }}
            onSubmitted={() => { setTake5Modal(false); setTake5Block(null); }}
          />
        </Modal>
      )}
    </div>
  );
}
