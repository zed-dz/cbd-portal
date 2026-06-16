import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../../supabaseClient';
import { C, btnPrimary, btnSecondary, btnSmall, btnDanger } from '../../theme';
import { Spinner, Badge, EmptyState } from '../../components';

// Admin view of inbound applications from the marketing site / LinkedIn ad
// / portal /apply page. Submissions land via the `submit-application` edge
// function which writes via service_role (so RLS on the table can stay
// admin-only and not leak PII to anon callers).
//
// Triage states (see DB CHECK constraint):
//   new        — just submitted, hasn't been looked at
//   reviewing  — admin is following up / scheduling a chat
//   approved   — passes the bar, ready to convert to a worker row
//   rejected   — not a fit
//   converted  — worker row was created via approve_application_to_worker RPC

const STATUS_OPTIONS = [
  { value: 'new',        label: 'New' },
  { value: 'reviewing',  label: 'Reviewing' },
  { value: 'approved',   label: 'Approved' },
  { value: 'rejected',   label: 'Rejected' },
  { value: 'converted',  label: 'Converted' },
];

const STATUS_COLOR = {
  new: 'yellow', reviewing: 'blue', approved: 'green', rejected: 'gray', converted: 'green',
};

const SOURCE_LABEL = {
  'linkedin-ad': 'LinkedIn Ad',
  'marketing-site': 'Marketing Site',
  'portal-apply': 'Portal /apply',
};

export function ApplicationsPage({ showToast, onNavigate }) {
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState('new');
  const [filterType, setFilterType] = useState('worker');
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [notesDraft, setNotesDraft] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('worker_applications')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) showToast(error.message, 'error');
    else setApps(data || []);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => apps.filter(a => {
    if (filterStatus && a.status !== filterStatus) return false;
    if (filterType   && a.type   !== filterType)   return false;
    if (search) {
      const s = search.toLowerCase();
      if (!a.full_name.toLowerCase().includes(s)
          && !a.email.toLowerCase().includes(s)
          && !(a.phone || '').toLowerCase().includes(s)
          && !(a.message || '').toLowerCase().includes(s)) return false;
    }
    return true;
  }), [apps, filterStatus, filterType, search]);

  const counts = useMemo(() => {
    const c = { new: 0, reviewing: 0, approved: 0, rejected: 0, converted: 0 };
    apps.filter(a => a.type === filterType).forEach(a => { c[a.status] = (c[a.status] || 0) + 1; });
    return c;
  }, [apps, filterType]);

  const updateStatus = async (app, newStatus) => {
    setBusyId(app.id);
    const reviewer = (await supabase.auth.getUser()).data?.user?.email || null;
    const { error } = await supabase
      .from('worker_applications')
      .update({ status: newStatus, reviewed_at: new Date().toISOString(), reviewed_by: reviewer })
      .eq('id', app.id);
    setBusyId(null);
    if (error) { showToast(error.message, 'error'); return; }
    showToast(`Marked ${app.full_name} as ${newStatus}`, 'success');
    load();
  };

  const saveNotes = async (app) => {
    const text = notesDraft[app.id];
    if (text == null) return;
    setBusyId(app.id);
    const { error } = await supabase
      .from('worker_applications')
      .update({ review_notes: text })
      .eq('id', app.id);
    setBusyId(null);
    if (error) { showToast(error.message, 'error'); return; }
    showToast('Notes saved', 'success');
    setNotesDraft(d => { const x = { ...d }; delete x[app.id]; return x; });
    load();
  };

  const approveAndConvert = async (app) => {
    if (app.type !== 'worker') {
      showToast('Only worker-type applications can be converted to workers. Use status = approved for clients.', 'error');
      return;
    }
    if (!window.confirm(`Convert "${app.full_name}" into a Worker record? They'll show up in the Workers page with status "Profile Incomplete" and you can send them an onboarding link.`)) return;
    setBusyId(app.id);
    const reviewer = (await supabase.auth.getUser()).data?.user?.email || null;
    const { data, error } = await supabase.rpc('approve_application_to_worker', {
      p_application_id: app.id,
      p_reviewer: reviewer,
    });
    setBusyId(null);
    if (error) { showToast(error.message, 'error'); return; }
    showToast(`Converted to worker — open Workers page to send onboarding link.`, 'success');
    load();
    if (data && onNavigate) {
      // Soft cross-page nav so the admin can jump straight to the new worker.
      setTimeout(() => onNavigate('pending_workers'), 800);
    }
  };

  const deleteApp = async (app) => {
    if (!window.confirm(`Delete this application from ${app.full_name}? This cannot be undone (use Reject instead if you want to keep a record).`)) return;
    setBusyId(app.id);
    const { error } = await supabase.from('worker_applications').delete().eq('id', app.id);
    setBusyId(null);
    if (error) { showToast(error.message, 'error'); return; }
    showToast('Application deleted', 'success');
    load();
  };

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>;

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text, marginBottom: 4 }}>Applications</h1>
        <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.5 }}>
          Inbound applications from the marketing site, LinkedIn ad, and the portal's public /apply page.
          Review new ones, approve good fits, and click <strong>Convert to Worker</strong> to materialise them into your Workers list.
        </div>
      </div>

      {/* Worker / Client tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 14, background: C.card, borderRadius: 8, padding: 3, width: 'fit-content' }}>
        {['worker', 'client'].map(t => (
          <button
            key={t}
            onClick={() => setFilterType(t)}
            style={{
              padding: '6px 16px', border: 'none', borderRadius: 5, cursor: 'pointer',
              background: filterType === t ? C.cardHover : 'transparent',
              color: filterType === t ? C.text : C.textMuted,
              fontWeight: filterType === t ? 600 : 500, fontSize: 13,
            }}>
            {t === 'worker' ? '👷 Workers' : '🏗 Clients'}
          </button>
        ))}
      </div>

      {/* Status counts + filter chips */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {STATUS_OPTIONS.map(s => {
          const n = counts[s.value] || 0;
          const active = filterStatus === s.value;
          return (
            <button
              key={s.value}
              onClick={() => setFilterStatus(active ? '' : s.value)}
              style={{
                padding: '6px 12px', border: `1px solid ${active ? C.accent : C.border}`, borderRadius: 16, cursor: 'pointer',
                background: active ? 'rgba(249,115,22,0.12)' : C.card,
                color: active ? C.accent : C.text,
                fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6,
              }}>
              {s.label}
              <span style={{ background: active ? C.accent : C.border, color: active ? '#fff' : C.textMuted, borderRadius: 8, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>{n}</span>
            </button>
          );
        })}
      </div>

      <input
        placeholder="Search name, email, phone, message…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{
          width: '100%', maxWidth: 420, padding: '8px 12px', marginBottom: 18,
          background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 13,
        }}
      />

      {filtered.length === 0 ? (
        <EmptyState message={
          filterStatus === 'new' && filterType === 'worker'
            ? 'No new applications. When someone fills the form on the marketing site, the LinkedIn ad, or the portal /apply page, they appear here.'
            : 'No applications match these filters.'
        } />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 14 }}>
          {filtered.map(app => {
            const isOpen = expanded === app.id;
            const localNotes = notesDraft[app.id];
            return (
              <div key={app.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: C.text, overflowWrap: 'anywhere' }}>{app.full_name}</div>
                    <a href={`mailto:${app.email}`} style={{ fontSize: 12, color: C.textMuted, textDecoration: 'none' }}>{app.email}</a>
                    {app.phone && <div style={{ fontSize: 12, color: C.textMuted }}>📱 <a href={`tel:${app.phone.replace(/\s/g, '')}`} style={{ color: 'inherit', textDecoration: 'none' }}>{app.phone}</a></div>}
                  </div>
                  <Badge label={app.status} color={STATUS_COLOR[app.status] || 'gray'} />
                </div>
                <div style={{ fontSize: 10, color: C.textDim, fontFamily: '"DM Mono", monospace', letterSpacing: 0.5, marginBottom: 10, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <span>{new Date(app.created_at).toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'short' })}</span>
                  {app.source && <span>· source: {SOURCE_LABEL[app.source] || app.source}</span>}
                  {app.converted_worker_id && <span style={{ color: C.success }}>· worker created</span>}
                </div>

                {app.message && (
                  <div style={{
                    fontSize: 13, color: C.text, lineHeight: 1.55, background: C.bg,
                    border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 12px', marginBottom: 10,
                    maxHeight: isOpen ? 'unset' : 80, overflow: isOpen ? 'visible' : 'hidden', position: 'relative',
                  }}>
                    {app.message}
                  </div>
                )}

                {isOpen && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: C.textMuted, fontFamily: '"DM Mono", monospace', letterSpacing: 1, marginBottom: 4 }}>REVIEW NOTES</div>
                    <textarea
                      value={localNotes != null ? localNotes : (app.review_notes || '')}
                      onChange={e => setNotesDraft(d => ({ ...d, [app.id]: e.target.value }))}
                      placeholder="Internal notes — visible to admins only"
                      style={{ width: '100%', minHeight: 60, padding: 8, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontSize: 12, fontFamily: 'inherit', resize: 'vertical' }}
                    />
                    {localNotes != null && (
                      <button onClick={() => saveNotes(app)} disabled={busyId === app.id} style={{ ...btnSmall, marginTop: 6 }}>
                        {busyId === app.id ? 'Saving…' : '💾 Save notes'}
                      </button>
                    )}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {app.type === 'worker' && app.status !== 'converted' && (
                    <button onClick={() => approveAndConvert(app)} disabled={busyId === app.id} style={btnPrimary} title="Create a workers row from this application">
                      ✅ Convert to Worker
                    </button>
                  )}
                  {app.status === 'new' && (
                    <button onClick={() => updateStatus(app, 'reviewing')} disabled={busyId === app.id} style={btnSecondary}>👀 Reviewing</button>
                  )}
                  {app.status !== 'rejected' && app.status !== 'converted' && (
                    <button onClick={() => updateStatus(app, 'rejected')} disabled={busyId === app.id} style={btnSecondary}>👎 Reject</button>
                  )}
                  <button onClick={() => setExpanded(isOpen ? null : app.id)} style={btnSmall}>
                    {isOpen ? '▴ Collapse' : '▾ Details'}
                  </button>
                  {(app.status === 'rejected' || app.status === 'converted') && (
                    <button onClick={() => deleteApp(app)} style={btnDanger} title="Permanently delete this application">🗑</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
