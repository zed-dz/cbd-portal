import { C, R, MONO, inputStyle, btnPrimary } from '../../theme';
import { Spinner, Field } from '../../components';

export function LoginPage({ email, setEmail, password, setPassword, error, loading, onSubmit }) {
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
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.28)',
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
