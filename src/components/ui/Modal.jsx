import { useEffect } from 'react';
import { C, R, SHADOW, T } from '../../theme';

export function Modal({ title, onClose, children, width = 480, dismissible = false }) {
  // Lock body scroll while modal is open. When `dismissible` is true,
  // Escape and backdrop click close the modal. Data-entry modals default to
  // off so an accidental click or browser focus change can't wipe a
  // half-typed form.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => { if (dismissible && e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);

    // Broadcast that a modal is open so fixed-position furniture (the floating
    // help bubble) can get out of the way — it sits at z-index 9999 and was
    // covering the Save button on narrow screens.
    const bump = (n) => {
      window.__cbdModalCount = Math.max(0, (window.__cbdModalCount || 0) + n);
      window.dispatchEvent(new CustomEvent('cbd:modal', { detail: window.__cbdModalCount }));
    };
    bump(1);

    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
      bump(-1);
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
