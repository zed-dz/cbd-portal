import { useState, useEffect, useCallback } from 'react';
import { C, R } from '../../theme';
import { isSupported, getState, subscribe, unsubscribe, needsHomeScreenInstall } from '../../utils/push';

// "Phone alerts" card: shows whether THIS browser gets push alerts and lets the
// user switch it on (asks permission on the tap, never on load) or off.
//   variant="card" — standalone block for the worker profile tab
//   variant="row"  — compact toggle row for the admin notification modal
export function PushPrompt({ workerId, showToast, variant = 'card', label = 'Phone alerts' }) {
  const [state, setState] = useState({ permission: 'default', subscribed: false });
  const [busy, setBusy] = useState(false);
  const supported = isSupported();

  const refresh = useCallback(async () => { setState(await getState()); }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const turnOn = async () => {
    setBusy(true);
    const r = await subscribe(workerId);
    setBusy(false);
    await refresh();
    if (r.ok) { showToast?.('Alerts on for this device', 'success'); return; }
    if (r.reason === 'denied') showToast?.('Notifications are blocked for this site — allow them in your browser settings, then try again.', 'error');
    else if (r.reason === 'unsupported') showToast?.('This browser cannot receive alerts.', 'error');
    else showToast?.(`Could not turn alerts on${r.detail ? `: ${r.detail}` : ''}`, 'error');
  };
  const turnOff = async () => {
    setBusy(true);
    const r = await unsubscribe();
    setBusy(false);
    await refresh();
    showToast?.(r.ok ? 'Alerts off for this device' : 'Could not turn alerts off', r.ok ? 'success' : 'error');
  };

  const on = supported && state.permission === 'granted' && state.subscribed;
  const blocked = supported && state.permission === 'denied';
  const installHint = !supported && needsHomeScreenInstall();

  let hint;
  if (installHint) hint = 'On iPhone, first add the portal to your Home Screen (Share → Add to Home Screen), then open it from there.';
  else if (!supported) hint = 'This browser cannot receive alerts.';
  else if (blocked) hint = 'Blocked in this browser. Allow notifications for this site in the browser settings, then tap again.';
  else if (on) hint = 'New jobs, reminders and office alerts pop up on this device even when the app is closed.';
  else hint = 'Get new jobs and reminders as instant pop-ups on this device — free, no SMS needed.';

  const canToggle = supported && !blocked && !busy;
  const toggle = () => (on ? turnOff() : turnOn());

  if (variant === 'row') {
    return (
      <button
        type="button"
        onClick={canToggle ? toggle : undefined}
        disabled={!canToggle}
        data-area="push-toggle"
        style={{
          display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
          background: 'transparent', border: `1px solid ${C.border}`, borderRadius: R.md,
          padding: '10px 14px', cursor: canToggle ? 'pointer' : 'default', opacity: supported ? 1 : 0.7, minHeight: 44,
        }}
      >
        <span style={{
          width: 38, height: 22, borderRadius: R.pill, flexShrink: 0, position: 'relative',
          background: on ? C.accent : C.borderStrong, transition: 'background 140ms',
        }}>
          <span style={{ position: 'absolute', top: 2, left: on ? 18 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left 140ms' }} />
        </span>
        <span style={{ flex: 1 }}>
          <span style={{ display: 'block', fontWeight: 600, color: C.text, fontSize: 13 }}>{label}{busy ? '…' : ''}</span>
          <span style={{ display: 'block', fontSize: 11, color: C.textMuted, marginTop: 1 }}>{hint}</span>
        </span>
      </button>
    );
  }

  return (
    <div data-area="push-alerts" style={{ border: `1px solid ${on ? C.accentBorder || C.accent : C.border}`, background: on ? C.accentSoft : C.card, borderRadius: R.md, padding: '12px 14px', display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 700, color: C.text, fontSize: 14 }}>
          🔔 {label}: <span style={{ color: on ? C.accent : C.textMuted }}>{on ? 'On' : 'Off'}</span>
        </div>
        {supported && !blocked && (
          <button
            type="button"
            onClick={toggle}
            disabled={busy}
            style={{
              minHeight: 36, padding: '0 14px', borderRadius: R.md, fontWeight: 600, fontSize: 13, cursor: busy ? 'default' : 'pointer',
              border: `1px solid ${on ? C.border : C.accent}`, background: on ? 'transparent' : C.accent, color: on ? C.text : '#fff',
            }}
          >
            {busy ? 'Working…' : on ? 'Turn off' : 'Turn on'}
          </button>
        )}
      </div>
      <div style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.45 }}>{hint}</div>
    </div>
  );
}
