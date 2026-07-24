import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnSmall, btnDanger } from '../../theme';
import { todayISO, isTakeFiveDay } from '../../utils/dates';
import {
  dayFromDate, computeLineTotalHours, computeLineRegularHours, autoMealAllowance, SHIFT_TYPES,
  splitDailyHours,
} from '../../utils/payroll';
import { Field } from '../ui/Field';
import { sendTimesheetForClientApproval } from '../../utils/clientApproval';
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
      start_time: r.start_time ? new Date(r.start_time).toTimeString().slice(0, 5) : '',
      end_time: r.end_time ? new Date(r.end_time).toTimeString().slice(0, 5) : '',
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
  let d = new Date(`${date}T${time}:00`);
  if (isNaN(d)) return '';
  if (rollAfter && d <= rollAfter) d = new Date(d.getTime() + 24 * 3600 * 1000);
  return d.toISOString();
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
  const [workerType, setWorkerType] = useState(null);   // drives the ordinary/RDO/OT split display

  useEffect(() => { setForm(initial || blankDaily()); }, [initial]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const [c, r, j, alloc, cfg] = await Promise.all([
        supabase.from('clients').select('name').order('name'),
        supabase.from('job_roles').select('name').order('name'),
        supabase.from('client_jobs').select('name').order('name'),
        supabase.from('allocations').select('project').not('project', 'is', null),
        supabase.from('payroll_config').select('config_key, config_value'),
      ]);
      if (!mounted) return;
      if (c.data) setClients(c.data.map(x => x.name).filter(Boolean));
      if (r.data) setRoles(r.data.map(x => x.name).filter(Boolean));
      const projSet = new Set([
        ...((j.data || []).map(x => x.name)),
        ...((alloc.data || []).map(x => x.project)),
      ].filter(Boolean));
      setProjects([...projSet].sort());
      if (cfg.data) {
        const map = {};
        cfg.data.forEach(row => { map[row.config_key] = row.config_value; });
        setConfig(map);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Recompute Day + Total + Regular + auto Meal Allowance for a single hours line.
  const recalcLine = useCallback((line) => {
    const total = computeLineTotalHours(line.start_time, line.end_time, line.total_break_hours);
    const meal = line.meal_allowance_override
      ? (parseFloat(line.meal_allowance) || 0)
      : autoMealAllowance(total, config);
    return {
      ...line,
      day: dayFromDate(line.date),
      total_hours: total,
      regular_hours: computeLineRegularHours(total, config),
      meal_allowance: meal,
    };
  }, [config]);

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
      const sp = splitDailyHours(l.total_hours, workerType, l.date, config);
      totalRdo += sp.rdo; totalOt += sp.overtime;
    });
    const totalMeal = form.hours_lines.reduce((s, l) => {
      const meal = l.meal_allowance_override
        ? (parseFloat(l.meal_allowance) || 0)
        : autoMealAllowance(l.total_hours, config);
      return s + meal;
    }, 0);
    return { totalHours, totalReg, totalRdo, totalOt, totalMeal };
  }, [form, config, workerType]);

  const targetWorker = workerId || form.worker_id;

  useEffect(() => {
    let mounted = true;
    if (!targetWorker) { setWorkerType(null); return undefined; }
    supabase.from('workers').select('worker_type').eq('id', targetWorker).maybeSingle()
      .then(({ data }) => { if (mounted) setWorkerType(data?.worker_type || null); });
    return () => { mounted = false; };
  }, [targetWorker]);

  // Master role list is the primary source; keep any library roles (job_roles)
  // or a pre-existing legacy value so nothing already saved gets dropped.
  const extraRoles = useMemo(() => {
    const known = new Set(ALL_ROLE_NAMES);
    const extra = new Set();
    roles.forEach(r => { if (r && !known.has(r)) extra.add(r); });
    if (form.role && !known.has(form.role)) extra.add(form.role);
    return [...extra];
  }, [roles, form.role]);

  // statusOverride (from the manager Approve/Reject buttons) forces the saved
  // status; otherwise the form's own status is used.
  const handleSave = async (statusOverride) => {
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

    const statusToUse = overriding ? statusOverride : (form.status || 'pending');
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

    // Manager Approve/Reject: keep the header + line rows in lock-step so
    // payroll/Xero read the same status (mirrors the old row-level action).
    if (overriding && form.id) {
      await supabase.from('timesheet_headers').update({ status: statusToUse }).eq('id', form.id);
      await supabase.from('timesheets').update({ status: statusToUse }).eq('header_id', form.id);
    }
    setSaving(false);
    const msg = overriding
      ? (statusToUse === 'approved' ? 'Timesheet approved' : 'Timesheet rejected')
      : (form.id ? 'Daily timesheet updated' : 'Daily timesheet submitted');
    showToast(msg, statusToUse === 'rejected' ? 'info' : 'success');

    // Autonomous sign-off: every submission (worker or admin) goes straight to
    // the site supervisor. Their acceptance auto-approves the timesheet and
    // makes it billable in Payroll — no admin step required. Fire-and-forget;
    // duplicate sends are blocked by the already-sent guard in the util, and
    // contact/channel failures light up the admin bell so the office can act.
    if (statusToUse !== 'rejected') {
      const headerId = form.id || data;
      if (headerId) {
        sendTimesheetForClientApproval(headerId).then(r => {
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
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 12px' }}>
        <Field label="Client *">
          <input style={inputStyle} list="dts-clients" value={form.client}
            onChange={e => setField('client', e.target.value)} placeholder="Select…" />
          <datalist id="dts-clients">{clients.map(c => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label="Project *">
          <input style={inputStyle} list="dts-projects" value={form.project}
            onChange={e => setField('project', e.target.value)} placeholder="Select or type…" />
          <datalist id="dts-projects">{projects.map(p => <option key={p} value={p} />)}</datalist>
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
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: C.textMuted, textAlign: 'left' }}>
              <th style={{ padding: 4, fontWeight: 500 }}>Date</th>
              <th style={{ padding: 4, fontWeight: 500 }}>Day</th>
              <th style={{ padding: 4, fontWeight: 500 }}>Shift Type</th>
              <th style={{ padding: 4, fontWeight: 500 }}>Start *</th>
              <th style={{ padding: 4, fontWeight: 500 }}>End *</th>
              <th style={{ padding: 4, fontWeight: 500 }}>Break (h)</th>
              <th style={{ padding: 4, fontWeight: 500 }}>Total</th>
              <th style={{ padding: 4, fontWeight: 500 }}>Normal</th>
              <th style={{ padding: 4, fontWeight: 500 }} title="Banked to your RDO accrual (full-time, weekdays)">RDO</th>
              <th style={{ padding: 4, fontWeight: 500 }}>OT</th>
              <th style={{ padding: 4, fontWeight: 500 }}>Meal&nbsp;($)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {form.hours_lines.map((l, i) => {
              const autoMeal = autoMealAllowance(l.total_hours, config);
              const mealVal = l.meal_allowance_override ? (parseFloat(l.meal_allowance) || 0) : autoMeal;
              const split = splitDailyHours(l.total_hours, workerType, l.date, config);
              const breakOpts = BREAK_OPTIONS.includes(parseFloat(l.total_break_hours) || 0)
                ? BREAK_OPTIONS
                : [...BREAK_OPTIONS, parseFloat(l.total_break_hours) || 0].sort((a, b) => a - b);
              return (
              <tr key={i}>
                <td style={{ padding: 3 }}><input type="date" style={{ ...cellInput, width: 130 }} value={l.date} onChange={e => setHoursLine(i, { date: e.target.value })} /></td>
                <td style={{ padding: 3, color: C.textMuted, whiteSpace: 'nowrap' }}>{dayFromDate(l.date) || '—'}</td>
                <td style={{ padding: 3 }}>
                  <select style={{ ...cellInput, width: 120 }} value={l.shift_type} onChange={e => setHoursLine(i, { shift_type: e.target.value })}>
                    {SHIFT_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </td>
                <td style={{ padding: 3 }}><input type="time" style={{ ...cellInput, width: 100 }} value={l.start_time} onChange={e => setHoursLine(i, { start_time: e.target.value })} /></td>
                <td style={{ padding: 3 }}><input type="time" style={{ ...cellInput, width: 100 }} value={l.end_time} onChange={e => setHoursLine(i, { end_time: e.target.value })} /></td>
                <td style={{ padding: 3 }}>
                  <select style={{ ...cellInput, width: 78 }} value={String(parseFloat(l.total_break_hours) || 0)}
                    onChange={e => setHoursLine(i, { total_break_hours: parseFloat(e.target.value) })}>
                    {breakOpts.map(b => <option key={b} value={String(b)}>{b === 0 ? 'No break' : `${b} hr`}</option>)}
                  </select>
                </td>
                <td style={{ padding: 3 }}><input readOnly style={{ ...roInput, width: 64 }} value={Number(l.total_hours).toFixed(2)} /></td>
                <td style={{ padding: 3 }}><input readOnly style={{ ...roInput, width: 64 }} value={Number(l.regular_hours).toFixed(2)} /></td>
                <td style={{ padding: 3 }}><input readOnly style={{ ...roInput, width: 52, color: split.rdo > 0 ? C.success : C.textMuted }} value={split.rdo.toFixed(2)} title="Banked to the RDO accrual (full-time weekday shifts)" /></td>
                <td style={{ padding: 3 }}><input readOnly style={{ ...roInput, width: 56, color: split.overtime > 0 ? C.warning : C.textMuted }} value={split.overtime.toFixed(2)} title="Overtime — hours beyond the 8-hour normal-time block" /></td>
                <td style={{ padding: 3 }}>
                  {l.meal_allowance_override
                    ? <input type="number" step="0.01" min="0" style={{ ...cellInput, width: 72 }} value={l.meal_allowance}
                        onChange={e => setHoursLine(i, { meal_allowance: e.target.value })} title="Admin override amount" />
                    : <input readOnly style={{ ...roInput, width: 72 }} value={mealVal.toFixed(2)}
                        title={`Auto: ${l.total_hours >= 0 ? `${Number(l.total_hours).toFixed(2)}h` : ''} → ${autoMeal > 0 ? 'meal allowance applies' : 'below threshold'}`} />}
                  {allowAdmin && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: C.textMuted, marginTop: 2, cursor: 'pointer' }} title="Admin override of the auto meal allowance">
                      <input type="checkbox" checked={!!l.meal_allowance_override}
                        onChange={e => setHoursLine(i, { meal_allowance_override: e.target.checked, ...(e.target.checked ? {} : { meal_allowance: autoMeal }) })} />
                      override
                    </label>
                  )}
                </td>
                <td style={{ padding: 3 }}>
                  <button type="button" onClick={() => removeHoursLine(i)} style={{ ...btnDanger, padding: '4px 8px' }}>×</button>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button type="button" onClick={addHoursLine} style={{ ...btnSmall, marginTop: 8 }}>+ Add hours row</button>

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

      {take5Block && (
        <div style={{ background: C.warningSoft, border: `1px solid ${C.warning}`, borderRadius: 8, padding: '12px 16px', margin: '4px 0 12px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ color: C.text, fontSize: 13, flex: 1, minWidth: 220 }}>
            <strong>⚠ A Take 5 is required on Tue/Thu before submitting your timesheet.</strong>
            <div style={{ color: C.textMuted, fontSize: 12, marginTop: 3 }}>
              Missing for: {take5Block.dates.join(', ')}. Complete a Take 5 for that date, then submit again.
            </div>
          </div>
          {onGoToTake5 && (
            <button type="button" onClick={() => onGoToTake5()} style={{ ...btnPrimary, background: C.warning, color: '#1a1a1a' }}>
              Go to Take 5 →
            </button>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={onCancel} style={btnSecondary}>Cancel</button>
        <button type="button" onClick={() => handleSave()} disabled={saving} style={allowReview ? btnSecondary : btnPrimary}>
          {saving ? 'Saving…' : form.id ? 'Save changes' : 'Submit'}
        </button>
        {allowReview && (
          <>
            <button type="button" onClick={() => handleSave('rejected')} disabled={saving}
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
    </div>
  );
}
