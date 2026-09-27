// hoursCalc — exact JS port of docs/dashpivot/code/hoursCalc.ts (the Dashpivot
// "Daily Timesheet A / B / C" hour formulas, pulled from the live CBD templates
// Sep 2026). Clients have signed ~4,700 timesheets on these rules, so this
// port must never "improve" the maths — bugs and all are kept, except the
// day-shift-after-5pm case which returns zeros and must block the save.
//
// Which rules apply is a PER-CLIENT setting: clients.award_profile
//   'A' | 'B' | 'C'  -> these Dashpivot rules (variant letter)
//   'PORTAL'         -> the legacy 7.6h + RDO model (split_shift_hours / splitDailyHours)
// Pure function. No rates, no money. Hours only.

const DAY_START = 5;   // 05:00
const DAY_END = 17;    // 17:00
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Excel-style ROUND(x/0.25,0)*0.25 (half away from zero).
export function q(x) {
  const n = x / 0.25;
  const r = Math.sign(n) * Math.round(Math.abs(n) + 1e-9);
  return (r * 0.25) || 0;
}

function toHours(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h + m / 60;
}

function timedif(a, b) {
  const d = b - a;
  return d < 0 ? d + 24 : d;
}

function weekday(dateISO) {
  const [y, m, d] = dateISO.split('-').map(Number);
  return DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

// input: { date:'YYYY-MM-DD', shiftType:'Day Shift'|'Night Shift',
//          dayType:'Regular Work'|'Public Holiday', start:'HH:mm', end:'HH:mm',
//          breakHours:0|0.5|0.75|1 }  variant: 'A'|'B'|'C'
export function calcShift(input, variant = 'B') {
  const warnings = [];
  const B = weekday(input.date);
  const C = variant === 'A' ? 'Regular Work' : (input.dayType ?? '');
  const D = input.shiftType;
  const E = toHours(input.start);
  const F = toHours(input.end);
  const G = input.breakHours;

  const isWeekend = B === 'Saturday' || B === 'Sunday';
  const wk = isWeekend ? 0 : 1;
  const notPH = C === 'Public Holiday' ? 0 : 1;
  const isDay = D === 'Day Shift';
  const isNight = D === 'Night Shift';

  const dayShiftStartsLate = !isNight && E >= DAY_END;
  if (dayShiftStartsLate) {
    warnings.push('Day shift cannot start at or after 5:00 pm. Pick Night Shift.');
    return { day: B, total: 0, regular: 0, ot15: 0, ot20: 0, mealAllowance: 0, travelAllowance: 0, warnings };
  }

  let H;
  if (variant === 'A') {
    H = q(timedif(E, F) - G);
  } else {
    if (!C) warnings.push('Type of Day is empty -> total is 0.');
    const worked = (timedif(E, F) - G) * (C === 'Regular Work' ? 1 : 0);
    const ph = C === 'Public Holiday' ? 8 : 0;
    H = q(worked + ph);
  }

  let I = 0;
  if (isDay && wk) {
    if (E >= DAY_START && F <= DAY_END) I = Math.min(H, 8);
    else if (E >= DAY_START && F > DAY_END) I = Math.min(timedif(E, DAY_END), 8);
    else if (E < DAY_START && F <= DAY_END) I = Math.min(timedif(DAY_START, F), 8);
    else if (E < DAY_START && F > DAY_END) I = 8;
  }
  I = q(I);

  const phFactor = variant === 'A' ? 1 : notPH;
  let J = 0;
  if (isDay && wk) {
    if (E >= DAY_START && F <= DAY_END) {
      const over = H - 8;
      J += over > 0 ? Math.min(over, 2) : 0;
    } else if (E < DAY_START && F > DAY_END) {
      J += 2;
    } else {
      J += Math.min(H - I, 2);
      if (H - I < 0) warnings.push('Break is longer than the time after 5 pm. Dashpivot gives negative 1.5x here.');
    }
  }
  if (isNight && wk) {
    if (E >= DAY_END) J += Math.min(H, 8);
    else if (variant === 'C' && E < DAY_START) {
      if (H <= 8) J += H;
      else if (F > DAY_START) J += 8;
    }
  }
  if (B === 'Saturday' && !isNight && I === 0) J += Math.min(H, 2);
  J = q(J * phFactor);

  const K = q(H - I - J);

  const mealAllowance = H >= 9.5 ? 1 : 0;
  const travelAllowance = variant === 'B' && (C === 'Regular Work' || C === 'Public Holiday') ? 1 : 0;

  if (C === 'Public Holiday' && isNight) warnings.push('Public Holiday + Night Shift gives 8 h at 2.0x in Dashpivot. Check this rule.');

  return { day: B, total: H, regular: I, ot15: J, ot20: K, mealAllowance, travelAllowance, warnings };
}

// Adapter for the portal's timesheet line shape -> calcShift input.
// Returns null when the line can't be computed (missing times) or when the
// client is on the legacy 'PORTAL' profile (caller keeps the old maths).
export function calcPortalLine(line, profile) {
  if (!profile || profile === 'PORTAL') return null;
  if (!line.date || !line.start_time || !line.end_time) return null;
  const shift = line.shift_type === 'Night' ? 'Night Shift' : 'Day Shift';
  const dayType = (line.shift_type === 'Public Holiday' || line.scenario === 'public_holiday')
    ? 'Public Holiday' : 'Regular Work';
  return calcShift({
    date: line.date,
    shiftType: shift,
    dayType,
    start: line.start_time,
    end: line.end_time,
    breakHours: parseFloat(line.total_break_hours) || 0,
  }, profile);
}
