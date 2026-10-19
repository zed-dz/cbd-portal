import {
  roundTo15Min, computeLineTotalHours, computeLineRegularHours, computeLineOvertimeHours,
  splitDailyHours, computeTimesheetHours, computePayrollRow, withRoleRate, PUBLIC_HOLIDAYS,
  autoMealAllowance, applyFullTimeMinDay,
} from './payroll';

describe('0.25h rounding', () => {
  test.each([
    [7.6, 7.5], [7.62, 7.5], [7.63, 7.75], [7.87, 7.75], [7.88, 8], [0, 0], [10.125, 10.25],
  ])('roundTo15Min(%p) = %p', (h, want) => { expect(roundTo15Min(h)).toBe(want); });

  test('line total = span minus break, rounded, never negative', () => {
    expect(computeLineTotalHours('07:00', '15:35', 0.5)).toBe(8); // 8.583 - 0.5 = 8.08 -> 8
    expect(computeLineTotalHours('07:00', '15:40', 0.5)).toBe(8.25);
    expect(computeLineTotalHours('22:00', '06:00', 0)).toBe(8);   // overnight
    expect(computeLineTotalHours('07:00', '07:15', 1)).toBe(0);
    expect(computeLineTotalHours('', '15:00', 0)).toBe(0);
  });
});

describe('OT split at the daily threshold', () => {
  test('regular caps at the configured threshold, rest is OT', () => {
    expect(computeLineRegularHours(10, { ot_threshold_daily: 7.6 })).toBe(7.6);
    expect(computeLineOvertimeHours(10, { ot_threshold_daily: 7.6 })).toBe(2.4);
    expect(computeLineOvertimeHours(6, { ot_threshold_daily: 7.6 })).toBe(0);
  });
  test('no threshold configured: everything is regular', () => {
    expect(computeLineRegularHours(10, {})).toBe(10);
  });
  test('full-timer weekday: 7.6 ordinary + 0.4 RDO + OT above 8', () => {
    expect(splitDailyHours(10, 'full-time', '2026-10-13')).toEqual({ regular: 7.6, rdo: 0.4, overtime: 2 });
    expect(splitDailyHours(7.8, 'full-time', '2026-10-13')).toEqual({ regular: 7.6, rdo: 0.2, overtime: 0 });
  });
  test('casual weekday: no RDO, OT above 7.6', () => {
    expect(splitDailyHours(10, 'casual', '2026-10-13')).toEqual({ regular: 7.6, rdo: 0, overtime: 2.4 });
  });
  test('full-timer on a weekend or public holiday banks no RDO', () => {
    expect(splitDailyHours(10, 'full-time', '2026-10-17').rdo).toBe(0); // Saturday
    expect(splitDailyHours(10, 'full-time', '2026-12-25').rdo).toBe(0); // Christmas
  });
  test('computeTimesheetHours: overtime above threshold, 0.25 rounded', () => {
    const r = computeTimesheetHours({ start_time: '2026-10-13T07:00:00+11:00', end_time: '2026-10-13T17:10:00+11:00', break_minutes: 30, scenario: 'standard' }, 'casual', {});
    expect(r.pay_hours).toBe(9.75);
    expect(r.overtime_hours).toBe(2.25);
    expect(r.meal_allowance).toBe(18.7);
    expect(r.travel_allowance).toBe(15);
  });
});

describe('public holiday detection', () => {
  test('gazetted NSW days are listed, the August bank holiday is not', () => {
    expect(PUBLIC_HOLIDAYS.has('2026-12-25')).toBe(true);
    expect(PUBLIC_HOLIDAYS.has('2026-01-26')).toBe(true);
    expect(PUBLIC_HOLIDAYS.has('2026-08-03')).toBe(false);
  });
  test('a weekday public holiday is weekend-rated and paid at 2x', () => {
    const r = computeTimesheetHours({ date: '2026-12-25', start_time: '2026-12-25T07:00:00+11:00', end_time: '2026-12-25T15:00:00+11:00', break_minutes: 0, scenario: 'standard' }, 'casual', {});
    expect(r.is_weekend).toBe(true);
    const row = computePayrollRow({ date: '2026-12-25', pay_hours: 8, overtime_hours: 0, charge_hours: 8, scenario: 'standard' }, { name: 'C', worker_type: 'casual', pay_rate_regular: 40 }, {});
    expect(row.ot2x_hours).toBe(8);
    expect(row.ordinary_hours).toBe(0);
    expect(row.base_pay).toBe('640.00');
  });
});

describe('casual loading / rates', () => {
  test('casual without a B rate still pays OT at A x 1.5', () => {
    const ts = { date: '2026-10-13', pay_hours: 10, overtime_hours: 2, charge_hours: 10, scenario: 'standard' };
    const r = computePayrollRow(ts, { name: 'Casual', worker_type: 'casual', pay_rate_regular: 40, pay_rate_overtime: null }, {});
    expect(r.ot15_rate).toBe('60.00');
    expect(r.rate_missing).toBe(false);
    expect(r.total_pay).toBe('440.00');
  });
  test('a loaded base rate (A = base x 1.25) flows straight into pay', () => {
    const ts = { date: '2026-10-13', pay_hours: 8, overtime_hours: 0, charge_hours: 8, scenario: 'standard' };
    const base = 40, loaded = +(base * 1.25).toFixed(2);
    const r = computePayrollRow(ts, { name: 'Casual', worker_type: 'casual', pay_rate_regular: loaded, pay_rate_base: base, casual_loading_pct: 25 }, {});
    expect(r.pay_rate).toBe('50.00');
    expect(r.ordinary_pay).toBe('400.00');
  });
  test('meal allowance triggers at the configured hours', () => {
    expect(autoMealAllowance(9.5)).toBe(18.7);
    expect(autoMealAllowance(9.25)).toBe(0);
    expect(autoMealAllowance(8, { meal_allowance_trigger: 8, meal_allowance_amount: 20 })).toBe(20);
  });
  test('unpaid training for a casual zeroes every bucket and allowance', () => {
    const r = computePayrollRow({ date: '2026-10-13', pay_hours: 8, overtime_hours: 0, charge_hours: 0, scenario: 'training_day', travel_allowance: 15 }, { name: 'C', worker_type: 'casual', pay_rate_regular: 40 }, {});
    expect(r.total_pay).toBe('0.00');
    expect(r.charge_amount).toBe('0.00');
  });
  test('full-time minimum day tops a short weekday up to 8h of pay', () => {
    const rows = applyFullTimeMinDay([{ id: 'a', worker_id: 'w', date: '2026-10-13', pay_hours: 5, scenario: 'standard' }], { w: { worker_type: 'full-time' } });
    expect(rows[0].pay_hours).toBe(8);
    expect(rows[0].min_day_topup).toBe(3);
  });
});

// Subcontractor rules — the known-good cases from test_sub_rates.mjs.
describe('subcontractor: no-guess rule', () => {
  const ts = { date: '2026-10-13', pay_hours: 10, overtime_hours: 2, charge_hours: 10, scenario: 'standard' }; // Tuesday

  test('sub with B: OT rate is the typed B', () => {
    const r = computePayrollRow(ts, { name: 'Sub with B', worker_type: 'subcontractor', pay_rate_regular: 50, pay_rate_overtime: 60 }, {});
    expect([r.ot15_rate, r.total_pay, r.rate_missing]).toEqual(['60.00', '520.00', false]);
  });
  test('sub without B: no 1.5x guess, flagged', () => {
    const r = computePayrollRow(ts, { name: 'Sub no B', worker_type: 'subcontractor', pay_rate_regular: 50, pay_rate_overtime: null }, {});
    expect([r.ot15_rate, r.ot15_pay, r.rate_missing]).toEqual(['0.00', '0.00', true]);
  });
  test('sub without B but no OT: not flagged', () => {
    const r = computePayrollRow({ ...ts, overtime_hours: 0, pay_hours: 8 }, { name: 'Sub no B no OT', worker_type: 'subcontractor', pay_rate_regular: 50, pay_rate_overtime: null }, {});
    expect([r.total_pay, r.rate_missing]).toEqual(['400.00', false]);
  });
  test('sub with a blank A and hours worked: flagged', () => {
    const r = computePayrollRow({ ...ts, overtime_hours: 0, pay_hours: 8 }, { name: 'Sub no A', worker_type: 'subcontractor', pay_rate_regular: null, pay_rate_overtime: null }, {});
    expect(r.rate_missing).toBe(true);
  });

  describe('rates by role (withRoleRate)', () => {
    const sub = { id: 'w1', name: 'Sam Sub', worker_type: 'subcontractor', pay_rate_regular: 50, pay_rate_overtime: 60 };
    const rates = [
      { worker_id: 'w1', role_name: 'Traffic Controller', rate_normal: 70, rate_overtime: 95 },
      { worker_id: 'w1', role_name: 'Excavator Operator', rate_normal: 90, rate_overtime: null },
      { worker_id: 'w2', role_name: 'Labourer', rate_normal: 1, rate_overtime: 1 },
    ];
    test('role match (any case/spaces): role rates used', () => {
      const r = computePayrollRow({ ...ts, role: 'traffic controller ' }, withRoleRate(sub, 'traffic controller ', rates), {});
      expect([r.pay_rate, r.ot15_rate, r.total_pay, r.pay_rate_source]).toEqual(['70.00', '95.00', '750.00', 'role: Traffic Controller']);
    });
    test('no match for THIS person: person A/B used', () => {
      const r = computePayrollRow({ ...ts, role: 'Labourer' }, withRoleRate(sub, 'Labourer', rates), {});
      expect([r.pay_rate, r.ot15_rate, r.pay_rate_source]).toEqual(['50.00', '60.00', 'person']);
    });
    test('role rate with blank overtime: flagged, not guessed', () => {
      const r = computePayrollRow({ ...ts, role: 'Excavator Operator' }, withRoleRate(sub, 'Excavator Operator', rates), {});
      expect([r.pay_rate, r.ot15_rate, r.rate_missing]).toEqual(['90.00', '0.00', true]);
    });
    test('non-subcontractor ignores role rates', () => {
      const cas = { id: 'w1', name: 'Casey', worker_type: 'casual', pay_rate_regular: 40 };
      const r = computePayrollRow({ ...ts, role: 'Traffic Controller' }, withRoleRate(cas, 'Traffic Controller', rates), {});
      expect([r.pay_rate, r.pay_rate_source]).toEqual(['40.00', null]);
    });
    test('withRoleRate leaves a missing worker alone', () => {
      expect(withRoleRate(null, 'x', rates)).toBeNull();
    });
  });
});
