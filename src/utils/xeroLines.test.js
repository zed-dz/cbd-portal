import { buildEmployeeLines, findOvertimeRate, casualLoadingFor } from './xeroLines';

const RATES = [
  { EarningsRateID: 'ord',   Name: 'Ordinary Hours',   EarningsType: 'ORDINARYTIMEEARNINGS', RateType: 'RATEPERUNIT' },
  { EarningsRateID: 'ot15',  Name: 'Overtime 1.5x',    EarningsType: 'OVERTIMEEARNINGS',     RateType: 'MULTIPLE', Multiplier: 1.5 },
  { EarningsRateID: 'ot2',   Name: 'Overtime Double',  EarningsType: 'OVERTIMEEARNINGS',     RateType: 'MULTIPLE', Multiplier: 2 },
  { EarningsRateID: 'load',  Name: 'Casual Loading',   EarningsType: 'ORDINARYTIMEEARNINGS', RateType: 'RATEPERUNIT' },
];
const TEMPLATE = [{ EarningsRateID: 'ord', NumberOfUnits: 0, RatePerUnit: 40 }];

describe('findOvertimeRate', () => {
  it('matches by multiplier first', () => {
    expect(findOvertimeRate(RATES, 1.5).EarningsRateID).toBe('ot15');
    expect(findOvertimeRate(RATES, 2).EarningsRateID).toBe('ot2');
  });
  it('falls back to names: "Overtime" + "1.5" / "2" or "Double"', () => {
    const byName = [
      { EarningsRateID: 'a', Name: 'Overtime (1.5)', EarningsType: 'OVERTIMEEARNINGS' },
      { EarningsRateID: 'b', Name: 'Overtime 2x',   EarningsType: 'OVERTIMEEARNINGS' },
    ];
    expect(findOvertimeRate(byName, 1.5).EarningsRateID).toBe('a');
    expect(findOvertimeRate(byName, 2).EarningsRateID).toBe('b');
  });
  it('a lone "Overtime" item carries 1.5x; nothing carries 2x', () => {
    const one = [{ EarningsRateID: 'x', Name: 'Overtime', EarningsType: 'OVERTIMEEARNINGS' }];
    expect(findOvertimeRate(one, 1.5).EarningsRateID).toBe('x');
    expect(findOvertimeRate(one, 2)).toBeNull();
  });
});

describe('buildEmployeeLines — full-timer', () => {
  it('splits ordinary / 1.5x / 2x onto their own pay items', () => {
    const { lines, summary, ok } = buildEmployeeLines({
      totals: { ordinary: 38, ot15: 3, ot2x: 1.5, unsplit: 0 },
      worker: { worker_type: 'full-time', pay_rate_regular: 40 },
      earningsRates: RATES, templateLines: TEMPLATE,
    });
    expect(ok).toBe(true);
    expect(lines.find(l => l.EarningsRateID === 'ord').NumberOfUnits).toBe(38);
    expect(lines.find(l => l.EarningsRateID === 'ot15').NumberOfUnits).toBe(3);
    expect(lines.find(l => l.EarningsRateID === 'ot2').NumberOfUnits).toBe(1.5);
    expect(summary).toMatchObject({ ordinary: 38, ot15: 3, ot2: 1.5, loading: 0, warnings: [] });
    expect(summary.pay_items_used).toEqual(['Ordinary Hours', 'Overtime 1.5x', 'Overtime Double']);
    // Full-timer: ordinary RatePerUnit untouched (template decides).
    expect(lines[0].RatePerUnit).toBe(40);
  });

  it('folds OT into ordinary (and warns) when Xero has no overtime item', () => {
    const { lines, summary } = buildEmployeeLines({
      totals: { ordinary: 38, ot15: 2, ot2x: 0, unsplit: 0 },
      worker: { worker_type: 'full-time' },
      earningsRates: [RATES[0]], templateLines: TEMPLATE,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].NumberOfUnits).toBe(40);
    expect(summary.ordinary).toBe(40);
    expect(summary.ot15).toBe(0);
    expect(summary.warnings[0]).toMatch(/folded into ordinary/);
  });

  it('legacy unsplit overtime goes to the 1.5x item', () => {
    const { summary } = buildEmployeeLines({
      totals: { ordinary: 8, ot15: 0, ot2x: 0, unsplit: 2 },
      worker: { worker_type: 'full-time' },
      earningsRates: RATES, templateLines: TEMPLATE,
    });
    expect(summary.ot15).toBe(2);
  });

  it('reports a bad template (no lines) instead of pushing', () => {
    const r = buildEmployeeLines({ totals: { ordinary: 8 }, worker: {}, earningsRates: RATES, templateLines: [] });
    expect(r.ok).toBe(false);
    expect(r.summary.warnings[0]).toMatch(/no earnings lines/);
  });
});

describe('buildEmployeeLines — casual loading', () => {
  const casual = { worker_type: 'casual', pay_rate_regular: 50, pay_rate_base: 40, casual_loading_pct: 0.25 };

  it('sends ordinary at the BASE rate plus a 25% Casual Loading line', () => {
    const { lines, summary } = buildEmployeeLines({
      totals: { ordinary: 20, ot15: 2, ot2x: 0, unsplit: 0 },
      worker: casual, earningsRates: RATES, templateLines: TEMPLATE,
    });
    const ord = lines.find(l => l.EarningsRateID === 'ord');
    const load = lines.find(l => l.EarningsRateID === 'load');
    expect(ord).toMatchObject({ NumberOfUnits: 20, RatePerUnit: 40 });
    expect(load).toMatchObject({ NumberOfUnits: 20, RatePerUnit: 10 });   // 40 × 25%
    expect(summary).toMatchObject({ ordinary: 20, ot15: 2, loading: 20 });
    expect(summary.pay_items_used).toContain('Casual Loading');
    expect(summary.warnings).toEqual([]);
  });

  it('reads a whole-number percentage (25) the same as 0.25', () => {
    expect(casualLoadingFor({ ...casual, casual_loading_pct: 25 })).toEqual({ base: 40, pct: 0.25 });
  });

  it('falls back to rate A and says so when Xero has no Casual Loading item', () => {
    const noLoad = RATES.filter(r => r.EarningsRateID !== 'load');
    const { lines, summary } = buildEmployeeLines({
      totals: { ordinary: 20, ot15: 0, ot2x: 0, unsplit: 0 },
      worker: casual, earningsRates: noLoad, templateLines: TEMPLATE,
    });
    expect(lines.find(l => l.EarningsRateID === 'ord')).toMatchObject({ NumberOfUnits: 20, RatePerUnit: 50 });
    expect(lines.find(l => l.EarningsRateID === 'load')).toBeUndefined();
    expect(summary.loading).toBe(0);
    expect(summary.warnings[0]).toMatch(/no "Casual Loading" pay item/);
  });

  it('a casual without a base rate is pushed like everyone else', () => {
    const { lines, summary } = buildEmployeeLines({
      totals: { ordinary: 10 }, worker: { worker_type: 'casual', pay_rate_regular: 50 },
      earningsRates: RATES, templateLines: TEMPLATE,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].RatePerUnit).toBe(40);   // template untouched
    expect(summary.loading).toBe(0);
  });
});
