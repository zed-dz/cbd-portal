import { useState } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnPrimary } from '../../theme';
import { Spinner, Field } from '../../components';
import { portalBaseUrl } from '../../utils/inviteLinks';

// Two-mode login screen. `signin` calls the parent's onSubmit (existing flow).
// `signup` calls supabase.auth.signUp directly — a Postgres trigger on
// auth.users creates the matching workers row (first user is auto-admin).
export function LoginPage({ email, setEmail, password, setPassword, error, loading, onSubmit }) {
  const [mode, setMode] = useState('signin');
  const [name, setName] = useState('');
  const [signupBusy, setSignupBusy]   = useState(false);
  const [signupError, setSignupError] = useState('');
  const [signupSuccess, setSignupSuccess] = useState(null);

  async function handleSignUp(e) {
    e.preventDefault();
    setSignupError('');
    if (!email || !password) { setSignupError('Email and password are required.'); return; }
    if (password.length < 8) { setSignupError('Password must be at least 8 characters.'); return; }
    setSignupBusy(true);
    // emailRedirectTo defends against Site URL misconfig — Supabase's
    // confirmation email uses THIS value over Site URL when present, so even
    // if the project's Site URL is wrong, the confirm link still lands on
    // the right portal.
    const { data, error: err } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name: name.trim() || null },
        emailRedirectTo: portalBaseUrl(),
      },
    });
    setSignupBusy(false);
    if (err) { setSignupError(err.message); return; }
    if (!data.session) {
      setSignupSuccess('Account created. Check your email to confirm, then sign in.');
    }
  }

  const isSignup = mode === 'signup';

  return (
    <div style={{
      minHeight: '100vh',
      background: `radial-gradient(ellipse 80% 60% at 50% -10%, rgba(249,115,22,0.12), transparent 60%), ${C.bg}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div style={{ width: '100%', maxWidth: 380 }}>
        {/* Brand */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{
            fontFamily: 'Syne, sans-serif', fontSize: 44, fontWeight: 800,
            color: C.accent, lineHeight: 1, letterSpacing: -1,
          }}>CBD</div>
          <div style={{
            fontSize: 11, color: C.textMuted, fontFamily: MONO,
            letterSpacing: 3, textTransform: 'uppercase', marginTop: 6,
          }}>Plant & Labour</div>
          <div style={{ color: C.textDim, fontSize: 12, marginTop: 8 }}>Operations Portal</div>
        </div>

        {/* Card */}
        <div style={{
          background: C.card, borderRadius: R.xl, padding: 28,
          border: `1px solid ${C.border}`,
          boxShadow: '0 24px 60px -20px rgba(0,0,0,0.6)',
        }}>
          <div style={{
            display: 'flex', gap: 4, marginBottom: 22,
            background: C.bg, border: `1px solid ${C.border}`,
            borderRadius: R.md, padding: 3,
          }}>
            {[
              { id: 'signin', label: 'Sign in' },
              { id: 'signup', label: 'Create account' },
            ].map(t => {
              const active = mode === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => { setMode(t.id); setSignupError(''); setSignupSuccess(null); }}
                  style={{
                    flex: 1, padding: '7px 8px', border: 'none', cursor: 'pointer',
                    background: active ? C.cardHover : 'transparent',
                    color: active ? C.text : C.textMuted,
                    borderRadius: R.sm, fontWeight: active ? 600 : 500, fontSize: 13,
                    transition: 'all 120ms',
                  }}
                >{t.label}</button>
              );
            })}
          </div>

          {signupSuccess ? (
            <div style={{
              background: 'rgba(34,197,94,0.10)', border: '1px solid rgba(34,197,94,0.32)',
              color: '#86efac', fontSize: 13, padding: '12px 14px', borderRadius: R.md,
              lineHeight: 1.5,
            }}>
              ✓ {signupSuccess}
            </div>
          ) : isSignup ? (
            <>
              <div style={{ marginBottom: 18 }}>
                <h2 style={{ color: C.text, fontSize: 19, fontWeight: 700, letterSpacing: -0.3 }}>Create an account</h2>
                <p style={{ color: C.textMuted, fontSize: 13, marginTop: 4 }}>
                  The first person to sign up becomes admin. After that, sign-ups land as employees and an admin promotes them.
                </p>
              </div>
              <form onSubmit={handleSignUp}>
                <Field label="Full name">
                  <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} placeholder="Jane Smith" autoComplete="name" autoFocus />
                </Field>
                <Field label="Email">
                  <input style={inputStyle} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
                </Field>
                <Field label="Password" hint="At least 8 characters.">
                  <input style={inputStyle} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
                </Field>
                {signupError && (
                  <div style={{
                    background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.28)',
                    borderRadius: R.md, padding: '9px 12px',
                    color: '#fca5a5', fontSize: 12.5, marginBottom: 14,
                  }}>
                    {signupError}
                  </div>
                )}
                <button type="submit" disabled={signupBusy} style={{
                  ...btnPrimary, width: '100%', padding: '11px',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  fontSize: 14, fontWeight: 700, marginTop: 4,
                }}>
                  {signupBusy ? <><Spinner size={14} /> Creating…</> : 'Create account →'}
                </button>
              </form>
            </>
          ) : (
            <>
              <div style={{ marginBottom: 22 }}>
                <h2 style={{ color: C.text, fontSize: 19, fontWeight: 700, letterSpacing: -0.3 }}>Sign in</h2>
                <p style={{ color: C.textMuted, fontSize: 13, marginTop: 4 }}>Welcome back. Enter your credentials below.</p>
              </div>
              <form onSubmit={onSubmit}>
                <Field label="Email">
                  <input style={inputStyle} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" autoFocus />
                </Field>
                <Field label="Password">
                  <input style={inputStyle} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" />
                </Field>
                {error && (
                  <div style={{
                    background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.28)',
                    borderRadius: R.md, padding: '9px 12px',
                    color: '#fca5a5', fontSize: 12.5, marginBottom: 14,
                  }}>
                    {error}
                  </div>
                )}
                <button type="submit" disabled={loading} style={{
                  ...btnPrimary, width: '100%', padding: '11px',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  fontSize: 14, fontWeight: 700, marginTop: 4,
                }}>
                  {loading ? <><Spinner size={14} /> Signing in…</> : 'Sign In →'}
                </button>
              </form>
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{
          marginTop: 20, textAlign: 'center',
          color: C.textDim, fontSize: 10.5, fontFamily: MONO, letterSpacing: 1.2,
        }}>
          ROAD · RAIL · WATER &nbsp; ·&nbsp; ABN 75 663 693 070
        </div>
      </div>
    </div>
  );
}
