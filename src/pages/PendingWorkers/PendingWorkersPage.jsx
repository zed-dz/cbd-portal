import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, btnSmall } from '../../theme';
import { Spinner, Badge, EmptyState } from '../../components';

export function PendingWorkersPage({ showToast }) {
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sendingId, setSendingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('workers').select('*').neq('app_status', 'Active').is('archived_at', null).order('created_at', { ascending: false });
    if (error) showToast(error.message, 'error');
    else setWorkers(data || []);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const handleRemind = async (w) => {
    setSendingId(w.id);
    try {
      const { data, error } = await supabase.functions.invoke('send-invite', { body: { worker_id: w.id } });
      if (error || (data && data.error)) {
        const msg = data?.message || error?.message || 'Email not sent';
        if (w.profile_token) {
          const link = `${window.location.origin}/onboard/${w.profile_token}`;
          try { await navigator.clipboard.writeText(link); } catch (e) {}
          showToast(`${msg} Link copied to clipboard.`, 'info');
        } else {
          showToast(msg, 'error');
        }
      } else {
        showToast(`Reminder emailed to ${w.email}`, 'success');
        load();
      }
    } catch (e) {
      showToast(e.message || 'Failed to send reminder', 'error');
    }
    setSendingId(null);
  };

  const copyLink = async (w) => {
    if (!w.profile_token) { showToast('No profile token — re-save the worker first.', 'error'); return; }
    const link = `${window.location.origin}/onboard/${w.profile_token}`;
    try {
      await navigator.clipboard.writeText(link);
      showToast('Onboarding link copied', 'success');
    } catch (e) {
      showToast(link, 'info');
    }
  };

  const appStatusColor = (s) => s === 'Invite Sent' ? 'blue' : s === 'Completing Profile' ? 'yellow' : s === 'Profile Incomplete' ? 'yellow' : 'gray';

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>;
  if (!workers.length) return <EmptyState message="All workers are active — no pending onboarding." />;

  return (
    <div>
      <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 20 }}>Workers who haven't completed their profile or accepted their invite.</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
        {workers.map(w => (
          <div key={w.id} style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <div>
                <div style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>{w.name}</div>
                <div style={{ color: C.textMuted, fontSize: 12, marginTop: 2 }}>{w.email}</div>
                {w.job_title && <div style={{ color: C.textMuted, fontSize: 12 }}>{w.job_title}</div>}
              </div>
              <Badge label={w.app_status || 'Pending'} color={appStatusColor(w.app_status)} />
            </div>
            {w.mobile && <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 10 }}>📱 {w.mobile}</div>}
            {w.profile_invite_sent_at && (
              <div style={{ color: C.textMuted, fontSize: 11, marginBottom: 10, fontFamily: '"DM Mono", monospace' }}>
                Last invite: {new Date(w.profile_invite_sent_at).toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'short' })}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => handleRemind(w)} disabled={sendingId === w.id} style={{ ...btnSmall, flex: 1 }}>
                {sendingId === w.id ? 'Sending…' : '✉️ Send Reminder'}
              </button>
              <button onClick={() => copyLink(w)} style={btnSmall} title="Copy onboarding link">🔗</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
