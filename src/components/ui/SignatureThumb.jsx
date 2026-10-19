import { C } from '../../theme';

// Small white tile with a drawn signature (PNG data URL) for office tables.
// Rows signed before drawn signatures existed (2026-10-20) show a dash.
export function SignatureThumb({ png, who }) {
  if (!String(png || '').startsWith('data:image/png;base64,')) return <span style={{ color: C.textDim, fontSize: 12 }}>—</span>;
  return (
    <img src={png} alt={`Signature of ${who || 'worker'}`}
      style={{ display: 'block', height: 40, width: 'auto', maxWidth: 130, background: '#fff', borderRadius: 4, border: `1px solid ${C.border}` }} />
  );
}
