import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnSmall, btnDanger } from '../../theme';
import { fmtDate } from '../../utils/dates';
import { Field } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { Spinner } from '../ui/Spinner';
import { EmptyState } from '../ui/EmptyState';

const BUCKET = 'worker-certificates';
const MAX_BYTES = 12 * 1024 * 1024; // 12 MB
const OK_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

const blankCert = () => ({ id: null, name: '', issued_date: '', expiry_date: '', file_path: '' });

// Worker self-managed certificate / ticket uploads.
// `canEdit` enables add/edit/delete + upload; otherwise it's a read-only list
// (used by staff to view a worker's certificates). `workerId` is the subject.
export function WorkerCertificateUploads({ workerId, showToast, canEdit = false }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // cert being added/edited
  const [form, setForm] = useState(blankCert());
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fileErr, setFileErr] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('worker_certificates')
      .select('*')
      .eq('worker_id', workerId)
      .order('expiry_date', { ascending: true, nullsFirst: false });
    if (error) showToast(error.message, 'error');
    else setRows(data || []);
    setLoading(false);
  }, [workerId, showToast]);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => { setForm(blankCert()); setFileErr(null); setModal('add'); };
  const openEdit = (row) => {
    setForm({
      id: row.id, name: row.name || '',
      issued_date: row.issued_date || '', expiry_date: row.expiry_date || '',
      file_path: row.file_path || '',
    });
    setFileErr(null);
    setModal('edit');
  };

  const pickFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileErr(null);
    if (file.size > MAX_BYTES) { setFileErr('File is too large. Keep it under 12 MB.'); return; }
    if (!OK_TYPES.includes(file.type)) { setFileErr('Use a PDF, JPG, PNG or WEBP file.'); return; }
    setUploading(true);
    const ext = (file.name.split('.').pop() || 'pdf').toLowerCase();
    const path = `${workerId}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`.slice(0, 200) || `${workerId}/${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, file, { upsert: true, contentType: file.type, cacheControl: '3600' });
    setUploading(false);
    if (upErr) { setFileErr(upErr.message || 'Upload failed.'); return; }
    setForm((f) => ({ ...f, file_path: path }));
  };

  const viewFile = async (path) => {
    if (!path) return;
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 120);
    if (error) { showToast(error.message, 'error'); return; }
    window.open(data.signedUrl, '_blank', 'noopener');
  };

  const save = async () => {
    if (!form.name.trim()) { showToast('Give the certificate a name (e.g. "Excavator Operator").', 'error'); return; }
    setSaving(true);
    const payload = {
      worker_id: workerId,
      name: form.name.trim(),
      issued_date: form.issued_date || null,
      expiry_date: form.expiry_date || null,
      file_path: form.file_path || null,
    };
    let error;
    if (form.id) {
      ({ error } = await supabase.from('worker_certificates').update(payload).eq('id', form.id));
    } else {
      ({ error } = await supabase.from('worker_certificates').insert([payload]));
    }
    setSaving(false);
    if (error) { showToast(error.message, 'error'); return; }
    showToast(form.id ? 'Certificate updated' : 'Certificate added', 'success');
    setModal(null);
    load();
  };

  const remove = async (row) => {
    if (!window.confirm(`Delete "${row.name}"? This also removes the uploaded file.`)) return;
    if (row.file_path) {
      await supabase.storage.from(BUCKET).remove([row.file_path]);
    }
    const { error } = await supabase.from('worker_certificates').delete().eq('id', row.id);
    if (error) { showToast(error.message, 'error'); return; }
    showToast('Certificate deleted', 'success');
    load();
  };

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>;

  return (
    <div>
      {canEdit && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
          <div style={{ color: C.textMuted, fontSize: 13, maxWidth: 560 }}>
            Add each ticket or licence you hold — a name, the certificate-of-currency file, and the issue / expiry dates.
            Only you and the office can see these.
          </div>
          <button onClick={openAdd} style={btnPrimary}>+ Add certificate</button>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState message={canEdit ? 'No certificates yet. Add your first ticket above.' : 'No uploaded certificates on file.'} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
          {rows.map((c) => {
            const expired = c.expiry_date && new Date(c.expiry_date) < new Date();
            return (
              <div key={c.id} style={{ background: C.card, borderRadius: 10, border: `1px solid ${expired ? C.error : C.border}`, padding: 18 }}>
                <div style={{ fontWeight: 700, color: C.text, fontSize: 15, marginBottom: 8 }}>{c.name}</div>
                <div style={{ color: C.textMuted, fontSize: 13 }}>Issued: {c.issued_date ? fmtDate(c.issued_date) : '—'}</div>
                <div style={{ color: expired ? C.error : C.textMuted, fontSize: 13, marginBottom: 10 }}>
                  Expiry: {c.expiry_date ? fmtDate(c.expiry_date) : '—'}{expired ? ' (expired)' : ''}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {c.file_path
                    ? <button onClick={() => viewFile(c.file_path)} style={btnSmall}>View file</button>
                    : <span style={{ color: C.textDim, fontSize: 12, alignSelf: 'center' }}>No file</span>}
                  {canEdit && <button onClick={() => openEdit(c)} style={btnSmall}>Edit</button>}
                  {canEdit && <button onClick={() => remove(c)} style={{ ...btnDanger, padding: '6px 10px', fontSize: 12 }}>Delete</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {modal && (
        <Modal title={modal === 'add' ? 'Add certificate' : 'Edit certificate'} onClose={() => setModal(null)} width={460}>
          <div style={{ display: 'grid', gap: 12 }}>
            <Field label="Name / keyword *">
              <input style={inputStyle} value={form.name} onChange={set('name')} placeholder="e.g. Excavator Operator" />
            </Field>
            <Field label="Issue date">
              <input type="date" style={inputStyle} value={form.issued_date || ''} onChange={set('issued_date')} />
            </Field>
            <Field label="Expiry date">
              <input type="date" style={inputStyle} value={form.expiry_date || ''} onChange={set('expiry_date')} />
            </Field>
            <Field label="Certificate of currency (PDF / image)">
              <label style={{ ...btnSecondary, padding: '8px 12px', fontSize: 13, cursor: 'pointer', display: 'inline-block' }}>
                {uploading ? 'Uploading…' : (form.file_path ? 'Replace file' : 'Choose file')}
                <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={pickFile} style={{ display: 'none' }} />
              </label>
              {form.file_path && !uploading && (
                <div style={{ marginTop: 6, fontSize: 12, color: C.success }}>File attached ✓</div>
              )}
              {fileErr && <div style={{ marginTop: 6, fontSize: 12, color: '#fda4af' }}>{fileErr}</div>}
            </Field>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 }}>
              <button onClick={() => setModal(null)} style={btnSecondary}>Cancel</button>
              <button onClick={save} disabled={saving || uploading} style={btnPrimary}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
