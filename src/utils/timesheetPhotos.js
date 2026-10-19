// Photos on a daily timesheet (dockets, plant hour meters). Private bucket
// `timesheet-photos`, one folder per worker: <worker_id>/<header_id>/<uuid>.jpg.
// Rows in timesheet_photos carry the path + caption; RLS = worker's own +
// office. Photos never reach the client PDF (hours only).
import { supabase } from '../supabaseClient';

export const PHOTO_BUCKET = 'timesheet-photos';
export const MAX_PHOTOS = 6;
export const MAX_EDGE = 1600;

function uuid() {
  try { if (window.crypto?.randomUUID) return window.crypto.randomUUID(); } catch { /* fall through */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
    img.src = url;
  });
}

// Shrinks a camera photo to at most MAX_EDGE px on its long side and
// re-encodes as JPEG — a 12 MP phone shot becomes ~250 KB before upload.
export async function resizeImage(file, maxEdge = MAX_EDGE, quality = 0.85) {
  let source, w, h;
  if (typeof createImageBitmap === 'function') {
    try {
      source = await createImageBitmap(file, { imageOrientation: 'from-image' });
      w = source.width; h = source.height;
    } catch { source = null; }
  }
  if (!source) {
    source = await loadImage(file);
    w = source.naturalWidth || source.width; h = source.naturalHeight || source.height;
  }
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, cw, ch);
  if (source.close) { try { source.close(); } catch { /* bitmap already closed */ } }
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
  if (!blob) throw new Error('Could not resize that image');
  return blob;
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read photo'));
    r.readAsDataURL(blob);
  });
}

export function dataUrlToBlob(dataUrl) {
  const [head, b64] = String(dataUrl).split(',');
  const mime = /data:([^;]+)/.exec(head)?.[1] || 'image/jpeg';
  const bin = atob(b64 || '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// photos: [{ blob?, dataUrl?, caption? }]. Returns { uploaded, errors }.
export async function uploadTimesheetPhotos({ workerId, headerId, photos = [] }) {
  const uploaded = [];
  const errors = [];
  for (const p of photos) {
    try {
      const blob = p.blob || (p.dataUrl ? dataUrlToBlob(p.dataUrl) : null);
      if (!blob) continue;
      const path = `${workerId}/${headerId}/${uuid()}.jpg`;
      const { error: upErr } = await supabase.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      if (upErr) throw upErr;
      const { data, error: rowErr } = await supabase.from('timesheet_photos')
        .insert({ header_id: headerId, worker_id: workerId, path, caption: p.caption ? String(p.caption).slice(0, 120) : null })
        .select('id, path, caption, created_at').single();
      if (rowErr) throw rowErr;
      uploaded.push(data);
    } catch (e) {
      errors.push(e);
    }
  }
  return { uploaded, errors };
}

// Rows for a header with short-lived signed URLs (10 min). Silent on
// failure: the public supervisor page renders this view anonymously.
export async function listTimesheetPhotos(headerId) {
  if (!headerId) return [];
  try {
    const { data, error } = await supabase.from('timesheet_photos')
      .select('id, path, caption, created_at, worker_id').eq('header_id', headerId).order('created_at');
    if (error || !data?.length) return [];
    const { data: signed } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrls(data.map(r => r.path), 600);
    const byPath = new Map((signed || []).map(s => [s.path, s.signedUrl]));
    return data.map(r => ({ ...r, url: byPath.get(r.path) || null }));
  } catch { return []; }
}

export async function removeTimesheetPhoto(row) {
  const { error } = await supabase.from('timesheet_photos').delete().eq('id', row.id);
  if (error) return { ok: false, error: error.message };
  await supabase.storage.from(PHOTO_BUCKET).remove([row.path]).catch(() => {});
  return { ok: true };
}
