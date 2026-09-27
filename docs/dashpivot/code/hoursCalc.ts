/**
 * hoursCalc.ts — exact port of the Dashpivot "Daily Timesheet A / B / C" hour formulas
 * (pulled from the live CBD Plant & Labour templates, Sep 2026).
 *
 * Pure function. No rates, no money. Hours only.
 * Use it in BOTH places: the worker form (live preview) and the server (source of truth).
 *
 * Time model (same as Dashpivot):
 *  - Day window for "regular" hours = 05:00 → 17:00.
 *  - Everything rounds to the nearest 0.25 h (Excel ROUND, half away from zero).
 *  - A shift that ends earlier than it starts crosses midnight (+24 h).
 *  - The weekday comes from the shift START date.
 */

export type ShiftType = "Day Shift" | "Night Shift";
export type DayType = "Regular Work" | "Public Holiday";
export type Variant = "A" | "B" | "C";

export interface ShiftInput {
  date: string;          // "YYYY-MM-DD" (start date)
  shiftType: ShiftType;
  dayType?: DayType;     // A has no day type (always Regular Work)
  start: string;         // "HH:mm" 24h, 15-min steps
  end: string;           // "HH:mm" 24h
  breakHours: 0 | 0.5 | 0.75 | 1;
}

export interface ShiftResult {
  day: string;           // "Monday"...
  total: number;         // Total Hours (paid hours)
  regular: number;       // ordinary 1.0x
  ot15: number;          // 1.5x
  ot20: number;          // 2.0x
  mealAllowance: 0 | 1;  // 1 when total >= 9.5
  travelAllowance: 0 | 1;// B only: 1 on any Regular Work / Public Holiday day
  warnings: string[];
}

const DAY_START = 5;   // 05:00  (0.208333 in Dashpivot)
const DAY_END = 17;    // 17:00  (0.708333 in Dashpivot)
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Excel-style ROUND(x/0.25,0)*0.25 (half away from zero). */
export function q(x: number): number {
  const n = x / 0.25;
  const r = Math.sign(n) * Math.round(Math.abs(n) + 1e-9);
  return (r * 0.25) || 0; // avoid -0
}

function toHours(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h + m / 60;
}

/** Dashpivot TIMEDIF(a, b): hours from a to b, wrapping past midnight. */
function timedif(a: number, b: number): number {
  const d = b - a;
  return d < 0 ? d + 24 : d;
}

function weekday(dateISO: string): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  return DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function calcShift(input: ShiftInput, variant: Variant = "B"): ShiftResult {
  const warnings: string[] = [];
  const B = weekday(input.date);
  const C: DayType = variant === "A" ? "Regular Work" : (input.dayType ?? ("" as DayType));
  const D = input.shiftType;
  const E = toHours(input.start);
  const F = toHours(input.end);
  const G = input.breakHours;

  const isWeekend = B === "Saturday" || B === "Sunday";
  const wk = isWeekend ? 0 : 1;               // IF(OR(Sat,Sun),0,1)
  const notPH = C === "Public Holiday" ? 0 : 1;
  const isDay = D === "Day Shift";
  const isNight = D === "Night Shift";

  // Guard used by every variant: a DAY shift that starts at/after 17:00 is invalid -> 0 h.
  const dayShiftStartsLate = !isNight && E >= DAY_END;
  if (dayShiftStartsLate) {
    // Dashpivot sets Total to 0 here but still fills Regular=8 and 1.5x=-8 (a bug).
    // We return all zeros and the UI must block the save.
    warnings.push("Day shift cannot start at or after 5:00 pm. Pick Night Shift.");
    return { day: B, total: 0, regular: 0, ot15: 0, ot20: 0, mealAllowance: 0, travelAllowance: 0, warnings };
  }

  // ---------- H: Total Hours ----------
  let H: number;
  if (variant === "A") {
    H = q((timedif(E, F) - G) * (dayShiftStartsLate ? 0 : 1));
  } else {
    if (!C) warnings.push("Type of Day is empty -> total is 0.");
    const worked = (timedif(E, F) - G) * (C === "Regular Work" ? 1 : 0);
    const ph = C === "Public Holiday" ? 8 : 0; // Public Holiday = flat 8 h
    H = q((worked + ph) * (dayShiftStartsLate ? 0 : 1));
  }

  // ---------- I: Regular Hours (weekday day shift only, capped at 8, window 05:00-17:00) ----------
  let I = 0;
  if (isDay && wk) {
    if (E >= DAY_START && F <= DAY_END) I = Math.min(H, 8);
    else if (E >= DAY_START && F > DAY_END) I = Math.min(timedif(E, DAY_END), 8);
    else if (E < DAY_START && F <= DAY_END) I = Math.min(timedif(DAY_START, F), 8);
    else if (E < DAY_START && F > DAY_END) I = 8;
  }
  I = q(I);

  // ---------- J: 1.5x OT ----------
  const phFactor = variant === "A" ? 1 : notPH;
  let J = 0;
  // Weekday day shift: first 2 h after regular
  if (isDay && wk) {
    if (E >= DAY_START && F <= DAY_END) {
      const over = H - 8;
      J += over > 0 ? Math.min(over, 2) : 0;
    } else if (E < DAY_START && F > DAY_END) {
      J += 2; // Dashpivot: flat 2 h when the shift covers the whole day window
    } else {
      J += Math.min(H - I, 2); // exact Dashpivot behaviour (can go negative on tiny shifts)
      if (H - I < 0) warnings.push("Break is longer than the time after 5 pm. Dashpivot gives negative 1.5x here.");
    }
  }
  // Weekday night shift: first 8 h at 1.5x
  if (isNight && wk) {
    if (E >= DAY_END) J += Math.min(H, 8);
    else if (variant === "C" && E < DAY_START) {
      // C only: night shift that starts after midnight (before 05:00)
      if (H <= 8) J += H;
      else if (F > DAY_START) J += 8;
    }
  }
  // Saturday day shift: first 2 h at 1.5x (Sunday = all 2.0x)
  if (B === "Saturday" && !isNight && I === 0) J += Math.min(H, 2);
  J = q(J * phFactor);

  // ---------- K: 2.0x OT = everything left ----------
  const K = q(H - I - J);

  // ---------- Allowances (hidden from client PDF in Dashpivot) ----------
  const mealAllowance: 0 | 1 = H >= 9.5 ? 1 : 0;
  const travelAllowance: 0 | 1 = variant === "B" && (C === "Regular Work" || C === "Public Holiday") ? 1 : 0;

  if (C === "Public Holiday" && isNight) warnings.push("Public Holiday + Night Shift gives 8 h at 2.0x in Dashpivot. Check this rule.");

  return { day: B, total: H, regular: I, ot15: J, ot20: K, mealAllowance, travelAllowance, warnings };
}
