import { C, R, SHADOW } from '../../theme';

const TOAST_STYLES = {
  success: { bg: 'rgba(34,197,94,0.12)',  bd: 'rgba(34,197,94,0.38)',  fg: '#86efac', icon: '✓' },
  error:   { bg: 'rgba(239,68,68,0.12)',  bd: 'rgba(239,68,68,0.38)',  fg: '#fca5a5', icon: '✕' },
  info:    { bg: 'rgba(56,189,248,0.12)', bd: 'rgba(56,189,248,0.38)', fg: '#7dd3fc', icon: 'ⓘ' },
};

export function ToastContainer({ toasts, onRemove }) {
  return (
    <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none' }}>
      {toasts.map(t => {
        const s = TOAST_STYLES[t.type] || TOAST_STYLES.info;
        return (
          <div key={t.id} style={{
            background: '#13161e', border: `1px solid ${s.bd}`,
            color: s.fg, padding: '11px 14px',
            borderRadius: R.md, minWidth: 280, maxWidth: 380,
            boxShadow: SHADOW.md, display: 'flex',
            alignItems: 'flex-start', gap: 10,
            fontSize: 13, fontWeight: 500,
            animation: 'toastIn 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
            pointerEvents: 'auto', backdropFilter: 'blur(6px)',
          }}>
            <span style={{ flexShrink: 0, width: 18, height: 18, borderRadius: '50%', background: s.bg, color: s.fg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, marginTop: 1 }}>{s.icon}</span>
            <span style={{ flex: 1, lineHeight: 1.4 }}>{t.message}</span>
            <button onClick={() => onRemove(t.id)} style={{ background: 'none', border: 'none', color: C.textDim, cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0, marginLeft: 2 }}>×</button>
          </div>
        );
      })}
    </div>
  );
}
