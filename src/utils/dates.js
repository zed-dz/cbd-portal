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

// ── Sydney wall-clock helpers ────────────────────────────────────────────────
// Shift times are SITE-LOCAL (Australia/Sydney), stored as UTC instants. Both
// directions must pin the zone: rendering with the viewer's own timezone put
// the same shift 9 hours apart on two screens for an overseas viewer, and
// parsing browser-local would let an overseas admin shift saved times.
const SYD = 'Australia/Sydney';

export function sydneyHHMM(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: SYD, hour12: false, hour: '2-digit', minute: '2-digit' }).format(d);
}

export function sydneyTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleTimeString('en-AU', { timeZone: SYD, hour: 'numeric', minute: '2-digit' });
}

export function sydneyDateTimeInput(iso) {
  // "yyyy-MM-ddTHH:mm" for datetime-local inputs, Sydney wall-clock.
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: SYD, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

// UTC instant for a Sydney wall-clock date+time, whichever browser runs this.
// Probe the zone offset at the moment itself, then once more to settle DST edges.
export function sydneyInstant(dateISO, hhmm) {
  if (!dateISO || !hhmm) return '';
  const [y, mo, dd] = dateISO.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  if ([y, mo, dd, h, mi].some(isNaN)) return '';
  const utcGuess = Date.UTC(y, mo - 1, dd, h, mi);
  const offsetAt = (t) => {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: SYD, timeZoneName: 'longOffset' })
      .formatToParts(t).find(x => x.type === 'timeZoneName')?.value || 'GMT+10:00';
    const m = /([+-])(\d{2}):(\d{2})/.exec(name);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 600;
  };
  let t = utcGuess - offsetAt(utcGuess) * 60000;
  t = utcGuess - offsetAt(t) * 60000;
  return new Date(t).toISOString();
}
