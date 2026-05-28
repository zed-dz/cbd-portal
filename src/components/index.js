import { useEffect } from 'react';
import { C, R, SHADOW, T, MONO } from '../theme';

// ── Toasts ──────────────────────────────────────────────────────────────────

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

// ── Spinner ─────────────────────────────────────────────────────────────────

export function Spinner({ size = 22 }) {
  return (
    <div style={{
      width: size, height: size,
      border: `2px solid ${C.border}`,
      borderTopColor: C.accent,
      borderRadius: '50%',
      animation: 'spin 0.7s linear infinite',
      display: 'inline-block',
    }} />
  );
}

// ── Badge ───────────────────────────────────────────────────────────────────

const BADGE_PALETTE = {
  green:  { bg: 'rgba(34,197,94,0.13)',  fg: '#86efac' },
  yellow: { bg: 'rgba(234,179,8,0.14)',  fg: '#fde047' },
  red:    { bg: 'rgba(239,68,68,0.13)',  fg: '#fca5a5' },
  blue:   { bg: 'rgba(56,189,248,0.13)', fg: '#7dd3fc' },
  orange: { bg: 'rgba(249,115,22,0.13)', fg: '#fdba74' },
  purple: { bg: 'rgba(168,85,247,0.13)', fg: '#d8b4fe' },
  gray:   { bg: 'rgba(139,146,168,0.13)', fg: '#cbd0dc' },
};

export function Badge({ label, color, size = 'md' }) {
  const c = BADGE_PALETTE[color] || BADGE_PALETTE.gray;
  const isSm = size === 'sm';
  return (
    <span style={{
      background: c.bg, color: c.fg,
      padding: isSm ? '1px 7px' : '2px 9px',
      borderRadius: R.pill,
      fontSize: isSm ? 10 : 11,
      fontWeight: 600,
      letterSpacing: 0.2,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  );
}

// ── Modal ───────────────────────────────────────────────────────────────────

export function Modal({ title, onClose, children, width = 480, dismissible = false }) {
  // Lock body scroll while modal is open. When `dismissible` is true (the
  // legacy behavior), Escape and backdrop click close the modal. For data-
  // entry modals we default to off so an accidental click or browser focus
  // change can't wipe a half-typed form.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => { if (dismissible && e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, dismissible]);

  return (
    <div onClick={dismissible ? onClose : undefined} style={{
      position: 'fixed', inset: 0,
      background: 'rgba(5, 7, 12, 0.65)',
      backdropFilter: 'blur(6px)',
      WebkitBackdropFilter: 'blur(6px)',
      zIndex: 1000,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: '5vh 16px 16px',
      animation: 'fadeIn 0.18s ease',
      overflowY: 'auto',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.card,
        borderRadius: R.xl,
        padding: 26,
        width: '100%',
        maxWidth: width,
        border: `1px solid ${C.border}`,
        boxShadow: SHADOW.lg,
        animation: 'modalIn 0.24s cubic-bezier(0.16, 1, 0.3, 1)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ margin: 0, color: C.text, fontSize: 17, fontWeight: 700, letterSpacing: -0.2 }}>{title}</h3>
          <button onClick={onClose} aria-label="Close" style={{
            background: 'none', border: 'none', color: C.textMuted, cursor: 'pointer',
            fontSize: 22, lineHeight: 1, padding: 4, borderRadius: R.sm,
            transition: `color ${T.fast}, background ${T.fast}`,
          }}
          onMouseEnter={e => { e.currentTarget.style.color = C.text; e.currentTarget.style.background = C.cardHover; }}
          onMouseLeave={e => { e.currentTarget.style.color = C.textMuted; e.currentTarget.style.background = 'transparent'; }}
          >×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Field ───────────────────────────────────────────────────────────────────

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

// ── EmptyState ──────────────────────────────────────────────────────────────

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

// ── Table primitives ────────────────────────────────────────────────────────

export function TableWrap({ children }) {
  return (
    <div style={{
      overflowX: 'auto',
      borderRadius: R.lg,
      border: `1px solid ${C.border}`,
      background: C.card,
    }}>
      <table style={{
        width: '100%', borderCollapse: 'collapse',
        color: C.text, fontSize: 13,
      }}>
        {children}
      </table>
    </div>
  );
}

export function Th({ children, align = 'left' }) {
  return (
    <th style={{
      padding: '11px 14px',
      textAlign: align,
      color: C.textMuted,
      fontSize: 10,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: 1.2,
      background: C.bg,
      borderBottom: `1px solid ${C.border}`,
      fontFamily: MONO,
      whiteSpace: 'nowrap',
    }}>
      {children}
    </th>
  );
}

export function Td({ children, align = 'left', onClick, title, style }) {
  return (
    <td
      onClick={onClick}
      title={title}
      style={{
        padding: '11px 14px',
        textAlign: align,
        borderBottom: `1px solid ${C.border}`,
        verticalAlign: 'middle',
        ...style,
      }}>
      {children}
    </td>
  );
}

// ── Badge helpers tied to domain status ────────────────────────────────────

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
