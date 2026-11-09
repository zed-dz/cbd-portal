import { closeChecklist, closeableMonths, isMonthClosed, suggestMatches, suggestAccountCode, receiptsCSVRows, vendorToken } from './booksClose';

const tx = (over) => ({ xero_id: 'x' + Math.random().toString(36).slice(2), is_cash: true, status: 'AUTHORISED', kind: 'spend', direction: 'out', total: 110, txn_date: '2026-10-05', contact_name: 'Fuel Co', account_code: '400', account_name: 'Fuel', is_reconciled: true, ...over });

describe('closeChecklist', () => {
  it('counts every blocker for the month', () => {
    const r = closeChecklist({
      month: '2026-10',
      transactions: [tx(), tx({ account_code: null }), tx({ account_name: 'Suspense' }), tx({ is_reconciled: false }), tx({ txn_date: '2026-11-02', account_code: null }), tx({ xero_id: 'matched1' })],
      receipts: [{ receipt_date: '2026-10-06', status: 'new', total: 50 }, { receipt_date: '2026-10-06', status: 'confirmed', total: 110, matched_xero_id: 'matched1' }],
      timesheets: [{ date: '2026-10-07', status: 'submitted' }, { date: '2026-10-07', status: 'approved' }],
      headers: [{ status: 'approved', approved_at: '2026-10-20T01:00:00Z', invoiced_at: null, invoice_id: null }, { status: 'approved', approved_at: '2026-10-21T01:00:00Z', invoiced_at: '2026-10-22' }],
      invoices: [{ period_to: '2026-10-14', status: 'error' }],
    });
    const by = Object.fromEntries(r.items.map((i) => [i.key, i]));
    expect(by.uncoded.count).toBe(2);
    expect(by.unreconciled.count).toBe(1);
    expect(by.receipts_unmatched.count).toBe(1);
    expect(by.spend_no_receipt.count).toBe(4);         // 5 Oct spend lines − 1 matched
    expect(by.unapproved_ts.count).toBe(1);
    expect(by.unsent_invoices.count).toBe(1);
    expect(by.invoice_errors.count).toBe(1);
    expect(r.ready).toBe(false);
    expect(r.blocking).toBe(6);
  });
  it('a clean month is ready (soft items do not block)', () => {
    const r = closeChecklist({ month: '2026-10', transactions: [tx()], receipts: [], timesheets: [], headers: [], invoices: [] });
    expect(r.ready).toBe(true);
    expect(r.items.find((i) => i.key === 'spend_no_receipt').count).toBe(1);
  });
});

describe('closeableMonths / isMonthClosed', () => {
  const closes = [{ month: '2026-09-01', closed_at: '2026-10-02T00:00:00Z', reopened_at: null }, { month: '2026-08-01', closed_at: '2026-09-02T00:00:00Z', reopened_at: '2026-09-05T00:00:00Z' }];
  it('lists past months with cash lines, newest first, with close state', () => {
    const m = closeableMonths([tx({ txn_date: '2026-08-03' }), tx({ txn_date: '2026-09-03' }), tx({ txn_date: '2026-10-03' }), tx({ txn_date: '2026-11-03' })], closes, '2026-11-09');
    expect(m.map((x) => x.month)).toEqual(['2026-10', '2026-09', '2026-08']);
    expect(m[1].closed).toBe(true);
    expect(m[2].closed).toBe(false);     // re-opened
  });
  it('isMonthClosed', () => {
    expect(isMonthClosed('2026-09-15', closes)).toBe(true);
    expect(isMonthClosed('2026-08-15', closes)).toBe(false);
    expect(isMonthClosed('2026-10-15', closes)).toBe(false);
  });
});

describe('suggestMatches / suggestAccountCode', () => {
  const lines = [
    tx({ xero_id: 'a', total: 110, txn_date: '2026-10-05', contact_name: 'Fuel Co' }),
    tx({ xero_id: 'b', total: 111.5, txn_date: '2026-10-08', contact_name: 'Other' }),
    tx({ xero_id: 'c', total: 110, txn_date: '2026-10-20' }),                 // too far in time
    tx({ xero_id: 'd', total: 150, txn_date: '2026-10-05' }),                 // amount off
    tx({ xero_id: 'e', total: 110, txn_date: '2026-10-05', direction: 'in', kind: 'receive' }),
  ];
  it('amount ±2 %, date ±5 days, exact + vendor match first', () => {
    const m = suggestMatches({ vendor: 'Fuel Co Pty', receipt_date: '2026-10-06', total: 110 }, lines);
    expect(m.map((x) => x.xero_id)).toEqual(['a', 'b']);
    expect(m[0].vendor_hit).toBe(true);
    expect(m[1].amount_diff).toBe(1.5);
  });
  it('no total → nothing', () => { expect(suggestMatches({ total: 0 }, lines)).toEqual([]); });
  it('account code from the matched line, else the vendor history', () => {
    expect(suggestAccountCode({ vendor: 'Fuel' }, lines, lines[0])).toMatchObject({ code: '400', why: 'from the matched bank line' });
    expect(suggestAccountCode({ vendor: 'Fuel' }, [...lines, tx({ contact_name: 'Fuel Co', account_code: '401', account_name: 'Oil' })], null)).toMatchObject({ code: '400' });
    expect(suggestAccountCode({ vendor: 'Nobody' }, lines, null)).toBeNull();
  });
  it('CSV', () => {
    expect(receiptsCSVRows([{ uploaded_at: '2026-11-09T10:00:00Z', vendor: 'X', total: 1, gst: 0.09, status: 'new' }])[0]).toMatchObject({ Uploaded: '2026-11-09', Total: '1.00', GST: '0.09' });
  });
});

describe('vendorToken', () => {
  it('skips generic words and short tokens', () => {
    expect(vendorToken('DEMO FLEET FUEL PTY LTD')).toBe('fleet');
    expect(vendorToken('The Print Shop')).toBe('print');
    expect(vendorToken('BP')).toBe('bp');
    expect(vendorToken('')).toBe('');
  });
  it('a DEMO-prefixed vendor matches the right supplier, not every DEMO contact', () => {
    const lines = [
      { xero_id: 'w', is_cash: true, direction: 'out', kind: 'spend', total: 9000, txn_date: '2026-11-05', contact_name: 'DEMO - Wages', account_code: '477', account_name: 'Wages' },
      { xero_id: 'f', is_cash: true, direction: 'out', kind: 'spend', total: 249, txn_date: '2026-11-06', contact_name: 'DEMO - Fleet Fuel', account_code: '449', account_name: 'Motor Vehicle Expenses' },
    ];
    expect(suggestAccountCode({ vendor: 'DEMO FLEET FUEL PTY LTD' }, lines, null)).toMatchObject({ code: '449' });
    expect(suggestMatches({ vendor: 'DEMO FLEET FUEL PTY LTD', receipt_date: '2026-11-06', total: 249 }, lines)[0]).toMatchObject({ xero_id: 'f', vendor_hit: true });
  });
});
