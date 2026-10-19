import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnPrimary, btnSecondary, btnDanger } from '../../theme';
import { Modal, Spinner, Field } from '../index';
import { logActivity } from '../../utils/activity';

// Two-step login (TOTP) for the signed-in person, built on Supabase MFA.
// Enrol → QR + secret → verify a 6-digit code → factor active. Unenrol with a
// confirm. Nothing here touches other users; every call is the caller's own JWT.

export async function listTotpFactors() {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw error;
  return data?.totp || [];
}

// Shared by the admin top bar (nudge) and the modal. `verified` is null until
// the first load so callers can tell "unknown" from "none".
export function useMfaFactors() {
  const [state, setState] = useState({ loading: true, factors: [], verified: null });
  const refresh = useCallback(async () => {
    try {
      const factors = await listTotpFactors();
      setState({ loading: false, factors, verified: factors.some(f => f.status === 'verified') });
    } catch {
      setState(s => ({ ...s, loading: false }));
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { ...state, refresh };
}

const friendlyError = (msg = '') =>
  /aal2/i.test(msg)
    ? 'For safety this needs a session that passed the code. Sign out, sign in with your code, then try again.'
    : /invalid|incorrect|expired|code/i.test(msg)
    ? 'That code did not work. Codes change every 30 seconds — type the one showing now.'
    : msg || 'Something went wrong. Try again.';

export function MfaSettings({ onClose, showToast, onChanged }) {
  const { loading, factors, refresh } = useMfaFactors();
  const [enrolling, setEnrolling] = useState(null); // { id, qr, secret }
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const verified = factors.filter(f => f.status === 'verified');

  async function startEnrol() {
    setBusy(true); setError('');
    try {
      // Abandoned enrolments leave "unverified" factors behind and Supabase
      // refuses a second factor with the same name — clear them first.
      for (const f of factors.filter(x => x.status !== 'verified')) {
        await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      const friendlyName = `Portal ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
      const { data, error: err } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName });
      if (err) throw err;
      setEnrolling({ id: data.id, qr: data.totp?.qr_code, secret: data.totp?.secret });
      setCode('');
    } catch (e) {
      setError(friendlyError(e.message));
    } finally { setBusy(false); }
  }

  async function cancelEnrol() {
    if (!enrolling) return;
    setBusy(true);
    try { await supabase.auth.mfa.unenroll({ factorId: enrolling.id }); } catch { /* leftover is cleaned next time */ }
    setEnrolling(null); setCode(''); setError(''); setBusy(false);
    refresh();
  }

  async function confirmEnrol(e) {
    e.preventDefault();
    const clean = code.replace(/\D/g, '');
    if (clean.length !== 6) { setError('Enter the 6-digit code from your authenticator app.'); return; }
    setBusy(true); setError('');
    try {
      const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId: enrolling.id });
      if (chErr) throw chErr;
      const { error: vErr } = await supabase.auth.mfa.verify({ factorId: enrolling.id, challengeId: ch.id, code: clean });
      if (vErr) throw vErr;
      showToast?.('Two-step login is on. You will be asked for a code at every sign-in.', 'success');
      logActivity({ verb: 'enabled', object_type: 'two-step login', after: { name: 'authenticator app' } });
      setEnrolling(null); setCode('');
      await refresh();
      onChanged?.();
    } catch (err) {
      setError(friendlyError(err.message));
    } finally { setBusy(false); }
  }

  async function remove(factor) {
    if (!window.confirm('Turn off two-step login? Your password alone will open the portal again.')) return;
    setBusy(true); setError('');
    try {
      const { error: err } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
      if (err) throw err;
      showToast?.('Two-step login turned off.', 'info');
      logActivity({ verb: 'removed', object_type: 'two-step login', before: { name: factor.friendly_name || 'authenticator app' } });
      await refresh();
      onChanged?.();
    } catch (err) {
      setError(friendlyError(err.message));
    } finally { setBusy(false); }
  }

  return (
    <Modal title="🔐 Two-step login" onClose={busy ? undefined : onClose} width={440}>
      <div data-area="two-step login settings">
        <p style={{ color: C.textMuted, fontSize: 13, lineHeight: 1.55, marginBottom: 16 }}>
          Adds a 6-digit code from an authenticator app (Google Authenticator, Authy, 1Password…) after your password.
          Only your own sign-in is affected.
        </p>

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}><Spinner size={22} /></div>
        ) : enrolling ? (
          <form onSubmit={confirmEnrol}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              {enrolling.qr
                ? <img src={enrolling.qr} alt="QR code for your authenticator app" style={{ width: 188, height: 188, background: '#fff', borderRadius: R.md, padding: 6 }} />
                : <div style={{ color: C.textDim, fontSize: 12 }}>QR not available — type the secret instead.</div>}
              <div style={{ fontSize: 11, color: C.textDim, textAlign: 'center' }}>Scan with your app, or enter this secret by hand:</div>
              <code style={{ fontFamily: MONO, fontSize: 12, color: C.text, background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.sm, padding: '6px 10px', wordBreak: 'break-all', textAlign: 'center', userSelect: 'all' }}>
                {enrolling.secret}
              </code>
            </div>
            <Field label="Code from the app" hint="6 digits, changes every 30 seconds.">
              <input style={{ ...inputStyle, fontFamily: MONO, fontSize: 20, letterSpacing: 6, textAlign: 'center' }}
                inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6}
                value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus />
            </Field>
            {error && <ErrorBox>{error}</ErrorBox>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="submit" disabled={busy || code.length !== 6} style={{ ...btnPrimary, flex: 1, minHeight: 40 }}>
                {busy ? <><Spinner size={13} /> Checking…</> : 'Turn on'}
              </button>
              <button type="button" disabled={busy} onClick={cancelEnrol} style={{ ...btnSecondary, minHeight: 40 }}>Cancel</button>
            </div>
          </form>
        ) : (
          <>
            {verified.length === 0 ? (
              <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: R.md, padding: '10px 12px', color: '#fcd34d', fontSize: 12.5, marginBottom: 14 }}>
                Not set up yet. Your password alone opens the portal.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
                {verified.map(f => (
                  <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 10, border: `1px solid ${C.border}`, borderRadius: R.md, padding: '10px 12px', flexWrap: 'wrap' }}>
                    <span style={{ color: '#4ade80', fontSize: 12, fontWeight: 700, letterSpacing: 0.5 }}>ACTIVE</span>
                    <div style={{ flex: 1, minWidth: 120 }}>
                      <div style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>{f.friendly_name || 'Authenticator app'}</div>
                      <div style={{ color: C.textDim, fontSize: 11, fontFamily: MONO }}>since {new Date(f.created_at).toLocaleDateString('en-AU')}</div>
                    </div>
                    <button type="button" disabled={busy} onClick={() => remove(f)} style={{ ...btnDanger, padding: '7px 12px', fontSize: 12, minHeight: 36 }}>Remove</button>
                  </div>
                ))}
              </div>
            )}
            {error && <ErrorBox>{error}</ErrorBox>}
            {verified.length === 0 && (
              <button type="button" disabled={busy} onClick={startEnrol} style={{ ...btnPrimary, width: '100%', minHeight: 42 }}>
                {busy ? <><Spinner size={13} /> Preparing…</> : 'Set up with an authenticator app'}
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function ErrorBox({ children }) {
  return (
    <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.28)', borderRadius: R.md, padding: '9px 12px', color: '#fca5a5', fontSize: 12.5, marginBottom: 12, lineHeight: 1.5 }}>
      {children}
    </div>
  );
}
