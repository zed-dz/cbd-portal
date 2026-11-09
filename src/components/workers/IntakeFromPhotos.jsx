import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../supabaseClient';
import { C, btnPrimary, btnSecondary, btnSmall } from '../../theme';
import { Modal } from '../ui/Modal';

// "Add from photos" — step one of adding a worker from their paperwork.
// The office picks (or snaps) the photos, they are shrunk in the browser,
// uploaded to the PRIVATE worker-intake bucket under the caller's own uid, and
// the worker-intake function reads them with a vision model. The parent gets
// the JSON plus the object paths and opens the normal Add Worker form.
//
// Phone first: the file input carries capture="environment" so a phone opens
// the camera; thumbnails sit in a 3-up grid that fits 360 px.

export const INTAKE_BUCKET = 'worker-intake';
const MAX_FILES = 12;
const MAX_EDGE  = 1800;   // px — plenty for card text, keeps every upload well under the 8 MB cap
const JPEG_Q    = 0.86;

// Shrink + re-encode as JPEG. createImageBitmap honours EXIF orientation, so
// a photo taken in portrait comes out the right way up. HEIC (iPhone default)
// cannot be decoded by Chrome/Edge/Firefox: that surfaces here as a clear
// message instead of a blank upload.
async function shrinkToJpeg(file) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    throw new Error('PDFs are not read — take a photo of each page instead.');
  }
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    const heic = /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
    throw new Error(heic
      ? `${file.name}: HEIC photos cannot be read. On iPhone set Camera → Formats → Most Compatible, or screenshot the photo and upload that.`
      : `${file.name}: this file is not a photo the browser can open.`);
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);   // PNG transparency → white
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', JPEG_Q));
  if (!blob) throw new Error(`${file.name}: could not be converted.`);
  return blob;
}

export function IntakeFromPhotos({ onClose, onResult, onFallback, showToast }) {
  const [items, setItems] = useState([]);          // { id, name, blob, url }
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [failed, setFailed] = useState(null);       // message when every provider failed
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);

  // Free object URLs when the modal goes away.
  useEffect(() => () => items.forEach((it) => URL.revokeObjectURL(it.url)), [items]);

  const addFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const room = MAX_FILES - items.length;
    if (room <= 0) { showToast(`Up to ${MAX_FILES} photos at a time.`, 'error'); return; }
    const take = files.slice(0, room);
    if (files.length > room) showToast(`Only the first ${room} added — ${MAX_FILES} photos max.`, 'info');
    setProgress('Preparing photos…');
    const out = [];
    for (const f of take) {
      try {
        const blob = await shrinkToJpeg(f);
        out.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: f.name, blob, url: URL.createObjectURL(blob) });
      } catch (e) {
        showToast(e.message, 'error');
      }
    }
    setItems((prev) => [...prev, ...out]);
    setProgress('');
  };

  const remove = (id) => setItems((prev) => {
    const it = prev.find((x) => x.id === id);
    if (it) URL.revokeObjectURL(it.url);
    return prev.filter((x) => x.id !== id);
  });

  const read = async () => {
    if (!items.length) { showToast('Add at least one photo first.', 'error'); return; }
    setBusy(true); setFailed(null);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user?.id) throw new Error('You are signed out — sign in again.');
      const stamp = Date.now();
      const paths = [];
      for (let i = 0; i < items.length; i++) {
        setProgress(`Uploading photo ${i + 1} of ${items.length}…`);
        const path = `${user.id}/${stamp}-${i + 1}.jpg`;
        const { error } = await supabase.storage.from(INTAKE_BUCKET).upload(path, items[i].blob, { contentType: 'image/jpeg', upsert: false });
        if (error) throw new Error(`Upload failed: ${error.message}`);
        paths.push(path);
      }
      setProgress(`Reading ${items.length} photo${items.length === 1 ? '' : 's'}… this takes 15–40 seconds.`);
      const { data, error } = await supabase.functions.invoke('worker-intake', { body: { paths } });
      if (error) {
        // supabase-js hides the JSON body of a non-2xx answer; dig it out.
        let msg = error.message || 'Could not read the photos';
        try { const j = await error.context?.json?.(); if (j?.message) msg = j.message; } catch (e) { /* keep msg */ }
        throw new Error(msg);
      }
      if (!data?.ok) throw new Error(data?.message || 'Could not read the photos');
      onResult({ ...data, paths });
    } catch (e) {
      const msg = e.message || 'Could not read the photos';
      setFailed(/read the photos|provider|Reading/i.test(msg) ? 'Could not read the photos — add the worker by hand.' : msg);
    } finally {
      setBusy(false); setProgress('');
    }
  };

  return (
    <Modal title="📷 Add worker from photos" onClose={busy ? () => {} : onClose} width={560}>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: C.textMuted, lineHeight: 1.55 }}>
        Snap or pick the new starter's paperwork: the filled-in employment form, driver licence
        (front and back), white card, plant tickets, Statements of Attainment. The details are
        read for you and the Add Worker form opens pre-filled — you check it, set the type, rate
        and start date, then save as usual.
      </p>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
        onClick={() => !busy && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
        style={{
          border: `2px dashed ${dragOver ? C.accent : C.borderStrong}`,
          background: dragOver ? C.accentSoft : C.bg,
          borderRadius: 12, padding: '22px 14px', textAlign: 'center', cursor: busy ? 'wait' : 'pointer',
          transition: 'border-color .15s, background .15s',
        }}
      >
        <div style={{ fontSize: 28, lineHeight: 1 }}>📷</div>
        <div style={{ marginTop: 8, fontSize: 14, fontWeight: 600, color: C.text }}>Take a photo or choose from your phone</div>
        <div style={{ marginTop: 4, fontSize: 12, color: C.textDim }}>JPG, PNG or WEBP · up to {MAX_FILES} photos · drag and drop on a computer</div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          capture="environment"
          onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
          style={{ display: 'none' }}
          data-testid="intake-file-input"
        />
      </div>

      {items.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 8, marginTop: 12 }}>
          {items.map((it, i) => (
            <div key={it.id} style={{ position: 'relative', borderRadius: 8, overflow: 'hidden', border: `1px solid ${C.border}`, background: C.bg, aspectRatio: '1 / 1' }}>
              <img src={it.url} alt={`Card ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              <span style={{ position: 'absolute', left: 6, bottom: 6, fontSize: 10, fontFamily: '"DM Mono", monospace', background: 'rgba(0,0,0,0.6)', color: '#fff', padding: '1px 6px', borderRadius: 999 }}>{i + 1}</span>
              {!busy && (
                <button type="button" onClick={(e) => { e.stopPropagation(); remove(it.id); }} aria-label={`Remove photo ${i + 1}`} style={{
                  position: 'absolute', top: 4, right: 4, width: 26, height: 26, borderRadius: '50%',
                  background: 'rgba(0,0,0,0.65)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 15, lineHeight: 1,
                }}>×</button>
              )}
            </div>
          ))}
        </div>
      )}

      {progress && (
        <div style={{ marginTop: 12, fontSize: 12.5, color: C.info, display: 'flex', alignItems: 'center', gap: 8 }} aria-live="polite">
          <span style={{ width: 10, height: 10, borderRadius: '50%', border: `2px solid ${C.info}`, borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite', display: 'inline-block' }} />
          {progress}
        </div>
      )}

      {failed && (
        <div style={{ marginTop: 12, background: C.errorSoft, border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 12px', fontSize: 12.5, color: '#fca5a5', lineHeight: 1.5 }}>
          <div>{failed}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={read} style={btnSmall}>Try again</button>
            <button type="button" onClick={onFallback} style={{ ...btnSmall, background: 'rgba(249,115,22,0.12)', color: C.accent, border: 'none' }}>Add the worker by hand</button>
          </div>
        </div>
      )}

      <div style={{ fontSize: 10.5, color: C.textDim, marginTop: 12, lineHeight: 1.5 }}>
        Tax file numbers, bank details, super member numbers, Medicare and passport numbers are
        never read — the worker types those into their own onboarding form. Photos are stored
        privately; a ticket's photo is attached to that ticket when you save.
      </div>

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14, flexWrap: 'wrap' }}>
        <button type="button" onClick={onClose} style={btnSecondary} disabled={busy}>Cancel</button>
        <button type="button" onClick={read} style={btnPrimary} disabled={busy || !items.length} data-testid="intake-read">
          {busy ? 'Reading…' : `Read the photos${items.length ? ` (${items.length})` : ''}`}
        </button>
      </div>
    </Modal>
  );
}
