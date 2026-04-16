import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnDanger, btnSmall } from '../../theme';
import { fmtDate, fmtDateTime } from '../../utils/dates';
import { Spinner, Modal, Field, TableWrap, Th, Td, EmptyState, allocationBadge } from '../../components';

const allocDefaults = {
  worker_id: '', site: '', client: '', project: '', address: '', site_manager: '',
  manager_phone: '', status: 'pending', start_date: '', end_date: '', start_time: '', end_time: '', notes: '',
};

export function AllocationsPage({ showToast }) {
  const [allocations, setAllocations] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState('');
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(allocDefaults);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [a, w] = await Promise.all([
      supabase.from('allocations').select('*, workers(name)').order('created_at', { ascending: false }),
      supabase.from('workers').select('id, name').order('name'),
    ]);
    if (a.error) showToast(a.error.message, 'error');
    else setAllocations(a.data || []);
    if (w.data) setWorkers(w.data);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => { setForm(allocDefaults); setModal('add'); };
  const openEdit = (a) => {
    setForm({
      worker_id: a.worker_id || '', site: a.site || '', client: a.client || '',
      project: a.project || '', address: a.address || '', site_manager: a.site_manager || '',
      manager_phone: a.manager_phone || '', status: a.status, start_date: a.start_date || '',
      end_date: a.end_date || '', start_time: a.start_time ? a.start_time.slice(0, 16) : '',
      end_time: a.end_time ? a.end_time.slice(0, 16) : '', notes: a.notes || '',
    });
    setModal(a);
  };
  const closeModal = () => { setModal(null); setForm(allocDefaults); };

  const handleSave = async () => {
    if (!form.worker_id) { showToast('Please select a worker.', 'error'); return; }
    setSaving(true);
    const payload = {
      ...form,
      start_time: form.start_time || null,
      end_time: form.end_time || null,
      end_date: form.end_date || null,
    };
    if (modal === 'add') {
      const { error } = await supabase.from('allocations').insert([payload]);
      if (error) showToast(error.message, 'error');
      else { showToast('Allocation created successfully', 'success'); closeModal(); load(); }
    } else {
      const { error } = await supabase.from('allocations').update(payload).eq('id', modal.id);
      if (error) showToast(error.message, 'error');
      else { showToast('Allocation updated successfully', 'success'); closeModal(); load(); }
    }
    setSaving(false);
  };

  const handleDelete = async (a) => {
    if (!window.confirm('Delete this allocation?')) return;
    const { error } = await supabase.from('allocations').delete().eq('id', a.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Allocation deleted', 'success'); load(); }
  };

  const filtered = allocations.filter(a => !filterStatus || a.status === filterStatus);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <select style={{ ...inputStyle, maxWidth: 200 }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="confirmed">Confirmed</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <button onClick={openAdd} style={btnPrimary}>+ Create Allocation</button>
      </div>

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div> : filtered.length === 0 ? (
        <EmptyState message="No allocations found." />
      ) : (
        <TableWrap>
          <thead><tr><Th>Worker</Th><Th>Client</Th><Th>Project / Site</Th><Th>Site Manager</Th><Th>Start Date</Th><Th>End Date</Th><Th>Status</Th><Th>Actions</Th></tr></thead>
          <tbody>
            {filtered.map(a => (
              <tr key={a.id}>
                <Td>{a.workers?.name || '—'}</Td>
                <Td>{a.client || '—'}</Td>
                <Td>
                  <div>{a.project || a.site || '—'}</div>
                  {a.project && a.site && <div style={{ fontSize: 12, color: C.textMuted }}>{a.site}</div>}
                </Td>
                <Td>
                  <div>{a.site_manager || '—'}</div>
                  {a.manager_phone && <div style={{ fontSize: 12, color: C.textMuted }}>{a.manager_phone}</div>}
                </Td>
                <Td>{a.start_date ? fmtDate(a.start_date) : fmtDateTime(a.start_time)}</Td>
                <Td>{a.end_date ? fmtDate(a.end_date) : '—'}</Td>
                <Td>{allocationBadge(a.status)}</Td>
                <Td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => openEdit(a)} style={btnSmall}>Edit</button>
                    <button onClick={() => handleDelete(a)} style={btnDanger}>Delete</button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      {modal && (
        <Modal title={modal === 'add' ? 'Create Allocation' : 'Edit Allocation'} onClose={closeModal} width={560}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Worker *">
                <select style={inputStyle} value={form.worker_id} onChange={e => setForm(f => ({ ...f, worker_id: e.target.value }))}>
                  <option value="">Select a worker…</option>
                  {workers.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Client"><input style={inputStyle} value={form.client} onChange={e => setForm(f => ({ ...f, client: e.target.value }))} /></Field>
            <Field label="Project"><input style={inputStyle} value={form.project} onChange={e => setForm(f => ({ ...f, project: e.target.value }))} /></Field>
            <Field label="Site"><input style={inputStyle} value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))} /></Field>
            <Field label="Site Address"><input style={inputStyle} value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} /></Field>
            <Field label="Site Manager"><input style={inputStyle} value={form.site_manager} onChange={e => setForm(f => ({ ...f, site_manager: e.target.value }))} /></Field>
            <Field label="Manager Phone"><input style={inputStyle} value={form.manager_phone} onChange={e => setForm(f => ({ ...f, manager_phone: e.target.value }))} /></Field>
            <Field label="Start Date"><input style={inputStyle} type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} /></Field>
            <Field label="End Date"><input style={inputStyle} type="date" value={form.end_date} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} /></Field>
            <Field label="Status">
              <select style={inputStyle} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                <option value="pending">Pending</option>
                <option value="confirmed">Confirmed</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </Field>
            <Field label="Arrival Time"><input style={inputStyle} type="datetime-local" value={form.start_time} onChange={e => setForm(f => ({ ...f, start_time: e.target.value }))} /></Field>
            <Field label="End Time"><input style={inputStyle} type="datetime-local" value={form.end_time} onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))} /></Field>
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
