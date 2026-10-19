import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnSmall } from '../../theme';
import { fmtDateTime } from '../../utils/dates';
import { logActivity } from '../../utils/activity';
import { Spinner, EmptyState, Modal, Field, TableWrap, Th, Td } from '../../components';
import { BUCKET, TYPE_LABEL, incidentTypeBadge, incidentStatusBadge } from '../../components/worker/IncidentReportTab';

// Safety — incident / near-miss / hazard reports from the crew (2026-10-19).
// List → open one (photos via short signed URLs) → mark reviewed / closed with
// notes → print view. Everything the worker wrote is read-only here; the
// office only adds its review.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function printIncident(r, workerName, photoUrls) {
  const w = window.open('', '_blank', 'noopener,width=900,height=1000');
  if (!w) return;
  const row = (k, v) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(TYPE_LABEL[r.type] || 'Incident')} report — ${esc(workerName)}</title>
  <style>body{font-family:-apple-system,Segoe UI,sans-serif;color:#111;padding:28px;max-width:800px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}.sub{color:#666;font-size:12px;margin-bottom:18px}
  table{border-collapse:collapse;width:100%;margin-bottom:16px}th{text-align:left;width:160px;color:#555;font-size:12px;text-transform:uppercase;letter-spacing:.5px;padding:7px 8px;border-bottom:1px solid #ddd;vertical-align:top}td{padding:7px 8px;border-bottom:1px solid #ddd;font-size:14px;white-space:pre-wrap}
  .photos img{max-width:100%;max-height:420px;display:block;margin:8px 0;border:1px solid #ddd}.review{background:#f6f6f6;padding:12px;border-radius:6px}@media print{button{display:none}}</style></head><body>
  <h1>${esc(TYPE_LABEL[r.type] || 'Incident')} report</h1><div class="sub">Reported ${esc(fmtDateTime(r.created_at))} · status ${esc(r.status)}</div>
  <table>${row('Reported by', workerName)}${row('Occurred', fmtDateTime(r.occurred_at))}${row('Client', r.client || '—')}${row('Site / location', r.site || '—')}
  ${row('Injured', r.injured ? 'YES' : 'No')}${row('First aid given', r.first_aid ? 'YES' : 'No')}${row('What happened', r.description)}</table>
  ${photoUrls.length ? `<div class="photos"><strong>Photos</strong>${photoUrls.map(u => `<img src="${u}" alt="">`).join('')}</div>` : ''}
  <div class="review"><strong>Office review</strong><br>${r.reviewed_by ? `${esc(r.status)} by ${esc(r.reviewed_by)} on ${esc(fmtDateTime(r.reviewed_at))}` : 'Not yet reviewed'}${r.review_notes ? `<br><br>${esc(r.review_notes)}` : ''}</div>
  <p><button onclick="window.print()">Print</button></p></body></html>`);
  w.document.close();
}

export function IncidentsPage({ showToast, currentWorker }) {
  const [rows, setRows] = useState([]);
  const [workers, setWorkers] = useState({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('open');
  const [open, setOpen] = useState(null);
  const [photoUrls, setPhotoUrls] = useState([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data, error }, { data: ws }] = await Promise.all([
      supabase.from('incident_reports').select('*').order('created_at', { ascending: false }).limit(300),
      supabase.from('workers').select('id, name, mobile'),
    ]);
    if (error) showToast(error.message, 'error');
    setRows(data || []);
    setWorkers(Object.fromEntries((ws || []).map(w => [w.id, w])));
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const openOne = async (r) => {
    setOpen(r); setNotes(r.review_notes || ''); setPhotoUrls([]);
    if (r.photo_paths?.length) {
      const { data } = await supabase.storage.from(BUCKET).createSignedUrls(r.photo_paths, 600);
      setPhotoUrls((data || []).map(d => d.signedUrl).filter(Boolean));
    }
  };

  const setStatus = async (status) => {
    setBusy(true);
    const payload = { status, review_notes: notes.trim() || null, reviewed_by: currentWorker?.name || 'Office', reviewed_at: new Date().toISOString() };
    const { error } = await supabase.from('incident_reports').update(payload).eq('id', open.id);
    setBusy(false);
    if (error) { showToast(error.message, 'error'); return; }
    logActivity({ verb: status === 'closed' ? 'closed' : 'reviewed', object_type: 'incident_report', object_id: open.id, site_id: open.site_id || null,
      after: { name: `${TYPE_LABEL[open.type] || open.type} — ${workers[open.worker_id]?.name || ''}`, status, notes: notes.trim() || null } });
    showToast(`Marked ${status}.`, 'success');
    setOpen({ ...open, ...payload });
    load();
  };

  const shown = rows.filter(r => filter === 'all' || r.status === filter);
  const openCount = rows.filter(r => r.status === 'open').length;

  return (
    <div data-area="safety">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, color: C.text, fontSize: 20, fontWeight: 800 }}>🦺 Safety</h2>
          <div style={{ color: C.textMuted, fontSize: 12.5, marginTop: 2 }}>Incidents, near misses and hazards reported from the crew's phones.</div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {['open', 'reviewed', 'closed', 'all'].map(s => (
            <button key={s} onClick={() => setFilter(s)} style={{ ...btnSecondary, minHeight: 36, padding: '6px 12px', fontSize: 12.5,
              background: filter === s ? C.accentSoft : 'transparent', borderColor: filter === s ? C.accentBorder : C.border, color: filter === s ? C.accent : C.text }}>
              {s}{s === 'open' && openCount ? ` (${openCount})` : ''}
            </button>
          ))}
        </div>
      </div>

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>
        : shown.length === 0 ? <EmptyState message="No reports here. Good." icon="🦺" />
        : (
          <TableWrap>
            <thead><tr><Th>Occurred</Th><Th>Type</Th><Th>Who</Th><Th>Where</Th><Th>Flags</Th><Th>Status</Th><Th /></tr></thead>
            <tbody>
              {shown.map(r => (
                <tr key={r.id} onClick={() => openOne(r)} style={{ cursor: 'pointer' }}>
                  <Td>{fmtDateTime(r.occurred_at)}</Td>
                  <Td>{incidentTypeBadge(r.type)}</Td>
                  <Td>{workers[r.worker_id]?.name || '—'}</Td>
                  <Td>{[r.client, r.site].filter(Boolean).join(' — ') || '—'}</Td>
                  <Td>{[r.injured ? '🚑 injured' : '', r.first_aid ? '🩹 first aid' : '', r.photo_paths?.length ? `📷 ${r.photo_paths.length}` : ''].filter(Boolean).join(' · ') || '—'}</Td>
                  <Td>{incidentStatusBadge(r.status)}</Td>
                  <Td><button style={btnSmall} onClick={(e) => { e.stopPropagation(); openOne(r); }}>Open</button></Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}

      {open && (
        <Modal title={`${TYPE_LABEL[open.type] || 'Report'} — ${workers[open.worker_id]?.name || 'worker'}`} onClose={() => setOpen(null)} width={720}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            {incidentTypeBadge(open.type)}{incidentStatusBadge(open.status)}
            <span style={{ color: C.textMuted, fontSize: 12.5 }}>Occurred {fmtDateTime(open.occurred_at)} · reported {fmtDateTime(open.created_at)}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 12 }}>
            {[['Client', open.client || '—'], ['Site / location', open.site || '—'], ['Injured', open.injured ? 'YES' : 'No'], ['First aid', open.first_aid ? 'YES' : 'No'],
              ['Phone', workers[open.worker_id]?.mobile || '—']].map(([k, v]) => (
              <div key={k} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px' }}>
                <div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>{k}</div>
                <div style={{ fontSize: 13, color: (k === 'Injured' || k === 'First aid') && v === 'YES' ? '#fca5a5' : C.text, fontWeight: 600 }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>What happened</div>
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px', fontSize: 13.5, color: C.text, whiteSpace: 'pre-wrap', marginBottom: 12 }}>{open.description}</div>
          {open.photo_paths?.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              {photoUrls.length === 0 ? <Spinner /> : photoUrls.map(u => (
                <a key={u} href={u} target="_blank" rel="noreferrer"><img src={u} alt="" style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 8, border: `1px solid ${C.border}` }} /></a>
              ))}
            </div>
          )}
          <Field label="Office notes" hint={open.reviewed_by ? `Last ${open.status} by ${open.reviewed_by} on ${fmtDateTime(open.reviewed_at)}` : 'Not reviewed yet'}>
            <textarea style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }} value={notes} onChange={e => setNotes(e.target.value)} placeholder="What was done about it, who was told, follow-ups…" />
          </Field>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => printIncident(open, workers[open.worker_id]?.name || '—', photoUrls)} style={btnSecondary}>🖨 Print</button>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {open.status !== 'reviewed' && <button onClick={() => setStatus('reviewed')} disabled={busy} style={{ ...btnPrimary, background: C.info }}>Mark reviewed</button>}
              {open.status !== 'closed' && <button onClick={() => setStatus('closed')} disabled={busy} style={{ ...btnPrimary, background: C.success }}>Close</button>}
              {open.status === 'closed' && <button onClick={() => setStatus('open')} disabled={busy} style={btnSecondary}>Reopen</button>}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
