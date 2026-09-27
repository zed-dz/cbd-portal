import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, MONO, inputStyle, btnPrimary, btnSecondary, btnSmall, btnDanger } from '../../theme';
import { Spinner, Modal, Field, TableWrap, Th, Td, EmptyState, Badge } from '../../components';
import { downloadCSV } from '../../utils/csv';
import { todayISO } from '../../utils/dates';
import { logActivity } from '../../utils/activity';

// Rate SETS are the reusable price lists (team request, meeting 2026-09-22:
// "we have five different sets of rates ... go into it and click 'Brefni is on
// these rates, JK's on these rates', hit update"). A set is defined ONCE here;
// applying it to a client COPIES the lines onto that client's own Schedule of
// Rates (client_rate_cards), which is what billing already reads — so applying
// a set can never change how past invoices were calculated, and a one-off
// client tweak on their own schedule stays possible afterwards.
//
// PAY columns (pay_a/b/c) are REFERENCE-ONLY (Dashpivot parity 3.2): they let
// the office see margin per line, but applying a set still copies only the
// CHARGE columns — billing must never read a pay number by accident.

const CATS = ['labour', 'plant', 'attachments', 'materials', 'allowances', 'other'];
const UOMS = ['hour', 'shift', 'day', 'ton', 'unit', 'km', 'm3', 'm2', 'lm', 'each'];
const blankItem = { role_name: '', uom: 'hour', category: 'labour', rate_a: '', rate_b: '', rate_c: '', pay_a: '', pay_b: '', pay_c: '', notes: '' };

const money = v => (v != null ? `$${Number(v).toFixed(2)}` : null);

export function RateSetsPage({ showToast }) {
  const [sets, setSets] = useState([]);
  const [items, setItems] = useState([]);          // all items, filtered per set on render
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(null);          // expanded set id
  const [setForm, setSetForm] = useState(null);    // { name, notes, id? }
  const [itemForm, setItemForm] = useState(null);  // { ...item, set_id, id? }
  const [importFor, setImportFor] = useState(null); // set being CSV-imported into
  const [applyTo, setApplyTo] = useState({});      // set_id -> client_id
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [s, i, c] = await Promise.all([
      supabase.from('rate_sets').select('*').order('name'),
      supabase.from('rate_set_items').select('*').order('sort_order'),
      supabase.from('clients').select('id, name, rate_set_id, archived_at').order('name'),
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
    let error, newId = setForm.id;
    if (setForm.id) {
      ({ error } = await supabase.from('rate_sets').update(payload).eq('id', setForm.id));
    } else {
      const res = await supabase.from('rate_sets').insert([payload]).select('id').single();
      error = res.error; newId = res.data?.id;
    }
    setBusy(false);
    if (error) { showToast(error.message, 'error'); return; }
    logActivity({ verb: setForm.id ? 'updated' : 'created', object_type: 'rate set', object_id: newId || null, after: { name: payload.name } });
    showToast(setForm.id ? 'Rate set updated.' : 'Rate set created.', 'success');
    setSetForm(null); load();
  };

  const removeSet = async (s) => {
    const used = clients.filter(c => c.rate_set_id === s.id);
    if (!window.confirm(`Delete "${s.name}" and its lines?${used.length ? `\n\n${used.length} client(s) point at it — their own Schedule of Rates keeps the copied lines.` : ''}\n\nPrefer Archive if you might need it again.`)) return;
    const { error } = await supabase.from('rate_sets').delete().eq('id', s.id);
    if (error) { showToast(error.message, 'error'); return; }
    logActivity({ verb: 'deleted', object_type: 'rate set', after: { name: s.name } });
    showToast('Rate set deleted.', 'success'); load();
  };

  const toggleArchive = async (s) => {
    const archiving = !s.archived_at;
    const { error } = await supabase.from('rate_sets')
      .update({ archived_at: archiving ? new Date().toISOString() : null }).eq('id', s.id);
    if (error) { showToast(error.message, 'error'); return; }
    logActivity({ verb: archiving ? 'archived' : 'restored', object_type: 'rate set', object_id: s.id, after: { name: s.name } });
    showToast(archiving ? `"${s.name}" archived — hidden until you tick "Show archived".` : `"${s.name}" restored.`, 'success');
    load();
  };

  const duplicateSet = async (s) => {
    const lines = items.filter(i => i.set_id === s.id);
    setBusy(true);
    const { data: created, error } = await supabase.from('rate_sets')
      .insert([{ name: `${s.name} (copy)`, notes: s.notes || null }]).select('id').single();
    if (error || !created) { setBusy(false); showToast(error?.message || 'Duplicate failed.', 'error'); return; }
    if (lines.length) {
      const { error: liErr } = await supabase.from('rate_set_items').insert(lines.map(i => ({
        set_id: created.id, role_name: i.role_name, uom: i.uom, category: i.category,
        rate_a: i.rate_a, rate_b: i.rate_b, rate_c: i.rate_c,
        pay_a: i.pay_a, pay_b: i.pay_b, pay_c: i.pay_c,
        notes: i.notes, sort_order: i.sort_order,
      })));
      if (liErr) { setBusy(false); showToast(`Set created but lines failed to copy: ${liErr.message}`, 'error'); load(); return; }
    }
    setBusy(false);
    logActivity({ verb: 'duplicated', object_type: 'rate set', object_id: created.id, after: { name: `${s.name} (copy)`, lines: lines.length } });
    showToast(`Duplicated as "${s.name} (copy)" (${lines.length} lines).`, 'success');
    setOpen(created.id); load();
  };

  const exportSetCSV = (s) => {
    const lines = items.filter(i => i.set_id === s.id);
    if (!lines.length) { showToast('This set has no lines to export.', 'error'); return; }
    downloadCSV(`rate_set_${s.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}_${todayISO()}.csv`, lines.map(i => ({
      description: i.role_name, uom: i.uom || '', category: i.category || '',
      rate_a: i.rate_a ?? '', rate_b: i.rate_b ?? '', rate_c: i.rate_c ?? '',
      pay_a: i.pay_a ?? '', pay_b: i.pay_b ?? '', pay_c: i.pay_c ?? '',
      notes: i.notes || '',
    })));
    showToast('Rate set exported.', 'success');
  };

  const saveItem = async () => {
    if (!itemForm.role_name.trim()) { showToast('Description is required.', 'error'); return; }
    setBusy(true);
    const n = v => (v === '' || v == null) ? null : parseFloat(v);
    const payload = {
      set_id: itemForm.set_id, role_name: itemForm.role_name.trim(),
      uom: itemForm.uom || null, category: itemForm.category || null,
      rate_a: n(itemForm.rate_a), rate_b: n(itemForm.rate_b), rate_c: n(itemForm.rate_c),
      pay_a: n(itemForm.pay_a), pay_b: n(itemForm.pay_b), pay_c: n(itemForm.pay_c),
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

  // Apply = copy this set's CHARGE lines onto the client's Schedule of Rates.
  // Pay columns are reference-only and deliberately NOT copied — billing reads
  // client_rate_cards and must never see a pay number.
  // Insert the new lines FIRST, then delete the old ones — a failed insert
  // must never strand the client with an empty schedule (same rule as the
  // rates uploader).
  const applySet = async (s) => {
    const clientId = applyTo[s.id];
    if (!clientId) { showToast('Pick a client to apply this set to.', 'error'); return; }
    const client = clients.find(c => c.id === clientId);
    const lines = items.filter(i => i.set_id === s.id);
    if (!lines.length) { showToast('This set has no lines yet.', 'error'); return; }
    if (!window.confirm(`Apply "${s.name}" (${lines.length} lines) to ${client?.name}?\n\nTheir current Schedule of Rates will be replaced by this set's CHARGE columns (pay columns stay here as reference).`)) return;
    setBusy(true);
    const { data: oldRows } = await supabase.from('client_rate_cards').select('id').eq('client_id', clientId);
    const { error: insErr } = await supabase.from('client_rate_cards').insert(lines.map(i => ({
      client_id: clientId, role_name: i.role_name, uom: i.uom, category: i.category,
      rate_a: i.rate_a, rate_b: i.rate_b, rate_c: i.rate_c, notes: i.notes, sort_order: i.sort_order,
    })));
    if (insErr) { setBusy(false); showToast(`Nothing changed — insert failed: ${insErr.message}`, 'error'); return; }
    const oldIds = (oldRows || []).map(r => r.id);
    if (oldIds.length) {
      const { error: delErr } = await supabase.from('client_rate_cards').delete().in('id', oldIds);
      if (delErr) {
        setBusy(false);
        showToast(`New lines added but the OLD schedule could not be removed — ${client?.name} now has duplicates. Fix in Clients & Rates. (${delErr.message})`, 'error');
        load();
        return;
      }
    }
    const { error: stampErr } = await supabase.from('clients').update({ rate_set_id: s.id }).eq('id', clientId);
    if (stampErr) showToast(`Rates applied, but tagging the client with the set failed: ${stampErr.message}`, 'error');
    setBusy(false);
    logActivity({ verb: 'applied', object_type: 'rate set', object_id: s.id, client_id: clientId, after: { name: `${s.name} → ${client?.name}`, lines: lines.length } });
    showToast(`"${s.name}" applied to ${client?.name} (${lines.length} lines).`, 'success');
    load();
  };

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>;

  const visibleSets = sets.filter(s => showArchived || !s.archived_at);
  const archivedCount = sets.filter(s => s.archived_at).length;

  return (
    <div>
      <div style={{ background: 'rgba(249,115,22,0.07)', border: '1px solid rgba(249,115,22,0.2)', borderRadius: 10, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: C.textMuted }}>
        📚 <strong style={{ color: C.text }}>Rate Sets</strong> — your reusable price lists. Define a set once, then apply it to any client:
        their <strong style={{ color: C.text }}>Schedule of Rates</strong> gets a copy of the <strong style={{ color: C.text }}>charge</strong> lines, and billing reads that copy.
        Pay columns are reference-only for margin checks. A one-off tweak for a single client still happens on their own schedule under <strong style={{ color: C.text }}>Clients &amp; Rates</strong>.
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 10, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: C.textMuted, cursor: 'pointer' }}>
          <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} style={{ accentColor: C.accent, width: 15, height: 15 }} />
          Show archived{archivedCount ? ` (${archivedCount})` : ''}
        </label>
        <button style={btnPrimary} onClick={() => setSetForm({ name: '', notes: '' })}>+ New rate set</button>
      </div>

      {visibleSets.length === 0 ? <EmptyState message={sets.length ? 'All rate sets are archived — tick "Show archived" to see them.' : 'No rate sets yet — create the first one.'} icon="📚" /> : visibleSets.map(s => {
        const mine = items.filter(i => i.set_id === s.id);
        const users = clients.filter(c => c.rate_set_id === s.id);
        const expanded = open === s.id;
        return (
          <div key={s.id} style={{ border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 12, background: C.card, opacity: s.archived_at ? 0.72 : 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '14px 16px', cursor: 'pointer', flexWrap: 'wrap' }}
              onClick={() => setOpen(expanded ? null : s.id)}>
              <div style={{ minWidth: 220 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: C.text, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {expanded ? '▾' : '▸'} {s.name}
                  {s.archived_at && <Badge label="Archived" color="gray" size="sm" />}
                </div>
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                  {mine.length} line{mine.length === 1 ? '' : 's'}
                  {users.length > 0 && <> · used by {users.map(u => u.name).join(', ')}</>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} onClick={e => e.stopPropagation()}>
                <button style={btnSmall} onClick={() => setSetForm({ id: s.id, name: s.name, notes: s.notes || '' })}>Edit</button>
                <button style={btnSmall} disabled={busy} onClick={() => duplicateSet(s)}>Duplicate</button>
                <button style={btnSmall} onClick={() => exportSetCSV(s)}>↓ CSV</button>
                <button style={btnSmall} onClick={() => setImportFor(s)}>↑ Import</button>
                <button style={btnSmall} onClick={() => toggleArchive(s)}>{s.archived_at ? 'Unarchive' : 'Archive'}</button>
                <button style={{ ...btnSmall, ...btnDanger }} onClick={() => removeSet(s)}>Delete</button>
              </div>
            </div>

            {expanded && (
              <div style={{ borderTop: `1px solid ${C.border}`, padding: '12px 16px' }}>
                {s.notes && <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 10 }}>{s.notes}</div>}

                {!s.archived_at && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12, background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.22)', borderRadius: 8, padding: '10px 12px' }}>
                    <span style={{ fontSize: 12.5, color: C.text, fontWeight: 600 }}>Apply this set to:</span>
                    <select style={{ ...inputStyle, maxWidth: 260 }} value={applyTo[s.id] || ''}
                      onChange={e => setApplyTo(a => ({ ...a, [s.id]: e.target.value }))}>
                      <option value="">Select a client…</option>
                      {clients.filter(c => !c.archived_at).map(c => <option key={c.id} value={c.id}>{c.name}{c.rate_set_id === s.id ? ' (already on this set)' : ''}</option>)}
                    </select>
                    <button style={{ ...btnPrimary, padding: '8px 16px' }} disabled={busy} onClick={() => applySet(s)}>
                      {busy ? 'Applying…' : 'Apply'}
                    </button>
                    <span style={{ fontSize: 11, color: C.textMuted }}>Replaces that client's Schedule of Rates with these lines — charge columns only; pay columns are never copied.</span>
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, color: C.textMuted }}>
                    <span style={{ fontFamily: MONO, color: C.accent }}>CHARGE A·B·C</span> is billed to the client ·{' '}
                    <span style={{ fontFamily: MONO, color: C.info }}>PAY A·B·C</span> is reference-only (not copied on apply)
                  </span>
                  <button style={btnSecondary} onClick={() => setItemForm({ ...blankItem, set_id: s.id })}>+ Add line</button>
                </div>
                {CATS.filter(cat => mine.some(i => (i.category || 'other') === cat)).map(cat => (
                  <div key={cat} style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.accent, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>{cat}</div>
                    <TableWrap>
                      <thead><tr><Th>Description</Th><Th>UOM</Th><Th>Charge A</Th><Th>B</Th><Th>C</Th><Th>Pay A</Th><Th>Pay B</Th><Th>Pay C</Th><Th /></tr></thead>
                      <tbody>
                        {mine.filter(i => (i.category || 'other') === cat).map(i => (
                          <tr key={i.id}>
                            <Td>
                              {i.role_name}
                              {i.notes && <div style={{ fontSize: 11, color: C.textMuted }}>{i.notes}</div>}
                            </Td>
                            <Td>{i.uom || '—'}</Td>
                            <Td>{money(i.rate_a) || 'POR'}</Td>
                            <Td>{money(i.rate_b) || '—'}</Td>
                            <Td>{money(i.rate_c) || '—'}</Td>
                            <Td style={{ color: C.info }}>{money(i.pay_a) || '—'}</Td>
                            <Td style={{ color: C.info }}>{money(i.pay_b) || '—'}</Td>
                            <Td style={{ color: C.info }}>{money(i.pay_c) || '—'}</Td>
                            <Td>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button style={btnSmall} onClick={() => setItemForm({
                                  ...i,
                                  rate_a: i.rate_a ?? '', rate_b: i.rate_b ?? '', rate_c: i.rate_c ?? '',
                                  pay_a: i.pay_a ?? '', pay_b: i.pay_b ?? '', pay_c: i.pay_c ?? '',
                                })}>Edit</button>
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
        <Modal title={itemForm.id ? 'Edit line' : 'Add line'} onClose={() => setItemForm(null)} width={620}>
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
          <div style={{ fontSize: 11, fontWeight: 700, color: C.accent, letterSpacing: 1, margin: '4px 0 6px' }}>CHARGE — billed to the client</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 12px' }}>
            <Field label="A — normal"><input style={inputStyle} type="number" step="0.01" value={itemForm.rate_a} onChange={e => setItemForm(f => ({ ...f, rate_a: e.target.value }))} placeholder="blank = POR" /></Field>
            <Field label="B — 1.5× band"><input style={inputStyle} type="number" step="0.01" value={itemForm.rate_b} onChange={e => setItemForm(f => ({ ...f, rate_b: e.target.value }))} /></Field>
            <Field label="C — 2× band"><input style={inputStyle} type="number" step="0.01" value={itemForm.rate_c} onChange={e => setItemForm(f => ({ ...f, rate_c: e.target.value }))} /></Field>
          </div>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.info, letterSpacing: 1, margin: '4px 0 6px' }}>PAY — reference only, never copied to a client</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 12px' }}>
            <Field label="Pay A"><input style={inputStyle} type="number" step="0.01" value={itemForm.pay_a} onChange={e => setItemForm(f => ({ ...f, pay_a: e.target.value }))} /></Field>
            <Field label="Pay B"><input style={inputStyle} type="number" step="0.01" value={itemForm.pay_b} onChange={e => setItemForm(f => ({ ...f, pay_b: e.target.value }))} /></Field>
            <Field label="Pay C"><input style={inputStyle} type="number" step="0.01" value={itemForm.pay_c} onChange={e => setItemForm(f => ({ ...f, pay_c: e.target.value }))} /></Field>
          </div>
          <Field label="Notes"><input style={inputStyle} value={itemForm.notes || ''} onChange={e => setItemForm(f => ({ ...f, notes: e.target.value }))} /></Field>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button style={btnSecondary} onClick={() => setItemForm(null)}>Cancel</button>
            <button style={btnPrimary} onClick={saveItem} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}

      {importFor && (
        <ImportSetCSVModal
          set={importFor}
          existingCount={items.filter(i => i.set_id === importFor.id).length}
          maxSort={Math.max(0, ...items.filter(i => i.set_id === importFor.id).map(i => i.sort_order || 0))}
          showToast={showToast}
          onClose={() => setImportFor(null)}
          onSaved={() => { setImportFor(null); setOpen(importFor.id); load(); }}
        />
      )}
    </div>
  );
}

// ── CSV import for one set ──────────────────────────────────────────────────
// Paste-area modal. Tolerant header matching for:
//   description,uom,category,rate_a,rate_b,rate_c,pay_a,pay_b,pay_c[,notes]
// No header row → those columns are assumed positionally in that order.

// pay_* entries sit BEFORE rate_* on purpose: matching walks this object in
// order, and "Pay Normal" must hit pay_a before rate_a's 'normal' swallows it.
const IMPORT_SYNONYMS = {
  description: ['description', 'desc', 'name', 'role', 'role name', 'line item', 'line', 'item'],
  uom:         ['uom', 'unit', 'units', 'um'],
  category:    ['category', 'section', 'group', 'type', 'cat'],
  pay_a:       ['pay_a', 'pay a', 'pay normal', 'pay'],
  pay_b:       ['pay_b', 'pay b', 'pay 1.5', 'pay 1.5x'],
  pay_c:       ['pay_c', 'pay c', 'pay 2', 'pay 2x', 'pay 2.0x'],
  rate_a:      ['rate_a', 'rate a', 'charge a', 'charge_a', 'a', 'normal', 'charge normal'],
  rate_b:      ['rate_b', 'rate b', 'charge b', 'charge_b', 'b', 'ot 1.5', '1.5x', 'charge 1.5'],
  rate_c:      ['rate_c', 'rate c', 'charge c', 'charge_c', 'c', 'ot 2', '2.0x', '2x', 'charge 2'],
  notes:       ['notes', 'note', 'comment', 'remark'],
};
const IMPORT_POSITIONAL = ['description', 'uom', 'category', 'rate_a', 'rate_b', 'rate_c', 'pay_a', 'pay_b', 'pay_c', 'notes'];

function importDelim(text) {
  const first = text.split(/\r?\n/).find(l => l.trim()) || '';
  if (first.includes('\t')) return '\t';
  if (first.includes('|')) return '|';
  return ',';
}
function importSplit(line, delim) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
    if (ch === '"') { q = !q; continue; }
    if (ch === delim && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}
function importNum(raw) {
  const s = (raw ?? '').toString().trim();
  if (!s || /^(POR|POA|TBA|N\/A)$/i.test(s)) return null;
  const n = parseFloat(s.replace(/[$,\s]/g, ''));
  return isNaN(n) ? null : n;
}
function importHeaders(firstRow) {
  const norm = s => (s || '').toString().toLowerCase().replace(/[\s_·\-+/().]+/g, ' ').replace(/\s+/g, ' ').trim();
  const map = {}; let hits = 0;
  firstRow.map(norm).forEach((h, idx) => {
    for (const [canon, syns] of Object.entries(IMPORT_SYNONYMS)) {
      // ≤2-char synonyms ("a","b","c") must match exactly or they misfire.
      if (syns.some(sy => sy.length <= 2 ? h === sy : (h === sy || h.includes(sy)))) {
        if (map[idx] == null) { map[idx] = canon; hits++; }
        break;
      }
    }
  });
  return hits >= 2 ? map : null;
}
function parseSetCSV(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return { rows: [], skipped: [] };
  const delim = importDelim(text);
  const cells = lines.map(l => importSplit(l, delim));
  const headerMap = importHeaders(cells[0]);
  const rows = []; const skipped = [];
  for (let i = headerMap ? 1 : 0; i < cells.length; i++) {
    const row = cells[i];
    const get = (key) => {
      if (headerMap) {
        const idx = Object.entries(headerMap).find(([, v]) => v === key)?.[0];
        return idx != null ? row[idx] : '';
      }
      const idx = IMPORT_POSITIONAL.indexOf(key);
      return idx >= 0 ? row[idx] : '';
    };
    const description = (get('description') || '').trim();
    if (!description) { skipped.push({ line: i + 1, reason: 'no description' }); continue; }
    const uomRaw = (get('uom') || '').toString().trim().toLowerCase().replace(/[\s.]/g, '');
    const catRaw = (get('category') || '').toString().trim().toLowerCase();
    rows.push({
      role_name: description,
      uom: UOMS.includes(uomRaw) ? uomRaw : 'hour',
      category: CATS.find(c => catRaw.includes(c.slice(0, 5))) || null,
      rate_a: importNum(get('rate_a')), rate_b: importNum(get('rate_b')), rate_c: importNum(get('rate_c')),
      pay_a: importNum(get('pay_a')), pay_b: importNum(get('pay_b')), pay_c: importNum(get('pay_c')),
      notes: (get('notes') || '').trim() || null,
    });
  }
  return { rows, skipped };
}

function ImportSetCSVModal({ set, existingCount, maxSort, showToast, onClose, onSaved }) {
  const [text, setText] = useState('');
  const [replace, setReplace] = useState(false);
  const [saving, setSaving] = useState(false);
  const parsed = parseSetCSV(text);

  const handleSave = async () => {
    if (!parsed.rows.length) { showToast('Nothing to import.', 'error'); return; }
    if (replace && existingCount && !window.confirm(`Replace all ${existingCount} existing lines in "${set.name}" with the ${parsed.rows.length} pasted rows?`)) return;
    setSaving(true);
    const { data: oldRows } = replace
      ? await supabase.from('rate_set_items').select('id').eq('set_id', set.id)
      : { data: [] };
    // Insert first, delete after (when replacing) — a failed insert must never
    // strand the set empty. Same rule as apply + the client rates uploader.
    const { error } = await supabase.from('rate_set_items').insert(parsed.rows.map((r, idx) => ({
      set_id: set.id, ...r, sort_order: (replace ? 0 : maxSort + 10) + idx * 10,
    })));
    if (error) { setSaving(false); showToast(`Nothing changed — insert failed: ${error.message}`, 'error'); return; }
    if (replace && oldRows?.length) {
      await supabase.from('rate_set_items').delete().in('id', oldRows.map(r => r.id));
    }
    setSaving(false);
    logActivity({ verb: 'imported', object_type: 'rate set', object_id: set.id, after: { name: set.name, lines: parsed.rows.length, replaced: replace } });
    showToast(`${parsed.rows.length} line${parsed.rows.length === 1 ? '' : 's'} imported into "${set.name}".`, 'success');
    onSaved();
  };

  return (
    <Modal title={`↑ Import CSV — ${set.name}`} onClose={onClose} width={720}>
      <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 12, lineHeight: 1.55 }}>
        Paste rows (comma, tab or pipe separated). Headers are matched tolerantly:{' '}
        <span style={{ fontFamily: MONO, fontSize: 11 }}>description, uom, category, rate_a, rate_b, rate_c, pay_a, pay_b, pay_c</span>.
        Without a header row the columns are assumed in that order. POR / blank prices stay empty.
      </div>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        spellCheck={false}
        placeholder={'description,uom,category,rate_a,rate_b,rate_c,pay_a,pay_b,pay_c\nGeneral Labour,hour,labour,60.15,85.05,103.50,38.50,57.75,77.00'}
        style={{ ...inputStyle, minHeight: 180, resize: 'vertical', fontFamily: MONO, fontSize: 12, lineHeight: 1.5 }}
      />
      {(parsed.rows.length > 0 || parsed.skipped.length > 0) && (
        <div style={{ display: 'flex', gap: 12, margin: '10px 0 4px', fontSize: 12 }}>
          <span style={{ color: C.success }}>✓ {parsed.rows.length} valid</span>
          {parsed.skipped.length > 0 && <span style={{ color: C.warning }}>⚠ {parsed.skipped.length} skipped (no description)</span>}
        </div>
      )}
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.textMuted, marginTop: 8 }}>
        <input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} style={{ accentColor: C.accent }} />
        Replace this set's existing {existingCount} line{existingCount === 1 ? '' : 's'} (otherwise rows are appended)
      </label>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
        <button onClick={onClose} style={btnSecondary}>Cancel</button>
        <button onClick={handleSave} disabled={saving || !parsed.rows.length} style={btnPrimary}>
          {saving ? 'Importing…' : `Import ${parsed.rows.length || ''} lines`}
        </button>
      </div>
    </Modal>
  );
}
