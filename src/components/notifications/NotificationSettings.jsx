import { useState, useEffect } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, btnPrimary, btnSecondary } from '../../theme';
import { Modal } from '../ui/Modal';

// Per-admin notification preferences. Persisted on the admin's own `workers`
// row (notify_mode / notify_sms / notify_email) and honored by
// broadcastAdminSms + sendAdminEmail in utils/notify.js.
export function NotificationSettings({ currentWorker, showToast, onClose }) {
  const [mode, setMode] = useState(currentWorker?.notify_mode || 'per_event');
  const [sms, setSms] = useState(currentWorker?.notify_sms !== false);
  const [email, setEmail] = useState(currentWorker?.notify_email !== false);
  const [saving, setSaving] = useState(false);

  // Pull the freshest values on open (currentWorker may predate these columns).
  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data } = await supabase
        .from('workers')
        .select('notify_mode, notify_sms, notify_email')
        .eq('id', currentWorker.id)
        .maybeSingle();
      if (!mounted || !data) return;
      setMode(data.notify_mode || 'per_event');
      setSms(data.notify_sms !== false);
      setEmail(data.notify_email !== false);
    })();
    return () => { mounted = false; };
  }, [currentWorker.id]);

  const save = async () => {
    setSaving(true);
    const { error } = await supabase
      .from('workers')
      .update({ notify_mode: mode, notify_sms: sms, notify_email: email })
      .eq('id', currentWorker.id);
    setSaving(false);
    if (error) { showToast?.(error.message, 'error'); return; }
    // Keep the in-session object roughly in sync (no re-render needed).
    if (currentWorker) { currentWorker.notify_mode = mode; currentWorker.notify_sms = sms; currentWorker.notify_email = email; }
    showToast?.('Notification settings saved', 'success');
    onClose?.();
  };

  const ModeCard = ({ value, title, sub, recommended }) => {
    const active = mode === value;
    return (
      <button
        type="button"
        onClick={() => setMode(value)}
        style={{
          flex: 1, textAlign: 'left', cursor: 'pointer',
          background: active ? C.accentSoft : 'transparent',
          border: `1px solid ${active ? C.accent : C.border}`,
          borderRadius: R.md, padding: '12px 14px', transition: 'all 120ms',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{
            width: 15, height: 15, borderRadius: '50%', flexShrink: 0,
            border: `2px solid ${active ? C.accent : C.borderStrong}`,
            background: active ? C.accent : 'transparent',
            boxShadow: active ? `inset 0 0 0 2px ${C.card}` : 'none',
          }} />
          <span style={{ fontWeight: 700, color: C.text, fontSize: 13.5 }}>{title}</span>
          {recommended && (
            <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5, color: C.accent, background: C.accentSoft, border: `1px solid ${C.accentBorder}`, borderRadius: R.pill, padding: '1px 7px', textTransform: 'uppercase' }}>
              Recommended
            </span>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: C.textMuted, lineHeight: 1.4, paddingLeft: 23 }}>{sub}</div>
      </button>
    );
  };

  const Toggle = ({ on, setOn, label, hint }) => (
    <button
      type="button"
      onClick={() => setOn(!on)}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
        background: 'transparent', border: `1px solid ${C.border}`, borderRadius: R.md,
        padding: '10px 14px', cursor: 'pointer',
      }}
    >
      <span style={{
        width: 38, height: 22, borderRadius: R.pill, flexShrink: 0, position: 'relative',
        background: on ? C.accent : C.borderStrong, transition: 'background 140ms',
      }}>
        <span style={{
          position: 'absolute', top: 2, left: on ? 18 : 2, width: 18, height: 18,
          borderRadius: '50%', background: '#fff', transition: 'left 140ms',
        }} />
      </span>
      <span style={{ flex: 1 }}>
        <span style={{ display: 'block', fontWeight: 600, color: C.text, fontSize: 13 }}>{label}</span>
        <span style={{ display: 'block', fontSize: 11, color: C.textMuted, marginTop: 1 }}>{hint}</span>
      </span>
    </button>
  );

  return (
    <Modal title="🔔 Notification Settings" onClose={onClose} width={480}>
      <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 14, lineHeight: 1.5 }}>
        Choose how you get allocation notifications (new allocations, accepts and declines).
      </div>

      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 1.2, color: C.textDim, textTransform: 'uppercase', marginBottom: 8 }}>How often</div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
        <ModeCard value="per_event" title="Per-event" sub="Notified immediately for each allocation event." recommended />
        <ModeCard value="daily_digest" title="Daily digest" sub="One summary of the day's events, once a day." />
      </div>

      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 1.2, color: C.textDim, textTransform: 'uppercase', marginBottom: 8 }}>Channels</div>
      <div style={{ display: 'grid', gap: 8 }}>
        <Toggle on={sms} setOn={setSms} label="SMS" hint="Text message to your mobile" />
        <Toggle on={email} setOn={setEmail} label="Email" hint="Email to your address on file" />
      </div>

      <div style={{ fontSize: 11, color: C.textDim, marginTop: 12, lineHeight: 1.5, background: C.cardHover, border: `1px solid ${C.border}`, borderRadius: R.sm, padding: '8px 10px' }}>
        The in-app bell always shows every event regardless of these settings.
      </div>

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
        <button onClick={onClose} style={btnSecondary}>Cancel</button>
        <button onClick={save} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save settings'}</button>
      </div>
    </Modal>
  );
}
