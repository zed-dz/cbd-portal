import {
  rollForwardBalance, daysLateByContact, expectedReceiptDate, weeklyPayroll, recurringBills, buildForecast, forecastPolyline, forecastCSVRows,
} from './booksForecast';

const TODAY = '2026-11-09';   // Monday
const cash = (over) => ({ is_cash: true, direction: 'out', total: 100, txn_date: '2026-11-02', contact_name: 'Fuel Co', ...over });

describe('rollForwardBalance', () => {
  it('adds money in and subtracts money out after the balance date, ignores rows on/before it and after today', () => {
    const tx = [
      cash({ direction: 'in', total: 500, txn_date: '2026-11-03' }),
      cash({ direction: 'out', total: 120, txn_date: '2026-11-05' }),
      cash({ direction: 'out', total: 999, txn_date: '2026-11-01' }),   // on the balance date → already in the balance
      cash({ direction: 'in', total: 999, txn_date: '2026-11-20' }),    // future
      cash({ direction: 'in', total: 999, txn_date: '2026-11-04', is_cash: false }),
    ];
    expect(rollForwardBalance(10000, '2026-11-01', tx, TODAY)).toBe(10380);
  });
  it('no typed balance → null', () => { expect(rollForwardBalance(null, '2026-11-01', [], TODAY)).toBeNull(); });
});

describe('daysLateByContact / expectedReceiptDate', () => {
  it('median days late per contact', () => {
    const m = daysLateByContact([
      { contact: 'Acme', due_date: '2026-09-01', paid_date: '2026-09-11' },
      { contact: 'Acme', due_date: '2026-10-01', paid_date: '2026-10-21' },
      { contact: 'Acme', due_date: '2026-10-15', paid_date: '2026-10-29' },
      { contact: 'Fast', due_date: '2026-10-01', paid_date: '2026-09-28' },
    ]);
    expect(m.get('Acme')).toBe(14);
    expect(m.get('Fast')).toBe(-3);
  });
  it('receipt lands at due + days late; early payers at due; overdue with no history → next week', () => {
    const m = new Map([['Acme', 14], ['Fast', -3]]);
    expect(expectedReceiptDate({ contact_name: 'Acme', due_date: '2026-11-20' }, m, TODAY)).toBe('2026-12-04');
    expect(expectedReceiptDate({ contact_name: 'Fast', due_date: '2026-11-20' }, m, TODAY)).toBe('2026-11-20');
    expect(expectedReceiptDate({ contact_name: 'New', due_date: '2026-10-01' }, m, TODAY)).toBe('2026-11-16');
    expect(expectedReceiptDate({ contact_name: 'New', due_date: '2026-11-20' }, m, TODAY)).toBe('2026-11-27');   // default 7 days late
  });
});

describe('weeklyPayroll', () => {
  it('median weekly wage payment over the last 8 weeks', () => {
    const tx = [
      cash({ contact_name: 'Wages', total: 9000, txn_date: '2026-10-15' }),
      cash({ contact_name: 'Wages', total: 9500, txn_date: '2026-10-22' }),
      cash({ contact_name: 'Wages', total: 12000, txn_date: '2026-10-29' }),
      cash({ contact_name: 'Wages', total: 9000, txn_date: '2026-11-05' }),
      cash({ contact_name: 'Wages', total: 50000, txn_date: '2026-06-01' }),   // too old
      cash({ contact_name: 'Fuel Co', total: 400, txn_date: '2026-11-05' }),
    ];
    expect(weeklyPayroll(tx, TODAY)).toEqual({ weekly: 9250, source: 'bank', weeks: 4 });
  });
  it('falls back to the timesheet figure', () => {
    expect(weeklyPayroll([], TODAY, 7000)).toEqual({ weekly: 7000, source: 'timesheets', weeks: 0 });
  });
});

describe('recurringBills', () => {
  it('finds a monthly supplier and projects it into the horizon', () => {
    const tx = ['2026-07-15', '2026-08-14', '2026-09-15', '2026-10-15'].map((d) => cash({ contact_name: 'Telco', total: 210, txn_date: d }));
    const r = recurringBills(tx, TODAY);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: 'Telco', cadence: 30, amount: 210 });
    expect(r[0].occurrences[0]).toBe('2026-11-14');
    expect(r[0].occurrences.length).toBeGreaterThanOrEqual(3);
  });
  it('ignores irregular suppliers, wages and one-offs', () => {
    const tx = [
      ...['2026-08-01', '2026-08-04', '2026-10-30'].map((d) => cash({ contact_name: 'Random', total: 100, txn_date: d })),
      ...['2026-09-03', '2026-10-01', '2026-10-29'].map((d) => cash({ contact_name: 'Wages', total: 9000, txn_date: d })),
      ...['2026-09-03', '2026-10-01', '2026-10-29'].map((d, i) => cash({ contact_name: 'Jumpy', total: [100, 900, 100][i], txn_date: d })),
    ];
    expect(recurringBills(tx, TODAY)).toEqual([]);
  });
  it('weekly cadence', () => {
    const tx = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02'].map((d) => cash({ contact_name: 'Hire Co', total: 1500, txn_date: d }));
    expect(recurringBills(tx, TODAY)[0]).toMatchObject({ cadence: 7, amount: 1500 });
  });
});

describe('buildForecast', () => {
  it('13 weeks, receipts in the right week, payroll every week, runway when it goes negative', () => {
    const fc = buildForecast({
      today: TODAY, opening: 5000,
      openItems: [{ contact_name: 'Acme', number: 'INV-1', due_date: '2026-11-13', amount_due: 20000 }],
      lateMap: new Map([['Acme', 10]]),                                   // lands 23 Nov → week of 23 Nov (index 2)
      payroll: { weekly: 9000 },
      bills: [{ name: 'Telco', amount: 210, occurrences: ['2026-11-14'] }],
      obligations: [{ due: '2026-11-23', amount: 1200, type: 'super', label: 'Super' }],
    });
    expect(fc.weeks).toHaveLength(13);
    expect(fc.weeks[0]).toMatchObject({ week: '2026-11-09', opening: 5000, receipts: 0, payroll: 9000, bills: 210, out: 9210, closing: -4210 });
    expect(fc.weeks[2]).toMatchObject({ week: '2026-11-23', receipts: 20000, ato: 1200 });
    expect(fc.runway_week).toBe('2026-11-09');
    expect(fc.total_in).toBe(20000);
    expect(fc.lowest.closing).toBeLessThan(0);
    expect(fc.weeks[12].week).toBe('2027-02-01');
  });
  it('no opening balance → closings null, still shows flows', () => {
    const fc = buildForecast({ today: TODAY, opening: null, openItems: [], payroll: { weekly: 100 } });
    expect(fc.weeks[0].closing).toBeNull();
    expect(fc.weeks[0].out).toBe(100);
    expect(fc.runway_week).toBeNull();
  });
  it('polyline and CSV', () => {
    const fc = buildForecast({ today: TODAY, opening: 1000, payroll: { weekly: 100 } });
    const pl = forecastPolyline(fc.weeks, 320, 120);
    expect(pl.points.split(' ')).toHaveLength(13);
    expect(pl.max).toBe(900);
    expect(forecastCSVRows(fc)[0]).toMatchObject({ 'Week': '2026-11-09', 'Closing $': '900.00' });
  });
});
