// Port of docs/dashpivot/code/hoursCalc.test.ts — the Dashpivot A/B/C hour
// formulas clients signed ~4,700 timesheets on. Expected values are the ones
// the live templates produce; never "fix" them here without the owner.
import { calcShift, calcPortalLine, q } from './hoursCalc';

const cases = [
  // name, input, variant, [total, regular, 1.5x, 2.0x]
  ['Weekday day 07:00-15:30, 0.5 break', { date: '2026-09-22', shiftType: 'Day Shift', dayType: 'Regular Work', start: '07:00', end: '15:30', breakHours: 0.5 }, 'B', [8, 8, 0, 0]],
  ['Weekday day 06:00-18:00, 0.5 break', { date: '2026-09-22', shiftType: 'Day Shift', dayType: 'Regular Work', start: '06:00', end: '18:00', breakHours: 0.5 }, 'B', [11.5, 8, 2, 1.5]],
  ['REAL FORM: Sat day 07:00-12:00, no break', { date: '2026-09-26', shiftType: 'Day Shift', dayType: 'Regular Work', start: '07:00', end: '12:00', breakHours: 0 }, 'B', [5, 0, 2, 3]],
  ['Sunday day 07:00-15:00, 0.5 break', { date: '2026-09-27', shiftType: 'Day Shift', dayType: 'Regular Work', start: '07:00', end: '15:00', breakHours: 0.5 }, 'B', [7.5, 0, 0, 7.5]],
  ['Weekday night 18:00-04:00, 0.5 break', { date: '2026-09-22', shiftType: 'Night Shift', dayType: 'Regular Work', start: '18:00', end: '04:00', breakHours: 0.5 }, 'B', [9.5, 0, 8, 1.5]],
  ['Day shift starting 18:00 is blocked', { date: '2026-09-22', shiftType: 'Day Shift', dayType: 'Regular Work', start: '18:00', end: '23:00', breakHours: 0 }, 'B', [0, 0, 0, 0]],
  ['Public Holiday weekday day', { date: '2026-09-22', shiftType: 'Day Shift', dayType: 'Public Holiday', start: '07:00', end: '15:00', breakHours: 0 }, 'B', [8, 8, 0, 0]],
  ['Weekday early 04:00-14:00, 0.5 break', { date: '2026-09-22', shiftType: 'Day Shift', dayType: 'Regular Work', start: '04:00', end: '14:00', breakHours: 0.5 }, 'B', [9.5, 8, 1.5, 0]],
  ['Variant A weekday day 06:30-17:00, 0.5', { date: '2026-09-23', shiftType: 'Day Shift', start: '06:30', end: '17:00', breakHours: 0.5 }, 'A', [10, 8, 2, 0]],
  ['Variant C night starting 01:00-07:00', { date: '2026-09-23', shiftType: 'Night Shift', dayType: 'Regular Work', start: '01:00', end: '07:00', breakHours: 0 }, 'C', [6, 0, 6, 0]],
  ['Saturday night 18:00-02:00 all 2.0x', { date: '2026-09-26', shiftType: 'Night Shift', dayType: 'Regular Work', start: '18:00', end: '02:00', breakHours: 0 }, 'B', [8, 0, 0, 8]],
];

describe('calcShift (Dashpivot A/B/C)', () => {
  test.each(cases)('%s', (_name, input, variant, [t, r, o15, o20]) => {
    const res = calcShift(input, variant);
    expect([res.total, res.regular, res.ot15, res.ot20]).toEqual([t, r, o15, o20]);
  });

  test('meal allowance at 9.5h', () => {
    const meal = calcShift({ date: '2026-09-22', shiftType: 'Day Shift', dayType: 'Regular Work', start: '06:00', end: '16:00', breakHours: 0.5 }, 'B');
    expect(meal.mealAllowance).toBe(1);
  });

  test('day shift at/after 5pm warns and returns zeros', () => {
    const res = calcShift({ date: '2026-09-22', shiftType: 'Day Shift', dayType: 'Regular Work', start: '17:00', end: '22:00', breakHours: 0 }, 'B');
    expect(res.total).toBe(0);
    expect(res.warnings[0]).toMatch(/Night Shift/);
  });
});

describe('q — Excel ROUND to 0.25', () => {
  test.each([
    [7.6, 7.5], [7.625, 7.75], [7.874, 7.75], [7.875, 8], [0.12, 0], [0.125, 0.25], [8, 8], [-0.3, -0.25],
  ])('q(%p) = %p', (x, want) => { expect(q(x)).toBe(want); });
});

describe('calcPortalLine adapter', () => {
  const l = { date: '2026-09-22', shift_type: 'Day', start_time: '07:00', end_time: '17:30', total_break_hours: 0.5 };
  test('PORTAL profile returns null (legacy maths stays in charge)', () => {
    expect(calcPortalLine(l, 'PORTAL')).toBeNull();
    expect(calcPortalLine(l, '')).toBeNull();
  });
  test('B profile splits a 10h weekday into 8 + 2 at 1.5x', () => {
    const r = calcPortalLine(l, 'B');
    expect([r.total, r.regular, r.ot15, r.ot20]).toEqual([10, 8, 2, 0]);
  });
  test('non-standard scenarios (leave, training) fall back to null', () => {
    expect(calcPortalLine({ ...l, scenario: 'training_day' }, 'B')).toBeNull();
    expect(calcPortalLine({ ...l, scenario: 'annual_leave' }, 'B')).toBeNull();
  });
  test('Public Holiday shift type maps to the PH day type', () => {
    const r = calcPortalLine({ ...l, shift_type: 'Public Holiday', end_time: '15:00', total_break_hours: 0 }, 'B');
    expect(r.total).toBe(8);
  });
});
