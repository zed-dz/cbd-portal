// CBD Plant & Labour — design tokens.
// Cool, low-chroma dark palette with one warm accent (orange) for high-signal
// actions only. Numeric stats lean cooler so the accent stays a primary CTA.

export const C = {
  // Surfaces — slightly cooler blacks, tighter elevation steps.
  bg:        '#0b0e14',  // page
  card:      '#11151e',  // raised
  cardHover: '#171c27',  // raised + hover / second elevation
  border:    '#222838',  // hairline
  borderStrong: '#2e3548',
  sidebar:   '#0e1219',
  sidebarW:  208,

  // Type
  text:      '#eef0f6',
  textMuted: '#8a92a8',
  textDim:   '#5b6276',

  // Brand + status
  accent:      '#f97316',  // orange — primary action / brand
  accentHover: '#fb923c',
  accentSoft:  'rgba(249,115,22,0.12)',
  accentBorder:'rgba(249,115,22,0.32)',

  success:     '#22c55e',
  successSoft: 'rgba(34,197,94,0.12)',
  warning:     '#eab308',
  warningSoft: 'rgba(234,179,8,0.12)',
  error:       '#ef4444',
  errorSoft:   'rgba(239,68,68,0.10)',
  info:        '#38bdf8',
  infoSoft:    'rgba(56,189,248,0.10)',
};

// Radii — consistent scale used across components.
export const R = { sm: 6, md: 8, lg: 11, xl: 14, pill: 999 };

// Elevation — used sparingly, prefer borders for separation in dark UIs.
export const SHADOW = {
  sm: '0 1px 2px rgba(0,0,0,0.20)',
  md: '0 4px 12px rgba(0,0,0,0.28)',
  lg: '0 16px 40px rgba(0,0,0,0.45)',
  ring: `0 0 0 3px rgba(249,115,22,0.28)`,
};

// Standard timings — keep things subtle, never slow.
export const T = { fast: '120ms', med: '180ms', slow: '260ms' };

// Inputs
export const inputStyle = {
  width: '100%',
  background: C.bg,
  border: `1px solid ${C.border}`,
  borderRadius: R.md,
  color: C.text,
  padding: '9px 12px',
  fontSize: 14,
  boxSizing: 'border-box',
  outline: 'none',
  transition: `border-color ${T.fast}, box-shadow ${T.fast}, background ${T.fast}`,
};

// Buttons — same height across the trio (primary/secondary/danger) for align.
export const btnPrimary = {
  background: C.accent,
  color: '#fff',
  border: '1px solid transparent',
  borderRadius: R.md,
  padding: '9px 18px',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: 0.1,
  transition: `background ${T.fast}, transform ${T.fast}, box-shadow ${T.fast}`,
};

export const btnSecondary = {
  background: 'transparent',
  color: C.text,
  border: `1px solid ${C.border}`,
  borderRadius: R.md,
  padding: '9px 18px',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
  transition: `background ${T.fast}, border-color ${T.fast}, color ${T.fast}`,
};

export const btnDanger = {
  background: 'rgba(239,68,68,0.10)',
  color: '#fca5a5',
  border: '1px solid rgba(239,68,68,0.28)',
  borderRadius: R.md,
  padding: '6px 13px',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
  transition: `background ${T.fast}, border-color ${T.fast}`,
};

export const btnSmall = {
  background: C.cardHover,
  color: C.text,
  border: `1px solid ${C.border}`,
  borderRadius: R.sm,
  padding: '5px 11px',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 500,
  transition: `background ${T.fast}, border-color ${T.fast}, color ${T.fast}`,
};

// Convenience: monospace token for tabular data.
export const MONO = '"DM Mono", ui-monospace, Menlo, Consolas, monospace';
