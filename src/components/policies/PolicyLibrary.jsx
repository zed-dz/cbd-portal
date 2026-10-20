import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnSecondary, btnSmall } from '../../theme';
import { fmtDate } from '../../utils/dates';
import { Spinner, EmptyState, Badge } from '../index';

// Policies library (2026-10-20): SWMS, Take 5 forms, incident report forms,
// annexures and other company files. The office uploads them (Policies page);
// workers open them any time from the phone app (Policies tab). Read only.
// Signing stays in Documents. Files live in the private policy-files bucket;
// RLS lets a worker read a file only while its row is live and shown to workers.

export const POLICY_BUCKET = 'policy-files';
export const POLICY_MAX_BYTES = 25 * 1024 * 1024;

export function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// A short label for the file type: PDF, WORD, EXCEL, IMAGE, or the extension.
export function fileKind(name, mime) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (mime === 'application/pdf' || ext === 'pdf') return 'PDF';
  if (['doc', 'docx'].includes(ext)) return 'WORD';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'EXCEL';
  if (['ppt', 'pptx'].includes(ext)) return 'SLIDES';
  if (String(mime || '').startsWith('image/')) return 'IMAGE';
  return ext ? ext.toUpperCase().slice(0, 6) : 'FILE';
}

// Opens a file in a new tab. The tab opens before the signed link is fetched,
// so phone browsers do not block it as a pop-up.
export async function openPolicyFile(doc, showToast) {
  const win = window.open('', '_blank');
  const { data, error } = await supabase.storage.from(POLICY_BUCKET).createSignedUrl(doc.file_path, 600);
  if (error || !data?.signedUrl) {
    if (win) win.close();
    showToast?.(error?.message || 'Could not open the file.', 'error');
    return;
  }
  if (win) { win.opener = null; win.location.href = data.signedUrl; }
  else window.location.href = data.signedUrl;
}

// Loads categories + files. Office sees archived rows too (RLS decides).
export function usePolicyLibrary(showToast) {
  const [cats, setCats] = useState([]);
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: c, error: e1 }, { data: d, error: e2 }] = await Promise.all([
      supabase.from('policy_categories').select('id, name, sort_order, archived_at').order('sort_order').order('name'),
      supabase.from('policy_documents').select('*').order('title'),
    ]);
    if (e1 || e2) showToast?.((e1 || e2).message, 'error');
    setCats(c || []); setDocs(d || []);
    setLoading(false);
  }, [showToast]);
  useEffect(() => { load(); }, [load]);
  return { cats, docs, loading, reload: load };
}

// The list both sides share: folder chips, a search box, files grouped by folder.
// `renderActions(doc)` adds office buttons; without it the list is read only.
export function PolicyList({ cats, docs, showToast, renderActions, emptyMessage }) {
  const [catId, setCatId] = useState('all');
  const [q, setQ] = useState('');

  const counts = useMemo(() => {
    const m = {};
    docs.forEach(d => { m[d.category_id] = (m[d.category_id] || 0) + 1; });
    return m;
  }, [docs]);

  const shownCats = cats.filter(c => counts[c.id] || (!c.archived_at && catId === c.id));
  const needle = q.trim().toLowerCase();
  const filtered = docs.filter(d =>
    (catId === 'all' || d.category_id === catId) &&
    (!needle || `${d.title} ${d.description || ''} ${d.file_name}`.toLowerCase().includes(needle)));

  const groups = cats
    .map(c => ({ cat: c, items: filtered.filter(d => d.category_id === c.id) }))
    .filter(g => g.items.length);

  const chip = (id, label, n) => (
    <button key={id} onClick={() => setCatId(id)} aria-pressed={catId === id}
      style={{ ...btnSecondary, minHeight: 36, padding: '6px 12px', fontSize: 13, whiteSpace: 'nowrap', flexShrink: 0,
        background: catId === id ? C.accentSoft : 'transparent', borderColor: catId === id ? C.accentBorder : C.border,
        color: catId === id ? C.accent : C.text }}>
      {label}{n ? <span style={{ color: catId === id ? C.accent : C.textDim, marginLeft: 6 }}>{n}</span> : null}
    </button>
  );

  return (
    <div data-area="policy list">
      <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search policies and forms"
        aria-label="Search policies and forms" style={{ ...inputStyle, marginBottom: 10 }} />
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 6, marginBottom: 10, WebkitOverflowScrolling: 'touch' }}>
        {chip('all', 'All', docs.length)}
        {shownCats.map(c => chip(c.id, c.name, counts[c.id]))}
      </div>

      {!groups.length ? (
        <EmptyState icon="📚" message={needle ? 'Nothing matches that search.' : (emptyMessage || 'No files here yet.')} />
      ) : groups.map(({ cat, items }) => (
        <section key={cat.id} style={{ marginBottom: 18 }}>
          <h3 style={{ margin: '4px 0 8px', color: C.textMuted, fontSize: 12, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase' }}>
            {cat.name} <span style={{ color: C.textDim, fontWeight: 500 }}>· {items.length}</span>
          </h3>
          <div style={{ display: 'grid', gap: 8 }}>
            {items.map(d => (
              <div key={d.id} data-area="policy file" style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10,
                padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', opacity: d.archived_at ? 0.6 : 1 }}>
                <button onClick={() => openPolicyFile(d, showToast)} title={`Open ${d.file_name}`}
                  style={{ flex: '1 1 220px', minWidth: 0, display: 'flex', alignItems: 'center', gap: 12, background: 'none', border: 'none',
                    padding: 0, cursor: 'pointer', textAlign: 'left', color: C.text, minHeight: 44 }}>
                  <span style={{ flexShrink: 0, width: 46, textAlign: 'center', fontSize: 10.5, fontWeight: 800, letterSpacing: 0.4,
                    color: C.accent, background: C.accentSoft, border: `1px solid ${C.accentBorder}`, borderRadius: 6, padding: '7px 0' }}>
                    {fileKind(d.file_name, d.mime_type)}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 700, fontSize: 14.5, overflowWrap: 'anywhere' }}>{d.title}</span>
                    {d.description && <span style={{ display: 'block', color: C.textMuted, fontSize: 12.5, marginTop: 2 }}>{d.description}</span>}
                    <span style={{ display: 'block', color: C.textDim, fontSize: 11.5, marginTop: 3 }}>
                      {fmtSize(d.size_bytes)}{d.size_bytes ? ' · ' : ''}added {fmtDate(d.created_at)}
                    </span>
                  </span>
                </button>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {d.archived_at && <Badge label="Archived" color="gray" size="sm" />}
                  {!d.archived_at && renderActions && !d.visible_to_workers && <Badge label="Office only" color="yellow" size="sm" />}
                  <button onClick={() => openPolicyFile(d, showToast)} style={{ ...btnSmall, minHeight: 36 }}>Open</button>
                  {renderActions?.(d)}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// Worker phone app tab: read only.
export function PoliciesTab({ showToast }) {
  const { cats, docs, loading } = usePolicyLibrary(showToast);
  if (loading) return <Spinner />;
  return (
    <div data-area="policies tab">
      <h2 style={{ margin: '0 0 4px', color: C.text, fontSize: 19, fontWeight: 800 }}>📚 Policies</h2>
      <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 14 }}>SWMS, Take 5, incident forms and company policies. Tap a file to open it.</div>
      <PolicyList cats={cats} docs={docs} showToast={showToast} emptyMessage="The office has not added any files yet." />
    </div>
  );
}
