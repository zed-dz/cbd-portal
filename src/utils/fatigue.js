// Fatigue checks for the daily timesheet — pure functions, no React, no
// Supabase, no money. Three rules (owner brief 2026-10-19):
//   1. any single shift over 12 worked hours
//   2. less than 10 hours' rest between one shift finishing and the next starting
//      (the previous line on this sheet, or the worker's last saved line before it)
//   3. more than 60 worked hours Mon–Sun in the week of the sheet
//      (this sheet + the worker's other lines that week)
// A breach never blocks a submission on its own — the worker confirms the
// hours are right and the office decides. The breaches are stored on the
// header (fatigue_flags) so the office list and the detail view can flag it.

export const FATIGUE_LIMITS = { maxShiftHours: 12, minRestHours: 10, maxWeekHours: 60 };

const DAY_MS = 24 * 3600 * 1000;

// Default instant resolver: naive UTC. The form swaps in a Sydney-pinned one
// so a saved UTC end_time and a typed wall-clock start compare correctly.
function naiveInstant(dateISO, hhmm) {
  const [y, m, d] = String(dateISO).split('-').map(Number);
  const [h, mi] = String(hhmm).split(':').map(Number);
  if ([y, m, d, h, mi].some(n => Number.isNaN(n))) return NaN;
  return Date.UTC(y, m - 1, d, h, mi);
}

// Monday..Sunday ISO bounds of the week holding dateISO.
export function weekBounds(dateISO) {
  const [y, m, d] = String(dateISO).split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  if (Number.isNaN(t)) return null;
  const dow = new Date(t).getUTCDay();          // 0 = Sunday
  const mon = t - ((dow + 6) % 7) * DAY_MS;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(mon), to: iso(mon + 6 * DAY_MS) };
}

// Turn a form line into { date, startMs, endMs, hours }. An end at/before the
// start rolls to the next day (overnight shift). Hours = the line's own
// total_hours when present (already rounded to 0.25 by the form), else the
// raw span minus the break.
export function shiftFromLine(line, toInstant = naiveInstant) {
  if (!line || !line.date || !line.start_time || !line.end_time) return null;
  let startMs = toInstant(line.date, line.start_time);
  let endMs = toInstant(line.date, line.end_time);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
  if (endMs <= startMs) endMs += DAY_MS;
  const span = (endMs - startMs) / 3600000 - (parseFloat(line.total_break_hours) || 0);
  const own = parseFloat(line.total_hours);
  const hours = Number.isFinite(own) && own > 0 ? own : Math.max(0, span);
  return { date: line.date, startMs, endMs, hours: +hours.toFixed(2) };
}

const fmtH = (h) => (Math.round(h * 100) / 100).toString();

// lines: the sheet's hours lines. previousEndMs: instant the worker's last
// saved line (before this sheet) finished, or null. otherWeekHours: worked
// hours already saved for the same Mon–Sun week, excluding this sheet.
export function checkFatigue({ lines = [], previousEndMs = null, otherWeekHours = 0, toInstant, limits } = {}) {
  const L = { ...FATIGUE_LIMITS, ...(limits || {}) };
  const shifts = lines.map(l => shiftFromLine(l, toInstant)).filter(Boolean).sort((a, b) => a.startMs - b.startMs);
  const breaches = [];

  for (const s of shifts) {
    if (s.hours > L.maxShiftHours) {
      breaches.push({ type: 'long_shift', date: s.date, text: `${s.date}: ${fmtH(s.hours)}h in one shift (limit ${L.maxShiftHours}h)` });
    }
  }

  let prevEnd = Number.isFinite(previousEndMs) ? previousEndMs : null;
  let prevLabel = 'the previous shift';
  for (const s of shifts) {
    if (prevEnd != null) {
      const rest = (s.startMs - prevEnd) / 3600000;
      if (rest >= 0 && rest < L.minRestHours) {
        breaches.push({ type: 'short_rest', date: s.date, text: `${s.date}: only ${fmtH(rest)}h rest since ${prevLabel} (minimum ${L.minRestHours}h)` });
      }
    }
    prevEnd = s.endMs;
    prevLabel = `the ${s.date} shift`;
  }

  let weekHours = 0;
  let sheetHours = 0;
  let week = null;
  if (shifts.length) {
    week = weekBounds(shifts[0].date);
    const inWeek = shifts.filter(s => week && s.date >= week.from && s.date <= week.to);
    sheetHours = +inWeek.reduce((t, s) => t + s.hours, 0).toFixed(2);
    weekHours = +(sheetHours + (parseFloat(otherWeekHours) || 0)).toFixed(2);
    if (weekHours > L.maxWeekHours) {
      breaches.push({ type: 'week_total', date: week.from, text: `Week of ${week.from}: ${fmtH(weekHours)}h worked (limit ${L.maxWeekHours}h)` });
    }
  }

  return { breaches, weekHours, sheetHours, week, shifts };
}

// Stable string for "did the breach set change" (resets the confirm tick).
export function fatigueKey(breaches) {
  return (breaches || []).map(b => `${b.type}|${b.date}`).join(';');
}
