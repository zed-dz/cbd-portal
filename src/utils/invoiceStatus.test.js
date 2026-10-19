import {
  isOverdue, invoiceChip, invoiceAmounts, invoiceTotals, matchesFilter,
  parseXeroDate, fmtISODate, daysBetween, sydneyTodayISO, CHIP_COLORS,
} from './invoiceStatus';

const TODAY = '2026-10-20';
const xero = (o) => ({ xero_invoice_id: 'abc', ...o });

describe('isOverdue', () => {
  it('AUTHORISED + owing + due before today = overdue', () => {
    expect(isOverdue('AUTHORISED', '2026-10-19', 100, TODAY)).toBe(true);
  });
  it('due today is not overdue yet', () => {
    expect(isOverdue('AUTHORISED', '2026-10-20', 100, TODAY)).toBe(false);
  });
  it('nothing owing is never overdue', () => {
    expect(isOverdue('AUTHORISED', '2026-10-01', 0, TODAY)).toBe(false);
  });
  it('not yet synced (amount_due null) still counts as owing', () => {
    expect(isOverdue('AUTHORISED', '2026-10-01', null, TODAY)).toBe(true);
  });
  it('only AUTHORISED can be overdue', () => {
    for (const s of ['DRAFT', 'SUBMITTED', 'PAID', 'VOIDED', 'DELETED', '', null]) {
      expect(isOverdue(s, '2026-10-01', 100, TODAY)).toBe(false);
    }
  });
  it('is case-insensitive and ignores a time part', () => {
    expect(isOverdue('authorised', '2026-10-19T00:00:00', '50.00', TODAY)).toBe(true);
  });
  it('no due date → not overdue', () => {
    expect(isOverdue('AUTHORISED', null, 100, TODAY)).toBe(false);
  });
});

describe('invoiceChip', () => {
  it('Draft', () => {
    const c = invoiceChip(xero({ xero_status: 'DRAFT' }), TODAY);
    expect(c.key).toBe('draft'); expect(c.label).toBe('Draft'); expect(c.color).toBe(CHIP_COLORS.draft);
  });
  it('no status yet on a Xero row reads as Draft', () => {
    expect(invoiceChip(xero({ xero_status: null }), TODAY).label).toBe('Draft');
  });
  it('Submitted = awaiting approval (still draft bucket)', () => {
    const c = invoiceChip(xero({ xero_status: 'SUBMITTED' }), TODAY);
    expect(c.key).toBe('draft'); expect(c.label).toBe('Awaiting approval');
  });
  it('Awaiting payment when authorised and not yet due', () => {
    const c = invoiceChip(xero({ xero_status: 'AUTHORISED', due_date: '2026-11-01', amount_due: 500, amount_paid: 0 }), TODAY);
    expect(c.key).toBe('awaiting'); expect(c.label).toBe('Awaiting payment'); expect(c.title).toBe('Due 01/11/2026');
  });
  it('Part paid when some money came in', () => {
    const c = invoiceChip(xero({ xero_status: 'AUTHORISED', due_date: '2026-11-01', amount_due: 200, amount_paid: 300 }), TODAY);
    expect(c.key).toBe('awaiting'); expect(c.label).toBe('Part paid');
  });
  it('Overdue with days late in the tooltip', () => {
    const c = invoiceChip(xero({ xero_status: 'AUTHORISED', due_date: '2026-10-17', amount_due: 500 }), TODAY);
    expect(c.key).toBe('overdue'); expect(c.label).toBe('Overdue'); expect(c.color).toBe(CHIP_COLORS.overdue);
    expect(c.title).toBe('Due 17/10/2026 — 3 days late.');
  });
  it('1 day late is singular', () => {
    expect(invoiceChip(xero({ xero_status: 'AUTHORISED', due_date: '2026-10-19', amount_due: 5 }), TODAY).title).toMatch(/1 day late/);
  });
  it('Paid with the date', () => {
    const c = invoiceChip(xero({ xero_status: 'PAID', fully_paid_on: '2026-10-18' }), TODAY);
    expect(c.key).toBe('paid'); expect(c.label).toBe('Paid 18/10/2026');
  });
  it('Paid without a date', () => {
    expect(invoiceChip(xero({ xero_status: 'PAID' }), TODAY).label).toBe('Paid');
  });
  it('Voided / Deleted', () => {
    expect(invoiceChip(xero({ xero_status: 'VOIDED' }), TODAY)).toMatchObject({ key: 'voided', label: 'Voided' });
    expect(invoiceChip(xero({ xero_status: 'DELETED' }), TODAY)).toMatchObject({ key: 'voided', label: 'Deleted' });
  });
  it('a paid invoice past its due date is still Paid', () => {
    expect(invoiceChip(xero({ xero_status: 'PAID', due_date: '2026-01-01', amount_due: 0 }), TODAY).key).toBe('paid');
  });
  it('non-Xero rows: failed Stripe row', () => {
    const c = invoiceChip({ xero_invoice_id: null, status: 'error', error: 'no key' }, TODAY);
    expect(c.key).toBe('failed'); expect(c.label).toBe('Failed'); expect(c.title).toBe('no key');
  });
  it('unknown Xero status falls through, title-cased', () => {
    expect(invoiceChip(xero({ xero_status: 'WEIRD' }), TODAY)).toMatchObject({ key: 'other', label: 'Weird' });
  });
});

describe('invoiceAmounts', () => {
  it('prefers Xero figures once synced', () => {
    expect(invoiceAmounts({ amount_cents: 10000, total: 110, amount_paid: 10, amount_due: 100 }))
      .toEqual({ total: 110, paid: 10, due: 100, synced: true });
  });
  it('falls back to the portal ex-GST total before the first sync', () => {
    expect(invoiceAmounts(xero({ amount_cents: 12345, xero_status: 'DRAFT' })))
      .toEqual({ total: 123.45, paid: 0, due: 123.45, synced: false });
  });
  it('a closed invoice owes nothing even if never synced', () => {
    expect(invoiceAmounts(xero({ amount_cents: 5000, xero_status: 'VOIDED' })).due).toBe(0);
  });
  it('a row that never reached Xero has no tracked balance', () => {
    expect(invoiceAmounts({ amount_cents: 5000, status: 'error' })).toEqual({ total: 50, paid: 0, due: null, synced: false });
  });
});

describe('filters + totals', () => {
  const rows = [
    xero({ id: 1, xero_status: 'AUTHORISED', due_date: '2026-10-01', amount_due: 100, total: 100 }),  // overdue
    xero({ id: 2, xero_status: 'AUTHORISED', due_date: '2026-12-01', amount_due: 250.5, total: 300, amount_paid: 49.5 }), // part paid
    xero({ id: 3, xero_status: 'PAID', amount_due: 0, total: 80 }),
    xero({ id: 4, xero_status: 'DRAFT', amount_cents: 9900 }),
    xero({ id: 5, xero_status: 'VOIDED', total: 10 }),
    { id: 6, status: 'error' },
  ];
  it('Unpaid = awaiting + overdue', () => {
    expect(rows.filter(r => matchesFilter(r, 'unpaid', TODAY)).map(r => r.id)).toEqual([1, 2]);
  });
  it('Overdue / Paid / All', () => {
    expect(rows.filter(r => matchesFilter(r, 'overdue', TODAY)).map(r => r.id)).toEqual([1]);
    expect(rows.filter(r => matchesFilter(r, 'paid', TODAY)).map(r => r.id)).toEqual([3]);
    expect(rows.filter(r => matchesFilter(r, 'all', TODAY))).toHaveLength(6);
  });
  it('totals: outstanding includes overdue; drafts and voids never count', () => {
    expect(invoiceTotals(rows, TODAY)).toEqual({ outstanding: 350.5, overdue: 100, unpaidCount: 2, overdueCount: 1 });
  });
  it('empty list', () => {
    expect(invoiceTotals([], TODAY)).toEqual({ outstanding: 0, overdue: 0, unpaidCount: 0, overdueCount: 0 });
  });
});

describe('date helpers', () => {
  it('parseXeroDate handles /Date()/ and ISO strings', () => {
    expect(parseXeroDate('/Date(1760832000000+0000)/')).toBe('2025-10-19');
    expect(parseXeroDate('2026-10-19T00:00:00')).toBe('2026-10-19');
    expect(parseXeroDate(null)).toBeNull();
    expect(parseXeroDate('junk')).toBeNull();
  });
  it('fmtISODate', () => {
    expect(fmtISODate('2026-03-04')).toBe('04/03/2026');
    expect(fmtISODate('')).toBe('');
  });
  it('daysBetween', () => {
    expect(daysBetween('2026-10-01', '2026-10-20')).toBe(19);
    expect(daysBetween('2026-10-20', '2026-10-01')).toBe(-19);
  });
  it('sydneyTodayISO uses the Sydney calendar date', () => {
    // 2026-10-19 20:00 UTC = 2026-10-20 07:00 in Sydney (AEDT)
    expect(sydneyTodayISO(new Date('2026-10-19T20:00:00Z'))).toBe('2026-10-20');
  });
});
