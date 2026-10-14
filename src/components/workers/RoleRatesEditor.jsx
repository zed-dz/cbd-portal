import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnSmall, btnDanger } from '../../theme';
import { ALL_ROLE_NAMES } from '../../constants/roles';

// Rates by role, for subcontractors. Payroll pays the row whose role matches
// the role on the timesheet; with no match it falls back to the person's own
// A/B above. Rows are edited here in memory and written by WorkersPage on Save
// (saveRoleRates below), so nothing half-saves if the worker save fails.
export function RoleRatesEditor({ rows, setRows }) {
  const [libraryRoles, setLibraryRoles] = useState([]);

  useEffect(() => {
    supabase.from('job_roles').select('name').order('name')
      .then(({ data }) => setLibraryRoles((data || []).map(r => r.name).filter(Boolean)));
  }, []);

  // Same list the timesheet role picker offers, so a rate can always match.
  const roleOptions = useMemo(() => {
    const all = new Set(ALL_ROLE_NAMES);
    libraryRoles.forEach(r => all.add(r));
    rows.forEach(r => r.role_name && all.add(r.role_name));
    return [...all].sort((a, b) => a.localeCompare(b));
  }, [libraryRoles, rows]);

  const taken = new Set(rows.map(r => (r.role_name || '').trim().toLowerCase()));
  const update = (i, patch) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i) => setRows(rs => rs.filter((_, j) => j !== i));
  const add = () => setRows(rs => [...rs, { role_name: '', rate_normal: '', rate_overtime: '' }]);
  const small = { fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 };

  return (
    <div style={{ marginTop: 12, borderTop: `1px dashed ${C.border}`, paddingTop: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.accent, letterSpacing: 1, marginBottom: 4 }}>
        RATES BY ROLE ($/hr)
      </div>
      <div style={{ fontSize: 11.5, color: C.textMuted, marginBottom: 8, lineHeight: 1.5 }}>
        Payroll uses the rate for the role on each timesheet. A role not listed here is paid at A and B above.
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {rows.map((r, i) => (
          <div key={r.id || `new-${i}`} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 180px', minWidth: 0 }}>
              <div style={small}>Role</div>
              <select style={{ ...inputStyle, width: '100%' }} value={r.role_name}
                onChange={e => update(i, { role_name: e.target.value })}>
                <option value="">Pick a role…</option>
                {roleOptions.map(name => (
                  <option key={name} value={name}
                    disabled={name !== r.role_name && taken.has(name.toLowerCase())}>{name}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: '0 1 110px' }}>
              <div style={small}>Normal</div>
              <input style={{ ...inputStyle, width: '100%' }} type="number" step="0.01" min="0"
                value={r.rate_normal} placeholder="e.g. 55.00"
                onChange={e => update(i, { rate_normal: e.target.value })} />
            </div>
            <div style={{ flex: '0 1 110px' }}>
              <div style={small}>Overtime</div>
              <input style={{ ...inputStyle, width: '100%' }} type="number" step="0.01" min="0"
                value={r.rate_overtime} placeholder="type it"
                onChange={e => update(i, { rate_overtime: e.target.value })} />
            </div>
            <button type="button" onClick={() => remove(i)} title="Remove this role rate"
              style={{ ...btnDanger, padding: '6px 10px' }}>×</button>
          </div>
        ))}
      </div>
      <button type="button" onClick={add} style={{ ...btnSmall, marginTop: 8 }}>+ Add a role rate</button>
    </div>
  );
}

// Validate the in-memory rows. Returns an error message, or '' when fine.
export function checkRoleRates(rows) {
  const seen = new Set();
  for (const r of rows) {
    const role = (r.role_name || '').trim();
    if (!role) return 'Rates by role: pick a role on every row (or remove the empty row).';
    if (r.rate_normal === '' || r.rate_normal == null) return `Rates by role: type the normal rate for ${role}.`;
    const key = role.toLowerCase();
    if (seen.has(key)) return `Rates by role: ${role} is listed twice.`;
    seen.add(key);
  }
  return '';
}

// Write the rows for one worker: update kept rows, insert new ones, archive
// removed ones (never delete — an old pay run must stay explainable).
export async function saveRoleRates(workerId, rows, originalIds) {
  const num = v => (v === '' || v == null ? null : parseFloat(v));
  const now = new Date().toISOString();
  const keptIds = new Set(rows.filter(r => r.id).map(r => r.id));
  const removed = (originalIds || []).filter(id => !keptIds.has(id));

  if (removed.length) {
    const { error } = await supabase.from('worker_role_rates')
      .update({ archived_at: now, updated_at: now }).in('id', removed);
    if (error) return error.message;
  }
  for (const r of rows.filter(r => r.id)) {
    const { error } = await supabase.from('worker_role_rates').update({
      role_name: r.role_name.trim(), rate_normal: num(r.rate_normal), rate_overtime: num(r.rate_overtime), updated_at: now,
    }).eq('id', r.id);
    if (error) return error.message;
  }
  const fresh = rows.filter(r => !r.id).map(r => ({
    worker_id: workerId, role_name: r.role_name.trim(),
    rate_normal: num(r.rate_normal), rate_overtime: num(r.rate_overtime),
  }));
  if (fresh.length) {
    const { error } = await supabase.from('worker_role_rates').insert(fresh);
    if (error) return error.message;
  }
  return '';
}
