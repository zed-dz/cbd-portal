import { pnlGroupOf, netOf, pnlByMonth, balanceSnapshot, budgetVsActual, pnlCSVRows } from './booksPnl';

const accounts = [
  { code: '200', name: 'Sales', type: 'REVENUE', class: 'REVENUE' },
  { code: '300', name: 'Subcontractors', type: 'DIRECTCOSTS', class: 'EXPENSE' },
  { code: '400', name: 'Fuel', type: 'EXPENSE', class: 'EXPENSE' },
  { code: '600', name: 'Bank', type: 'BANK', class: 'ASSET' },
];
const byCode = Object.fromEntries(accounts.map((a) => [a.code, a]));
const tx = (over) => ({ is_cash: true, status: 'AUTHORISED', direction: 'out', total: 110, gst: 10, subtotal: 100, txn_date: '2026-10-05', account_code: '400', ...over });

describe('pnlGroupOf / netOf', () => {
  it('maps chart types to P&L groups, balance-sheet accounts out, uncoded by direction', () => {
    expect(pnlGroupOf(tx({ account_code: '200' }), byCode)).toBe('REVENUE');
    expect(pnlGroupOf(tx({ account_code: '300' }), byCode)).toBe('DIRECTCOSTS');
    expect(pnlGroupOf(tx(), byCode)).toBe('EXPENSE');
    expect(pnlGroupOf(tx({ account_code: '600' }), byCode)).toBe('BALANCE');
    expect(pnlGroupOf(tx({ account_code: null, direction: 'in' }), byCode)).toBe('REVENUE');
  });
  it('net = subtotal when present, else total − gst', () => {
    expect(netOf(tx())).toBe(100);
    expect(netOf(tx({ subtotal: null, total: 220, gst: 20 }))).toBe(200);
  });
});

describe('pnlByMonth', () => {
  const rows = [
    tx({ account_code: '200', direction: 'in', total: 5500, gst: 500, subtotal: 5000, txn_date: '2026-10-03' }),
    tx({ account_code: '200', direction: 'in', total: 3300, gst: 300, subtotal: 3000, txn_date: '2026-11-03' }),
    tx({ account_code: '300', total: 2200, gst: 200, subtotal: 2000, txn_date: '2026-10-10' }),
    tx({ txn_date: '2026-10-12' }),                                                   // fuel 100
    tx({ txn_date: '2026-11-02' }),                                                   // fuel 100
    tx({ account_code: '600', txn_date: '2026-10-12', total: 9999 }),                 // transfer → ignored
    tx({ is_cash: false, account_code: '200', direction: 'in', total: 999, txn_date: '2026-10-12' }),
    tx({ status: 'DELETED', txn_date: '2026-10-12', total: 999 }),
    tx({ txn_date: '2026-09-12' }),                                                   // outside months
  ];
  const pnl = pnlByMonth(rows, accounts, ['2026-10', '2026-11']);

  it('groups in order with totals by month', () => {
    expect(pnl.groups.map((g) => g.group)).toEqual(['REVENUE', 'DIRECTCOSTS', 'EXPENSE']);
    expect(pnl.groups[0].byMonth).toEqual({ '2026-10': 5000, '2026-11': 3000 });
    expect(pnl.groups[1].total).toBe(-2000);
    expect(pnl.groups[2].byMonth).toEqual({ '2026-10': -100, '2026-11': -100 });
  });
  it('net per month and summary', () => {
    expect(pnl.net).toEqual({ '2026-10': 2900, '2026-11': 2900 });
    expect(pnl.income).toBe(8000); expect(pnl.costs).toBe(2200); expect(pnl.net_total).toBe(5800);
    expect(pnl.margin_pct).toBe(72.5);
  });
  it('accounts under each group', () => {
    expect(pnl.groups[2].accounts[0]).toMatchObject({ code: '400', name: 'Fuel', total: -200 });
  });
  it('CSV has group, account and NET rows', () => {
    const csv = pnlCSVRows(pnl);
    expect(csv[0]).toMatchObject({ Group: 'Revenue', Account: '(all)', '2026-10': '5000.00' });
    expect(csv[csv.length - 1]).toMatchObject({ Group: 'NET', Total: '5800.00' });
  });
});

describe('balanceSnapshot', () => {
  it('bank + receivables − payables − GST owing', () => {
    const s = balanceSnapshot({ bank: 10000, openItems: [{ item_type: 'ACCREC', amount_due: 4000 }, { item_type: 'ACCPAY', amount_due: 1500 }], bas: { gst_1a: 900, gst_1b: 400 } });
    expect(s).toEqual({ bank: 10000, receivables: 4000, payables: 1500, gst_owing: 500, working_capital: 12000 });
  });
  it('no bank balance → working capital null', () => {
    expect(balanceSnapshot({ bank: null, openItems: [], bas: null }).working_capital).toBeNull();
  });
});

describe('budgetVsActual', () => {
  it('compares absolute actuals to the budget per group per month', () => {
    const pnl = pnlByMonth([
      tx({ account_code: '200', direction: 'in', total: 5500, gst: 500, subtotal: 5000, txn_date: '2026-10-03' }),
      tx({ txn_date: '2026-10-12', total: 330, gst: 30, subtotal: 300 }),
    ], accounts, ['2026-10']);
    const bva = budgetVsActual(pnl, [{ account_group: 'REVENUE', month: '2026-10-01', amount: 6000 }, { account_group: 'EXPENSE', month: '2026-10-01', amount: 250 }]);
    expect(bva.find((r) => r.group === 'REVENUE').cells['2026-10']).toEqual({ budget: 6000, actual: 5000, variance: -1000 });
    expect(bva.find((r) => r.group === 'EXPENSE').cells['2026-10']).toEqual({ budget: 250, actual: 300, variance: 50 });
    expect(bva.find((r) => r.group === 'EXPENSE').is_cost).toBe(true);
  });
  it('no budget → variance null', () => {
    const pnl = pnlByMonth([tx({ txn_date: '2026-10-12' })], accounts, ['2026-10']);
    expect(budgetVsActual(pnl, [])[0].cells['2026-10'].variance).toBeNull();
  });
});
