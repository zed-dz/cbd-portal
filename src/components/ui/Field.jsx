import { C } from '../../theme';

export function Field({ label, hint, error, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', color: C.textMuted, fontSize: 12, fontWeight: 500, marginBottom: 5, letterSpacing: 0.1 }}>{label}</label>
      {children}
      {hint && !error && <div style={{ fontSize: 11, color: C.textDim, marginTop: 4 }}>{hint}</div>}
      {error && <div style={{ fontSize: 11, color: '#fca5a5', marginTop: 4 }}>{error}</div>}
    </div>
  );
}
