import { overlapDays, collectedInPeriod } from './partnerAuto';

describe('collected revenue in a period', () => {
  test('overlap days inclusive', () => {
    expect(overlapDays('2026-02-01', '2026-02-28', '2026-02-01', '2026-02-28')).toBe(28);
    expect(overlapDays('2026-01-20', '2026-02-05', '2026-02-01', '2026-02-28')).toBe(5);
    expect(overlapDays('2026-03-01', '2026-03-10', '2026-02-01', '2026-02-28')).toBe(0);
  });
  test('only paid amounts count; straddling invoices are pro-rated by days', () => {
    const invoices = [
      { id: 'a', period_from: '2026-02-01', period_to: '2026-02-28', amount_paid: 1000, total: 1000 },
      { id: 'b', period_from: '2026-02-15', period_to: '2026-03-16', amount_paid: 3000, total: 3000 }, // 30 days, 14 inside
      { id: 'c', period_from: '2026-02-01', period_to: '2026-02-28', amount_paid: 0, total: 500 },     // billed, unpaid
    ];
    const r = collectedInPeriod(invoices, '2026-02-01', '2026-02-28');
    expect(r.collected).toBe(2400);
    expect(r.invoices.map(i => i.id)).toEqual(['a', 'b']);
  });
});
