export function fmtDate(str) {
  if (!str) return '—';
  return new Date(str).toLocaleDateString('en-AU');
}

export function fmtDateTime(str) {
  if (!str) return '—';
  return new Date(str).toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'short' });
}

export function todayISO() {
  return new Date().toISOString().split('T')[0];
}

// True when a 'YYYY-MM-DD' work date falls on a Tuesday or Thursday.
// Weekday is computed at local noon (from the date parts) so it's stable in
// the browser's timezone — for the AU team that's AEST/AEDT — with no
// UTC-midnight rollback. Used to gate timesheet submission behind a Take 5.
export function isTakeFiveDay(dateStr) {
  if (!dateStr) return false;
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return false;
  const dow = new Date(y, m - 1, d, 12, 0, 0).getDay(); // 0=Sun … 2=Tue, 4=Thu
  return dow === 2 || dow === 4;
}
