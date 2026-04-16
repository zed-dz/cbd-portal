import { C, inputStyle, btnPrimary } from '../../theme';
import { Spinner, Field } from '../../components';

export function LoginPage({ email, setEmail, password, setPassword, error, loading, onSubmit }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.bg, padding: 16 }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: C.text, letterSpacing: -0.5 }}>CBD Plant & Labour</div>
          <div style={{ color: C.textMuted, marginTop: 4, fontSize: 14 }}>Operations Portal</div>
        </div>
        <div style={{ background: C.card, borderRadius: 12, padding: 32, border: `1px solid ${C.border}` }}>
          <h2 style={{ color: C.text, marginBottom: 24, fontSize: 20 }}>Sign In</h2>
          <form onSubmit={onSubmit}>
            <Field label="Email">
              <input style={inputStyle} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
            </Field>
            <Field label="Password">
              <input style={inputStyle} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" />
            </Field>
            {error && <p style={{ color: C.error, fontSize: 13, marginBottom: 16 }}>{error}</p>}
            <button type="submit" disabled={loading} style={{ ...btnPrimary, width: '100%', padding: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              {loading ? <><Spinner size={16} /> Signing in…</> : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
