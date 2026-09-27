import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnSmall, btnDanger } from '../../theme';
import { Spinner, Modal, Field, TableWrap, Th, Td, EmptyState } from '../../components';

// Rate SETS are the reusable price lists (team request, meeting 2026-09-22:
// "we have five different sets of rates ... go into it and click 'Brefni is on
// these rates, JK's on these rates', hit update"). A set is defined ONCE here;
// applying it to a client COPIES the lines onto that client's own Schedule of
// Rates (client_rate_cards), which is what billing already reads — so applying
// a set can never change how past invoices were calculated, and a one-off
// client tweak on their own schedule stays possible afterwards.

const CATS = ['labour', 'plant', 'attachments', 'materials', 'allowances', 'other'];
const UOMS = ['hour', 'shift', 'day', 'ton', 'unit', 'km', 'm3', 'm2', 'lm', 'each'];
const blankItem = { role_name: '', uom: 'hour', category: 'labour', rate_a: '', rate_b: '', rate_c: '', notes: '' };

export function RateSetsPage({ showToast }) {
  const [sets, setSets] = useState([]);
  const [items, setItems] = useState([]);          // all items, filtered per set on render
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(null);          // expanded set id
  const [setForm, setSetForm] = useState(null);    // { name, notes, id? }
  const [itemForm, setItemForm] = useState(null);  // { ...item, set_id, id? }
  const [applyTo, setApplyTo] = useState({});      // set_id -> client_id
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [s, i, c] = await Promise.all([
      supabase.from('rate_sets').select('*').order('name'),
      supabase.from('rate_set_items').select('*').order('sort_order'),
      supabase.from('clients').select('id, name, rate_set_id').order('name'),
    ]);
    if (s.error) showToast(s.error.message, 'error');
    setSets(s.data || []); setItems(i.data || []); setClients(c.data || []);
    setLoading(false);
  }, [showToast]);
  useEffect(() => { load(); }, [load]);

  const saveSet = async () => {
    if (!setForm.name.trim()) { showToast('Set name is required.', 'error'); return; }
    setBusy(true);
    const payload = { name: setForm.name.trim(), notes: setForm.notes || null };
    const { error } = setForm.id
      ? await supabase.from('rate_sets').update(payload).eq('id', setForm.id)
      : await supabase.from('rate_sets').insert([payload]);
    setBusy(false);
    if (error) { showToast(error.message, 'error'); return; }
    showToast(setForm.id ? 'Rate set updated.' : 'Rate set created.', 'success');
    setSetForm(null); load();
  };

  const removeSet = async (s) => {
    const used = clients.filter(c => c.rate_set_id === s.id);
    if (!window.confirm(`Delete "${s.name}" and its lines?${used.length ? `\n\n${used.length} client(s) point at it — their own Schedule of Rates keeps the copied lines.` : ''}`)) return;
    const { error } = await supabase.from('rate_sets').delete().eq('id', s.id);
    if (error) { showToast(error.message, 'error'); return; }
    showToast('Rate set deleted.', 'success'); load();
  };

  const saveItem = async () => {
    if (!itemForm.role_name.trim()) { showToast('Description is required.', 'error'); return; }
    setBusy(true);
    const n = v => (v === '' || v == null) ? null : parseFloat(v);
    const payload = {
      set_id: itemForm.set_id, role_name: itemForm.role_name.trim(),
      uom: itemForm.uom || null, category: itemForm.category || null,
      rate_a: n(itemForm.rate_a), rate_b: n(itemForm.rate_b), rate_c: n(itemForm.rate_c),
      notes: itemForm.notes || null,
      sort_order: itemForm.sort_order ?? (Math.max(0, ...items.filter(i => i.set_id === itemForm.set_id).map(i => i.sort_order || 0)) + 10),
    };
    const { error } = itemForm.id
      ? await supabase.from('rate_set_items').update(payload).eq('id', itemForm.id)
      : await supabase.from('rate_set_items').insert([payload]);
    setBusy(false);
    if (error) { showToast(error.message, 'error'); return; }
    setItemForm(null); load();
  };

  const removeItem = async (i) => {
    if (!window.confirm(`Remove "${i.role_name}" from this set?`)) return;
    const { error } = await supabase.from('rate_set_items').delete().eq('id', i.id);
    if (error) { showToast(error.message, 'error'); return; }
    load();
  };

  // Apply = copy this set's lines onto the client's Schedule of Rates.
  // Insert the new lines FIRST, then delete the old ones — a failed insert
  // must never strand the client with an empty schedule (same rule as the
  // rates uploader).
  const applySet = async (s) => {
    const clientId = applyTo[s.id];
    if (!clientId) { showToast('Pick a client to apply this set to.', 'error'); return; }
    const client = clients.find(c => c.id === clientId);
    const lines = items.filter(i => i.set_id === s.id);
    if (!lines.length) { showToast('This set has no lines yet.', 'error'); return; }
    if (!window.confirm(`Apply "${s.name}" (${lines.length} lines) to ${client?.name}?\n\nTheir current Schedule of Rates will be replaced by this set.`)) return;
    setBusy(true);
    const { data: oldRows } = await supabase.from('client_rate_cards').select('id').eq('client_id', clientId);
    const { error: insErr } = await supabase.from('client_rate_cards').insert(lines.map(i => ({
      client_id: clientId, role_name: i.role_name, uom: i.uom, category: i.category,
      rate_a: i.rate_a, rate_b: i.rate_b, rate_c: i.rate_c, notes: i.notes, sort_order: i.sort_order,
    })));
    if (insErr) { setBusy(false); showToast(`Nothing changed — insert failed: ${insErr.message}`, 'error'); return; }
    const oldIds = (oldRows || []).map(r => r.id);
    if (oldIds.length) await supabase.from('client_rate_cards').delete().in('id', oldIds);
    await supabase.from('clients').update({ rate_set_id: s.id }).eq('id', clientId);
    setBusy(false);
    showToast(`"${s.name}" applied to ${client?.name} (${lines.length} lines).`, 'success');
    load();
  };

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>;

  return (
    <div>
      <div style={{ background: 'rgba(249,115,22,0.07)', border: '1px solid rgba(249,115,22,0.2)', borderRadius: 10, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: C.textMuted }}>
        📚 <strong style={{ color: C.text }}>Rate Sets</strong> — your reusable price lists. Define a set once, then apply it to any client:
        their <strong style={{ color: C.text }}>Schedule of Rates</strong> gets a copy of the lines, and billing reads that copy.
        A one-off tweak for a single client still happens on their own schedule under <strong style={{ color: C.text }}>Clients &amp; Rates</strong>.
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button style={btnPrimary} onClick={() => setSetForm({ name: '', notes: '' })}>+ New rate set</button>
      </div>

      {sets.length === 0 ? <EmptyState message="No rate sets yet — create the first one." icon="📚" /> : sets.map(s => {
        const mine = items.filter(i => i.set_id === s.id);
        const users = clients.filter(c => c.rate_set_id === s.id);
        const expanded = open === s.id;
        return (
          <div key={s.id} style={{ border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 12, background: C.card }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '14px 16px', cursor: 'pointer', flexWrap: 'wrap' }}
              onClick={() => setOpen(expanded ? null : s.id)}>
              <div style={{ minWidth: 220 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>{expanded ? '▾' : '▸'} {s.name}</div>
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                  {mine.length} line{mine.length === 1 ? '' : 's'}
                  {users.length > 0 && <> · used by {users.map(u => u.name).join(', ')}</>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
                <button style={btnSmall} onClick={() => setSetForm({ id: s.id, name: s.name, notes: s.notes || '' })}>Edit</button>
                <button style={{ ...btnSmall, ...btnDanger }} onClick={() => removeSet(s)}>Delete</button>
              </div>
            </div>

            {expanded && (
              <div style={{ borderTop: `1px solid ${C.border}`, padding: '12px 16px' }}>
                {s.notes && <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 10 }}>{s.notes}</div>}

                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12, background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.22)', borderRadius: 8, padding: '10px 12px' }}>
                  <span style={{ fontSize: 12.5, color: C.text, fontWeight: 600 }}>Apply this set to:</span>
                  <select style={{ ...inputStyle, maxWidth: 260 }} value={applyTo[s.id] || ''}
                    onChange={e => setApplyTo(a => ({ ...a, [s.id]: e.target.value }))}>
                    <option value="">Select a client…</option>
                    {clients.map(c => <option key={c.id} value={c.id}>{c.name}{c.rate_set_id === s.id ? ' (already on this set)' : ''}</option>)}
                  </select>
                  <button style={{ ...btnPrimary, padding: '8px 16px' }} disabled={busy} onClick={() => applySet(s)}>
                    {busy ? 'Applying…' : 'Apply'}
                  </button>
                  <span style={{ fontSize: 11, color: C.textMuted }}>Replaces that client's Schedule of Rates with these lines.</span>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                  <button style={btnSecondary} onClick={() => setItemForm({ ...blankItem, set_id: s.id })}>+ Add line</button>
                </div>
                {CATS.filter(cat => mine.some(i => (i.category || 'other') === cat)).map(cat => (
                  <div key={cat} style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.accent, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>{cat}</div>
                    <TableWrap>
                      <thead><tr><Th>Description</Th><Th>UOM</Th><Th>A</Th><Th>B</Th><Th>C</Th><Th /></tr></thead>
                      <tbody>
                        {mine.filter(i => (i.category || 'other') === cat).map(i => (
                          <tr key={i.id}>
                            <Td>
                              {i.role_name}
                              {i.notes && <div style={{ fontSize: 11, color: C.textMuted }}>{i.notes}</div>}
                            </Td>
                            <Td>{i.uom || '—'}</Td>
                            <Td>{i.rate_a != null ? `$${Number(i.rate_a).toFixed(2)}` : 'POR'}</Td>
                            <Td>{i.rate_b != null ? `$${Number(i.rate_b).toFixed(2)}` : '—'}</Td>
                            <Td>{i.rate_c != null ? `$${Number(i.rate_c).toFixed(2)}` : '—'}</Td>
                            <Td>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button style={btnSmall} onClick={() => setItemForm({ ...i, rate_a: i.rate_a ?? '', rate_b: i.rate_b ?? '', rate_c: i.rate_c ?? '' })}>Edit</button>
                                <button style={{ ...btnSmall, ...btnDanger }} onClick={() => removeItem(i)}>✕</button>
                              </div>
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </TableWrap>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {setForm && (
        <Modal title={setForm.id ? 'Edit rate set' : 'New rate set'} onClose={() => setSetForm(null)}>
          <Field label="Set name *">
            <input style={inputStyle} value={setForm.name} autoFocus
              onChange={e => setSetForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. CBD SOR 2027-28" />
          </Field>
          <Field label="Notes" hint="Payment terms, who it was prepared for, anything the next person should know.">
            <textarea style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }} value={setForm.notes}
              onChange={e => setSetForm(f => ({ ...f, notes: e.target.value }))} />
          </Field>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button style={btnSecondary} onClick={() => setSetForm(null)}>Cancel</button>
            <button style={btnPrimary} onClick={saveSet} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}

      {itemForm && (
        <Modal title={itemForm.id ? 'Edit line' : 'Add line'} onClose={() => setItemForm(null)} width={560}>
          <Field label="Description *">
            <input style={inputStyle} value={itemForm.role_name} autoFocus
              onChange={e => setItemForm(f => ({ ...f, role_name: e.target.value }))}
              placeholder="e.g. General Labour" />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
            <Field label="Unit">
              <select style={inputStyle} value={itemForm.uom || 'hour'} onChange={e => setItemForm(f => ({ ...f, uom: e.target.value }))}>
                {UOMS.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </Field>
            <Field label="Category">
              <select style={inputStyle} value={itemForm.category || 'labour'} onChange={e => setItemForm(f => ({ ...f, category: e.target.value }))}>
                {CATS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 12px' }}>
            <Field label="A — normal"><input style={inputStyle} type="number" step="0.01" value={itemForm.rate_a} onChange={e => setItemForm(f => ({ ...f, rate_a: e.target.value }))} placeholder="blank = POR" /></Field>
            <Field label="B — 1.5× band"><input style={inputStyle} type="number" step="0.01" value={itemForm.rate_b} onChange={e => setItemForm(f => ({ ...f, rate_b: e.target.value }))} /></Field>
            <Field label="C — 2× band"><input style={inputStyle} type="number" step="0.01" value={itemForm.rate_c} onChange={e => setItemForm(f => ({ ...f, rate_c: e.target.value }))} /></Field>
          </div>
          <Field label="Notes"><input style={inputStyle} value={itemForm.notes || ''} onChange={e => setItemForm(f => ({ ...f, notes: e.target.value }))} /></Field>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button style={btnSecondary} onClick={() => setItemForm(null)}>Cancel</button>
            <button style={btnPrimary} onClick={saveItem} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
