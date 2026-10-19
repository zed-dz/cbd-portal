import { useState, useEffect } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnPrimary } from '../../theme';
import { Spinner, Field } from '../../components';

// Second step of sign-in for people who turned on two-step login. They are
// signed in at aal1 here; a correct 6-digit code upgrades the session to aal2
// and only then does App.jsx render the portal. Same look as SetPasswordPage.
export function MfaChallengePage({ email, onDone, onSignOut, showToast }) {
  const [factorId, setFactorId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error: err } = await supabase.auth.mfa.listFactors();
        if (err) throw err;
        const f = (data?.totp || []).find(x => x.status === 'verified');
        if (!cancelled) {
          if (f) setFactorId(f.id);
          else setError('No authenticator is set up for this account. Sign out and contact your administrator.');
        }
      } catch (e) {
        if (!cancelled) setError(e.message || 'Could not load your two-step login settings.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    const clean = code.replace(/\D/g, '');
    if (clean.length !== 6) { setError('Enter the 6-digit code from your authenticator app.'); return; }
    if (!factorId) return;
    setBusy(true); setError('');
    const { error: err } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: clean });
    setBusy(false);
    if (err) {
      setCode('');
      setError(/invalid|incorrect|expired|code/i.test(err.message)
        ? 'That code did not work. Codes change every 30 seconds — type the one showing now.'
        : err.message);
      return;
    }
    showToast?.('Welcome back.', 'success');
    onDone?.();
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: `radial-gradient(ellipse 80% 60% at 50% -10%, rgba(249,115,22,0.12), transparent 60%), ${C.bg}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 44, fontWeight: 800, color: C.accent, lineHeight: 1, letterSpacing: -1 }}>CBD</div>
          <div style={{ fontSize: 11, color: C.textMuted, fontFamily: MONO, letterSpacing: 3, textTransform: 'uppercase', marginTop: 6 }}>Plant & Labour</div>
          <div style={{ color: C.textDim, fontSize: 12, marginTop: 8 }}>Operations Portal</div>
        </div>

        <div style={{ background: C.card, borderRadius: R.xl, padding: 28, border: `1px solid ${C.border}`, boxShadow: '0 24px 60px -20px rgba(0,0,0,0.6)' }}>
          <div style={{ marginBottom: 18 }}>
            <h2 style={{ color: C.text, fontSize: 19, fontWeight: 700, letterSpacing: -0.3 }}>Enter your code</h2>
            <p style={{ color: C.textMuted, fontSize: 13, marginTop: 4, lineHeight: 1.5 }}>
              Open your authenticator app and type the 6-digit code it shows for this portal.
            </p>
            {email && <p style={{ color: C.textDim, fontSize: 12, marginTop: 6, fontFamily: MONO }}>{email}</p>}
          </div>

          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 16 }}><Spinner size={22} /></div>
          ) : (
            <form onSubmit={handleSubmit} data-area="two-step login code form">
              <Field label="6-digit code">
                <input style={{ ...inputStyle, fontFamily: MONO, fontSize: 22, letterSpacing: 8, textAlign: 'center' }}
                  inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6}
                  value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  disabled={!factorId} autoFocus />
              </Field>
              {error && (
                <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.28)', borderRadius: R.md, padding: '9px 12px', color: '#fca5a5', fontSize: 12.5, marginBottom: 14, lineHeight: 1.5 }}>
                  {error}
                </div>
              )}
              <button type="submit" disabled={busy || !factorId || code.length !== 6}
                style={{ ...btnPrimary, width: '100%', padding: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 14, fontWeight: 700 }}>
                {busy ? <><Spinner size={14} /> Checking…</> : 'Continue →'}
              </button>
            </form>
          )}

          <div style={{ marginTop: 14, textAlign: 'center' }}>
            <button type="button" onClick={() => onSignOut?.()}
              style={{ background: 'none', border: 'none', color: C.textDim, fontSize: 12, cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>
              Not you? Sign out
            </button>
          </div>
        </div>

        <div style={{ marginTop: 20, textAlign: 'center', color: C.textDim, fontSize: 10.5, fontFamily: MONO, letterSpacing: 1.2 }}>
          ROAD · RAIL · WATER &nbsp; ·&nbsp; ABN 75 663 693 070
        </div>
      </div>
    </div>
  );
}
