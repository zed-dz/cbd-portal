import { C } from '../theme';

export function ToastContainer({ toasts, onRemove }) {
  return (
    <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {toasts.map(t => (
        <div key={t.id} style={{
          background: t.type === 'success' ? C.success : t.type === 'error' ? C.error : C.info,
          color: '#fff', padding: '12px 16px', borderRadius: 8, minWidth: 280, maxWidth: 360,
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)', display: 'flex', justifyContent: 'space-between',
          alignItems: 'center', fontSize: 14, animation: 'slideIn 0.2s ease',
        }}>
          <span>{t.message}</span>
          <button onClick={() => onRemove(t.id)} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', marginLeft: 12, fontSize: 16, lineHeight: 1 }}>×</button>
        </div>
      ))}
    </div>
  );
}

export function Spinner({ size = 24 }) {
  return (
    <div style={{
      width: size, height: size, border: `3px solid ${C.border}`,
      borderTop: `3px solid ${C.accent}`, borderRadius: '50%',
      animation: 'spin 0.7s linear infinite', display: 'inline-block',
    }} />
  );
}

export function Badge({ label, color }) {
  const colors = {
    green: { bg: '#16653a', text: '#4ade80' },
    yellow: { bg: '#713f12', text: '#fde047' },
    red: { bg: '#7f1d1d', text: '#fca5a5' },
    blue: { bg: '#1e3a5f', text: '#93c5fd' },
    gray: { bg: '#1e293b', text: '#94a3b8' },
  };
  const c = colors[color] || colors.gray;
  return (
    <span style={{ background: c.bg, color: c.text, padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600 }}>
      {label}
    </span>
  );
}

export function Modal({ title, onClose, children, width = 480 }) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.card, borderRadius: 12, padding: 28, width: '100%', maxWidth: width,
        maxHeight: '90vh', overflowY: 'auto', border: `1px solid ${C.border}`,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ margin: 0, color: C.text, fontSize: 18 }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.textMuted, cursor: 'pointer', fontSize: 22, lineHeight: 1 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', color: C.textMuted, fontSize: 13, marginBottom: 6 }}>{label}</label>
      {children}
    </div>
  );
}

export function EmptyState({ message }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 24px', color: C.textMuted }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>📭</div>
      <p style={{ margin: 0 }}>{message}</p>
    </div>
  );
}

export function TableWrap({ children }) {
  return (
    <div style={{ overflowX: 'auto', borderRadius: 8, border: `1px solid ${C.border}` }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', color: C.text, fontSize: 14 }}>
        {children}
      </table>
    </div>
  );
}

export function Th({ children }) {
  return <th style={{ padding: '12px 16px', textAlign: 'left', color: C.textMuted, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', background: C.bg, borderBottom: `1px solid ${C.border}` }}>{children}</th>;
}

export function Td({ children }) {
  return <td style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}` }}>{children}</td>;
}

export function allocationBadge(status) {
  const map = { pending: 'yellow', confirmed: 'blue', completed: 'green', cancelled: 'red' };
  return <Badge label={status} color={map[status] || 'gray'} />;
}

export function timesheetBadge(status) {
  const map = { pending: 'yellow', approved: 'green', rejected: 'red' };
  return <Badge label={status} color={map[status] || 'gray'} />;
}

export function certBadge(expiry) {
  if (!expiry) return <Badge label="No expiry" color="gray" />;
  const d = new Date(expiry);
  const now = new Date();
  const diff = (d - now) / (1000 * 60 * 60 * 24);
  if (diff < 0) return <Badge label="Expired" color="red" />;
  if (diff < 30) return <Badge label="Expiring soon" color="yellow" />;
  return <Badge label="Valid" color="green" />;
}
