import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnSmall, btnDanger } from '../../theme';
import { todayISO } from '../../utils/dates';
import {
  dayFromDate, computeLineTotalHours, computeLineRegularHours, autoMealAllowance, SHIFT_TYPES,
} from '../../utils/payroll';
import { Field } from '../ui/Field';
import { SignaturePad } from '../ui/SignaturePad';

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
    })).concat((lineRows || []).length ? [] : [emptyHoursLine()]),
  };
}

// Build the {date, start_time, end_time, ...} ISO payload for the RPC.
// meal_allowance is AUTO-computed from hours here for an immediate echo, but the
// DB triggers are authoritative on save (admin overrides are passed through).
function buildLinesPayload(form, config) {
  return form.hours_lines
    .filter(l => l.date)
    .map(l => ({
      date: l.date,
      shift_type: l.shift_type,
      scenario: l.scenario || 'standard',
      start_time: l.date && l.start_time ? `${l.date}T${l.start_time}:00` : '',
      end_time: l.date && l.end_time ? `${l.date}T${l.end_time}:00` : '',
      total_break_hours: parseFloat(l.total_break_hours) || 0,
      total_hours: parseFloat(l.total_hours) || 0,
      regular_hours: parseFloat(l.regular_hours) || 0,
      meal_allowance: l.meal_allowance_override
        ? (parseFloat(l.meal_allowance) || 0)
        : autoMealAllowance(l.total_hours, config),
      meal_allowance_override: !!l.meal_allowance_override,
    }));
}

// Shared Daily Timesheet form. `workerId` is the subject worker.
// `allowAdmin` shows the status selector + worker picker for admin editing.
export function DailyTimesheetForm({
  initial, workerId, onSaved, onCancel, showToast, allowAdmin = false,
  workers = [], onWorkerChange,
}) {
  const [form, setForm] = useState(initial || blankDaily());
  const [clients, setClients] = useState([]);
  const [roles, setRoles] = useState([]);
  const [projects, setProjects] = useState([]);
  const [config, setConfig] = useState({});
  const [saving, setSaving] = useState(false);

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
    const totalMeal = form.hours_lines.reduce((s, l) => {
      const meal = l.meal_allowance_override
        ? (parseFloat(l.meal_allowance) || 0)
        : autoMealAllowance(l.total_hours, config);
      return s + meal;
    }, 0);
    return { totalHours, totalReg, totalMeal };
  }, [form, config]);

  const targetWorker = workerId || form.worker_id;

  const handleSave = async () => {
    if (!targetWorker) { showToast('No worker selected for this timesheet.', 'error'); return; }
    if (!form.client) { showToast('Client is required.', 'error'); return; }
    if (!form.project) { showToast('Project is required.', 'error'); return; }
    if (!form.role) { showToast('Role is required.', 'error'); return; }
    const validLines = form.hours_lines.filter(l => l.date && l.start_time && l.end_time);
    if (!validLines.length) { showToast('Add at least one hours line with date, start and end.', 'error'); return; }

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
      p_status: form.status || 'pending',
      p_lines: buildLinesPayload({ ...form, hours_lines: recalced }, config),
    });
    setSaving(false);
    if (error) { showToast(error.message, 'error'); return; }
    showToast(form.id ? 'Daily timesheet updated' : 'Daily timesheet submitted', 'success');
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
        <Field label="Role *">
          <select style={inputStyle} value={form.role} onChange={e => setField('role', e.target.value)}>
            <option value="">Select…</option>
            {roles.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
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
              <th style={{ padding: 4, fontWeight: 500 }}>Regular</th>
              <th style={{ padding: 4, fontWeight: 500 }}>Meal&nbsp;($)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {form.hours_lines.map((l, i) => {
              const autoMeal = autoMealAllowance(l.total_hours, config);
              const mealVal = l.meal_allowance_override ? (parseFloat(l.meal_allowance) || 0) : autoMeal;
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
                <td style={{ padding: 3 }}><input type="number" step="0.25" min="0" style={{ ...cellInput, width: 70 }} value={l.total_break_hours} onChange={e => setHoursLine(i, { total_break_hours: e.target.value })} /></td>
                <td style={{ padding: 3 }}><input readOnly style={{ ...roInput, width: 64 }} value={Number(l.total_hours).toFixed(2)} /></td>
                <td style={{ padding: 3 }}><input readOnly style={{ ...roInput, width: 64 }} value={Number(l.regular_hours).toFixed(2)} /></td>
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
      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>
        Meal allowance is calculated automatically: a day of {parseFloat(config.meal_allowance_trigger ?? 9.5)}h or more
        earns ${parseFloat(config.meal_allowance_amount ?? 18.70).toFixed(2)}.
        {allowAdmin ? ' Tick “override” on a row to set it manually.' : ''}
      </div>

      {/* Totals preview */}
      <div style={{ background: C.accentSoft, border: `1px solid ${C.accentBorder}`, borderRadius: 8, padding: '10px 16px', margin: '16px 0', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div><div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>Total Hours</div><div style={{ fontSize: 20, fontWeight: 800, color: C.accent }}>{totals.totalHours.toFixed(2)}</div></div>
        <div><div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>Regular Hours</div><div style={{ fontSize: 20, fontWeight: 800, color: C.text }}>{totals.totalReg.toFixed(2)}</div></div>
        <div><div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>Meal Allowance</div><div style={{ fontSize: 20, fontWeight: 800, color: C.text }}>${totals.totalMeal.toFixed(2)}</div></div>
      </div>

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
      <Field label="Comments">
        <textarea style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }} value={form.comments} onChange={e => setField('comments', e.target.value)} />
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

      <Field label="Client Manual Signature">
        <SignaturePad value={form.client_signature} onChange={(v) => setField('client_signature', v)} />
      </Field>

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
        <button type="button" onClick={onCancel} style={btnSecondary}>Cancel</button>
        <button type="button" onClick={handleSave} disabled={saving} style={btnPrimary}>
          {saving ? 'Saving…' : form.id ? 'Save changes' : 'Submit'}
        </button>
      </div>
    </div>
  );
}
