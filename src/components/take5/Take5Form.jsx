import { useState } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary } from '../../theme';
import { todayISO } from '../../utils/dates';
import { Field } from '../ui/Field';

const PPE_ITEMS = ['Hard hat', 'Hi-vis clothing', 'Steel-cap boots', 'Safety glasses', 'Gloves', 'Hearing protection', 'Dust mask / respirator', 'Sunscreen'];

const HAZARD_SUGGESTIONS = [
  'Moving plant / machinery', 'Live traffic', 'Working at heights', 'Manual handling',
  'Overhead powerlines', 'Underground services', 'Noise', 'Dust / silica',
  'Sun / UV exposure', 'Slips, trips and falls', 'Crush / pinch points', 'Fatigue',
  'Hot works', 'Confined space', 'Weather (wind / rain / lightning)', 'Public / pedestrians',
];

const emptyTaskHazard = () => ({ hazard: '', control: '' });
const blankTake5 = (prefill = {}) => ({
  work_date: todayISO(), site: '', task: '',
  task_hazards: [emptyTaskHazard(), emptyTaskHazard()],
  ppe: [], acknowledged: false,
  ...prefill,
});

// Core Take 5 form, shared by the Take 5 tab in WorkerPortal and the inline
// "Do it now" modal inside DailyTimesheetForm — the Tue/Thu gate must never
// force a worker to abandon a half-filled timesheet to satisfy it.
// `prefill` seeds work_date / site (e.g. from the timesheet being submitted).
export function Take5Form({ workerId, showToast, prefill, onSubmitted }) {
  const [f, setF] = useState(() => blankTake5(prefill));
  const [saving, setSaving] = useState(false);

  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));
  const togglePpe = (item) => setF(s => ({ ...s, ppe: s.ppe.includes(item) ? s.ppe.filter(x => x !== item) : [...s.ppe, item] }));
  const setHazard = (idx, key, value) => setF(s => ({
    ...s, task_hazards: s.task_hazards.map((h, i) => i === idx ? { ...h, [key]: value } : h),
  }));
  const addHazard = () => setF(s => s.task_hazards.length >= 3 ? s : ({ ...s, task_hazards: [...s.task_hazards, emptyTaskHazard()] }));
  const removeHazard = (idx) => setF(s => ({
    ...s, task_hazards: s.task_hazards.length > 1 ? s.task_hazards.filter((_, i) => i !== idx) : s.task_hazards,
  }));

  const submit = async () => {
    if (!String(f.task).trim()) { showToast('Describe the task you are about to do.', 'error'); return; }
    const filled = f.task_hazards.filter(h => String(h.hazard).trim());
    if (filled.length < 2) { showToast('Pick at least 2 hazards for this task (add a third if it applies).', 'error'); return; }
    if (filled.some(h => !String(h.control).trim())) { showToast('Add a control measure for each hazard.', 'error'); return; }
    if (!f.acknowledged) { showToast('Please tick the acknowledgement to submit your Take 5.', 'error'); return; }
    setSaving(true);
    const { error } = await supabase.from('take5').insert([{
      worker_id: workerId,
      work_date: f.work_date,
      site: f.site || null,
      task: f.task,
      task_hazards: filled,
      // legacy text columns stay populated so older views/reports keep working
      hazards: filled.map(h => h.hazard).join('; '),
      controls: filled.map(h => h.control).join('; '),
      ppe: f.ppe,
      acknowledged: f.acknowledged,
    }]);
    setSaving(false);
    if (error) { showToast(error.message, 'error'); return; }
    showToast('Take 5 submitted — you can now submit your timesheet for this day.', 'success');
    setF(blankTake5(prefill));
    onSubmitted?.();
  };

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
        <Field label="Date"><input type="date" style={inputStyle} value={f.work_date} onChange={set('work_date')} /></Field>
        <Field label="Client / site"><input style={inputStyle} value={f.site} onChange={set('site')} placeholder="Where are you working?" /></Field>
      </div>
      <Field label="What task are you doing? *" hint="The specific job you're about to start — e.g. operating the roller on the access road.">
        <input style={inputStyle} value={f.task} onChange={set('task')} placeholder="e.g. Operating dozer for bulk earthworks" />
      </Field>
      <Field label="Hazards for this task * (pick 2–3, with your control for each)">
        <div style={{ display: 'grid', gap: 8 }}>
          {f.task_hazards.map((h, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 180px', minWidth: 160 }}>
                <input style={inputStyle} list="take5-hazards" value={h.hazard}
                  onChange={e => setHazard(i, 'hazard', e.target.value)}
                  placeholder={`Hazard ${i + 1} — pick or type`} />
              </div>
              <div style={{ flex: '1 1 220px', minWidth: 180 }}>
                <input style={inputStyle} value={h.control}
                  onChange={e => setHazard(i, 'control', e.target.value)}
                  placeholder="Control measure — how you'll manage it" />
              </div>
              {f.task_hazards.length > 1 && (
                <button type="button" onClick={() => removeHazard(i)}
                  style={{ ...btnSecondary, padding: '9px 12px', color: '#fca5a5', borderColor: 'rgba(239,68,68,0.32)' }}>×</button>
              )}
            </div>
          ))}
          <datalist id="take5-hazards">{HAZARD_SUGGESTIONS.map(h => <option key={h} value={h} />)}</datalist>
          {f.task_hazards.length < 3 && (
            <button type="button" onClick={addHazard} style={{ ...btnSecondary, padding: '7px 14px', fontSize: 12, justifySelf: 'start', width: 'fit-content' }}>+ Add another hazard</button>
          )}
        </div>
      </Field>
      <Field label="PPE for this task">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {PPE_ITEMS.map(item => (
            <label key={item} style={{ display: 'flex', alignItems: 'center', gap: 6, color: C.text, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={f.ppe.includes(item)} onChange={() => togglePpe(item)} /> {item}
            </label>
          ))}
        </div>
      </Field>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.text, fontSize: 14, cursor: 'pointer', margin: '12px 0' }}>
        <input type="checkbox" checked={f.acknowledged} onChange={e => setF(s => ({ ...s, acknowledged: e.target.checked }))} />
        I've completed this Take 5 and it's safe to proceed.
      </label>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" onClick={submit} disabled={saving} style={btnPrimary}>{saving ? 'Submitting…' : 'Submit Take 5'}</button>
      </div>
    </>
  );
}
