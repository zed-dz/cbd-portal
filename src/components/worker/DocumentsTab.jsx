import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnSmall } from '../../theme';
import { fmtDateTime } from '../../utils/dates';
import { Spinner, EmptyState, Badge, Modal } from '../index';

// Company documents e-sign (2026-10-19): contracts, policies, handbooks. The
// office publishes a document (text body and/or a PDF) and says which worker
// types must sign it. The worker reads it, ticks, types their name, signs.
// Signatures carry the document version, so a new version asks again.

export const DOCS_BUCKET = 'company-documents';

// Documents this worker must sign: required_for empty = everyone.
export function docsForWorker(docs, workerType) {
  const t = String(workerType || '').toLowerCase();
  return (docs || []).filter(d => !d.required_for?.length || d.required_for.map(x => String(x).toLowerCase()).includes(t));
}

// Shared loader for the tab and the banner: [{ doc, signed }].
export async function loadWorkerDocuments(currentWorker) {
  const [{ data: docs }, { data: sigs }] = await Promise.all([
    supabase.from('company_documents').select('*').is('archived_at', null).order('created_at', { ascending: false }),
    supabase.from('document_signatures').select('document_id, version, signed_at, signed_name').eq('worker_id', currentWorker.id),
  ]);
  const byKey = Object.fromEntries((sigs || []).map(s => [`${s.document_id}:${s.version}`, s]));
  return docsForWorker(docs, currentWorker.worker_type).map(d => ({ doc: d, signed: byKey[`${d.id}:${d.version}`] || null }));
}

export function DocumentsBanner({ currentWorker, onOpen }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let on = true;
    loadWorkerDocuments(currentWorker).then(items => { if (on) setCount(items.filter(i => !i.signed).length); }).catch(() => {});
    return () => { on = false; };
  }, [currentWorker]);
  if (!count) return null;
  return (
    <div data-area="documents banner" style={{ background: C.infoSoft, borderBottom: '1px solid rgba(56,189,248,0.4)', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 200, color: '#7dd3fc', fontSize: 13.5, fontWeight: 600 }}>
        📄 {count} document{count === 1 ? '' : 's'} need{count === 1 ? 's' : ''} your signature
      </div>
      <button onClick={onOpen} style={{ ...btnSecondary, minHeight: 36, padding: '8px 14px', color: '#7dd3fc', borderColor: 'rgba(56,189,248,0.4)' }}>Open →</button>
    </div>
  );
}

export function DocumentsTab({ currentWorker, showToast }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(null);   // { doc, signed }

  const load = useCallback(async () => {
    try { setItems(await loadWorkerDocuments(currentWorker)); }
    catch (e) { showToast(e.message || 'Could not load documents', 'error'); }
    setLoading(false);
  }, [currentWorker, showToast]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>;
  const unsigned = items.filter(i => !i.signed);

  return (
    <div data-area="documents" style={{ display: 'grid', gap: 12, maxWidth: 640, margin: '0 auto' }}>
      <div style={{ color: C.textMuted, fontSize: 13 }}>
        {unsigned.length ? `${unsigned.length} document${unsigned.length === 1 ? '' : 's'} still need${unsigned.length === 1 ? 's' : ''} your signature.` : 'Everything is signed. New documents will appear here.'}
      </div>
      {items.length === 0 ? <EmptyState message="No documents for you right now." icon="📄" /> : items.map(({ doc, signed }) => (
        <div key={doc.id} style={{ background: C.card, border: `1px solid ${signed ? C.border : 'rgba(56,189,248,0.4)'}`, borderRadius: 10, padding: '14px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>{doc.title}</div>
              <div style={{ color: C.textDim, fontSize: 11.5, marginTop: 2 }}>Version {doc.version}{doc.file_path ? ' · PDF' : ''}</div>
            </div>
            {signed ? <Badge label={`Signed ${fmtDateTime(signed.signed_at)}`} color="green" /> : <Badge label="Not signed" color="blue" />}
          </div>
          <div style={{ marginTop: 10 }}>
            <button onClick={() => setReading({ doc, signed })} style={{ ...(signed ? btnSmall : btnPrimary), minHeight: 36 }}>{signed ? 'Open' : 'Read & sign →'}</button>
          </div>
        </div>
      ))}

      {reading && (
        <DocumentReader item={reading} currentWorker={currentWorker} showToast={showToast}
          onClose={() => setReading(null)} onSigned={() => { setReading(null); load(); }} />
      )}
    </div>
  );
}

export function DocumentReader({ item, currentWorker, showToast, onClose, onSigned }) {
  const { doc, signed } = item;
  const [agree, setAgree] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const openPdf = async () => {
    const { data, error } = await supabase.storage.from(DOCS_BUCKET).createSignedUrl(doc.file_path, 300);
    if (error) { showToast(error.message, 'error'); return; }
    window.open(data.signedUrl, '_blank', 'noopener');
  };

  const sign = async () => {
    if (!agree) { showToast('Tick the box first.', 'error'); return; }
    const typed = name.trim();
    if (typed.length < 3) { showToast('Type your full name to sign.', 'error'); return; }
    setBusy(true);
    const { error } = await supabase.from('document_signatures').insert([{
      document_id: doc.id, worker_id: currentWorker.id, version: doc.version, signed_name: typed,
    }]);
    setBusy(false);
    if (error) { showToast(error.message, 'error'); return; }
    showToast(`"${doc.title}" signed.`, 'success');
    onSigned?.();
  };

  return (
    <Modal title={doc.title} onClose={onClose} width={720}>
      <div style={{ color: C.textDim, fontSize: 11.5, marginBottom: 10 }}>Version {doc.version} · published {fmtDateTime(doc.created_at)}</div>
      {doc.file_path && (
        <button onClick={openPdf} style={{ ...btnSecondary, minHeight: 40, marginBottom: 12, width: '100%' }}>📎 Open the PDF (new tab)</button>
      )}
      {doc.body && (
        <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14, color: C.text, fontSize: 14, lineHeight: 1.65, whiteSpace: 'pre-wrap', maxHeight: '45vh', overflowY: 'auto' }}>
          {doc.body}
        </div>
      )}
      {signed ? (
        <div style={{ marginTop: 14, color: C.success, fontSize: 13 }}>✓ You signed this as "{signed.signed_name}" on {fmtDateTime(signed.signed_at)}.</div>
      ) : (
        <div style={{ marginTop: 14, display: 'grid', gap: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: C.text, minHeight: 36 }}>
            <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} style={{ accentColor: C.accent, width: 20, height: 20 }} />
            I have read this document and agree to it
          </label>
          {/* Full-width Sign button + bottom room: the floating help bubble sits
              bottom-right and covered a right-aligned button on 360 px phones. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 84 }}>
            <input style={{ ...inputStyle, width: '100%' }} value={name} onChange={e => setName(e.target.value)} placeholder="Type your full name" autoComplete="name" />
            <button onClick={sign} disabled={busy} style={{ ...btnPrimary, minHeight: 44, width: '100%' }}>{busy ? 'Signing…' : '✍ Sign'}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
