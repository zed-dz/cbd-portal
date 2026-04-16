import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnDanger, btnSmall } from '../../theme';
import { todayISO } from '../../utils/dates';
import { downloadCSV } from '../../utils/csv';
import { Spinner, Modal, Field, TableWrap, Th, Td, EmptyState } from '../../components';

const clientDefaults = {
  name: '', site: '', contact: '', contact_email: '', contact_phone: '',
  rate_regular: '', rate_overtime: '', rate_night: '', rate_weekend: '',
  charge_travel: '', charge_meal: '', notes: '',
};

export function ClientsPage({ showToast }) {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(clientDefaults);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('clients').select('*').order('name');
    if (error) showToast(error.message, 'error');
    else setClients(data || []);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => { setForm(clientDefaults); setModal('add'); };
  const openEdit = (c) => {
    setForm({
      name: c.name, site: c.site || '', contact: c.contact || '',
      contact_email: c.contact_email || '', contact_phone: c.contact_phone || '',
      rate_regular: c.rate_regular ?? '', rate_overtime: c.rate_overtime ?? '',
      rate_night: c.rate_night ?? '', rate_weekend: c.rate_weekend ?? '',
      charge_travel: c.charge_travel ?? '', charge_meal: c.charge_meal ?? '',
      notes: c.notes || '',
    });
    setModal(c);
  };
  const closeModal = () => { setModal(null); setForm(clientDefaults); };

  const handleSave = async () => {
    if (!form.name.trim()) { showToast('Client name is required.', 'error'); return; }
    setSaving(true);
    const numOrNull = v => v === '' ? null : parseFloat(v);
    const payload = {
      ...form,
      rate_regular: numOrNull(form.rate_regular),
      rate_overtime: numOrNull(form.rate_overtime),
      rate_night: numOrNull(form.rate_night),
      rate_weekend: numOrNull(form.rate_weekend),
      charge_travel: numOrNull(form.charge_travel),
      charge_meal: numOrNull(form.charge_meal),
    };
    if (modal === 'add') {
      const { error } = await supabase.from('clients').insert([payload]);
      if (error) showToast(error.message, 'error');
      else { showToast('Client added successfully', 'success'); closeModal(); load(); }
    } else {
      const { error } = await supabase.from('clients').update(payload).eq('id', modal.id);
      if (error) showToast(error.message, 'error');
      else { showToast('Client updated successfully', 'success'); closeModal(); load(); }
    }
    setSaving(false);
  };

  const handleDelete = async (c) => {
    if (!window.confirm(`Delete client "${c.name}"? This cannot be undone.`)) return;
    const { error } = await supabase.from('clients').delete().eq('id', c.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Client deleted', 'success'); load(); }
  };

  const handleExport = async () => {
    const { data, error } = await supabase.from('clients').select('*');
    if (error) { showToast(error.message, 'error'); return; }
    downloadCSV(`clients_export_${todayISO()}.csv`, data);
    showToast('Clients exported', 'success');
  };

  const filtered = clients.filter(c => !search || c.name.toLowerCase().includes(search.toLowerCase()) || (c.site || '').toLowerCase().includes(search.toLowerCase()) || (c.contact || '').toLowerCase().includes(search.toLowerCase()));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <input style={{ ...inputStyle, maxWidth: 280 }} placeholder="Search by name, site, contact…" value={search} onChange={e => setSearch(e.target.value)} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleExport} style={btnSecondary}>↓ Export CSV</button>
          <button onClick={openAdd} style={btnPrimary}>+ Add Client</button>
        </div>
      </div>

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div> : filtered.length === 0 ? (
        <EmptyState message="No clients yet. Add your first client to get started." />
      ) : (
        <TableWrap>
          <thead><tr><Th>Client Name</Th><Th>Site</Th><Th>Contact</Th><Th>Phone</Th><Th>Rate / hr</Th><Th>OT Rate / hr</Th><Th>Actions</Th></tr></thead>
          <tbody>
            {filtered.map(c => (
              <tr key={c.id}>
                <Td><strong>{c.name}</strong></Td>
                <Td>{c.site || '—'}</Td>
                <Td>
                  <div>{c.contact || '—'}</div>
                  {c.contact_email && <div style={{ fontSize: 12, color: C.textMuted }}>{c.contact_email}</div>}
                </Td>
                <Td>{c.contact_phone || '—'}</Td>
                <Td>
                  {c.rate_regular != null
                    ? <span style={{ fontWeight: 700, color: '#f97316' }}>${parseFloat(c.rate_regular).toFixed(2)}</span>
                    : '—'}
                </Td>
                <Td>
                  {c.rate_overtime != null
                    ? <span style={{ fontWeight: 700, color: C.warning }}>${parseFloat(c.rate_overtime).toFixed(2)}</span>
                    : '—'}
                </Td>
                <Td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => openEdit(c)} style={btnSmall}>Edit</button>
                    <button onClick={() => handleDelete(c)} style={btnDanger}>Delete</button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      {modal && (
        <Modal title={modal === 'add' ? 'Add Client' : 'Edit Client'} onClose={closeModal} width={560}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Client Name *"><input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></Field>
            </div>
            <Field label="Site / Project"><input style={inputStyle} value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))} /></Field>
            <Field label="Contact Person"><input style={inputStyle} value={form.contact} onChange={e => setForm(f => ({ ...f, contact: e.target.value }))} /></Field>
            <Field label="Contact Email"><input style={inputStyle} type="email" value={form.contact_email} onChange={e => setForm(f => ({ ...f, contact_email: e.target.value }))} /></Field>
            <Field label="Contact Phone"><input style={inputStyle} value={form.contact_phone} onChange={e => setForm(f => ({ ...f, contact_phone: e.target.value }))} /></Field>
            <Field label="Regular Rate ($/hr)"><input style={inputStyle} type="number" step="0.01" min="0" value={form.rate_regular} onChange={e => setForm(f => ({ ...f, rate_regular: e.target.value }))} placeholder="e.g. 68.00" /></Field>
            <Field label="OT Rate ($/hr)"><input style={inputStyle} type="number" step="0.01" min="0" value={form.rate_overtime} onChange={e => setForm(f => ({ ...f, rate_overtime: e.target.value }))} placeholder="e.g. 102.00" /></Field>
            <Field label="Night Rate ($/hr)"><input style={inputStyle} type="number" step="0.01" min="0" value={form.rate_night} onChange={e => setForm(f => ({ ...f, rate_night: e.target.value }))} placeholder="e.g. 85.00" /></Field>
            <Field label="Weekend Rate ($/hr)"><input style={inputStyle} type="number" step="0.01" min="0" value={form.rate_weekend} onChange={e => setForm(f => ({ ...f, rate_weekend: e.target.value }))} placeholder="e.g. 102.00" /></Field>
            <Field label="Travel Charge ($)"><input style={inputStyle} type="number" step="0.01" min="0" value={form.charge_travel} onChange={e => setForm(f => ({ ...f, charge_travel: e.target.value }))} /></Field>
            <Field label="Meal Charge ($)"><input style={inputStyle} type="number" step="0.01" min="0" value={form.charge_meal} onChange={e => setForm(f => ({ ...f, charge_meal: e.target.value }))} /></Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Notes"><textarea style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></Field>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={closeModal} style={btnSecondary}>Cancel</button>
            <button onClick={handleSave} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
