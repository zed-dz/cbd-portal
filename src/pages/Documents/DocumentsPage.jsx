import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnSmall, btnDanger } from '../../theme';
import { fmtDateTime } from '../../utils/dates';
import { logActivity } from '../../utils/activity';
import { Spinner, EmptyState, Modal, Field, TableWrap, Th, Td, Badge } from '../../components';
import { DOCS_BUCKET, docsForWorker } from '../../components/worker/DocumentsTab';
import { openPrintWindow } from '../../components/timesheet/TimesheetDetailView';
import { SignatureThumb } from '../../components/ui/SignatureThumb';
import { shortDevice, buildSignedCopyHtml } from '../../utils/signatures';

// Documents — office side of company-document e-sign (2026-10-19). Create /
// edit a document (title, body text, optional PDF into the private
// company-documents bucket, which worker types must sign), archive it, and see
// who has signed the current version. Re-publishing as a new version asks
// everyone to sign again; a plain edit (typo) does not. The "who" view shows
// each drawn signature, IP and device, and prints a signed copy (2026-10-20).

const WORKER_TYPES = ['full-time', 'part-time', 'casual', 'subcontractor'];
const blank = () => ({ id: null, title: '', body: '', file_path: '', required_for: [], version: 1, bump: false });

export function DocumentsPage({ showToast, currentWorker }) {
  const [docs, setDocs] = useState([]);
  const [sigs, setSigs] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [form, setForm] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sigView, setSigView] = useState(null);   // doc whose signatures are shown

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: d, error }, { data: s }, { data: w }] = await Promise.all([
      supabase.from('company_documents').select('*').order('created_at', { ascending: false }),
      // No signature_png here (up to 200 KB each): the "who" view fetches the
      // drawn signatures for one document when it opens.
      supabase.from('document_signatures').select('id, document_id, worker_id, version, signed_name, signed_at, ip, user_agent'),
      supabase.from('workers').select('id, name, worker_type, role, app_status').is('archived_at', null).order('name'),
    ]);
    if (error) showToast(error.message, 'error');
    setDocs(d || []); setSigs(s || []); setWorkers((w || []).filter(x => x.role !== 'admin'));
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const pickFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.type !== 'application/pdf') { showToast('PDF only.', 'error'); return; }
    if (file.size > 15 * 1024 * 1024) { showToast('Keep the PDF under 15 MB.', 'error'); return; }
    setUploading(true);
    const path = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`.slice(0, 180);
    const { error } = await supabase.storage.from(DOCS_BUCKET).upload(path, file, { contentType: 'application/pdf', upsert: false });
    setUploading(false);
    if (error) { showToast(error.message, 'error'); return; }
    setForm(f => ({ ...f, file_path: path }));
  };

  const openPdf = async (path) => {
    const { data, error } = await supabase.storage.from(DOCS_BUCKET).createSignedUrl(path, 300);
    if (error) { showToast(error.message, 'error'); return; }
    window.open(data.signedUrl, '_blank', 'noopener');
  };

  const save = async () => {
    if (!form.title.trim()) { showToast('Give the document a title.', 'error'); return; }
    if (!form.body.trim() && !form.file_path) { showToast('Add the text or upload a PDF.', 'error'); return; }
    setSaving(true);
    const payload = {
      title: form.title.trim(), body: form.body.trim() || null, file_path: form.file_path || null,
      required_for: form.required_for, created_by: currentWorker?.name || null,
    };
    let error;
    if (form.id) {
      if (form.bump) payload.version = (form.version || 1) + 1;
      ({ error } = await supabase.from('company_documents').update(payload).eq('id', form.id));
    } else {
      ({ error } = await supabase.from('company_documents').insert([payload]));
    }
    setSaving(false);
    if (error) { showToast(error.message, 'error'); return; }
    logActivity({ verb: form.id ? (form.bump ? 'republished' : 'updated') : 'created', object_type: 'company_document', object_id: form.id,
      after: { name: payload.title, version: payload.version || form.version, required_for: form.required_for } });
    showToast(form.id ? (form.bump ? 'New version published — everyone signs again.' : 'Document updated.') : 'Document published.', 'success');
    setForm(null); load();
  };

  const archive = async (d) => {
    if (!window.confirm(`Archive "${d.title}"? Workers stop seeing it; signatures are kept.`)) return;
    const { error } = await supabase.from('company_documents').update({ archived_at: new Date().toISOString() }).eq('id', d.id);
    if (error) { showToast(error.message, 'error'); return; }
    logActivity({ verb: 'archived', object_type: 'company_document', object_id: d.id, after: { name: d.title } });
    showToast('Archived.', 'success'); load();
  };
  const unarchive = async (d) => {
    const { error } = await supabase.from('company_documents').update({ archived_at: null }).eq('id', d.id);
    if (error) { showToast(error.message, 'error'); return; }
    showToast('Restored.', 'success'); load();
  };

  const toggleType = (t) => setForm(f => ({ ...f, required_for: f.required_for.includes(t) ? f.required_for.filter(x => x !== t) : [...f.required_for, t] }));

  // Signature status for one document: every active worker it applies to.
  const statusFor = (d) => {
    const applies = workers.filter(w => docsForWorker([d], w.worker_type).length);
    const signedIds = new Set(sigs.filter(s => s.document_id === d.id && s.version === d.version).map(s => s.worker_id));
    return { applies, signed: applies.filter(w => signedIds.has(w.id)), unsigned: applies.filter(w => !signedIds.has(w.id)) };
  };

  const shown = docs.filter(d => showArchived ? true : !d.archived_at);

  return (
    <div data-area="documents">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, color: C.text, fontSize: 20, fontWeight: 800 }}>📄 Documents</h2>
          <div style={{ color: C.textMuted, fontSize: 12.5, marginTop: 2 }}>Contracts, policies and handbooks the crew sign from their phone.</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setShowArchived(s => !s)} style={{ ...btnSecondary, minHeight: 36 }}>{showArchived ? 'Hide archived' : 'Show archived'}</button>
          <button onClick={() => setForm(blank())} style={{ ...btnPrimary, minHeight: 36 }}>+ New document</button>
        </div>
      </div>

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>
        : shown.length === 0 ? <EmptyState message="No documents yet. Publish the first contract or policy." icon="📄" />
        : (
          <TableWrap>
            <thead><tr><Th>Title</Th><Th>Required for</Th><Th>Version</Th><Th>Signed</Th><Th>Published</Th><Th /></tr></thead>
            <tbody>
              {shown.map(d => {
                const st = statusFor(d);
                return (
                  <tr key={d.id} style={{ opacity: d.archived_at ? 0.55 : 1 }}>
                    <Td><strong>{d.title}</strong>{d.file_path ? <span style={{ color: C.textDim, fontSize: 11, marginLeft: 6 }}>PDF</span> : null}{d.archived_at ? <span style={{ color: C.textDim, fontSize: 11, marginLeft: 6 }}>(archived)</span> : null}</Td>
                    <Td>{d.required_for?.length ? d.required_for.join(', ') : 'everyone'}</Td>
                    <Td>v{d.version}</Td>
                    <Td>
                      <button onClick={() => setSigView(d)} style={{ ...btnSmall, minHeight: 32 }}>
                        <Badge label={`${st.signed.length} / ${st.applies.length}`} color={st.unsigned.length === 0 && st.applies.length ? 'green' : 'yellow'} /> <span style={{ marginLeft: 6 }}>who</span>
                      </button>
                    </Td>
                    <Td>{fmtDateTime(d.created_at)}</Td>
                    <Td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {d.file_path && <button style={btnSmall} onClick={() => openPdf(d.file_path)}>PDF</button>}
                        <button style={btnSmall} onClick={() => setForm({ id: d.id, title: d.title, body: d.body || '', file_path: d.file_path || '', required_for: d.required_for || [], version: d.version, bump: false })}>Edit</button>
                        {d.archived_at ? <button style={btnSmall} onClick={() => unarchive(d)}>Restore</button> : <button style={btnDanger} onClick={() => archive(d)}>Archive</button>}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}

      {form && (
        <Modal title={form.id ? 'Edit document' : 'New document'} onClose={() => setForm(null)} width={680}>
          <Field label="Title *"><input style={inputStyle} value={form.title} autoFocus onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="e.g. Drug & Alcohol Policy 2026" /></Field>
          <Field label="Text (shown on the phone)" hint="Plain text. Leave empty if the PDF is the whole document.">
            <textarea style={{ ...inputStyle, minHeight: 180, resize: 'vertical', fontFamily: 'inherit' }} value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))} />
          </Field>
          <Field label="PDF (optional)">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ ...btnSecondary, padding: '8px 12px', cursor: 'pointer', display: 'inline-block', minHeight: 36, boxSizing: 'border-box' }}>
                {uploading ? 'Uploading…' : (form.file_path ? 'Replace PDF' : 'Choose PDF')}
                <input type="file" accept="application/pdf" onChange={pickFile} style={{ display: 'none' }} />
              </label>
              {form.file_path && !uploading && <span style={{ fontSize: 12, color: C.success }}>Attached ✓</span>}
              {form.file_path && <button style={btnSmall} onClick={() => setForm(f => ({ ...f, file_path: '' }))}>Remove</button>}
            </div>
          </Field>
          <Field label="Who must sign it" hint="Tick none = everyone.">
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {WORKER_TYPES.map(t => (
                <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: C.text, minHeight: 32 }}>
                  <input type="checkbox" checked={form.required_for.includes(t)} onChange={() => toggleType(t)} style={{ accentColor: C.accent, width: 16, height: 16 }} />{t}
                </label>
              ))}
            </div>
          </Field>
          {form.id && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.text, marginBottom: 12 }}>
              <input type="checkbox" checked={form.bump} onChange={e => setForm(f => ({ ...f, bump: e.target.checked }))} style={{ accentColor: C.accent, width: 16, height: 16 }} />
              Publish as version {form.version + 1} — everyone must sign again (leave off for a typo fix)
            </label>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={() => setForm(null)} style={btnSecondary}>Cancel</button>
            <button onClick={save} disabled={saving || uploading} style={btnPrimary}>{saving ? 'Saving…' : form.id ? 'Save' : 'Publish'}</button>
          </div>
        </Modal>
      )}

      {sigView && (
        <DocSignaturesModal doc={sigView} st={statusFor(sigView)} sigs={sigs} showToast={showToast} onClose={() => setSigView(null)} />
      )}
    </div>
  );
}

// Who signed one document (current version): status per worker, the drawn
// signature, IP + device, and "Print signed copy" for any one signature.
function DocSignaturesModal({ doc, st, sigs, showToast, onClose }) {
  const [pngs, setPngs] = useState({});   // signature id -> data URL
  const [snaps, setSnaps] = useState({});  // signature id -> { text, sha } (wording stored at signing)
  const [loadingPngs, setLoadingPngs] = useState(true);

  useEffect(() => {
    let on = true;
    supabase.from('document_signatures').select('id, signature_png, content_snapshot, content_sha256').eq('document_id', doc.id).eq('version', doc.version)
      .then(({ data, error }) => {
        if (!on) return;
        if (error) showToast(error.message, 'error');
        setPngs(Object.fromEntries((data || []).map(r => [r.id, r.signature_png])));
        setSnaps(Object.fromEntries((data || []).map(r => [r.id, { text: r.content_snapshot || '', sha: r.content_sha256 || '' }])));
        setLoadingPngs(false);
      });
    return () => { on = false; };
  }, [doc.id, doc.version, showToast]);

  const sigOf = (wid) => sigs.find(s => s.document_id === doc.id && s.version === doc.version && s.worker_id === wid);

  const printSigned = (w, s) => {
    openPrintWindow(buildSignedCopyHtml({
      kind: 'Document', title: doc.title, context: doc.file_path ? 'has a PDF attachment' : '',
      text: doc.body || '', currentVersion: doc.version, signedVersion: s.version,
      workerName: w.name, signedName: s.signed_name, signedAt: fmtDateTime(s.signed_at),
      ip: s.ip, userAgent: s.user_agent, signaturePng: pngs[s.id], printedAt: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }),
      snapshot: snaps[s.id]?.text || '', snapshotSha256: snaps[s.id]?.sha || '',
    }), 'width=900,height=1000');
  };

  return (
    <Modal title={`Signatures — ${doc.title} (v${doc.version})`} onClose={onClose} width={860}>
      <div style={{ color: C.textMuted, fontSize: 12.5, marginBottom: 10 }}>{st.signed.length} of {st.applies.length} signed the current version.</div>
      {st.applies.length === 0 ? <EmptyState message="No active workers match this document's worker types." /> : (
        <TableWrap>
          <thead><tr><Th>Worker</Th><Th>Type</Th><Th>Status</Th><Th>Signature</Th><Th>Signed as</Th><Th>IP · device</Th><Th /></tr></thead>
          <tbody>
            {[...st.unsigned, ...st.signed].map(w => {
              const s = sigOf(w.id);
              return (
                <tr key={w.id}>
                  <Td>{w.name}</Td><Td>{w.worker_type || '—'}</Td>
                  <Td>{s ? <Badge label={`Signed ${fmtDateTime(s.signed_at)}`} color="green" /> : <Badge label="Not signed" color="yellow" />}</Td>
                  <Td>{s ? (loadingPngs ? <span style={{ color: C.textDim, fontSize: 12 }}>…</span> : <SignatureThumb png={pngs[s.id]} who={s.signed_name} />) : '—'}</Td>
                  <Td>{s?.signed_name || '—'}</Td>
                  <Td>{s ? <div style={{ fontSize: 12, color: C.textMuted, whiteSpace: 'nowrap' }}>{s.ip || '—'}<br />{shortDevice(s.user_agent)}</div> : '—'}</Td>
                  <Td>{s && <button onClick={() => printSigned(w, s)} disabled={loadingPngs} style={{ ...btnSmall, minHeight: 36, whiteSpace: 'nowrap' }}>🖨 Print signed copy</button>}</Td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
    </Modal>
  );
}
