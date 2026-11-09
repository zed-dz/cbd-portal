import { weekStart, weekLabel, shiftMarginRows, groupMargin, marginTotals, marginLeaks, marginCSVRows } from './booksMargin';

const workers = [
  { id: 'w1', name: 'Sam', worker_type: 'casual', pay_rate_regular: 40 },
  { id: 'w2', name: 'Dee', worker_type: 'casual', pay_rate_regular: 70 },   // paid more than billed
  { id: 's1', name: 'Sub Co', worker_type: 'subcontractor', pay_rate_regular: 55, pay_rate_overtime: null },
];
const clients = [
  { id: 'c1', name: 'Acme', rate_a: 60, rate_b: 85, rate_c: 100 },
  { id: 'c2', name: 'Thin', rate_a: 42, rate_b: 60, rate_c: 80 },
];
const config = { ot_threshold_daily: 7.6, geo_loading_pct: 0.10 };
const sheet = (over = {}) => ({
  id: 't1', worker_id: 'w1', client_id: 'c1', client: 'Acme', project: 'Site A', header_id: 'h1',
  date: '2026-10-14', scenario: 'standard', pay_hours: 8, charge_hours: 8, ot15_hours: 0, ot2x_hours: 0,
  travel_allowance: 0, meal_allowance: 0, role: 'Labourer', workers: { name: 'Sam' }, ...over,
});
const base = { workers, clients, rateCards: [], roleRates: [], config };

describe('weekStart / weekLabel', () => {
  it('Monday of the week, ISO', () => {
    expect(weekStart('2026-10-14')).toBe('2026-10-12');   // Wed → Mon
    expect(weekStart('2026-10-12')).toBe('2026-10-12');   // Mon stays
    expect(weekStart('2026-10-18')).toBe('2026-10-12');   // Sun → previous Mon
    expect(weekStart('')).toBe('');
  });
  it('label', () => { expect(weekLabel('2026-10-12')).toBe('Wk 12 Oct'); });
});

describe('shiftMarginRows', () => {
  it('prices one shift like Payroll: 8h × A $60 billed, 8h × $40 paid', () => {
    const rows = shiftMarginRows({ ...base, timesheets: [sheet()] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ client: 'Acme', site: 'Site A', worker: 'Sam', week: '2026-10-12', hours: 8, charge: 480, pay: 320 });
  });
  it('training day: paid casual nothing, billed nothing', () => {
    const rows = shiftMarginRows({ ...base, timesheets: [sheet({ scenario: 'training_day' })] });
    expect(rows[0].charge).toBe(0); expect(rows[0].pay).toBe(0);
  });
  it('subcontractor with no OT rate is flagged rate_missing', () => {
    const rows = shiftMarginRows({ ...base, timesheets: [sheet({ worker_id: 's1', overtime_hours: 2, pay_hours: 10, charge_hours: 10, workers: { name: 'Sub Co' } })] });
    expect(rows[0].rate_missing).toBe(true);
  });
  it('schedule-of-rates line beats the client bands', () => {
    const rateCards = [{ client_id: 'c1', role_name: 'Labourer', rate_a: 70, rate_b: 90, rate_c: 110 }];
    const rows = shiftMarginRows({ ...base, rateCards, timesheets: [sheet()] });
    expect(rows[0].charge).toBe(560); expect(rows[0].charge_source).toBe('schedule');
  });
});

describe('groupMargin', () => {
  const ts = [
    sheet(),
    sheet({ id: 't2', date: '2026-10-15', worker_id: 'w2', workers: { name: 'Dee' } }),                   // Acme, Dee: 480 billed / 560 paid
    sheet({ id: 't3', date: '2026-10-21', client_id: 'c2', client: 'Thin', project: 'Pit', pay_hours: 8, charge_hours: 8 }),  // Thin: 336 / 320
  ];
  const rows = shiftMarginRows({ ...base, timesheets: ts });

  it('by client, biggest first, margin % right', () => {
    const g = groupMargin(rows, 'client');
    expect(g.map((x) => x.key)).toEqual(['Acme', 'Thin']);
    expect(g[0]).toMatchObject({ shifts: 2, charge: 960, pay: 880, margin: 80, margin_pct: 8.33, workers: 2 });
    expect(g[1]).toMatchObject({ charge: 336, pay: 320, margin: 16, margin_pct: 4.76 });
  });
  it('by site carries the client name', () => {
    const g = groupMargin(rows, 'site');
    expect(g.find((x) => x.key === 'Thin · Pit')).toMatchObject({ client: 'Thin', shifts: 1 });
  });
  it('by worker', () => {
    const g = groupMargin(rows, 'worker');
    expect(g.find((x) => x.key === 'Dee')).toMatchObject({ charge: 480, pay: 560, margin: -80 });
    expect(g.find((x) => x.key === 'Sam').roles).toEqual(['Labourer']);
  });
  it('by week, oldest first, labelled', () => {
    const g = groupMargin(rows, 'week');
    expect(g.map((x) => x.key)).toEqual(['2026-10-12', '2026-10-19']);
    expect(g[0].label).toBe('Wk 12 Oct');
    expect(g[0].charge).toBe(960);
  });
  it('totals', () => {
    expect(marginTotals(rows)).toMatchObject({ shifts: 3, charge: 1296, pay: 1200, margin: 96, margin_pct: 7.41 });
  });
  it('CSV rows carry the dimension header', () => {
    const csv = marginCSVRows(groupMargin(rows, 'week'), 'week');
    expect(Object.keys(csv[0])[0]).toBe('Week');
    expect(csv[0]['Margin $']).toBe('80.00');
  });
});

describe('marginLeaks', () => {
  it('flags the under-floor client, the worker who costs more than billed, and paid-not-billed shifts', () => {
    const ts = [
      sheet(),
      sheet({ id: 't2', worker_id: 'w2', workers: { name: 'Dee' } }),
      sheet({ id: 't3', client_id: 'c2', client: 'Thin', project: 'Pit' }),
      sheet({ id: 't4', client_id: null, client: 'Nobody', charge_hours: 0, pay_hours: 4 }),      // paid, not billed
    ];
    const leaks = marginLeaks(shiftMarginRows({ ...base, timesheets: ts }), 15);
    const kinds = leaks.map((l) => l.kind);
    expect(kinds[0]).toBe('worker_cost_over_charge');            // worst first
    expect(leaks.find((l) => l.kind === 'worker_cost_over_charge').who).toBe('Dee');
    expect(leaks.filter((l) => l.kind === 'client_under_floor').map((l) => l.who).sort()).toEqual(['Acme', 'Thin']);
    expect(leaks.find((l) => l.kind === 'paid_not_billed')).toMatchObject({ margin: -160 });
  });
  it('a healthy book has no leaks', () => {
    const rows = shiftMarginRows({ ...base, timesheets: [sheet()] });   // 33 %
    expect(marginLeaks(rows, 15)).toEqual([]);
  });
});
