import { useState } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnSmall } from '../../theme';
import { logActivity } from '../../utils/activity';
import { Spinner, Modal, Field } from '../../components';
import { POLICY_BUCKET, POLICY_MAX_BYTES, fmtSize, usePolicyLibrary, PolicyList } from '../../components/policies/PolicyLibrary';

// Policies — office side (2026-10-20). Upload SWMS, Take 5 forms, incident
// report forms, annexures and any other file, sorted into folders. Workers see
// every live file marked "Workers can see this" in their Policies tab.
// Archive, never delete: an archived file disappears for workers and can be
// restored here.

const titleFromFile = (name) => String(name || '').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
const safeName = (name) => String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);

export function PoliciesPage({ showToast, currentWorker }) {
  const { cats, docs, loading, reload } = usePolicyLibrary(showToast);
  const [showArchived, setShowArchived] = useState(false);
  const [upload, setUpload] = useState(null);     // { catId, visible, items: [{ file, title }] }
  const [progress, setProgress] = useState(null); // 'Uploading 2 of 5'
  const [edit, setEdit] = useState(null);         // a copy of one policy_documents row
  const [folders, setFolders] = useState(false);
  const [newFolder, setNewFolder] = useState('');
  const [busy, setBusy] = useState(false);

  const liveCats = cats.filter(c => !c.archived_at);
  const catName = (id) => cats.find(c => c.id === id)?.name || '';
  const shown = docs.filter(d => showArchived || !d.archived_at);
  const archivedCount = docs.filter(d => d.archived_at).length;

  // ── upload ──
  const startUpload = () => setUpload({ catId: liveCats[0]?.id || '', visible: true, items: [] });
  const pickFiles = (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    const tooBig = files.filter(f => f.size > POLICY_MAX_BYTES);
    if (tooBig.length) showToast(`${tooBig.length} file${tooBig.length === 1 ? ' is' : 's are'} over 25 MB and left out.`, 'error');
    const ok = files.filter(f => f.size <= POLICY_MAX_BYTES).map(file => ({ file, title: titleFromFile(file.name) }));
    setUpload(u => ({ ...u, items: [...u.items, ...ok] }));
  };
  const doUpload = async () => {
    if (!upload.catId) { showToast('Pick a folder.', 'error'); return; }
    if (!upload.items.length) { showToast('Pick at least one file.', 'error'); return; }
    if (upload.items.some(i => !i.title.trim())) { showToast('Every file needs a title.', 'error'); return; }
    setBusy(true);
    const folder = catName(upload.catId);
    let done = 0; const failed = [];
    for (const item of upload.items) {
      setProgress(`Uploading ${done + 1} of ${upload.items.length}`);
      const path = `${upload.catId}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safeName(item.file.name)}`;
      const { error: upErr } = await supabase.storage.from(POLICY_BUCKET)
        .upload(path, item.file, { contentType: item.file.type || 'application/octet-stream', upsert: false });
      if (upErr) { failed.push(`${item.file.name}: ${upErr.message}`); continue; }
      const { data: row, error } = await supabase.from('policy_documents').insert([{
        category_id: upload.catId, category_name_snapshot: folder, title: item.title.trim(),
        file_path: path, file_name: item.file.name, mime_type: item.file.type || null, size_bytes: item.file.size,
        visible_to_workers: upload.visible, uploaded_by_id: currentWorker?.id || null, uploaded_by_name: currentWorker?.name || null,
      }]).select('id').single();
      if (error) { failed.push(`${item.file.name}: ${error.message}`); continue; }
      logActivity({ verb: 'uploaded', object_type: 'policy_document', object_id: row.id, after: { name: item.title.trim(), folder } });
      done += 1;
    }
    setBusy(false); setProgress(null);
    if (failed.length) {
      showToast(`${done} uploaded. Failed: ${failed.join('; ')}`, 'error');
      // Keep only the files that failed, so "Upload" retries just those.
      setUpload(u => ({ ...u, items: u.items.filter(i => failed.some(f => f.startsWith(`${i.file.name}:`))) }));
    } else {
      showToast(`${done} file${done === 1 ? '' : 's'} added to ${folder}.`);
      setUpload(null);
    }
    reload();
  };

  // ── edit / replace / archive ──
  const replaceFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > POLICY_MAX_BYTES) { showToast('Keep the file under 25 MB.', 'error'); return; }
    setBusy(true);
    const path = `${edit.category_id}/${Date.now()}-${safeName(file.name)}`;
    const { error } = await supabase.storage.from(POLICY_BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    setBusy(false);
    if (error) { showToast(error.message, 'error'); return; }
    setEdit(x => ({ ...x, file_path: path, file_name: file.name, mime_type: file.type || null, size_bytes: file.size, _replaced: true }));
  };
  const saveEdit = async () => {
    if (!edit.title.trim()) { showToast('Give the file a title.', 'error'); return; }
    setBusy(true);
    const before = docs.find(d => d.id === edit.id);
    const payload = {
      title: edit.title.trim(), description: (edit.description || '').trim() || null,
      category_id: edit.category_id, category_name_snapshot: catName(edit.category_id),
      visible_to_workers: edit.visible_to_workers,
      file_path: edit.file_path, file_name: edit.file_name, mime_type: edit.mime_type, size_bytes: edit.size_bytes,
    };
    const { error } = await supabase.from('policy_documents').update(payload).eq('id', edit.id);
    setBusy(false);
    if (error) { showToast(error.message, 'error'); return; }
    logActivity({ verb: edit._replaced ? 'replaced file' : 'updated', object_type: 'policy_document', object_id: edit.id,
      before: { name: before?.title, folder: before?.category_name_snapshot }, after: { name: payload.title, folder: payload.category_name_snapshot } });
    showToast('Saved.'); setEdit(null); reload();
  };
  const setArchived = async (d, archive) => {
    const { error } = await supabase.from('policy_documents').update({ archived_at: archive ? new Date().toISOString() : null }).eq('id', d.id);
    if (error) { showToast(error.message, 'error'); return; }
    logActivity({ verb: archive ? 'archived' : 'restored', object_type: 'policy_document', object_id: d.id, after: { name: d.title } });
    showToast(archive ? 'Archived. Workers no longer see it.' : 'Restored.'); reload();
  };

  // ── folders ──
  const addFolder = async () => {
    const name = newFolder.trim();
    if (!name) return;
    const sort = Math.max(0, ...cats.map(c => c.sort_order || 0)) + 10;
    const { error } = await supabase.from('policy_categories').insert([{ name, sort_order: sort }]);
    if (error) { showToast(/duplicate|unique/i.test(error.message) ? 'That folder already exists.' : error.message, 'error'); return; }
    logActivity({ verb: 'created', object_type: 'policy_category', after: { name } });
    setNewFolder(''); reload();
  };
  const setFolderArchived = async (c, archive) => {
    if (archive && docs.some(d => d.category_id === c.id && !d.archived_at)) {
      showToast('Move or archive the files in this folder first.', 'error'); return;
    }
    const { error } = await supabase.from('policy_categories').update({ archived_at: archive ? new Date().toISOString() : null }).eq('id', c.id);
    if (error) { showToast(error.message, 'error'); return; }
    logActivity({ verb: archive ? 'archived' : 'restored', object_type: 'policy_category', object_id: c.id, after: { name: c.name } });
    reload();
  };

  if (loading) return <Spinner />;

  return (
    <div data-area="policies">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, color: C.text, fontSize: 20, fontWeight: 800 }}>📚 Policies</h2>
          <div style={{ color: C.textMuted, fontSize: 12.5, marginTop: 2 }}>SWMS, Take 5, incident forms, annexures and more. Workers open these from their phone app.</div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button onClick={() => setFolders(true)} style={{ ...btnSecondary, minHeight: 40 }}>Folders</button>
          <button onClick={startUpload} style={{ ...btnPrimary, minHeight: 40 }}>+ Upload files</button>
        </div>
      </div>

      {archivedCount > 0 && (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: C.textMuted, fontSize: 13, marginBottom: 10, minHeight: 36, cursor: 'pointer' }}>
          <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> Show archived ({archivedCount})
        </label>
      )}

      <PolicyList cats={cats} docs={shown} showToast={showToast}
        emptyMessage="No files yet. Press + Upload files to add your SWMS, Take 5 and other forms."
        renderActions={(d) => (
          <>
            {!d.archived_at && <button onClick={() => setEdit({ ...d })} style={{ ...btnSmall, minHeight: 36 }}>Edit</button>}
            {d.archived_at
              ? <button onClick={() => setArchived(d, false)} style={{ ...btnSmall, minHeight: 36 }}>Restore</button>
              : <button onClick={() => setArchived(d, true)} style={{ ...btnSmall, minHeight: 36, color: '#fca5a5' }}>Archive</button>}
          </>
        )} />

      {upload && (
        <Modal title="Upload files" onClose={() => !busy && setUpload(null)} width={560}>
          <Field label="Folder">
            <select value={upload.catId} onChange={e => setUpload(u => ({ ...u, catId: e.target.value }))} style={inputStyle}>
              {liveCats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Files" hint="Any file type: PDF, Word, Excel, photos. Up to 25 MB each. You can pick many at once.">
            <input type="file" multiple onChange={pickFiles} disabled={busy} style={{ ...inputStyle, padding: 8 }} />
          </Field>
          {upload.items.length > 0 && (
            <div style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
              {upload.items.map((it, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input aria-label={`Title for ${it.file.name}`} value={it.title} disabled={busy}
                    onChange={e => setUpload(u => ({ ...u, items: u.items.map((x, j) => j === i ? { ...x, title: e.target.value } : x) }))}
                    style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
                  <span style={{ color: C.textDim, fontSize: 11.5, whiteSpace: 'nowrap' }}>{fmtSize(it.file.size)}</span>
                  <button aria-label={`Remove ${it.file.name}`} disabled={busy}
                    onClick={() => setUpload(u => ({ ...u, items: u.items.filter((_, j) => j !== i) }))}
                    style={{ ...btnSmall, minHeight: 36, minWidth: 36 }}>✕</button>
                </div>
              ))}
            </div>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.text, fontSize: 13.5, marginBottom: 16, minHeight: 36, cursor: 'pointer' }}>
            <input type="checkbox" checked={upload.visible} onChange={e => setUpload(u => ({ ...u, visible: e.target.checked }))} />
            Workers can see these files in their app
          </label>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button onClick={() => setUpload(null)} disabled={busy} style={btnSecondary}>Cancel</button>
            <button onClick={doUpload} disabled={busy || !upload.items.length} style={btnPrimary}>
              {progress || `Upload ${upload.items.length || ''} file${upload.items.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </Modal>
      )}

      {edit && (
        <Modal title="Edit file" onClose={() => !busy && setEdit(null)} width={520}>
          <Field label="Title">
            <input value={edit.title} onChange={e => setEdit(x => ({ ...x, title: e.target.value }))} style={inputStyle} maxLength={160} />
          </Field>
          <Field label="Short note (optional)" hint="For example: which site or job this SWMS is for.">
            <input value={edit.description || ''} onChange={e => setEdit(x => ({ ...x, description: e.target.value }))} style={inputStyle} maxLength={400} />
          </Field>
          <Field label="Folder">
            <select value={edit.category_id} onChange={e => setEdit(x => ({ ...x, category_id: e.target.value }))} style={inputStyle}>
              {cats.filter(c => !c.archived_at || c.id === edit.category_id).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="File" hint={`Now: ${edit.file_name} (${fmtSize(edit.size_bytes)}). Replacing keeps the title and folder.`}>
            <input type="file" onChange={replaceFile} disabled={busy} style={{ ...inputStyle, padding: 8 }} />
          </Field>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.text, fontSize: 13.5, marginBottom: 16, minHeight: 36, cursor: 'pointer' }}>
            <input type="checkbox" checked={edit.visible_to_workers} onChange={e => setEdit(x => ({ ...x, visible_to_workers: e.target.checked }))} />
            Workers can see this file in their app
          </label>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button onClick={() => setEdit(null)} disabled={busy} style={btnSecondary}>Cancel</button>
            <button onClick={saveEdit} disabled={busy} style={btnPrimary}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}

      {folders && (
        <Modal title="Folders" onClose={() => setFolders(false)} width={460} dismissible>
          <div style={{ display: 'grid', gap: 6, marginBottom: 14 }}>
            {cats.map(c => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${C.border}`, opacity: c.archived_at ? 0.55 : 1 }}>
                <span style={{ flex: 1, color: C.text, fontSize: 14 }}>{c.name}</span>
                <span style={{ color: C.textDim, fontSize: 12 }}>{docs.filter(d => d.category_id === c.id && !d.archived_at).length} files</span>
                {c.archived_at
                  ? <button onClick={() => setFolderArchived(c, false)} style={{ ...btnSmall, minHeight: 36 }}>Restore</button>
                  : <button onClick={() => setFolderArchived(c, true)} style={{ ...btnSmall, minHeight: 36, color: '#fca5a5' }}>Archive</button>}
              </div>
            ))}
          </div>
          <Field label="New folder">
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={newFolder} onChange={e => setNewFolder(e.target.value)} maxLength={60} placeholder="For example: Toolbox talks"
                onKeyDown={e => { if (e.key === 'Enter') addFolder(); }} style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
              <button onClick={addFolder} style={{ ...btnPrimary, minHeight: 40 }}>Add</button>
            </div>
          </Field>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={() => setFolders(false)} style={btnSecondary}>Done</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
