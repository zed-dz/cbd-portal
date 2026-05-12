import { useState, useEffect, useRef, useCallback } from 'react';

const DRAFT_PREFIX = 'cbd_draft_';

export function useDraft(key, initial, { enabled = true } = {}) {
  const fullKey = DRAFT_PREFIX + key;
  const hadDraft = useRef(false);

  const [value, setValue] = useState(() => {
    if (!enabled) return initial;
    try {
      const raw = localStorage.getItem(fullKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        hadDraft.current = true;
        return { ...initial, ...parsed };
      }
    } catch (e) { /* corrupt draft – ignore */ }
    return initial;
  });

  const [draftRestored, setDraftRestored] = useState(hadDraft.current);

  useEffect(() => {
    if (!enabled) return;
    const id = setTimeout(() => {
      try { localStorage.setItem(fullKey, JSON.stringify(value)); } catch (e) {}
    }, 250);
    return () => clearTimeout(id);
  }, [fullKey, value, enabled]);

  const clear = useCallback(() => {
    try { localStorage.removeItem(fullKey); } catch (e) {}
    setDraftRestored(false);
  }, [fullKey]);

  const discardDraft = useCallback(() => {
    clear();
    setValue(initial);
  }, [clear, initial]);

  return [value, setValue, { draftRestored, discardDraft, clear, dismissBanner: () => setDraftRestored(false) }];
}

export function DraftBanner({ visible, onDiscard, onDismiss, label = 'Draft restored from your last session.' }) {
  if (!visible) return null;
  return (
    <div style={{
      background: 'rgba(234,179,8,0.10)', border: '1px solid rgba(234,179,8,0.35)',
      borderRadius: 7, padding: '8px 12px', marginBottom: 14, display: 'flex',
      alignItems: 'center', justifyContent: 'space-between', gap: 10,
      fontSize: 12, color: '#fde68a',
    }}>
      <span>📝 {label}</span>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onDiscard} style={{
          background: 'transparent', color: '#fde68a',
          border: '1px solid rgba(234,179,8,0.5)', borderRadius: 5,
          padding: '3px 10px', cursor: 'pointer', fontSize: 11, fontWeight: 600,
        }}>Discard</button>
        <button onClick={onDismiss} style={{
          background: 'transparent', color: '#fde68a',
          border: 'none', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0,
        }}>×</button>
      </div>
    </div>
  );
}
