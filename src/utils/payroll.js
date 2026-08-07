// All payroll logic — pure functions, no React, no Supabase.

export const PUBLIC_HOLIDAYS = new Set([
  // 2025 NSW
  '2025-01-01','2025-01-27','2025-04-18','2025-04-19','2025-04-20','2025-04-21',
  '2025-04-25','2025-06-09','2025-08-04','2025-10-06','2025-12-25','2025-12-26',
  // 2026 NSW
  '2026-01-01','2026-01-26','2026-04-03','2026-04-04','2026-04-05','2026-04-06',
  '2026-04-25','2026-06-08','2026-08-03','2026-10-05','2026-12-25','2026-12-28',
]);

export function roundTo15Min(hours) {
  return Math.round(hours * 4) / 4;
}

export function computeTimesheetHours(form, workerType, config = {}) {
  const OT_THRESHOLD  = parseFloat(config.ot_threshold_daily     ?? 7.6);
  const MEAL_TRIGGER  = parseFloat(config.meal_allowance_trigger  ?? 9.5);
  const MEAL_AMT      = parseFloat(config.meal_allowance_amount   ?? 18.70);
  const TRAVEL_AMT    = parseFloat(config.travel_allowance_casual ?? 15.00);

  let actualHours = 0;
  if (form.start_time && form.end_time) {
    const breakH = (form.break_minutes || 0) / 60;
    actualHours  = roundTo15Min(
      Math.max(0, (new Date(form.end_time) - new Date(form.start_time)) / 3_600_000 - breakH)
    );
  }
  if (form.admin_override_hours != null && form.admin_override_hours !== '') {
    actualHours = parseFloat(form.admin_override_hours);
  }

  let pay_hours, charge_hours;
  switch (form.scenario) {
    case 'late_start_admin':   pay_hours = 8.00; charge_hours = actualHours; break;
    case 'rain_off_partial':   pay_hours = 8.00; charge_hours = 4.00;        break;
    case 'rain_off_cancelled': pay_hours = 8.00; charge_hours = 0.00;        break;
    case 'no_work_available':  pay_hours = 8.00; charge_hours = 0.00;        break;
    case 'training_day':       pay_hours = 8.00; charge_hours = 0.00;        break;
    case 'annual_leave':       pay_hours = 8.00; charge_hours = 0.00;        break;
    case 'personal_leave':     pay_hours = 8.00; charge_hours = 0.00;        break;
    case 'lwop':               pay_hours = 0.00; charge_hours = 0.00;        break;
    case 'public_holiday':
      pay_hours = workerType === 'full-time' ? 8.00 : 0.00; charge_hours = 0.00; break;
    default: pay_hours = actualHours; charge_hours = actualHours;            break;
  }

  const dateStr   = form.date || (form.start_time ? form.start_time.slice(0, 10) : null);
  const dayOfWeek = dateStr ? new Date(dateStr).getDay() : -1;
  const is_weekend = dayOfWeek === 0 || dayOfWeek === 6 || PUBLIC_HOLIDAYS.has(dateStr);

  const overtime_hours   = pay_hours > OT_THRESHOLD ? roundTo15Min(pay_hours - OT_THRESHOLD) : 0;
  // Casuals get one travel allowance per SHIFT — not on leave, rain-off, LWOP or
  // training days, where nobody travelled anywhere. This mirrors the DB's own
  // casual_travel_allowance() rule, which the UI value was overriding.
  const travelScenarios  = ['standard', 'emergency_callout'];
  const travel_allowance = (workerType === 'casual' && travelScenarios.includes(form.scenario || 'standard'))
    ? TRAVEL_AMT : 0;
  const meal_allowance   = pay_hours >= MEAL_TRIGGER ? MEAL_AMT : 0;

  return { pay_hours, charge_hours, overtime_hours, is_weekend, travel_allowance, meal_allowance };
}

// --- Daily Timesheet (detailed) line computations ---------------------------
// Each "Hours worked" line: Total Hours = end - start - break (in hours).
// Regular Hours reuses the daily overtime threshold if configured, else = Total.

export const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// Day-of-week label from an ISO date (uses noon to dodge DST/tz edges).
export function dayFromDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00');
  if (isNaN(d)) return '';
  return DAY_NAMES[d.getDay()];
}

// Total Hours = (end - start) - break, in decimal hours, never negative.
// start/end are "HH:MM" strings; crosses-midnight handled by adding 24h.
export function computeLineTotalHours(startTime, endTime, breakHours) {
  if (!startTime || !endTime) return 0;
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  if ([sh, sm, eh, em].some(isNaN)) return 0;
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60; // overnight shift
  const hrs = mins / 60 - (parseFloat(breakHours) || 0);
  return roundTo15Min(Math.max(0, hrs));
}

// Regular Hours — reuse the existing daily OT threshold if present, else = total.
export function computeLineRegularHours(totalHours, config = {}) {
  const OT_THRESHOLD = config.ot_threshold_daily != null ? parseFloat(config.ot_threshold_daily) : null;
  if (OT_THRESHOLD == null || isNaN(OT_THRESHOLD)) return totalHours;
  return Math.min(totalHours, OT_THRESHOLD);
}

// Overtime for a single line: everything above the regular-hours cap.
export function computeLineOvertimeHours(totalHours, config = {}) {
  const t = parseFloat(totalHours) || 0;
  return Math.max(0, +(t - computeLineRegularHours(t, config)).toFixed(2));
}

// Ordinary / RDO / overtime split for one worked day.
// FULL-TIMERS on a standard weekday: the first 8 worked hours are "normal
// time" — 7.6 paid ordinary + 0.4 banked to the RDO accrual — and only hours
// past 8.0 are overtime (40 worked hrs/week = 38 paid + 2.0 RDO accrued).
// Casuals/subcontractors and weekend/PH shifts: no RDO, OT above the threshold.
export function splitDailyHours(totalHours, workerType, dateStr, config = {}) {
  const t = parseFloat(totalHours) || 0;
  const threshold = parseFloat(config.ot_threshold_daily ?? 7.6);
  const accrual = parseFloat(config.rdo_daily_accrual ?? 0.4);
  const dow = dateStr ? new Date(dateStr + 'T12:00:00').getDay() : 1;
  const weekday = dow >= 1 && dow <= 5 && !PUBLIC_HOLIDAYS.has(dateStr);
  const regular = +Math.min(t, threshold).toFixed(2);
  if (workerType === 'full-time' && weekday) {
    const rdo = +Math.max(0, Math.min(accrual, t - threshold)).toFixed(2);
    return { regular, rdo, overtime: +Math.max(0, t - threshold - rdo).toFixed(2) };
  }
  return { regular, rdo: 0, overtime: +Math.max(0, t - threshold).toFixed(2) };
}

// Full-time minimum day: a full-timer sent home early on a standard weekday is
// still paid a full day, while the client is only charged the hours worked.
// The minimum applies to the DAY as a whole (two 4h shifts on one day already
// make the 8), never to weekends/PH penalty shifts or non-standard scenarios.
// Days under 0.5h are ignored so a stray clock-in test can't become 8h of pay.
// Returns a copy of the rows with pay_hours topped up and min_day_topup set.
export function applyFullTimeMinDay(timesheets, workersById, config = {}) {
  const MIN = parseFloat(config.min_day_hours_fulltime ?? 8);
  const byDay = new Map();
  for (const ts of timesheets) {
    const w = workersById[ts.worker_id];
    if (!w || w.worker_type !== 'full-time') continue;
    if ((ts.scenario || 'standard') !== 'standard') continue;
    if (!ts.date) continue;
    const dow = new Date(ts.date + 'T12:00:00').getDay();
    if (dow === 0 || dow === 6 || PUBLIC_HOLIDAYS.has(ts.date)) continue;
    const key = `${ts.worker_id}|${ts.date}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(ts);
  }
  const topUps = new Map();
  for (const rows of byDay.values()) {
    const dayTotal = rows.reduce((s, r) => s + (parseFloat(r.pay_hours) || 0), 0);
    if (dayTotal >= 0.5 && dayTotal < MIN) {
      const last = rows[rows.length - 1];
      topUps.set(last.id, +(MIN - dayTotal).toFixed(2));
    }
  }
  if (!topUps.size) return timesheets;
  return timesheets.map(ts => topUps.has(ts.id)
    ? { ...ts, pay_hours: +((parseFloat(ts.pay_hours) || 0) + topUps.get(ts.id)).toFixed(2), min_day_topup: topUps.get(ts.id) }
    : ts);
}

// Auto meal allowance for a single worked day/line.
// Mirrors the authoritative DB trigger rule: if hours >= trigger, grant amount.
// Config keys: meal_allowance_trigger (default 9.5h), meal_allowance_amount ($18.70).
export function autoMealAllowance(totalHours, config = {}) {
  const trigger = parseFloat(config.meal_allowance_trigger ?? 9.5);
  const amount  = parseFloat(config.meal_allowance_amount  ?? 18.70);
  return (parseFloat(totalHours) || 0) >= trigger ? amount : 0;
}

export const SHIFT_TYPES = ['Day', 'Night', 'Weekend', 'Public Holiday'];

// --- Client charging ---------------------------------------------------------
// Owner-specified Schedule of Rates bands (2026-08-07). We used to bill
// charge_hours x one flat rate with only a weekend variant, so a night shift was
// PAID at 1.5x/2x and BILLED at 1x — the loading came straight out of margin.
//
//   Mon-Fri day    first 8h column A, everything after column B
//   Mon-Fri night  all hours column B
//   Saturday day   all hours column B
//   Saturday night all hours column C
//   Sunday day     all hours column C
//   Sunday night   all hours column C
//
// Public holidays are billed as Sunday (column C) — NOT owner-confirmed, flagged.
// Saturday day beyond 8h is billed at B throughout for the same reason.
const CHARGE_DAY_THRESHOLD = 8;

// Match a timesheet's role to a line on the client's Schedule of Rates.
//
// Exact matching silently mis-billed, because the role names people allocate and
// the names on the rate cards drifted apart. Measured 2026-08-07:
//   "General Labourer" vs Matt Civil's "General Labour"   -> fell back to $100 instead of $50
//   "Operator - Dozer" vs JK Williams' "Operator"          -> fell back to $66 instead of $84.25
// A miss is not harmless: it quietly bills the catch-all rate, which can be double
// the agreed price or well under it.
//
// So we try progressively looser matches and REPORT which tier hit, so the Payroll
// screen can flag a row that never found a priced line instead of showing a
// confident wrong number.
const normRole = (s) => (s || '')
  .toString().toLowerCase()
  .replace(/[^a-z0-9\s-]/g, ' ')     // drop brackets/punctuation: "Operator (EWP)" -> "operator ewp"
  .replace(/\blabourers?\b/g, 'labour')  // labourer / labourers -> labour
  .replace(/\s+/g, ' ')
  .trim();

// "Operator - Dozer" -> "operator". Everything before the first dash separator.
const roleHead = (s) => normRole(s).split(/\s*-\s*/)[0].trim();

export function findRateLine(rateLines, role) {
  const lines = rateLines || [];
  if (!lines.length || !role) return { line: null, match: 'none' };

  const want = normRole(role);
  const exact = lines.find(r => normRole(r.role_name) === want);
  if (exact) return { line: exact, match: 'exact' };

  // "Operator - Dozer" against a card that only prices "Operator".
  const head = roleHead(role);
  const byHead = lines.find(r => normRole(r.role_name) === head)
              || lines.find(r => roleHead(r.role_name) === head);
  if (byHead) return { line: byHead, match: 'role-group' };

  return { line: null, match: 'none' };
}

// A priced line from the client's Schedule of Rates wins; the client's own A/B/C
// is the catch-all; the legacy single-rate columns are the last resort so older
// clients that were never given bands still bill something rather than $0.
function chargeBands(clientRecord, rateLine) {
  const pick = (...vals) => {
    for (const v of vals) {
      const n = parseFloat(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  };
  const A = pick(rateLine?.rate_a, clientRecord?.rate_a, clientRecord?.rate_regular);
  const B = pick(rateLine?.rate_b, clientRecord?.rate_b, clientRecord?.rate_overtime, A);
  const C = pick(rateLine?.rate_c, clientRecord?.rate_c, clientRecord?.rate_weekend, B);
  return { A, B, C };
}

// Exported so the invoice screen and any test can bill exactly as payroll does.
export function computeChargeAmount(ts, clientRecord, rateLine, opts = {}) {
  const { isSaturday = false, isSundayOrPH = false, geoPct = 0 } = opts;
  const hours = parseFloat(ts.charge_hours) || 0;
  if (hours <= 0) return 0;

  const { A, B, C } = chargeBands(clientRecord, rateLine);
  const night = !!ts.is_night_shift;
  let amount;

  if (isSundayOrPH) {
    amount = hours * C;                       // Sunday / PH, day or night
  } else if (isSaturday) {
    amount = hours * (night ? C : B);         // Sat night C, Sat day B
  } else if (night) {
    amount = hours * B;                       // weekday night
  } else {
    const ordinary = Math.min(hours, CHARGE_DAY_THRESHOLD);
    const beyond   = Math.max(0, hours - CHARGE_DAY_THRESHOLD);
    amount = ordinary * A + beyond * B;       // weekday day: 8h at A, rest at B
  }

  return amount * (ts.geo_loading ? (1 + geoPct) : 1);
}

// Where the charge rate came from, so Payroll can show it rather than presenting a
// catch-all rate as if it were the agreed one.
export function chargeRateSource(clientRecord, rateLine, match) {
  if (rateLine) return match === 'exact' ? 'schedule' : 'schedule-group';
  const hasBands = [clientRecord?.rate_a, clientRecord?.rate_b, clientRecord?.rate_c]
    .some(v => Number.isFinite(parseFloat(v)) && parseFloat(v) > 0);
  if (hasBands) return 'client-fallback';
  return 'legacy';
}

export function computePayrollRow(ts, worker, clientRecord, config = {}, rateLine = null, rateMatch = 'none') {
  const OT_MULT      = parseFloat(config.ot_multiplier               ?? 1.5);
  const GEO_PCT      = parseFloat(config.geo_loading_pct             ?? 0.10);
  const SUB_NIGHT    = parseFloat(config.subcontractor_night_loading  ?? 10.00);
  const SAT_THRESH   = parseFloat(config.saturday_threshold_hours     ?? 2);
  const NIGHT_THRESH = parseFloat(config.night_threshold_hours        ?? 8);

  const payRate    = parseFloat(worker.pay_rate_regular || 0);
  const payRateOT  = parseFloat(worker.pay_rate_overtime || payRate * OT_MULT);

  // Detect day type from date (use noon to avoid DST edge cases)
  const d   = ts.date ? new Date(ts.date + 'T12:00:00') : null;
  const dow = d ? d.getDay() : -1; // 0=Sun, 6=Sat
  const isPH         = !!(ts.date && PUBLIC_HOLIDAYS.has(ts.date));
  const isSaturday   = dow === 6;
  const isSundayOrPH = dow === 0 || isPH;
  const hours        = ts.pay_hours || 0;

  // Timesheets saved from 2026-08-06 carry the penalty split the portal actually
  // recorded (ordinary / RDO / 1.5x / 2x, computed once in split_shift_hours).
  // Pay straight from those buckets so the payslip can never disagree with the
  // hours printed on the timesheet — the two used to be derived separately, so a
  // Sunday could show "7.6 normal + 1.9 OT" while being paid all-2x.
  const hasSplit = ts.ot15_hours != null || ts.ot2x_hours != null;
  if (hasSplit && worker.worker_type !== 'subcontractor') {
    const ord  = Math.max(0, hours - (ts.ot15_hours || 0) - (ts.ot2x_hours || 0) - (ts.rdo_hours || 0));
    let pay    = ord * payRate + (ts.ot15_hours || 0) * payRate * 1.5 + (ts.ot2x_hours || 0) * payRate * 2;
    if (ts.geo_loading) pay *= (1 + GEO_PCT);
    const totalPaySplit = pay + (ts.travel_allowance || 0) + (ts.meal_allowance || 0);
    const chargeAmountS = computeChargeAmount(ts, clientRecord, rateLine, { isSaturday, isSundayOrPH, geoPct: GEO_PCT });
    return {
      worker_name: worker.name, worker_type: worker.worker_type,
      date: ts.date, scenario: ts.scenario, site: ts.site, client: ts.client, role: ts.role,
      pay_hours: ts.pay_hours, charge_hours: ts.charge_hours, overtime_hours: ts.overtime_hours,
      ot15_hours: ts.ot15_hours || 0, ot2x_hours: ts.ot2x_hours || 0,
      rdo_hours: ts.rdo_hours || 0,
      min_day_topup: ts.min_day_topup || 0,
      is_weekend: ts.is_weekend, geo_loading: ts.geo_loading,
      travel_allowance: ts.travel_allowance, meal_allowance: ts.meal_allowance,
      base_pay:      pay.toFixed(2),
      total_pay:     totalPaySplit.toFixed(2),
      charge_amount: chargeAmountS.toFixed(2),
      charge_rate_source: chargeRateSource(clientRecord, rateLine, rateMatch),
      awj_reference: ts.awj_reference || '',
      xero_pay_item: 'OrdinaryTime',
    };
  }

  let basePay;
  if (worker.worker_type === 'subcontractor') {
    // Subcontractors: flat rate + flat night/weekend loading
    const normalH = Math.max(0, hours - (ts.overtime_hours || 0));
    basePay = normalH * payRate + (ts.overtime_hours || 0) * payRateOT;
    if (ts.is_night_shift || ts.is_weekend || isSaturday || isSundayOrPH) basePay += SUB_NIGHT;
  } else if (ts.is_night_shift && (isSaturday || isSundayOrPH)) {
    // Saturday/Sunday/PH night → double time all hours
    basePay = hours * payRate * 2;
  } else if (ts.is_night_shift) {
    // Weekday night → first NIGHT_THRESH hrs at 1.5x, rest at 2x
    const h1 = Math.min(hours, NIGHT_THRESH);
    const h2 = Math.max(0, hours - NIGHT_THRESH);
    basePay = h1 * payRate * 1.5 + h2 * payRate * 2;
  } else if (isSaturday) {
    // Saturday → first SAT_THRESH hrs at 1.5x, rest at 2x
    const h1 = Math.min(hours, SAT_THRESH);
    const h2 = Math.max(0, hours - SAT_THRESH);
    basePay = h1 * payRate * 1.5 + h2 * payRate * 2;
  } else if (isSundayOrPH) {
    // Sunday / public holiday → double time all hours
    basePay = hours * payRate * 2;
  } else {
    // Standard weekday → ordinary + OT. RDO-banked hours are NOT paid today —
    // they accrue to the worker's RDO balance and are paid when the RDO is taken.
    const normalH = Math.max(0, hours - (ts.overtime_hours || 0) - (ts.rdo_hours || 0));
    basePay = normalH * payRate + (ts.overtime_hours || 0) * payRateOT;
  }

  if (ts.geo_loading) basePay *= (1 + GEO_PCT);

  const totalPay    = basePay + (ts.travel_allowance || 0) + (ts.meal_allowance || 0);
  const chargeAmount = computeChargeAmount(ts, clientRecord, rateLine, { isSaturday, isSundayOrPH, geoPct: GEO_PCT });

  return {
    worker_name: worker.name, worker_type: worker.worker_type,
    date: ts.date, scenario: ts.scenario, site: ts.site, client: ts.client, role: ts.role,
    pay_hours: ts.pay_hours, charge_hours: ts.charge_hours, overtime_hours: ts.overtime_hours,
    rdo_hours: ts.rdo_hours || 0,
    min_day_topup: ts.min_day_topup || 0,
    is_weekend: ts.is_weekend, geo_loading: ts.geo_loading,
    travel_allowance: ts.travel_allowance, meal_allowance: ts.meal_allowance,
    base_pay:      basePay.toFixed(2),
    total_pay:     totalPay.toFixed(2),
    charge_amount: chargeAmount.toFixed(2),
    charge_rate_source: chargeRateSource(clientRecord, rateLine, rateMatch),
    awj_reference: ts.awj_reference || '',
    xero_pay_item: worker.worker_type === 'subcontractor' ? 'SubcontractorFee' : 'OrdinaryTime',
  };
}

export function buildXeroCSV(rows, periodFrom, periodTo, downloadFn) {
  const xeroRows = rows.map(r => ({
    'Employee Name':      r.worker_name,
    'Pay Period Start':   periodFrom,
    'Pay Period End':     periodTo,
    'Earnings Rate Name': r.xero_pay_item,
    'Hours':              r.pay_hours,
    // base_pay, NOT total_pay: total_pay already includes travel + meal, and the
    // two allowance columns below carry them separately. Using total_pay here
    // paid both allowances twice on any import that maps those columns.
    'Amount':             r.base_pay,
    'Travel Allowance':   r.travel_allowance,
    'Meal Allowance':     r.meal_allowance,
    'AWJ Reference':      r.awj_reference,
    'Site':               r.site,
    'Client':             r.client,
  }));
  downloadFn(`xero_payroll_${periodFrom}_to_${periodTo}.csv`, xeroRows);
}
