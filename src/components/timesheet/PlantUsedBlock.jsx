import { useEffect, useState } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnSmall } from '../../theme';
import { Field } from '../ui/Field';

// "Plant used" on the daily timesheet: pick plant items from the register and
// type the hours each ran. Hours only — the plant's hourly charge never reaches
// this screen (the column is not granted to workers; see plant_items grants).
//
// Self-contained so DailyTimesheetForm only needs: state, one render line and
// one savePlantHours() call after the header is saved.

// Safe columns only — hourly_charge is admin-only and would fail the grant.
const PLANT_COLS = 'id, name, type, status';

export async function loadPlantHours(headerId) {
  if (!headerId) return [];
  const { data } = await supabase.from('plant_hours').select('id, plant_id, hours, notes').eq('header_id', headerId);
  return (data || []).map(r => ({ plant_id: r.plant_id, hours: r.hours ?? '', notes: r.notes || '' }));
}

// Replace the sheet's plant lines with `rows` (delete + insert; a locked sheet
// refuses both via the lock trigger, like the hour lines).
export async function savePlantHours(headerId, rows) {
  if (!headerId) return { ok: false, error: 'no header' };
  const clean = (rows || [])
    .filter(r => r.plant_id && parseFloat(r.hours) > 0)
    .map(r => ({ header_id: headerId, plant_id: r.plant_id, hours: Math.round(parseFloat(r.hours) * 4) / 4, notes: (r.notes || '').trim() || null }));
  const { error: dErr } = await supabase.from('plant_hours').delete().eq('header_id', headerId);
  if (dErr) return { ok: false, error: dErr.message };
  if (!clean.length) return { ok: true, count: 0 };
  const { error: iErr } = await supabase.from('plant_hours').insert(clean);
  if (iErr) return { ok: false, error: iErr.message };
  return { ok: true, count: clean.length };
}

export function PlantUsedBlock({ headerId, value, onChange }) {
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const [{ data: plant }, existing] = await Promise.all([
        supabase.from('plant_items').select(PLANT_COLS).is('archived_at', null).order('name'),
        loadPlantHours(headerId),
      ]);
      if (!mounted) return;
      setItems(plant || []);
      if (existing.length) onChange(existing);
      setLoaded(true);
    })();
    return () => { mounted = false; };
  // The existing rows belong to this header only; re-run when it changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerId]);

  const rows = value || [];
  const setRow = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => onChange([...rows, { plant_id: '', hours: '', notes: '' }]);
  const removeRow = (i) => onChange(rows.filter((_, j) => j !== i));

  if (loaded && !items.length && !rows.length) return null;   // nothing in the register yet

  const cell = { ...inputStyle, padding: '6px 8px', fontSize: 13 };
  return (
    <Field label="Plant used (optional)" hint="Machines or equipment used on this sheet and the hours each ran.">
      <div data-area="plant used" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <select style={{ ...cell, flex: '1 1 160px', minWidth: 0 }} value={r.plant_id} onChange={e => setRow(i, { plant_id: e.target.value })}>
              <option value="">Select plant…</option>
              {items.map(p => (
                <option key={p.id} value={p.id} disabled={p.status !== 'active' && p.id !== r.plant_id}>
                  {p.name}{p.type ? ` · ${p.type}` : ''}{p.status !== 'active' ? ` (${p.status.replace('_', ' ')})` : ''}
                </option>
              ))}
            </select>
            <input type="number" step="0.25" min="0" inputMode="decimal" placeholder="Hours"
              style={{ ...cell, width: 92 }} value={r.hours} onChange={e => setRow(i, { hours: e.target.value })} />
            <button type="button" onClick={() => removeRow(i)} title="Remove" aria-label="Remove plant line"
              style={{ ...btnSmall, minHeight: 36, padding: '0 12px' }}>✕</button>
          </div>
        ))}
        <button type="button" onClick={addRow} style={{ ...btnSmall, alignSelf: 'flex-start', minHeight: 36, padding: '0 12px' }}>
          + Add plant
        </button>
        {!!rows.length && (
          <div style={{ fontSize: 11, color: C.textMuted }}>
            {rows.filter(r => r.plant_id && parseFloat(r.hours) > 0).length} item(s) ·{' '}
            {rows.reduce((s, r) => s + (parseFloat(r.hours) || 0), 0).toFixed(2)}h plant time
          </div>
        )}
      </div>
    </Field>
  );
}
