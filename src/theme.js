export const C = {
  bg: '#0d0f14',
  card: '#131620',
  cardHover: '#1a1e28',
  border: '#2a2f40',
  accent: '#f97316',
  accentHover: '#ea6a0a',
  text: '#e8eaf2',
  textMuted: '#8b90a8',
  success: '#22c55e',
  warning: '#eab308',
  error: '#ef4444',
  info: '#f97316',
  sidebar: '#13161e',
  sidebarW: 200,
};

export const inputStyle = {
  width: '100%', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6,
  color: C.text, padding: '9px 12px', fontSize: 14, boxSizing: 'border-box', outline: 'none',
};

export const btnPrimary = {
  background: C.accent, color: '#fff', border: 'none', borderRadius: 6,
  padding: '10px 20px', cursor: 'pointer', fontSize: 14, fontWeight: 600,
};

export const btnSecondary = {
  background: 'transparent', color: C.textMuted, border: `1px solid ${C.border}`,
  borderRadius: 6, padding: '10px 20px', cursor: 'pointer', fontSize: 14,
};

export const btnDanger = {
  background: '#7f1d1d', color: '#fca5a5', border: 'none', borderRadius: 6,
  padding: '6px 14px', cursor: 'pointer', fontSize: 13,
};

export const btnSmall = {
  background: C.cardHover, color: C.text, border: `1px solid ${C.border}`,
  borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 13,
};
