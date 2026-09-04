import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnDanger, btnSmall } from '../../theme';
import { todayISO, fmtDate } from '../../utils/dates';
import { Spinner, Modal, Field, TableWrap, Th, Td, EmptyState, certBadge } from '../../components';

const certDefaultsLA = { worker_id: '', cert_name: '', issuer: '', expiry: '', doc_url: '' };

export function LicenceAgentPage({ showToast }) {
  const [certs, setCerts] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(certDefaultsLA);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [c, w] = await Promise.all([
      supabase.from('certifications').select('*, workers(name)').order('expiry', { ascending: true }),
      supabase.from('workers').select('id, name').is('archived_at', null).order('name'),
    ]);
    if (c.error) showToast(c.error.message, 'error');
    else setCerts(c.data || []);
    if (w.data) setWorkers(w.data);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => { setForm(certDefaultsLA); setModal('add'); };
  const openEdit = (c) => { setForm({ worker_id: c.worker_id || '', cert_name: c.cert_name, issuer: c.issuer || '', expiry: c.expiry || '', doc_url: c.doc_url || '' }); setModal(c); };
  const closeModal = () => { setModal(null); setForm(certDefaultsLA); };

  const handleSave = async () => {
    if (!form.worker_id || !form.cert_name.trim()) { showToast('Worker and licence name are required.', 'error'); return; }
    setSaving(true);
    const payload = { ...form, expiry: form.expiry || null };
    if (modal === 'add') {
      const { error } = await supabase.from('certifications').insert([payload]);
      if (error) showToast(error.message, 'error');
      else { showToast('Licence added successfully', 'success'); closeModal(); load(); }
    } else {
      const { error } = await supabase.from('certifications').update(payload).eq('id', modal.id);
      if (error) showToast(error.message, 'error');
      else { showToast('Licence updated successfully', 'success'); closeModal(); load(); }
    }
    setSaving(false);
  };

  // Ticket photos go into the private cert-photos bucket; the row stores the
  // storage path in doc_url. Viewing mints a 1-hour signed URL, so photos of
  // people's licences are never on a public URL.
  const uploadPhoto = async (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/') && file.type !== 'application/pdf') {
      showToast('Attach a photo or a PDF.', 'error'); return;
    }
    if (file.size > 10 * 1024 * 1024) { showToast('Max file size is 10 MB.', 'error'); return; }
    setUploading(true);
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const path = `${form.worker_id || 'unassigned'}/${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from('cert-photos').upload(path, file);
    if (error) showToast(error.message, 'error');
    else { setForm(f => ({ ...f, doc_url: path })); showToast('Ticket photo attached — hit Save to keep it', 'success'); }
    setUploading(false);
  };

  const viewPhoto = async (docUrl) => {
    if (!docUrl) return;
    if (/^https?:\/\//.test(docUrl)) { window.open(docUrl, '_blank'); return; }
    const { data, error } = await supabase.storage.from('cert-photos').createSignedUrl(docUrl, 3600);
    if (error || !data?.signedUrl) { showToast(error?.message || 'Could not open the photo.', 'error'); return; }
    window.open(data.signedUrl, '_blank');
  };

  const handleDelete = async (c) => {
    if (!window.confirm('Delete this licence/certification?')) return;
    const { error } = await supabase.from('certifications').delete().eq('id', c.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Licence deleted', 'success'); load(); }
  };

  const now = new Date();
  const in30 = new Date(Date.now() + 30 * 86400000);
  const today = new Date(todayISO());

  const filtered = certs.filter(c => {
    const matchSearch = !search || c.cert_name.toLowerCase().includes(search.toLowerCase()) || (c.workers?.name || '').toLowerCase().includes(search.toLowerCase());
    if (!matchSearch) return false;
    if (!filterStatus) return true;
    if (!c.expiry) return filterStatus === 'valid';
    const exp = new Date(c.expiry);
    const diff = (exp - now) / (1000 * 60 * 60 * 24);
    if (filterStatus === 'expired') return diff < 0;
    if (filterStatus === 'expiring') return diff >= 0 && diff < 30;
    if (filterStatus === 'valid') return diff >= 30;
    return true;
  });

  const expiredCount = certs.filter(c => c.expiry && new Date(c.expiry) < today).length;
  const expiringCount = certs.filter(c => c.expiry && new Date(c.expiry) >= today && new Date(c.expiry) <= in30).length;

  return (
    <div>
      {(expiredCount > 0 || expiringCount > 0) && (
        <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 10, padding: '12px 16px', marginBottom: 16, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          {expiredCount > 0 && <span style={{ color: C.error, fontSize: 13, fontWeight: 600 }}>🚨 {expiredCount} expired licence{expiredCount > 1 ? 's' : ''}</span>}
          {expiringCount > 0 && <span style={{ color: C.warning, fontSize: 13, fontWeight: 600 }}>⚡ {expiringCount} expiring within 30 days</span>}
          <button onClick={() => setFilterStatus('expired')} style={{ ...btnSecondary, padding: '4px 12px', fontSize: 12, marginLeft: 'auto' }}>Show Expired</button>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', flex: 1 }}>
          <input style={{ ...inputStyle, maxWidth: 220 }} placeholder="Search worker or licence…" value={search} onChange={e => setSearch(e.target.value)} />
          <select style={{ ...inputStyle, maxWidth: 180 }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="">All Statuses</option>
            <option value="valid">Valid</option>
            <option value="expiring">Expiring Soon (30d)</option>
            <option value="expired">Expired</option>
          </select>
        </div>
        <button onClick={openAdd} style={btnPrimary}>+ Add Licence</button>
      </div>

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div> :
        filtered.length === 0 ? <EmptyState message="No licences found." /> : (
        <TableWrap>
          <thead><tr><Th>Worker</Th><Th>Licence / Certification</Th><Th>Issuer</Th><Th>Expiry</Th><Th>Status</Th><Th>Actions</Th></tr></thead>
          <tbody>
            {filtered.map(c => (
              <tr key={c.id}>
                <Td>{c.workers?.name || '—'}</Td>
                <Td><strong>{c.cert_name}</strong></Td>
                <Td>{c.issuer || '—'}</Td>
                <Td>{fmtDate(c.expiry)}</Td>
                <Td>{certBadge(c.expiry)}</Td>
                <Td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {c.doc_url && <button onClick={() => viewPhoto(c.doc_url)} style={btnSmall} title="View ticket photo">📷</button>}
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
        <Modal title={modal === 'add' ? 'Add Licence / Certification' : 'Edit Licence / Certification'} onClose={closeModal}>
          <Field label="Worker *">
            <select style={inputStyle} value={form.worker_id} onChange={e => setForm(f => ({ ...f, worker_id: e.target.value }))}>
              <option value="">Select a worker…</option>
              {workers.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
          <Field label="Licence / Certification Name *"><input style={inputStyle} value={form.cert_name} onChange={e => setForm(f => ({ ...f, cert_name: e.target.value }))} placeholder="e.g. White Card, RIW, High Risk" /></Field>
          <Field label="Issuer / Authority"><input style={inputStyle} value={form.issuer} onChange={e => setForm(f => ({ ...f, issuer: e.target.value }))} /></Field>
          <Field label="Expiry Date"><input style={inputStyle} type="date" value={form.expiry} onChange={e => setForm(f => ({ ...f, expiry: e.target.value }))} /></Field>
          <Field label="Ticket photo (image or PDF, max 10 MB)" hint="Stored privately — viewing uses a link that expires after an hour.">
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <input type="file" accept="image/*,application/pdf" onChange={e => uploadPhoto(e.target.files && e.target.files[0])} style={{ color: C.textMuted, fontSize: 12, maxWidth: 260 }} />
              {uploading && <span style={{ fontSize: 12, color: C.textMuted }}>Uploading…</span>}
              {form.doc_url && !uploading && (
                <button type="button" onClick={() => viewPhoto(form.doc_url)} style={btnSmall}>📷 View attached</button>
              )}
            </div>
          </Field>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={closeModal} style={btnSecondary}>Cancel</button>
            <button onClick={handleSave} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
