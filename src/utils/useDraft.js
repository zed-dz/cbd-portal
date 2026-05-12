import { useState, useEffect, useRef, useCallback } from 'react';

const DRAFT_PREFIX = 'cbd_draft_';

function readDraft(fullKey, initial) {
  try {
    const raw = localStorage.getItem(fullKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { value: { ...initial, ...parsed }, hadDraft: true };
    }
  } catch (e) { /* corrupt draft — ignore */ }
  return { value: initial, hadDraft: false };
}

export function useDraft(key, initial, { enabled = true } = {}) {
  const fullKey = DRAFT_PREFIX + key;
  const initialRef = useRef(initial);
  initialRef.current = initial;

  const first = readDraft(fullKey, initialRef.current);
  const [value, setValue] = useState(first.value);
  const [draftRestored, setDraftRestored] = useState(first.hadDraft);
  const lastKey = useRef(fullKey);

  // When the draft key changes (e.g. closing one modal and opening another with
  // a different id), reload state from the new key's localStorage entry.
  useEffect(() => {
    if (lastKey.current === fullKey) return;
    lastKey.current = fullKey;
    if (!enabled) {
      setValue(initialRef.current);
      setDraftRestored(false);
      return;
    }
    const { value: v, hadDraft } = readDraft(fullKey, initialRef.current);
    setValue(v);
    setDraftRestored(hadDraft);
  }, [fullKey, enabled]);

  // Debounced persistence to localStorage.
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
    setValue(initialRef.current);
  }, [clear]);

  const dismissBanner = useCallback(() => setDraftRestored(false), []);

  return [value, setValue, { draftRestored, discardDraft, clear, dismissBanner }];
}

export function DraftBanner({ visible, onDiscard, onDismiss, label = 'Draft restored from your last session.' }) {
  if (!visible) return null;
  return (
    <div style={{
      background: 'rgba(234,179,8,0.10)', border: '1px solid rgba(234,179,8,0.35)',
      borderRadius: 8, padding: '8px 12px', marginBottom: 14, display: 'flex',
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
