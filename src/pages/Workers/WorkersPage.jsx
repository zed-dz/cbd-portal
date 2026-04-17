import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnDanger, btnSmall } from '../../theme';
import { Spinner, Badge, Modal, Field, TableWrap, Th, Td, EmptyState } from '../../components';
import { JOB_TITLES } from '../../constants/jobTitles';
import { WORKER_TYPES } from '../../constants/scenarios';

const workerDefaults = {
  name: '', email: '', mobile: '', role: 'worker', job_title: '', licences: '',
  address: '', access_level: 'employee', status: 'available', app_status: 'Active',
  site: '', client: '', worker_type: 'casual', pay_rate_regular: '', pay_rate_overtime: '',
  subcontractor_abn: '',
};

export function WorkersPage({ showToast }) {
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(workerDefaults);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('workers').select('*').order('created_at', { ascending: false });
    if (error) showToast(error.message, 'error');
    else setWorkers(data || []);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => { setForm(workerDefaults); setModal('add'); };
  const openEdit = (w) => {
    setForm({
      name: w.name, email: w.email, mobile: w.mobile || '', role: w.role,
      job_title: w.job_title || '', licences: w.licences || '', address: w.address || '',
      access_level: w.access_level || 'employee', status: w.status,
      app_status: w.app_status || 'Active', site: w.site || '', client: w.client || '',
      worker_type: w.worker_type || 'casual', pay_rate_regular: w.pay_rate_regular ?? '',
      pay_rate_overtime: w.pay_rate_overtime ?? '', subcontractor_abn: w.subcontractor_abn || '',
    });
    setModal(w);
  };
  const closeModal = () => { setModal(null); setForm(workerDefaults); };

  const handleSave = async () => {
    if (!form.name.trim() || !form.email.trim()) { showToast('Name and email are required.', 'error'); return; }
    setSaving(true);
    const payload = {
      ...form,
      pay_rate_regular: form.pay_rate_regular === '' ? null : parseFloat(form.pay_rate_regular),
      pay_rate_overtime: form.pay_rate_overtime === '' ? null : parseFloat(form.pay_rate_overtime),
    };
    if (modal === 'add') {
      const { error } = await supabase.from('workers').insert([payload]);
      if (error) showToast(error.message, 'error');
      else { showToast('Worker created successfully', 'success'); closeModal(); load(); }
    } else {
      const { error } = await supabase.from('workers').update(payload).eq('id', modal.id);
      if (error) showToast(error.message, 'error');
      else { showToast('Worker updated successfully', 'success'); closeModal(); load(); }
    }
    setSaving(false);
  };

  const handleDelete = async (w) => {
    if (!window.confirm(`Delete ${w.name}? This cannot be undone.`)) return;
    const { error } = await supabase.from('workers').delete().eq('id', w.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Worker deleted', 'success'); load(); }
  };

  const filtered = workers.filter(w => w.name.toLowerCase().includes(search.toLowerCase()) || w.email.toLowerCase().includes(search.toLowerCase()));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <input style={{ ...inputStyle, maxWidth: 280 }} placeholder="Search by name or email…" value={search} onChange={e => setSearch(e.target.value)} />
        <button onClick={openAdd} style={btnPrimary}>+ Add Worker</button>
      </div>

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div> : filtered.length === 0 ? (
        <EmptyState message="No workers found. Add one to get started." />
      ) : (
        <TableWrap>
          <thead><tr><Th>Name</Th><Th>Job Title</Th><Th>Type</Th><Th>Pay Rate</Th><Th>Mobile</Th><Th>Licences</Th><Th>Status</Th><Th>App Status</Th><Th>Actions</Th></tr></thead>
          <tbody>
            {filtered.map(w => (
              <tr key={w.id}>
                <Td>
                  <div><strong>{w.name}</strong></div>
                  <div style={{ fontSize: 12, color: C.textMuted }}>{w.email}</div>
                </Td>
                <Td>{w.job_title || <span style={{ color: C.textMuted }}>—</span>}</Td>
                <Td>
                  <span style={{ fontSize: 11, color: C.textMuted, fontFamily: '"DM Mono", monospace' }}>
                    {w.worker_type || 'casual'}
                  </span>
                </Td>
                <Td>
                  {w.pay_rate_regular != null
                    ? <span style={{ fontFamily: '"DM Mono", monospace', fontSize: 12, color: C.success, fontWeight: 600 }}>${parseFloat(w.pay_rate_regular).toFixed(2)}/hr</span>
                    : <span style={{ color: C.textMuted, fontSize: 12 }}>Not set</span>}
                </Td>
                <Td>{w.mobile || '—'}</Td>
                <Td><span style={{ fontSize: 12, color: C.textMuted }}>{w.licences || '—'}</span></Td>
                <Td><Badge label={w.status || 'available'} color={w.status === 'on_site' ? 'green' : w.status === 'job_details_sent' ? 'yellow' : 'blue'} /></Td>
                <Td><Badge label={w.app_status || 'Active'} color={w.app_status === 'Active' ? 'green' : w.app_status === 'Profile Incomplete' ? 'yellow' : 'gray'} /></Td>
                <Td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => openEdit(w)} style={btnSmall}>Edit</button>
                    <button onClick={() => handleDelete(w)} style={btnDanger}>Delete</button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      {modal && (
        <Modal title={modal === 'add' ? 'Add Worker' : 'Edit Worker'} onClose={closeModal} width={580}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <Field label="Full Name *"><input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></Field>
            <Field label="Email *"><input style={inputStyle} type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} /></Field>
            <Field label="Mobile"><input style={inputStyle} value={form.mobile} onChange={e => setForm(f => ({ ...f, mobile: e.target.value }))} /></Field>
            <Field label="Job Title">
              <>
                <input style={inputStyle} list="job-titles-list" value={form.job_title} onChange={e => setForm(f => ({ ...f, job_title: e.target.value }))} placeholder="Type or select a role…" />
                <datalist id="job-titles-list">
                  {JOB_TITLES.map(t => <option key={t} value={t} />)}
                </datalist>
              </>
            </Field>
            <Field label="Licences / Tickets"><input style={inputStyle} value={form.licences} onChange={e => setForm(f => ({ ...f, licences: e.target.value }))} placeholder="e.g. EWP, VOC Excavator, RIW…" /></Field>
            <Field label="Address"><input style={inputStyle} value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} /></Field>
            <Field label="Portal Access">
              <select style={inputStyle} value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                <option value="worker">Worker</option>
                <option value="admin">Admin</option>
              </select>
            </Field>
            <Field label="Access Level">
              <select style={inputStyle} value={form.access_level} onChange={e => setForm(f => ({ ...f, access_level: e.target.value }))}>
                <option value="employee">Employee</option>
                <option value="manager">Manager</option>
              </select>
            </Field>
            <Field label="Worker Type">
              <select style={inputStyle} value={form.worker_type} onChange={e => setForm(f => ({ ...f, worker_type: e.target.value }))}>
                {WORKER_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="Pay Rate Regular ($/hr)">
              <input style={inputStyle} type="number" step="0.01" min="0" value={form.pay_rate_regular} onChange={e => setForm(f => ({ ...f, pay_rate_regular: e.target.value }))} placeholder="e.g. 35.00" />
            </Field>
            <Field label="Pay Rate Overtime ($/hr)">
              <input style={inputStyle} type="number" step="0.01" min="0" value={form.pay_rate_overtime} onChange={e => setForm(f => ({ ...f, pay_rate_overtime: e.target.value }))} placeholder="e.g. 52.50" />
            </Field>
            {form.worker_type === 'subcontractor' && (
              <Field label="Subcontractor ABN">
                <input style={inputStyle} value={form.subcontractor_abn} onChange={e => setForm(f => ({ ...f, subcontractor_abn: e.target.value }))} placeholder="e.g. 12 345 678 901" />
              </Field>
            )}
            <Field label="Work Status">
              <select style={inputStyle} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                <option value="available">Available</option>
                <option value="on_site">On Site</option>
                <option value="job_details_sent">Job Details Sent</option>
                <option value="unavailable">Unavailable</option>
              </select>
            </Field>
            <Field label="App Status">
              <select style={inputStyle} value={form.app_status} onChange={e => setForm(f => ({ ...f, app_status: e.target.value }))}>
                <option value="Active">Active</option>
                <option value="Invite Sent">Invite Sent</option>
                <option value="Completing Profile">Completing Profile</option>
                <option value="Profile Incomplete">Profile Incomplete</option>
                <option value="Inactive">Inactive</option>
              </select>
            </Field>
            <Field label="Current Site"><input style={inputStyle} value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))} /></Field>
            <Field label="Current Client"><input style={inputStyle} value={form.client} onChange={e => setForm(f => ({ ...f, client: e.target.value }))} /></Field>
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
