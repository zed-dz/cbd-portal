import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnSmall } from '../../theme';
import { localISO, fmtDateTime, sydneyDateTimeInput } from '../../utils/dates';
import { Field, Spinner, EmptyState, Badge } from '../index';

// Incident / near-miss / hazard report from the phone (2026-10-19). Short
// form, up to 3 photos (resized on the phone to 1600 px so a 12 MB camera
// shot does not eat the worker's data), bell + SMS + email to every admin
// through notify-admins-ops. The office reviews it on the Safety page.

export const BUCKET = 'incident-photos';
const DESC_MAX = 600;
const MAX_PHOTOS = 3;
const TYPES = [
  ['incident',  '🚑 Incident',  'Something happened — someone was hurt or property was damaged'],
  ['near_miss', '⚠️ Near miss', 'Nobody hurt, but it nearly went wrong'],
  ['hazard',    '🦺 Hazard',    'Something unsafe that should be fixed before it hurts someone'],
];
export const TYPE_LABEL = { incident: 'Incident', near_miss: 'Near miss', hazard: 'Hazard' };

export function incidentTypeBadge(type) {
  const map = { incident: 'red', near_miss: 'orange', hazard: 'yellow' };
  return <Badge label={TYPE_LABEL[type] || type} color={map[type] || 'gray'} />;
}
export function incidentStatusBadge(status) {
  const map = { open: 'red', reviewed: 'blue', closed: 'green' };
  return <Badge label={status} color={map[status] || 'gray'} />;
}

// Downscale an image file to max 1600 px on its long edge, JPEG 0.85.
// Falls back to the original file when the browser cannot decode it.
export async function resizeImage(file, max = 1600) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
    return blob || file;
  } catch { return file; }
}

// Local wall-clock "yyyy-MM-ddTHH:mm" for the datetime-local default.
const nowLocalInput = () => {
  const d = new Date();
  return `${localISO(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function IncidentReportTab({ currentWorker, showToast }) {
  const [places, setPlaces] = useState([]);     // from recent allocations
  const [mine, setMine] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState({ type: 'near_miss', when: nowLocalInput(), place: '', other: '', description: '', injured: false, first_aid: false });
  const [photos, setPhotos] = useState([]);      // [{ file: Blob, name, preview }]

  const load = useCallback(async () => {
    const since = localISO(new Date(Date.now() - 90 * 86400000));
    const [{ data: allocs }, { data: reports }] = await Promise.all([
      supabase.from('allocations').select('client, site, site_id, start_date').eq('worker_id', currentWorker.id)
        .in('status', ['confirmed', 'completed']).gte('start_date', since).order('start_date', { ascending: false }).limit(60),
      supabase.from('incident_reports').select('*').eq('worker_id', currentWorker.id).order('created_at', { ascending: false }).limit(20),
    ]);
    const seen = new Set();
    const list = [];
    for (const a of allocs || []) {
      const key = `${a.client || ''}|${a.site || ''}`;
      if (!a.client && !a.site) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ key, client: a.client || '', site: a.site || '', site_id: a.site_id || null });
    }
    setPlaces(list);
    if (list.length && !f.place) setF(s => ({ ...s, place: list[0].key }));
    setMine(reports || []);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorker.id]);   // f.place is only read to seed the default once

  useEffect(() => { load(); }, [load]);

  const addPhotos = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    const room = MAX_PHOTOS - photos.length;
    if (room <= 0) { showToast(`Up to ${MAX_PHOTOS} photos.`, 'error'); return; }
    const next = [];
    for (const file of files.slice(0, room)) {
      if (!file.type.startsWith('image/')) continue;
      const blob = await resizeImage(file);
      next.push({ file: blob, name: file.name, preview: URL.createObjectURL(blob) });
    }
    setPhotos(p => [...p, ...next]);
  };
  const removePhoto = (i) => setPhotos(p => { try { URL.revokeObjectURL(p[i].preview); } catch { /* ignore */ } return p.filter((_, j) => j !== i); });

  const submit = async () => {
    const desc = f.description.trim();
    if (!desc) { showToast('Say what happened.', 'error'); return; }
    if (!f.when) { showToast('When did it happen?', 'error'); return; }
    const picked = places.find(p => p.key === f.place);
    const other = f.other.trim();
    if (f.place === '__other' && !other) { showToast('Where did it happen?', 'error'); return; }
    setSaving(true);

    // Photos first, under {worker_id}/ so the bucket policy accepts them.
    const paths = [];
    for (let i = 0; i < photos.length; i++) {
      const path = `${currentWorker.id}/${Date.now()}-${i}.jpg`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, photos[i].file, { contentType: 'image/jpeg', upsert: false });
      if (upErr) { setSaving(false); showToast(`Photo upload failed: ${upErr.message}`, 'error'); return; }
      paths.push(path);
    }

    const { data, error } = await supabase.from('incident_reports').insert([{
      worker_id: currentWorker.id,
      site_id: f.place === '__other' ? null : (picked?.site_id || null),
      client: f.place === '__other' ? null : (picked?.client || null),
      site: f.place === '__other' ? other : (picked?.site || null),
      occurred_at: new Date(f.when).toISOString(),
      type: f.type, description: desc.slice(0, DESC_MAX),
      injured: !!f.injured, first_aid: !!f.first_aid,
      photo_paths: paths, status: 'open',
    }]).select().single();
    setSaving(false);
    if (error) { showToast(error.message, 'error'); return; }
    supabase.functions.invoke('notify-admins-ops', { body: { kind: 'incident_reported', id: data.id } })
      .catch(e => console.error('notify-admins-ops failed:', e));
    showToast('Report sent to the office. Thank you for speaking up.', 'success');
    photos.forEach(p => { try { URL.revokeObjectURL(p.preview); } catch { /* ignore */ } });
    setPhotos([]);
    setF({ type: 'near_miss', when: nowLocalInput(), place: places[0]?.key || '', other: '', description: '', injured: false, first_aid: false });
    load();
  };

  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const check = (label, k) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: C.text, padding: '8px 0', minHeight: 36 }}>
      <input type="checkbox" checked={!!f[k]} onChange={set(k)} style={{ accentColor: C.accent, width: 20, height: 20 }} />
      {label}
    </label>
  );

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>;

  return (
    <div data-area="report incident" style={{ display: 'grid', gap: 16, maxWidth: 640, margin: '0 auto' }}>
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18 }}>
        <div style={{ fontWeight: 700, color: C.text, fontSize: 16, marginBottom: 4 }}>⚠️ Report an incident, near miss or hazard</div>
        <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 14 }}>
          If someone needs help right now, call <a href="tel:000" style={{ color: '#fca5a5', fontWeight: 700 }}>000</a> first. Then tell us here — it takes a minute and goes straight to the office.
        </div>

        <Field label="What kind?">
          <div style={{ display: 'grid', gap: 8 }}>
            {TYPES.map(([v, label, hint]) => (
              <button key={v} type="button" onClick={() => setF(s => ({ ...s, type: v }))}
                style={{ textAlign: 'left', padding: '10px 12px', borderRadius: 8, cursor: 'pointer', minHeight: 44,
                  border: `1px solid ${f.type === v ? C.accentBorder : C.border}`, background: f.type === v ? C.accentSoft : 'transparent', color: C.text }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{label}</div>
                <div style={{ fontSize: 12, color: C.textMuted }}>{hint}</div>
              </button>
            ))}
          </div>
        </Field>

        <Field label="When *">
          <input type="datetime-local" style={inputStyle} value={f.when} max={sydneyDateTimeInput(new Date().toISOString()) || undefined} onChange={set('when')} />
        </Field>

        <Field label="Where *">
          <select style={inputStyle} value={f.place} onChange={set('place')}>
            {places.map(p => <option key={p.key} value={p.key}>{[p.client, p.site].filter(Boolean).join(' — ')}</option>)}
            <option value="__other">Other location…</option>
          </select>
          {f.place === '__other' && (
            <input style={{ ...inputStyle, marginTop: 8 }} value={f.other} onChange={set('other')} placeholder="Type the site or address" />
          )}
        </Field>

        <Field label={`What happened? * (${f.description.length}/${DESC_MAX})`}>
          <textarea style={{ ...inputStyle, minHeight: 110, resize: 'vertical' }} value={f.description} maxLength={DESC_MAX} onChange={set('description')}
            placeholder="Who, what, where. Plain words are fine." />
        </Field>

        {check('Someone was injured', 'injured')}
        {check('First aid was given', 'first_aid')}

        <Field label={`Photos (up to ${MAX_PHOTOS})`} hint="Shots are shrunk on your phone before upload.">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {photos.map((p, i) => (
              <div key={p.preview} style={{ position: 'relative' }}>
                <img src={p.preview} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: `1px solid ${C.border}` }} />
                <button type="button" onClick={() => removePhoto(i)} aria-label="Remove photo"
                  style={{ position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: 11, border: 'none', background: C.error, color: '#fff', cursor: 'pointer', fontSize: 12, lineHeight: 1 }}>✕</button>
              </div>
            ))}
            {photos.length < MAX_PHOTOS && (
              <label style={{ ...btnSecondary, padding: '10px 14px', cursor: 'pointer', display: 'inline-block', minHeight: 36, boxSizing: 'border-box' }}>
                📷 Add photo
                <input type="file" accept="image/*" capture="environment" multiple onChange={addPhotos} style={{ display: 'none' }} />
              </label>
            )}
          </div>
        </Field>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={submit} disabled={saving} style={{ ...btnPrimary, minHeight: 44, fontSize: 14 }}>{saving ? 'Sending…' : 'Send report'}</button>
        </div>
      </div>

      <div>
        <h4 style={{ color: C.textMuted, fontSize: 13, marginBottom: 10, textTransform: 'uppercase' }}>My reports</h4>
        {mine.length === 0 ? <EmptyState message="No reports yet." icon="🦺" /> : mine.map(r => (
          <div key={r.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px', marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {incidentTypeBadge(r.type)}{incidentStatusBadge(r.status)}
              <span style={{ color: C.textMuted, fontSize: 12 }}>{fmtDateTime(r.occurred_at)}</span>
            </div>
            <div style={{ color: C.text, fontSize: 13, marginTop: 6 }}>{[r.client, r.site].filter(Boolean).join(' — ') || '—'}</div>
            <div style={{ color: C.textMuted, fontSize: 12.5, marginTop: 4, whiteSpace: 'pre-wrap' }}>{r.description}</div>
            {r.review_notes && <div style={{ marginTop: 6, fontSize: 12.5, color: C.text, background: C.bg, borderRadius: 6, padding: '6px 10px' }}>Office: {r.review_notes}</div>}
            {r.photo_paths?.length > 0 && <div style={{ marginTop: 4 }}><span style={btnSmall}>📷 {r.photo_paths.length} photo{r.photo_paths.length > 1 ? 's' : ''}</span></div>}
          </div>
        ))}
      </div>
    </div>
  );
}
