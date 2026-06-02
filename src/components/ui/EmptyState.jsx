import { C, R } from '../../theme';

export function EmptyState({ message, icon = '📭', action = null }) {
  return (
    <div style={{
      textAlign: 'center', padding: '56px 24px',
      color: C.textMuted, background: C.card,
      border: `1px dashed ${C.border}`, borderRadius: R.lg,
    }}>
      <div style={{ fontSize: 38, marginBottom: 10, opacity: 0.7 }}>{icon}</div>
      <p style={{ margin: 0, fontSize: 13, color: C.textMuted, maxWidth: 340, marginInline: 'auto', lineHeight: 1.5 }}>{message}</p>
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}
