import { R } from '../../theme';

const BADGE_PALETTE = {
  green:  { bg: 'rgba(34,197,94,0.13)',   fg: '#86efac' },
  yellow: { bg: 'rgba(234,179,8,0.14)',   fg: '#fde047' },
  red:    { bg: 'rgba(239,68,68,0.13)',   fg: '#fca5a5' },
  blue:   { bg: 'rgba(56,189,248,0.13)',  fg: '#7dd3fc' },
  orange: { bg: 'rgba(249,115,22,0.13)',  fg: '#fdba74' },
  purple: { bg: 'rgba(168,85,247,0.13)',  fg: '#d8b4fe' },
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

// Domain-specific badge helpers — keep colocated with Badge so the palette
// stays consistent and there's only one place to add new statuses.

export function allocationBadge(status) {
  const map = { pending: 'yellow', confirmed: 'blue', completed: 'green', cancelled: 'red', declined: 'red', filled: 'gray' };
  // 'filled' = the job's positions were taken by workers who accepted first.
  return <Badge label={status === 'filled' ? 'position filled' : status} color={map[status] || 'gray'} />;
}

export function timesheetBadge(status) {
  const map = { pending: 'yellow', approved: 'green', rejected: 'red' };
  return <Badge label={status} color={map[status] || 'gray'} />;
}

// Red "Fatigue" chip when a header carries fatigue_flags (>12h shift, <10h
// rest, >60h week). The breach texts ride on the title so the office can
// read them without opening the sheet.
export function fatigueBadge(flags) {
  if (!Array.isArray(flags) || flags.length === 0) return null;
  return (
    <span title={flags.map(f => f.text).join('\n')} style={{ display: 'inline-flex' }}>
      <Badge label={`⚠ Fatigue${flags.length > 1 ? ` ×${flags.length}` : ''}`} color="red" size="sm" />
    </span>
  );
}

export function certBadge(expiry) {
  if (!expiry) return <Badge label="No expiry" color="gray" />;
  // A date-only string parses as UTC midnight, which read as "Expired" from
  // ~10 am Sydney on the expiry day itself. Treat the ticket as valid all day.
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(expiry)) ? `${expiry}T23:59:59` : expiry);
  const now = new Date();
  const diff = (d - now) / (1000 * 60 * 60 * 24);
  if (diff < 0) return <Badge label="Expired" color="red" />;
  if (diff < 30) return <Badge label="Expiring soon" color="yellow" />;
  return <Badge label="Valid" color="green" />;
}
