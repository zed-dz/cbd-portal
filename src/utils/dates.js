export function fmtDate(str) {
  if (!str) return '—';
  return new Date(str).toLocaleDateString('en-AU');
}

export function fmtDateTime(str) {
  if (!str) return '—';
  return new Date(str).toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'short' });
}

// Local 'YYYY-MM-DD'. NEVER use toISOString() for a calendar date: that reads the
// UTC date, and in AEST/AEDT (UTC+10/+11) the UTC date is still YESTERDAY from
// local midnight until 10–11am — the whole working morning. That made "today"
// wrong for timesheet dates, clock-ins, Take 5 work_date and the calendar.
export function localISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function todayISO() {
  return localISO();
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
