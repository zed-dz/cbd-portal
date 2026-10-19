// Repeating allocations — pure date maths for "every week for N weeks on
// these weekdays". Kept out of the page so it can be unit-tested.
import { localISO } from './dates';

export const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function mondayOf(iso) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localISO(d);
}
export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return localISO(d);
}
// 0 = Monday … 6 = Sunday
export function weekdayIndex(iso) {
  return (new Date(iso + 'T12:00:00').getDay() + 6) % 7;
}
export function dayDiff(fromISO, toISO) {
  return Math.round((new Date(toISO + 'T12:00:00') - new Date(fromISO + 'T12:00:00')) / 86400000);
}

// All occurrence start dates for a weekly series: `weeks` weeks counted from the
// week containing `startISO`, on the given weekdays (0 = Mon). Dates before the
// start date are dropped, so the first occurrence is never earlier than the
// date typed in the form.
export function seriesDates(startISO, weeks, weekdays) {
  if (!startISO) return [];
  const n = Math.min(12, Math.max(1, parseInt(weeks, 10) || 1));
  const days = [...new Set((weekdays || []).map(Number).filter(d => d >= 0 && d <= 6))].sort((a, b) => a - b);
  if (!days.length) return [];
  const mon = mondayOf(startISO);
  const out = [];
  for (let w = 0; w < n; w++) {
    for (const d of days) {
      const iso = addDays(mon, w * 7 + d);
      if (iso >= startISO) out.push(iso);
    }
  }
  return out;
}

export function newSeriesId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
  });
}
