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
  const travel_allowance = workerType === 'casual' ? TRAVEL_AMT : 0;
  const meal_allowance   = pay_hours >= MEAL_TRIGGER ? MEAL_AMT : 0;

  return { pay_hours, charge_hours, overtime_hours, is_weekend, travel_allowance, meal_allowance };
}

export function computePayrollRow(ts, worker, clientRecord, config = {}) {
  const OT_MULT      = parseFloat(config.ot_multiplier               ?? 1.5);
  const GEO_PCT      = parseFloat(config.geo_loading_pct             ?? 0.10);
  const SUB_NIGHT    = parseFloat(config.subcontractor_night_loading  ?? 10.00);
  const SAT_THRESH   = parseFloat(config.saturday_threshold_hours     ?? 2);
  const NIGHT_THRESH = parseFloat(config.night_threshold_hours        ?? 8);

  const payRate    = parseFloat(worker.pay_rate_regular || 0);
  const payRateOT  = parseFloat(worker.pay_rate_overtime || payRate * OT_MULT);
  const chargeRate = parseFloat(clientRecord?.rate_regular || 0);

  // Detect day type from date (use noon to avoid DST edge cases)
  const d   = ts.date ? new Date(ts.date + 'T12:00:00') : null;
  const dow = d ? d.getDay() : -1; // 0=Sun, 6=Sat
  const isPH         = !!(ts.date && PUBLIC_HOLIDAYS.has(ts.date));
  const isSaturday   = dow === 6;
  const isSundayOrPH = dow === 0 || isPH;
  const hours        = ts.pay_hours || 0;

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
    // Standard weekday → normal hours + OT
    const normalH = Math.max(0, hours - (ts.overtime_hours || 0));
    basePay = normalH * payRate + (ts.overtime_hours || 0) * payRateOT;
  }

  if (ts.geo_loading) basePay *= (1 + GEO_PCT);

  const totalPay    = basePay + (ts.travel_allowance || 0) + (ts.meal_allowance || 0);
  const weekendRate = ts.is_weekend && clientRecord?.rate_weekend
    ? parseFloat(clientRecord.rate_weekend) : chargeRate;
  const chargeAmount = (ts.charge_hours || 0) * weekendRate
    * (ts.geo_loading ? (1 + GEO_PCT) : 1);

  return {
    worker_name: worker.name, worker_type: worker.worker_type,
    date: ts.date, scenario: ts.scenario, site: ts.site, client: ts.client,
    pay_hours: ts.pay_hours, charge_hours: ts.charge_hours, overtime_hours: ts.overtime_hours,
    is_weekend: ts.is_weekend, geo_loading: ts.geo_loading,
    travel_allowance: ts.travel_allowance, meal_allowance: ts.meal_allowance,
    base_pay:      basePay.toFixed(2),
    total_pay:     totalPay.toFixed(2),
    charge_amount: chargeAmount.toFixed(2),
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
    'Amount':             r.total_pay,
    'Travel Allowance':   r.travel_allowance,
    'Meal Allowance':     r.meal_allowance,
    'AWJ Reference':      r.awj_reference,
    'Site':               r.site,
    'Client':             r.client,
  }));
  downloadFn(`xero_payroll_${periodFrom}_to_${periodTo}.csv`, xeroRows);
}
