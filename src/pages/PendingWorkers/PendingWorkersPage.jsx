import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, btnSmall } from '../../theme';
import { Spinner, Badge, EmptyState } from '../../components';
import { onboardLink, whatsappLink, inviteMessage, normaliseMobileE164AU } from '../../utils/inviteLinks';

export function PendingWorkersPage({ showToast }) {
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sendingId, setSendingId] = useState(null);
  const [smsId, setSmsId] = useState(null);

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
        // Gmail accepted it — say so precisely, and point at the spam folder,
        // which is where these land often enough to look like "nothing sent".
        showToast(`Invite emailed to ${w.email}. If it doesn't arrive, check spam/promotions or use SMS.`, 'success');
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

  // Send the invite as a real SMS through Twilio (the `send-sms` edge function),
  // NOT an `sms:` device link. The old version called window.open('sms:…'),
  // which on a desktop browser just raises a "This site is trying to open Pick
  // an application" dialog and sends nothing — reported 2026-08-04.
  const sendSms = async (w) => {
    if (!w.profile_token) { showToast('No profile token — re-save the worker first.', 'error'); return; }
    const to = normaliseMobileE164AU(w.mobile);
    if (!to) { showToast(`No mobile number on file for ${w.name || 'this worker'}.`, 'error'); return; }
    setSmsId(w.id);
    try {
      const firstName = (w.name || '').split(' ')[0];
      const link = onboardLink(w.profile_token);
      const { data, error } = await supabase.functions.invoke('send-sms', {
        body: { to, body: inviteMessage({ firstName, link }) },
      });
      if (error || data?.error) {
        showToast(`Text failed: ${data?.error || error?.message || 'unknown error'}`, 'error');
      } else {
        await supabase.from('workers')
          .update({ profile_invite_sent_at: new Date().toISOString() })
          .eq('id', w.id);
        showToast(`Invite texted to ${to}`, 'success');
        load();
      }
    } catch (e) {
      showToast(e.message || 'Failed to send the text', 'error');
    }
    setSmsId(null);
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
        Workers who haven't completed their profile or accepted their invite. <strong style={{ color: C.text }}>SMS</strong> texts the onboarding link straight from the portal — the most reliable channel, and worth using if an emailed invite hasn't shown up. <strong style={{ color: C.text }}>WhatsApp</strong> opens a pre-filled chat on your device.
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
              <button
                onClick={() => sendSms(w)}
                disabled={smsId === w.id || !w.mobile}
                style={{ ...btnSmall, opacity: w.mobile ? 1 : 0.45 }}
                title={w.mobile ? `Text the invite to ${w.mobile}` : 'No mobile number on file'}
              >
                {smsId === w.id ? 'Texting…' : '📨 SMS'}
              </button>
              <button onClick={() => copyLink(w)} style={btnSmall} title="Copy onboarding link">🔗 Copy</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
