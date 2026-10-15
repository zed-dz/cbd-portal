import { useState } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnPrimary } from '../../theme';
import { Spinner, Field } from '../../components';

// Shown right after someone arrives through an emailed link (password reset,
// invite, or an old-style sign-in link). They are already signed in at this
// point; this screen makes them choose a password before they can use the
// portal, so "forgot password" always ends with a password the person knows.
//
// kind: 'recovery' | 'invite' | 'magiclink'
export function SetPasswordPage({ email, kind = 'recovery', onDone, onSignOut, showToast }) {
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [show, setShow] = useState(false);

  const title = kind === 'invite' ? 'Welcome — set your password' : kind === 'magiclink' ? 'Set a password' : 'Set your new password';
  const intro = kind === 'invite'
    ? 'Your account is ready. Choose a password so you can sign in normally next time.'
    : kind === 'magiclink'
    ? 'You signed in with an emailed link. Choose a password so you can sign in without a link next time.'
    : 'You asked to reset your password. Choose a new one below.';

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (pw1.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (pw1 !== pw2) { setError('The two passwords do not match.'); return; }
    setBusy(true);
    const { error: err } = await supabase.auth.updateUser({ password: pw1 });
    setBusy(false);
    if (err) {
      const msg = /different from the old/i.test(err.message)
        ? 'That is already your password. Pick a different one, or just continue.'
        : /session|expired|not logged in|jwt/i.test(err.message)
        ? 'This link has expired or was already used. Go back to the sign-in page and ask for a new link.'
        : err.message;
      setError(msg);
      return;
    }
    showToast?.('Password saved — use it next time you sign in.', 'success');
    onDone?.();
  }

  const canSkip = kind === 'magiclink';

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
            <h2 style={{ color: C.text, fontSize: 19, fontWeight: 700, letterSpacing: -0.3 }}>{title}</h2>
            <p style={{ color: C.textMuted, fontSize: 13, marginTop: 4, lineHeight: 1.5 }}>{intro}</p>
            {email && <p style={{ color: C.textDim, fontSize: 12, marginTop: 6, fontFamily: MONO }}>{email}</p>}
          </div>
          <form onSubmit={handleSubmit} data-area="set password form">
            <Field label="New password" hint="At least 8 characters.">
              <input style={inputStyle} type={show ? 'text' : 'password'} value={pw1} onChange={e => setPw1(e.target.value)}
                placeholder="••••••••" autoComplete="new-password" autoFocus />
            </Field>
            <Field label="Type it again">
              <input style={inputStyle} type={show ? 'text' : 'password'} value={pw2} onChange={e => setPw2(e.target.value)}
                placeholder="••••••••" autoComplete="new-password" />
            </Field>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.textMuted, fontSize: 12.5, marginBottom: 14, cursor: 'pointer' }}>
              <input type="checkbox" checked={show} onChange={e => setShow(e.target.checked)} /> Show passwords
            </label>
            {error && (
              <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.28)', borderRadius: R.md, padding: '9px 12px', color: '#fca5a5', fontSize: 12.5, marginBottom: 14, lineHeight: 1.5 }}>
                {error}
              </div>
            )}
            <button type="submit" disabled={busy} style={{ ...btnPrimary, width: '100%', padding: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 14, fontWeight: 700 }}>
              {busy ? <><Spinner size={14} /> Saving…</> : 'Save password →'}
            </button>
          </form>
          <div style={{ marginTop: 14, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {canSkip && (
              <button type="button" onClick={() => onDone?.()}
                style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: 12.5, cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>
                Skip for now
              </button>
            )}
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
