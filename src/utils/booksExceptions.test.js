import { missingGst, roundDollar, outOfHours, newVendors, spendSpikes, invoicesWithoutHours, exceptionsV2, exceptionsCSVRows } from './booksExceptions';

const TODAY = '2026-11-09';
const tx = (over) => ({ xero_id: Math.random().toString(36).slice(2), is_cash: true, status: 'AUTHORISED', kind: 'spend', direction: 'out', total: 110, gst: 10, tax_type: 'INPUT', txn_date: '2026-11-03', contact_name: 'Fuel Co', account_code: '400', account_name: 'Fuel', ...over });

describe('missingGst', () => {
  it('taxable line with $0 GST is flagged; GST-free and tiny lines are not', () => {
    const r = missingGst([tx({ gst: 0 }), tx({ gst: 10 }), tx({ gst: 0, tax_type: 'EXEMPTEXPENSES' }), tx({ gst: 0, total: 0.5 }), tx({ gst: 0, is_cash: false })]);
    expect(r).toHaveLength(1);
    expect(r[0].reason).toMatch(/expected about \$10.00/);
  });
});

describe('roundDollar', () => {
  it('direct spend of $1,000+ in exact hundreds; bill payments are normally round and are skipped', () => {
    const r = roundDollar([tx({ total: 1500 }), tx({ total: 1500.5 }), tx({ total: 800 }), tx({ total: 2000, kind: 'receive', direction: 'in' }), tx({ total: 3000, kind: 'bill_payment' })]);
    expect(r).toHaveLength(1); expect(r[0].amount).toBe(1500);
  });
});

describe('outOfHours', () => {
  it('weekend spend only', () => {
    const r = outOfHours([tx({ txn_date: '2026-11-07' }), tx({ txn_date: '2026-11-08' }), tx({ txn_date: '2026-11-09' }), tx({ txn_date: '2026-11-08', kind: 'bill_payment' })]);
    expect(r.map((x) => x.reason)).toEqual(['Spent on a Saturday', 'Spent on a Sunday']);
  });
});

describe('newVendors', () => {
  it('first appearance inside the last 30 days, once per vendor', () => {
    const r = newVendors([
      tx({ contact_name: 'Old Co', txn_date: '2026-06-01' }), tx({ contact_name: 'Old Co', txn_date: '2026-11-01' }),
      tx({ contact_name: 'Fresh Pty', txn_date: '2026-11-02' }), tx({ contact_name: 'fresh pty', txn_date: '2026-11-05' }),
    ], TODAY);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ contact_name: 'Fresh Pty', txn_date: '2026-11-02' });
  });
});

describe('spendSpikes', () => {
  it('this month > 2× the 3-month average per account', () => {
    const r = spendSpikes([
      tx({ txn_date: '2026-08-10', total: 1000 }), tx({ txn_date: '2026-09-10', total: 1000 }), tx({ txn_date: '2026-10-10', total: 1000 }),
      tx({ txn_date: '2026-11-03', total: 2500 }),                                                   // 2.5× → spike
      tx({ account_code: '500', account_name: 'Rent', txn_date: '2026-10-01', total: 3000 }), tx({ account_code: '500', account_name: 'Rent', txn_date: '2026-11-01', total: 3000 }),   // steady
    ], TODAY);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ flag: 'spend_spike', contact_name: '400 Fuel', amount: 2500 });
    expect(r[0].reason).toMatch(/×2.5/);
  });
  it('nothing when there is no history or under the minimum', () => {
    expect(spendSpikes([tx({ txn_date: '2026-11-03', total: 2500 })], TODAY)).toEqual([]);
    expect(spendSpikes([tx({ txn_date: '2026-10-03', total: 10 }), tx({ txn_date: '2026-11-03', total: 100 })], TODAY)).toEqual([]);
  });
});

describe('invoicesWithoutHours', () => {
  const invs = [
    { id: 'i1', client: 'Acme', client_id: 'c1', period_from: '2026-10-01', period_to: '2026-10-07', total: 4400, xero_invoice_number: 'INV-1' },
    { id: 'i2', client: 'Acme', client_id: 'c1', period_from: '2026-10-08', period_to: '2026-10-14', amount_cents: 220000 },
    { id: 'i3', client: 'Legacy', client_id: null, period_from: '2026-10-01', period_to: '2026-10-07', total: 100 },
  ];
  const ts = [{ client_id: 'c1', client: 'Acme', date: '2026-10-03', charge_hours: 8 }, { client_id: null, client: 'Legacy', date: '2026-10-03', charge_hours: 4 }];
  it('flags the invoice whose period has no hours', () => {
    const r = invoicesWithoutHours(invs, ts);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ flag: 'invoice_no_hours', xero_id: 'i2', amount: 2200, contact_name: 'Acme' });
  });
});

describe('exceptionsV2 / CSV', () => {
  it('combines all six and exports', () => {
    const list = exceptionsV2({ transactions: [tx({ gst: 0 })], invoices: [], timesheets: [], today: TODAY });
    expect(list.map((e) => e.flag)).toContain('missing_gst');
    expect(exceptionsCSVRows(list)[0]).toMatchObject({ Flag: 'missing_gst', Amount: '110.00' });
  });
});
