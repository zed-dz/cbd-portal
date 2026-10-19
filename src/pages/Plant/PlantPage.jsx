import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, MONO, inputStyle, btnPrimary, btnSecondary, btnSmall } from '../../theme';
import { Spinner, Modal, Field, TableWrap, Th, Td, EmptyState } from '../../components';
import { logActivity } from '../../utils/activity';

// Plant / equipment register (admin only). The hourly charge is MONEY: it is
// read through v_plant_items_admin and written straight to plant_items (RLS:
// admins only). Workers see name/type/status in the daily form, never the rate.
// Master data: archive, never delete.

const STATUSES = [
  { value: 'active',      label: 'Active',      color: C.success },
  { value: 'off_hire',    label: 'Off hire',    color: C.textMuted },
  { value: 'maintenance', label: 'Maintenance', color: C.warning },
];
const statusOf = (v) => STATUSES.find(s => s.value === v) || STATUSES[0];

const blank = { name: '', type: '', rego_or_serial: '', hourly_charge: '', status: 'active', notes: '' };

export function PlantPage({ showToast }) {
  const [items, setItems] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(null);   // null | 'add' | item
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState('all');

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('v_plant_items_admin').select('*').order('name');
    if (error) { showToast?.(error.message, 'error'); setItems([]); return; }
    setItems(data || []);
  }, [showToast]);
  useEffect(() => { load(); }, [load]);

  const openAdd = () => { setForm(blank); setEditing('add'); };
  const openEdit = (it) => {
    setForm({ name: it.name || '', type: it.type || '', rego_or_serial: it.rego_or_serial || '',
      hourly_charge: it.hourly_charge ?? '', status: it.status || 'active', notes: it.notes || '' });
    setEditing(it);
  };

  const save = async () => {
    if (!form.name.trim()) { showToast?.('Name is required.', 'error'); return; }
    const charge = form.hourly_charge === '' ? null : parseFloat(form.hourly_charge);
    if (charge != null && (!Number.isFinite(charge) || charge < 0)) { showToast?.('Hourly charge must be a number.', 'error'); return; }
    setSaving(true);
    const payload = {
      name: form.name.trim(), type: form.type.trim() || null, rego_or_serial: form.rego_or_serial.trim() || null,
      hourly_charge: charge, status: form.status, notes: form.notes.trim() || null, updated_at: new Date().toISOString(),
    };
    let error, id;
    if (editing === 'add') {
      const r = await supabase.from('plant_items').insert([payload]).select('id').single();
      error = r.error; id = r.data?.id;
    } else {
      const r = await supabase.from('plant_items').update(payload).eq('id', editing.id);
      error = r.error; id = editing.id;
    }
    setSaving(false);
    if (error) { showToast?.(error.message, 'error'); return; }
    // Never log the charge: activity_events is readable by the office.
    logActivity({ verb: editing === 'add' ? 'created' : 'edited', object_type: 'plant_item', object_id: id,
      after: { name: payload.name, type: payload.type, status: payload.status } });
    showToast?.(editing === 'add' ? 'Plant item added' : 'Plant item updated', 'success');
    setEditing(null);
    load();
  };

  const setStatus = async (it, status) => {
    const { error } = await supabase.from('plant_items').update({ status, updated_at: new Date().toISOString() }).eq('id', it.id);
    if (error) { showToast?.(error.message, 'error'); return; }
    logActivity({ verb: 'edited', object_type: 'plant_item', object_id: it.id, before: { status: it.status }, after: { status } });
    load();
  };

  const archive = async (it, restore = false) => {
    if (!restore && !window.confirm(`Archive "${it.name}"? It stays on past timesheets but can no longer be picked.`)) return;
    const { error } = await supabase.from('plant_items')
      .update({ archived_at: restore ? null : new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', it.id);
    if (error) { showToast?.(error.message, 'error'); return; }
    logActivity({ verb: restore ? 'restored' : 'archived', object_type: 'plant_item', object_id: it.id, after: { name: it.name } });
    showToast?.(restore ? 'Plant item restored' : 'Plant item archived', 'success');
    load();
  };

  if (items === null) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>;

  const visible = items
    .filter(it => showArchived ? !!it.archived_at : !it.archived_at)
    .filter(it => filter === 'all' || it.status === filter);
  const counts = STATUSES.map(s => ({ ...s, n: items.filter(it => !it.archived_at && it.status === s.value).length }));

  return (
    <div data-area="plant register">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, color: C.text }}>Plant &amp; equipment</h2>
          <div style={{ fontSize: 12, color: C.textMuted }}>Picked on daily timesheets; hours bill at the hourly charge on client invoices and in the margin report.</div>
        </div>
        <button onClick={openAdd} style={{ ...btnPrimary, marginLeft: 'auto', minHeight: 36 }}>+ Add plant</button>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        <button onClick={() => setFilter('all')} style={{ ...btnSmall, minHeight: 36, borderColor: filter === 'all' ? C.accent : C.border, color: filter === 'all' ? C.text : C.textMuted }}>
          All ({items.filter(it => !it.archived_at).length})
        </button>
        {counts.map(s => (
          <button key={s.value} onClick={() => setFilter(s.value)} style={{ ...btnSmall, minHeight: 36, borderColor: filter === s.value ? s.color : C.border, color: filter === s.value ? C.text : C.textMuted }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: s.color, marginRight: 6 }} />{s.label} ({s.n})
          </button>
        ))}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.textMuted, cursor: 'pointer', marginLeft: 'auto' }}>
          <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> Show archived
        </label>
      </div>

      {!visible.length ? (
        <EmptyState message={showArchived ? 'No archived plant.' : 'No plant in the register yet. Add the machines and equipment you hire out.'} icon="🚜" />
      ) : (
        <TableWrap>
          <thead>
            <tr><Th>Name</Th><Th>Type</Th><Th>Rego / serial</Th><Th>Charge / h</Th><Th>Status</Th><Th>Notes</Th><Th>Actions</Th></tr>
          </thead>
          <tbody>
            {visible.map(it => {
              const s = statusOf(it.status);
              return (
                <tr key={it.id} style={{ opacity: it.archived_at ? 0.6 : 1 }}>
                  <Td><strong>{it.name}</strong></Td>
                  <Td><span style={{ fontSize: 12, color: C.textMuted }}>{it.type || '—'}</span></Td>
                  <Td><span style={{ fontFamily: MONO, fontSize: 12 }}>{it.rego_or_serial || '—'}</span></Td>
                  <Td>
                    {it.hourly_charge != null
                      ? <span style={{ fontFamily: MONO, color: C.success, fontWeight: 600 }}>${Number(it.hourly_charge).toFixed(2)}</span>
                      : <span title="No charge set — hours on this item are NOT invoiced" style={{ fontSize: 11, color: C.warning, cursor: 'help' }}>⚠ not set</span>}
                  </Td>
                  <Td>
                    {it.archived_at ? (
                      <span style={{ fontSize: 11, color: C.textMuted }}>archived</span>
                    ) : (
                      <select value={it.status} onChange={e => setStatus(it, e.target.value)} aria-label={`Status of ${it.name}`}
                        style={{ ...inputStyle, width: 'auto', padding: '5px 8px', fontSize: 12, color: s.color, fontWeight: 700, minHeight: 36 }}>
                        {STATUSES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    )}
                  </Td>
                  <Td><span style={{ fontSize: 12, color: C.textMuted, whiteSpace: 'pre-wrap' }}>{it.notes || '—'}</span></Td>
                  <Td>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {!it.archived_at && <button onClick={() => openEdit(it)} style={{ ...btnSmall, minHeight: 36 }}>✎ Edit</button>}
                      {it.archived_at
                        ? <button onClick={() => archive(it, true)} style={{ ...btnSmall, minHeight: 36 }}>↩ Restore</button>
                        : <button onClick={() => archive(it)} style={{ ...btnSmall, minHeight: 36, color: C.error }}>Archive</button>}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}

      {editing && (
        <Modal title={editing === 'add' ? 'Add plant' : `Edit ${editing.name}`} onClose={() => setEditing(null)} width={520}>
          <Field label="Name *"><input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. CAT D6 Dozer" /></Field>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <Field label="Type"><input style={inputStyle} value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} placeholder="Dozer, Excavator, Ute…" /></Field>
            <Field label="Rego / serial"><input style={inputStyle} value={form.rego_or_serial} onChange={e => setForm(f => ({ ...f, rego_or_serial: e.target.value }))} /></Field>
            <Field label="Hourly charge ($)" hint="Billed to the client per plant hour. Admin only.">
              <input style={inputStyle} type="number" step="0.01" min="0" inputMode="decimal" value={form.hourly_charge} onChange={e => setForm(f => ({ ...f, hourly_charge: e.target.value }))} />
            </Field>
            <Field label="Status">
              <select style={inputStyle} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                {STATUSES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Notes"><textarea style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></Field>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={() => setEditing(null)} style={btnSecondary}>Cancel</button>
            <button onClick={save} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
