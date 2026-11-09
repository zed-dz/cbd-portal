import {
  fmtMoney, daysOverdue, ageingBucket, ageingTotals, duplicateKey, findDuplicates,
  monthKey, groupByMonth, monthLabel, basQuarter, monthOptions, monthBounds, isOurs,
} from './books';

const TODAY = '2026-11-09';

describe('ageing', () => {
  it('days overdue is positive after the due date, negative before', () => {
    expect(daysOverdue('2026-11-01', TODAY)).toBe(8);
    expect(daysOverdue('2026-11-20', TODAY)).toBe(-11);
    expect(daysOverdue(null, TODAY)).toBe(0);
  });
  it('buckets follow current / 1-30 / 31-60 / 61-90 / 90+', () => {
    expect(ageingBucket('2026-11-09', TODAY)).toBe('current');   // due today
    expect(ageingBucket('2026-12-01', TODAY)).toBe('current');   // not yet due
    expect(ageingBucket(null, TODAY)).toBe('current');
    expect(ageingBucket('2026-11-08', TODAY)).toBe('1-30');
    expect(ageingBucket('2026-10-10', TODAY)).toBe('1-30');      // 30 days
    expect(ageingBucket('2026-10-09', TODAY)).toBe('31-60');     // 31 days
    expect(ageingBucket('2026-09-10', TODAY)).toBe('31-60');     // 60
    expect(ageingBucket('2026-09-09', TODAY)).toBe('61-90');     // 61
    expect(ageingBucket('2026-08-11', TODAY)).toBe('61-90');     // 90
    expect(ageingBucket('2026-08-10', TODAY)).toBe('90+');       // 91
  });
  it('totals sum amount_due per bucket and skip paid items', () => {
    const t = ageingTotals([
      { due_date: '2026-11-20', amount_due: 100 },
      { due_date: '2026-11-01', amount_due: 50.5 },
      { due_date: '2026-10-01', amount_due: 20 },
      { due_date: '2026-01-01', amount_due: 0 },     // nothing owing
    ], TODAY);
    expect(t.current).toEqual({ amount: 100, count: 1 });
    expect(t['1-30']).toEqual({ amount: 50.5, count: 1 });
    expect(t['31-60']).toEqual({ amount: 20, count: 1 });
    expect(t['90+']).toEqual({ amount: 0, count: 0 });
  });
});

describe('duplicates', () => {
  const base = { contact_id: 'c1', total: 1100, kind: 'invoice_payment', txn_date: '2026-11-02' };
  it('same contact + amount + number is one key', () => {
    expect(duplicateKey({ ...base, invoice_number: 'INV-100' })).toBe(duplicateKey({ ...base, invoice_number: 'inv-100', txn_date: '2026-10-01' }));
  });
  it('different numbers are NOT duplicates even in the same week (audit fix #8)', () => {
    const groups = findDuplicates([
      { ...base, invoice_number: 'INV-100' },
      { ...base, invoice_number: 'INV-101', txn_date: '2026-11-03' },
    ]);
    expect(groups).toHaveLength(0);
  });
  it('blank number + reference falls back to contact + amount within 3 days', () => {
    expect(findDuplicates([
      { ...base, invoice_number: null, reference: '', txn_date: '2026-11-03' },
      { ...base, invoice_number: null, reference: null, txn_date: '2026-11-04' },
    ])).toHaveLength(1);
    expect(findDuplicates([
      { ...base, invoice_number: null, reference: '', txn_date: '2026-11-03' },
      { ...base, invoice_number: null, reference: null, txn_date: '2026-11-20' },
    ])).toHaveLength(0);
  });
  it('a reference counts as a number', () => {
    expect(findDuplicates([
      { ...base, reference: 'REF-1' }, { ...base, reference: 'REF-1' },
    ])).toHaveLength(1);
  });
});

describe('months', () => {
  it('monthKey and labels', () => {
    expect(monthKey('2026-11-09')).toBe('2026-11');
    expect(monthKey(null)).toBe('');
    expect(monthLabel('2026-11')).toBe('Nov 26');
  });
  it('groups cash by month, in vs out, oldest first', () => {
    const g = groupByMonth([
      { txn_date: '2026-11-02', direction: 'in', total: 100 },
      { txn_date: '2026-11-15', direction: 'out', total: 40.25 },
      { txn_date: '2026-10-02', direction: 'in', total: 10 },
    ]);
    expect(g.map((x) => x.month)).toEqual(['2026-10', '2026-11']);
    expect(g[1]).toEqual({ month: '2026-11', cash_in: 100, cash_out: 40.25, net: 59.75 });
  });
  it('BAS quarter that contains today', () => {
    expect(basQuarter('2026-11-09')).toEqual({ from: '2026-10-01', to: '2026-12-31', label: 'Oct–Dec 2026' });
    expect(basQuarter('2026-02-28')).toEqual({ from: '2026-01-01', to: '2026-03-31', label: 'Jan–Mar 2026' });
    expect(basQuarter('2026-09-30').to).toBe('2026-09-30');
  });
  it('month picker options count back from today; bounds cover the whole month', () => {
    const o = monthOptions('2026-01-15', 3);
    expect(o.map((x) => x.value)).toEqual(['2026-01', '2025-12', '2025-11']);
    expect(monthBounds('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });
});

describe('money + ours', () => {
  it('formats with brackets for refunds and a dash for nothing', () => {
    expect(fmtMoney(1234.5)).toBe('$1,234.50');
    expect(fmtMoney(-20)).toBe('($20.00)');
    expect(fmtMoney(null)).toBe('—');
  });
  it('matches a Xero number to the portal invoice set case-insensitively', () => {
    const ours = new Set(['inv-0042']);
    expect(isOurs('INV-0042', ours)).toBe(true);
    expect(isOurs('INV-0043', ours)).toBe(false);
    expect(isOurs('', ours)).toBe(false);
  });
});
