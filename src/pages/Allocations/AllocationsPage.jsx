import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnDanger, btnSmall } from '../../theme';
import { fmtDate, fmtDateTime } from '../../utils/dates';
import { normaliseAUMobile, sendWorkerSms, addAdminNotification, allocationSmsBody } from '../../utils/notify';
import { Spinner, Modal, Field, TableWrap, Th, Td, EmptyState, allocationBadge } from '../../components';

// Find allocations for a given worker that overlap a [start, end] date range
// AND are still live (pending/confirmed). Used to warn the admin before
// double-booking. Excludes the current allocation when editing.
function findConflicts(allAllocations, workerId, startISO, endISO, currentId) {
  if (!workerId || !startISO) return [];
  const winStart = startISO;
  const winEnd   = endISO || startISO;
  return allAllocations.filter(a => {
    if (a.worker_id !== workerId) return false;
    if (currentId && a.id === currentId) return false;
    if (!['pending', 'confirmed'].includes(a.status)) return false;
    const otherStart = a.start_date;
    const otherEnd   = a.end_date || a.start_date;
    if (!otherStart) return false;
    return otherStart <= winEnd && otherEnd >= winStart;
  });
}

const allocDefaults = {
  worker_id: '', site: '', client: '', project: '', address: '', site_supervisor: '',
  manager_phone: '', status: 'pending', start_date: '', end_date: '',
  arrival_time: '', end_time: '', notes: '',
};

export function AllocationsPage({ showToast }) {
  const [allocations, setAllocations] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState('');
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(allocDefaults);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [a, w, c] = await Promise.all([
      supabase.from('allocations').select('*, workers(name, job_title)').order('created_at', { ascending: false }),
      supabase.from('workers').select('id, name, mobile').is('archived_at', null).order('name'),
      supabase.from('clients').select('id, name').order('name'),
    ]);
    if (a.error) showToast(a.error.message, 'error');
    else setAllocations(a.data || []);
    if (w.data) setWorkers(w.data);
    if (c.data) setClients(c.data);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => { setForm(allocDefaults); setModal('add'); };
  const openEdit = (a) => {
    setForm({
      worker_id: a.worker_id || '', site: a.site || '', client: a.client || '',
      project: a.project || '', address: a.address || '',
      site_supervisor: a.site_manager || a.site_supervisor || '',
      manager_phone: a.manager_phone || '', status: a.status, start_date: a.start_date || '',
      end_date: a.end_date || '',
      // Extract time-only from stored datetime
      arrival_time: a.start_time ? a.start_time.slice(11, 16) : '',
      end_time: a.end_time ? a.end_time.slice(11, 16) : '',
      notes: a.notes || '',
    });
    setModal(a);
  };
  const closeModal = () => { setModal(null); setForm(allocDefaults); };

  const conflicts = useMemo(() => {
    if (!modal) return [];
    return findConflicts(
      allocations,
      form.worker_id,
      form.start_date,
      form.end_date,
      modal === 'add' ? null : modal.id
    );
  }, [allocations, form.worker_id, form.start_date, form.end_date, modal]);

  const workerName = useMemo(
    () => workers.find(w => w.id === form.worker_id)?.name || 'This worker',
    [workers, form.worker_id]
  );

  const handleSave = async () => {
    if (!form.worker_id) { showToast('Please select a worker.', 'error'); return; }
    if (conflicts.length > 0) {
      const summary = conflicts.slice(0, 3).map(c =>
        `• ${c.client || c.site || 'Allocated'} (${c.start_date}${c.end_date && c.end_date !== c.start_date ? ` → ${c.end_date}` : ''}, ${c.status})`
      ).join('\n');
      const extra = conflicts.length > 3 ? `\n…and ${conflicts.length - 3} more.` : '';
      const ok = window.confirm(
        `⚠ ${workerName} is already allocated during this period:\n\n${summary}${extra}\n\nContinue and create a clashing allocation anyway?`
      );
      if (!ok) return;
    }
    setSaving(true);
    const payload = {
      worker_id: form.worker_id,
      site: form.site, client: form.client, project: form.project,
      address: form.address,
      site_manager: form.site_supervisor,   // DB column stays site_manager
      manager_phone: form.manager_phone,
      status: form.status,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      // Combine date + time into full timestamp
      start_time: form.arrival_time && form.start_date
        ? `${form.start_date}T${form.arrival_time}` : null,
      end_time: form.end_time && form.start_date
        ? `${form.start_date}T${form.end_time}` : null,
      notes: form.notes || null,
    };
    if (modal === 'add') {
      const { data: inserted, error } = await supabase.from('allocations').insert([payload]).select().single();
      if (error) showToast(error.message, 'error');
      else {
        showToast('Allocation created successfully', 'success');
        notifyOnCreate(inserted);   // fire-and-forget SMS + admin notification
        closeModal();
        load();
      }
    } else {
      const { error } = await supabase.from('allocations').update(payload).eq('id', modal.id);
      if (error) showToast(error.message, 'error');
      else { showToast('Allocation updated successfully', 'success'); closeModal(); load(); }
    }
    setSaving(false);
  };

  // After an allocation is created: text the worker + drop an admin notification.
  // Fire-and-forget — never blocks the UI. `inserted` is the new allocation row.
  const notifyOnCreate = (inserted) => {
    const worker = workers.find(w => w.id === form.worker_id);
    const name = worker?.name || 'Worker';
    const client = inserted?.client || form.client || '';
    const site = inserted?.site || form.site || '';
    const startDate = inserted?.start_date || form.start_date || null;

    // (a) SMS the worker.
    const to = normaliseAUMobile(worker?.mobile);
    if (!to) {
      showToast(`${name} has no mobile on file — SMS skipped.`, 'info');
    } else {
      sendWorkerSms(to, allocationSmsBody({ name, client, site, start_date: startDate })).then(r => {
        if (r.ok) showToast(`SMS sent to ${name} (${r.status || 'queued'}).`, 'success');
        else showToast(`SMS to ${name} failed: ${r.error || 'unknown error'}`, 'error');
      });
    }

    // (b) Admin in-app notification.
    addAdminNotification({
      type: 'allocation_sent',
      title: `Allocation sent to ${name}`,
      body: `${client || site || 'New job'}${startDate ? ` — starts ${startDate}` : ''}`,
      allocation_id: inserted?.id || null,
      worker_id: form.worker_id || null,
    }).then(() => window.dispatchEvent(new CustomEvent('cbd:notify')));
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
          <thead><tr><Th>Worker</Th><Th>Role</Th><Th>Client</Th><Th>Project / Site</Th><Th>Site Supervisor</Th><Th>Start Date</Th><Th>End Date</Th><Th>Status</Th><Th>Actions</Th></tr></thead>
          <tbody>
            {filtered.map(a => (
              <tr key={a.id}>
                <Td>{a.workers?.name || '—'}</Td>
                <Td>
                  {a.workers?.job_title
                    ? <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 5, fontSize: 11, fontWeight: 600, background: 'rgba(249,115,22,0.12)', color: '#f97316', fontFamily: '"DM Mono", monospace' }}>{a.workers.job_title}</span>
                    : <span style={{ color: C.textMuted }}>—</span>}
                </Td>
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
          {conflicts.length > 0 && (
            <div style={{
              background: 'rgba(234,179,8,0.10)',
              border: '1px solid rgba(234,179,8,0.45)',
              borderRadius: 8, padding: '10px 14px', marginBottom: 14,
              fontSize: 12.5, color: '#fde68a',
            }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>
                ⚠ {workerName} is already allocated during this date range
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.55 }}>
                {conflicts.slice(0, 4).map(c => (
                  <li key={c.id} style={{ fontSize: 12 }}>
                    <strong>{c.client || c.site || 'Allocated'}</strong>
                    {' · '}
                    <span style={{ fontFamily: '"DM Mono", monospace' }}>
                      {c.start_date}{c.end_date && c.end_date !== c.start_date ? ` → ${c.end_date}` : ''}
                    </span>
                    {' · '}
                    <span style={{ textTransform: 'capitalize' }}>{c.status}</span>
                  </li>
                ))}
              </ul>
              {conflicts.length > 4 && (
                <div style={{ marginTop: 4, fontSize: 11, opacity: 0.8 }}>…and {conflicts.length - 4} more.</div>
              )}
              <div style={{ marginTop: 8, fontSize: 11, color: '#fde68a', opacity: 0.85 }}>
                You can still save — you'll get a confirm prompt first.
              </div>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Worker *">
                <select style={inputStyle} value={form.worker_id} onChange={e => setForm(f => ({ ...f, worker_id: e.target.value }))}>
                  <option value="">Select a worker…</option>
                  {workers.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Client">
              <>
                <input style={inputStyle} list="alloc-clients-list" value={form.client} onChange={e => setForm(f => ({ ...f, client: e.target.value }))} placeholder="Type or select…" />
                <datalist id="alloc-clients-list">
                  {clients.map(c => <option key={c.id} value={c.name} />)}
                </datalist>
              </>
            </Field>
            <Field label="Project"><input style={inputStyle} value={form.project} onChange={e => setForm(f => ({ ...f, project: e.target.value }))} /></Field>
            <Field label="Site"><input style={inputStyle} value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))} /></Field>
            <Field label="Site Address"><input style={inputStyle} value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} /></Field>
            <Field label="Site Supervisor"><input style={inputStyle} value={form.site_supervisor} onChange={e => setForm(f => ({ ...f, site_supervisor: e.target.value }))} /></Field>
            <Field label="Supervisor Phone"><input style={inputStyle} value={form.manager_phone} onChange={e => setForm(f => ({ ...f, manager_phone: e.target.value }))} /></Field>
            <Field label="Start Date *"><input style={inputStyle} type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} /></Field>
            <Field label="End Date"><input style={inputStyle} type="date" value={form.end_date} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} /></Field>
            <Field label="Status">
              <select style={inputStyle} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                <option value="pending">Pending</option>
                <option value="confirmed">Confirmed</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </Field>
            <Field label="Arrival Time">
              <input style={inputStyle} type="time" value={form.arrival_time} onChange={e => setForm(f => ({ ...f, arrival_time: e.target.value }))} />
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>Date is taken from Start Date above</div>
            </Field>
            <Field label="End Time">
              <input style={inputStyle} type="time" value={form.end_time} onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))} />
            </Field>
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
