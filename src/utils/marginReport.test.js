import { buildMarginReport, marginReportCSVRows } from './marginReport';

const workers = [{ id: 'w1', name: 'Sam', worker_type: 'casual', pay_rate_regular: 40 }];
const clients = [{ id: 'c1', name: 'Acme', rate_a: 60, rate_b: 85, rate_c: 100 }];
const config = { ot_threshold_daily: 7.6, geo_loading_pct: 0.10, travel_allowance_casual: 15 };

const sheet = (over = {}) => ({
  id: 't1', worker_id: 'w1', client_id: 'c1', client: 'Acme', project: 'Site A', header_id: 'h1',
  date: '2026-10-14', scenario: 'standard', pay_hours: 8, charge_hours: 8, ot15_hours: 0, ot2x_hours: 0,
  travel_allowance: 0, meal_allowance: 0, workers: { name: 'Sam' }, ...over,
});

describe('buildMarginReport', () => {
  it('charge, pay and margin per client and per site', () => {
    const r = buildMarginReport({ timesheets: [sheet()], workers, clients, rateCards: [], roleRates: [], config, plantRows: [] });
    expect(r.clients).toHaveLength(1);
    const c = r.clients[0];
    expect(c.client).toBe('Acme');
    expect(c.hours).toBe(8);
    expect(c.charge).toBe(480);      // 8h × A $60
    expect(c.pay).toBe(320);         // 8h × $40
    expect(c.margin).toBe(160);
    expect(c.margin_pct).toBe(33.33);
    expect(c.sites[0]).toMatchObject({ site: 'Site A', hours: 8, charge: 480, pay: 320 });
    expect(r.totals.billable).toBe(480);
  });

  it('plant hours join the site of their sheet and count in the margin', () => {
    const plantRows = [{ header_id: 'h1', hours: 4, plant_items: { name: 'Dozer', hourly_charge: 150 } }];
    const r = buildMarginReport({ timesheets: [sheet()], workers, clients, rateCards: [], roleRates: [], config, plantRows });
    const c = r.clients[0];
    expect(c.plant_hours).toBe(4);
    expect(c.plant_charge).toBe(600);
    expect(c.billable).toBe(1080);
    expect(c.margin).toBe(760);
    expect(c.sites[0].plant_charge).toBe(600);
  });

  it('plant on a sheet with no shift in range is ignored', () => {
    const plantRows = [{ header_id: 'other', hours: 4, plant_items: { hourly_charge: 150 } }];
    const r = buildMarginReport({ timesheets: [sheet()], workers, clients, rateCards: [], roleRates: [], config, plantRows });
    expect(r.clients[0].plant_charge).toBe(0);
  });

  it('CSV rows: client line, site lines, total', () => {
    const r = buildMarginReport({ timesheets: [sheet(), sheet({ id: 't2', project: 'Site B', header_id: 'h2' })], workers, clients, rateCards: [], roleRates: [], config, plantRows: [] });
    const rows = marginReportCSVRows(r);
    expect(rows.map(x => x.Site)).toEqual(['(all sites)', 'Site A', 'Site B', '']);
    expect(rows[3]['Billable $']).toBe('960.00');
  });
});
