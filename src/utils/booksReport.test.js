import { buildReportPackHTML } from './booksReport';

describe('buildReportPackHTML', () => {
  const html = buildReportPackHTML({
    brand: 'CBD <Plant>', month: '2026-10', today: '2026-11-09',
    pnl: { months: ['2026-09', '2026-10'], groups: [{ group: 'REVENUE', label: 'Revenue', total: 8000, byMonth: { '2026-10': 5000 }, accounts: [{ code: '200', name: 'Sales', total: 8000, byMonth: { '2026-10': 5000 } }] }], net: { '2026-10': 2900 }, net_total: 5800 },
    margin: { period: { from: '2026-09-14', to: '2026-11-09' }, totals: { shifts: 3, hours: 24, charge: 1296, pay: 1200, margin: 96, margin_pct: 7.41 }, client: [{ label: 'Acme & Co', shifts: 2, hours: 16, charge: 960, pay: 880, margin: 80, margin_pct: 8.33 }], leaks: [{ who: 'Dee', detail: 'paid more than billed' }] },
    debtors: [{ contact_name: 'Acme & Co', number: 'INV-1', due_date: '2026-10-01', amount_due: 2452.53 }],
    bas: { g1: 1000, g11: 500, gst_1a: 90.91, gst_1b: 45.45 }, quarter: { label: 'Oct–Dec 2026' },
    exceptions: [{ flag: 'missing_gst' }, { flag: 'missing_gst' }, { flag: 'duplicate' }],
    obligations: [{ label: 'BAS quarterly · Oct–Dec 2026', due: '2027-03-02', days_left: 113, amount: 45.46 }],
    forecast: { opening: 5000, total_in: 2452.53, total_out: 9000, runway_week: '2026-11-16' },
    close: { closed: false }, cashMonths: [{ month: '2026-10-01', cash_in: 7000, cash_out: 6000 }],
  });
  it('escapes the brand and names', () => {
    expect(html).toContain('CBD &lt;Plant&gt;');
    expect(html).toContain('Acme &amp; Co');
    expect(html).not.toContain('<Plant>');
  });
  it('carries every section with its figures', () => {
    expect(html).toContain('$5,000.00');          // revenue Oct
    expect(html).toContain('$2,900.00');          // net Oct
    expect(html).toContain('8.3%');               // client margin
    expect(html).toContain('39 d');               // INV-1 late by 39 days on 9 Nov
    expect(html).toContain('$45.46');             // net GST
    expect(html).toContain('02/03/2027');         // BAS due
    expect(html).toContain('missing gst');        // exceptions count label
    expect(html).toContain('below zero week of 16/11/2026');
    expect(html).toContain('$7,000.00');          // cash in tile
    expect(html).toMatch(/<title>.*Oct 26/);
  });
});
