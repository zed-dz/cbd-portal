import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, btnSmall } from '../../theme';
import { Spinner, Badge, EmptyState } from '../../components';
import { onboardLink, smsLink, whatsappLink, inviteMessage } from '../../utils/inviteLinks';

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
          const link = onboardLink(w.profile_token);
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
    const link = onboardLink(w.profile_token);
    try {
      await navigator.clipboard.writeText(link);
      showToast('Onboarding link copied', 'success');
    } catch (e) {
      showToast(link, 'info');
    }
  };

  // SMS + WhatsApp open the OS messenger app pre-populated with the worker's
  // mobile (when known) and the invite message. Email-free backup path for
  // when Gmail/Resend delivery fails or the worker doesn't check email.
  const openSms = (w) => {
    if (!w.profile_token) { showToast('No profile token — re-save the worker first.', 'error'); return; }
    const firstName = (w.name || '').split(' ')[0];
    const link = onboardLink(w.profile_token);
    window.open(smsLink({ mobile: w.mobile, body: inviteMessage({ firstName, link }) }), '_blank');
  };
  const openWhatsApp = (w) => {
    if (!w.profile_token) { showToast('No profile token — re-save the worker first.', 'error'); return; }
    const firstName = (w.name || '').split(' ')[0];
    const link = onboardLink(w.profile_token);
    window.open(whatsappLink({ mobile: w.mobile, body: inviteMessage({ firstName, link }) }), '_blank');
  };

  const appStatusColor = (s) => s === 'Invite Sent' ? 'blue' : s === 'Completing Profile' ? 'yellow' : s === 'Profile Incomplete' ? 'yellow' : 'gray';

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>;
  if (!workers.length) return <EmptyState message="All workers are active — no pending onboarding." />;

  return (
    <div>
      <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 20 }}>
        Workers who haven't completed their profile or accepted their invite. If email delivery is slow, use SMS or WhatsApp as a backup — both open your phone's messenger app pre-filled with their onboarding link.
      </div>
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
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button onClick={() => handleRemind(w)} disabled={sendingId === w.id} style={{ ...btnSmall, flex: '1 1 130px' }}>
                {sendingId === w.id ? 'Sending…' : '✉️ Send Email'}
              </button>
              <button onClick={() => openWhatsApp(w)} style={btnSmall} title={w.mobile ? `WhatsApp ${w.mobile}` : 'Open WhatsApp'}>💬 WhatsApp</button>
              <button onClick={() => openSms(w)} style={btnSmall} title={w.mobile ? `SMS ${w.mobile}` : 'Open SMS'}>📨 SMS</button>
              <button onClick={() => copyLink(w)} style={btnSmall} title="Copy onboarding link">🔗 Copy</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
