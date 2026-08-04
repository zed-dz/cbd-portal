import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, inputStyle, btnPrimary, btnSecondary, btnSmall } from '../../theme';
import { Spinner, TableWrap, Th, Td, EmptyState, Modal, Field } from '../../components';

// Company DEFAULT Schedule of Rates (feedback F5 + F6, 2026-08-04).
//
// One rate card held once for the business. Every line item on it is copied
// onto each NEW client automatically by the trg_clients_apply_default_rates
// trigger, so a new client starts with the full card populated and the office
// only edits the exceptions. Existing clients are never touched implicitly —
// use "Apply to a client" for that, which fills gaps and leaves any
// already-negotiated line alone.
//
// The catch-all A/B/C hourly defaults live in payroll_config
// (default_client_rate_a/b/c) so they share the no-deploy config editor.

// UOMs and categories cover the printed CBD Schedule of Rates 2026/27 — the
// card uses "each way" for floatage and "%" for the regional surcharge, and
// splits plant between wet hire and bolt-on attachments.
// 'm3'/'m2' are ASCII on purpose — the rate-card CHECK constraint lists them
// that way, and 'm³'/'m²' would fail on save.
const UOMS = ['hour', 'shift', 'day', 'ton', 'unit', 'km', 'm3', 'm2', 'lm', 'each', 'each way', '%'];
const CATEGORIES = ['labour', 'plant', 'attachments', 'materials', 'floatage', 'surcharge', 'allowances', 'other'];

const EMPTY_LINE = {
  role_name: '', rate_a: '', rate_b: '', rate_c: '',
  uom: 'hour', category: 'labour', notes: '', sort_order: 0,
};

export function DefaultRatesPage({ showToast }) {
  const [lines, setLines]     = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal]     = useState(null);   // 'add' | line object | 'bulk' | 'apply'
  const [form, setForm]       = useState(EMPTY_LINE);
  const [saving, setSaving]   = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: l, error: le }, { data: c }] = await Promise.all([
      supabase.from('default_rate_card').select('*').order('sort_order').order('role_name'),
      supabase.from('clients').select('id, name').order('name'),
    ]);
    if (le) showToast(le.message, 'error');
    else setLines(l || []);
    setClients(c || []);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const num = v => (v === '' || v == null ? null : parseFloat(v));

  const saveLine = async () => {
    if (!form.role_name.trim()) { showToast('Give the line item a description.', 'error'); return; }
    setSaving(true);
    const payload = {
      role_name:  form.role_name.trim(),
      rate_a:     num(form.rate_a),
      rate_b:     num(form.rate_b),
      rate_c:     num(form.rate_c),
      uom:        form.uom || 'hour',
      category:   form.category || null,
      notes:      form.notes.trim() || null,
      sort_order: parseInt(form.sort_order, 10) || 0,
    };
    const { error } = typeof modal === 'object' && modal?.id
      ? await supabase.from('default_rate_card').update(payload).eq('id', modal.id)
      : await supabase.from('default_rate_card').insert([payload]);
    if (error) showToast(error.message, 'error');
    else { showToast(typeof modal === 'object' && modal?.id ? 'Line item updated' : 'Line item added', 'success'); setModal(null); load(); }
    setSaving(false);
  };

  const removeLine = async (row) => {
    if (!window.confirm(`Remove "${row.role_name}" from the default rate card?\n\nClients that already have it keep their copy.`)) return;
    const { error } = await supabase.from('default_rate_card').delete().eq('id', row.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Line item removed', 'success'); load(); }
  };

  const openAdd  = () => { setForm({ ...EMPTY_LINE, sort_order: (lines.length + 1) * 10 }); setModal('add'); };
  const openEdit = (row) => {
    setForm({
      role_name: row.role_name || '', rate_a: row.rate_a ?? '', rate_b: row.rate_b ?? '',
      rate_c: row.rate_c ?? '', uom: row.uom || 'hour', category: row.category || 'labour',
      notes: row.notes || '', sort_order: row.sort_order ?? 0,
    });
    setModal(row);
  };

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>;

  const grouped = CATEGORIES
    .map(cat => ({ cat, rows: lines.filter(l => (l.category || 'other') === cat) }))
    .filter(g => g.rows.length);
  const uncategorised = lines.filter(l => !CATEGORIES.includes(l.category || 'other'));
  if (uncategorised.length) grouped.push({ cat: 'other', rows: uncategorised });

  return (
    <div>
      <div style={{ background: 'rgba(249,115,22,0.07)', border: '1px solid rgba(249,115,22,0.2)', borderRadius: 10, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: C.textMuted, lineHeight: 1.6 }}>
        💲 <strong style={{ color: C.text }}>Default Schedule of Rates</strong> — the rate card every <em>new</em> client
        starts with. Each line below is copied onto a client the moment you create them, so you only
        edit the exceptions. Existing clients aren't changed — use <strong style={{ color: C.text }}>Apply to a client</strong> for those.
        <br />
        The catch-all A/B/C hourly rates for new clients live in <strong style={{ color: C.text }}>Payroll Config</strong> (<code style={{ fontFamily: '"DM Mono", monospace', fontSize: 11.5, color: C.accent }}>default_client_rate_a/b/c</code>).
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button onClick={openAdd} style={btnPrimary}>+ Add line item</button>
        <button onClick={() => { setForm({ ...EMPTY_LINE, bulk: '' }); setModal('bulk'); }} style={btnSecondary}>📤 Paste many</button>
        <button onClick={() => { setForm({ client_id: '', replace: false }); setModal('apply'); }} style={btnSecondary} disabled={!lines.length}>➡ Apply to a client</button>
        <div style={{ marginLeft: 'auto', alignSelf: 'center', color: C.textMuted, fontSize: 12, fontFamily: '"DM Mono", monospace' }}>
          {lines.length} line item{lines.length === 1 ? '' : 's'}
        </div>
      </div>

      {!lines.length ? (
        <EmptyState message="No default rates yet — add your Schedule of Rates line items and every new client will start with them." />
      ) : grouped.map(({ cat, rows }) => (
        <div key={cat} style={{ marginBottom: 22 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.accent, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>{cat}</div>
          <TableWrap>
            <thead>
              <tr><Th>Description</Th><Th>UOM</Th><Th>A</Th><Th>B</Th><Th>C</Th><Th>Notes</Th><Th>Actions</Th></tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id}>
                  <Td><span style={{ color: C.text, fontWeight: 600 }}>{row.role_name}</span></Td>
                  <Td><span style={{ color: C.textMuted, fontSize: 12 }}>{row.uom}</span></Td>
                  <Td><Money v={row.rate_a} /></Td>
                  <Td><Money v={row.rate_b} /></Td>
                  <Td><Money v={row.rate_c} /></Td>
                  <Td><span style={{ color: C.textMuted, fontSize: 12 }}>{row.notes || '—'}</span></Td>
                  <Td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => openEdit(row)} style={btnSmall}>Edit</button>
                      <button onClick={() => removeLine(row)} style={{ ...btnSmall, color: C.error }}>Remove</button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </div>
      ))}

      {(modal === 'add' || (typeof modal === 'object' && modal?.id)) && (
        <Modal title={modal === 'add' ? 'Add default line item' : 'Edit default line item'} onClose={() => setModal(null)} width={560}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Description *" hint="Exactly as it reads on your printed Schedule of Rates.">
                <input style={inputStyle} value={form.role_name} onChange={e => setForm(f => ({ ...f, role_name: e.target.value }))} placeholder="e.g. Excavator 20t + Operator" />
              </Field>
            </div>
            <Field label="Unit of measure">
              <select style={inputStyle} value={form.uom} onChange={e => setForm(f => ({ ...f, uom: e.target.value }))}>
                {UOMS.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </Field>
            <Field label="Category">
              <select style={inputStyle} value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              <Field label="A — Normal"><input style={inputStyle} type="number" step="0.01" min="0" value={form.rate_a} onChange={e => setForm(f => ({ ...f, rate_a: e.target.value }))} placeholder="e.g. 68.00" /></Field>
              <Field label="B — OT 1.5×" hint="Leave blank for single-rate items."><input style={inputStyle} type="number" step="0.01" min="0" value={form.rate_b} onChange={e => setForm(f => ({ ...f, rate_b: e.target.value }))} placeholder="optional" /></Field>
              <Field label="C — OT 2×" hint="Leave blank for single-rate items."><input style={inputStyle} type="number" step="0.01" min="0" value={form.rate_c} onChange={e => setForm(f => ({ ...f, rate_c: e.target.value }))} placeholder="optional" /></Field>
            </div>
            <Field label="Sort order"><input style={inputStyle} type="number" value={form.sort_order} onChange={e => setForm(f => ({ ...f, sort_order: e.target.value }))} /></Field>
            <Field label="Notes"><input style={inputStyle} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="optional" /></Field>
          </div>
          <ModalActions onCancel={() => setModal(null)} onSave={saveLine} saving={saving} />
        </Modal>
      )}

      {modal === 'bulk' && (
        <BulkPasteModal
          onClose={() => setModal(null)}
          onDone={(n) => { showToast(`${n} line item${n === 1 ? '' : 's'} added`, 'success'); setModal(null); load(); }}
          showToast={showToast}
          startOrder={(lines.length + 1) * 10}
        />
      )}

      {modal === 'apply' && (
        <ApplyToClientModal
          clients={clients}
          onClose={() => setModal(null)}
          showToast={showToast}
        />
      )}
    </div>
  );
}

function Money({ v }) {
  if (v == null) return <span style={{ color: C.textMuted }}>—</span>;
  return <span style={{ fontFamily: '"DM Mono", monospace', color: C.text }}>${Number(v).toFixed(2)}</span>;
}

function ModalActions({ onCancel, onSave, saving, saveLabel = 'Save' }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
      <button onClick={onCancel} style={btnSecondary}>Cancel</button>
      <button onClick={onSave} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : saveLabel}</button>
    </div>
  );
}

// Paste a whole rate card straight out of a PDF/Excel/CSV. Accepts tab, pipe
// or comma separated: Description, UOM, A, B, C, Category, Notes. POR/POA/TBA
// and blanks become null so single-rate items don't get a bogus 0.
function BulkPasteModal({ onClose, onDone, showToast, startOrder }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  const parsed = parseRateLines(text, startOrder);

  const save = async () => {
    if (!parsed.length) { showToast('Nothing to import — check the format.', 'error'); return; }
    setSaving(true);
    const { error } = await supabase.from('default_rate_card').insert(parsed);
    if (error) { showToast(error.message, 'error'); setSaving(false); return; }
    setSaving(false);
    onDone(parsed.length);
  };

  return (
    <Modal title="Paste your Schedule of Rates" onClose={onClose} width={720}>
      <div style={{ color: C.textMuted, fontSize: 12.5, marginBottom: 12, lineHeight: 1.6 }}>
        One line item per row: <code style={{ color: C.accent }}>Description, UOM, A, B, C, Category, Notes</code>.
        Tab, pipe or comma separated — paste straight from Excel or a PDF table.
        Leave B/C blank for single-rate items; <code style={{ color: C.accent }}>POR</code>/<code style={{ color: C.accent }}>POA</code>/<code style={{ color: C.accent }}>TBA</code> are treated as blank.
      </div>
      <textarea
        style={{ ...inputStyle, minHeight: 190, fontFamily: '"DM Mono", monospace', fontSize: 12.5, resize: 'vertical' }}
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={'General Labourer\thour\t68.00\t95.00\t120.00\tlabour\nExcavator 20t + Operator\thour\t180.00\t\t\tplant\nSite establishment\teach\t950.00\t\t\tother'}
      />
      {!!parsed.length && (
        <div style={{ marginTop: 14, maxHeight: 210, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: R.md }}>
          <TableWrap>
            <thead><tr><Th>Description</Th><Th>UOM</Th><Th>A</Th><Th>B</Th><Th>C</Th><Th>Category</Th></tr></thead>
            <tbody>
              {parsed.map((p, i) => (
                <tr key={i}>
                  <Td>{p.role_name}</Td><Td>{p.uom}</Td>
                  <Td><Money v={p.rate_a} /></Td><Td><Money v={p.rate_b} /></Td><Td><Money v={p.rate_c} /></Td>
                  <Td>{p.category || '—'}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </div>
      )}
      <div style={{ marginTop: 10, color: parsed.length ? C.success : C.textMuted, fontSize: 12 }}>
        {parsed.length ? `${parsed.length} line item${parsed.length === 1 ? '' : 's'} ready to import.` : 'Paste above to preview.'}
      </div>
      <ModalActions onCancel={onClose} onSave={save} saving={saving} saveLabel={`Import ${parsed.length || ''}`.trim()} />
    </Modal>
  );
}

export function parseRateLines(text, startOrder = 0) {
  const rows = (text || '').split(/\r?\n/).map(r => r.trim()).filter(Boolean);
  const out = [];
  rows.forEach((row, i) => {
    const delim = row.includes('\t') ? '\t' : row.includes('|') ? '|' : ',';
    const cells = row.split(delim).map(c => c.trim());
    const name = cells[0];
    if (!name) return;
    // Skip an obvious header row.
    if (i === 0 && /^(description|item|role|service)$/i.test(name)) return;
    const money = (v) => {
      if (v == null) return null;
      const s = String(v).replace(/[$,\s]/g, '');
      if (!s || /^(por|poa|tba|n\/?a|-)$/i.test(s)) return null;
      const n = parseFloat(s);
      return isNaN(n) ? null : n;
    };
    const uomRaw = (cells[1] || 'hour').toLowerCase();
    out.push({
      role_name:  name,
      uom:        UOMS.includes(uomRaw) ? uomRaw : 'hour',
      rate_a:     money(cells[2]),
      rate_b:     money(cells[3]),
      rate_c:     money(cells[4]),
      category:   CATEGORIES.includes((cells[5] || '').toLowerCase()) ? cells[5].toLowerCase() : null,
      notes:      cells[6] || null,
      sort_order: startOrder + (i + 1) * 10,
    });
  });
  return out;
}

function ApplyToClientModal({ clients, onClose, showToast }) {
  const [clientId, setClientId] = useState('');
  const [replace, setReplace]   = useState(false);
  const [busy, setBusy]         = useState(false);

  const apply = async () => {
    if (!clientId) { showToast('Pick a client first.', 'error'); return; }
    setBusy(true);
    const { data, error } = await supabase.rpc('apply_default_rate_card_to_client', {
      p_client_id: clientId, p_replace: replace,
    });
    if (error) showToast(error.message, 'error');
    else showToast(`${data ?? 0} line item${data === 1 ? '' : 's'} added to the client.`, 'success');
    setBusy(false);
    if (!error) onClose();
  };

  return (
    <Modal title="Apply the default rates to a client" onClose={onClose} width={520}>
      <Field label="Client">
        <select style={inputStyle} value={clientId} onChange={e => setClientId(e.target.value)}>
          <option value="">Choose a client…</option>
          {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', marginTop: 6 }}>
        <input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} style={{ marginTop: 3, accentColor: C.accent, width: 16, height: 16, flexShrink: 0 }} />
        <span>
          <span style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>Replace the client's existing rate card</span>
          <span style={{ display: 'block', color: C.textMuted, fontSize: 11.5, marginTop: 3, lineHeight: 1.5 }}>
            Off (recommended): only line items the client is missing get added — anything you've
            already negotiated with them is left exactly as it is. On: wipes their card first.
          </span>
        </span>
      </label>
      <ModalActions onCancel={onClose} onSave={apply} saving={busy} saveLabel="Apply" />
    </Modal>
  );
}
