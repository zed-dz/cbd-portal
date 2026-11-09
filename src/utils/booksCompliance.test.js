import {
  isBusinessDay, nextBusinessDay, addBusinessDays, quarterOf, monthOf, basQuarterDue, monthlyDue,
  superQuarterDue, superPaydayDue, nextPayday, upcomingObligations, complianceEstimates, reminderLeads, daysBetween,
} from './booksCompliance';

describe('business days', () => {
  it('weekends and national holidays are not business days', () => {
    expect(isBusinessDay('2026-11-09')).toBe(true);    // Mon
    expect(isBusinessDay('2026-11-07')).toBe(false);   // Sat
    expect(isBusinessDay('2026-12-25')).toBe(false);   // Christmas
  });
  it('nextBusinessDay rolls Sat → Mon and keeps a weekday', () => {
    expect(nextBusinessDay('2026-11-07')).toBe('2026-11-09');
    expect(nextBusinessDay('2026-11-10')).toBe('2026-11-10');
  });
  it('addBusinessDays skips the weekend', () => {
    expect(addBusinessDays('2026-11-12', 7)).toBe('2026-11-23');   // Thu + 7 bd
  });
});

describe('periods', () => {
  it('quarterOf / monthOf', () => {
    expect(quarterOf('2026-11-09')).toMatchObject({ from: '2026-10-01', to: '2026-12-31', label: 'Oct–Dec 2026' });
    expect(monthOf('2026-02-10')).toMatchObject({ from: '2026-02-01', to: '2026-02-28', label: 'Feb 2026' });
  });
});

describe('ATO due dates', () => {
  it('quarterly BAS: 28th after quarter; Oct–Dec → 28 Feb; ATO override to 2 Mar 2027', () => {
    expect(basQuarterDue('2026-09-30')).toBe('2026-10-28');
    expect(basQuarterDue('2026-12-31')).toBe('2027-03-02');     // 28 Feb 2027 is a Sunday, 1 Mar WA Labour Day → ATO says 2 Mar
    expect(basQuarterDue('2027-03-31')).toBe('2027-04-28');
    expect(basQuarterDue('2026-06-30')).toBe('2026-07-28');
  });
  it('monthly IAS: 21st of the following month, rolled forward off a weekend', () => {
    expect(monthlyDue('2026-10-31')).toBe('2026-11-23');          // 21 Nov 2026 is a Saturday
    expect(monthlyDue('2026-11-30')).toBe('2026-12-21');
    expect(monthlyDue('2026-12-31')).toBe('2027-01-21');
  });
  it('super: quarterly 28 days for old quarters; 7 business days after payday now', () => {
    expect(superQuarterDue('2026-06-30')).toBe('2026-07-28');
    expect(superQuarterDue('2025-12-31')).toBe('2026-01-28');
    expect(superPaydayDue('2026-11-12')).toBe('2026-11-23');
  });
});

describe('nextPayday', () => {
  it('weekly Thursday from a Monday is that Thursday; from a Thursday is today', () => {
    expect(nextPayday('2026-11-09', 4, 'weekly')).toBe('2026-11-12');
    expect(nextPayday('2026-11-12', 4, 'weekly')).toBe('2026-11-12');
  });
  it('fortnightly honours the anchor', () => {
    expect(nextPayday('2026-11-09', 4, 'fortnightly', '2026-11-05')).toBe('2026-11-19');
    expect(nextPayday('2026-11-09', 4, 'fortnightly', '2026-10-29')).toBe('2026-11-12');
  });
});

describe('upcomingObligations', () => {
  it('quarterly BAS + monthly PAYG + payday super, sorted by due date, estimates on the open period only', () => {
    const list = upcomingObligations('2026-11-09', { bas_cycle: 'quarterly', payg_cycle: 'monthly', payroll_weekday: 4, payroll_frequency: 'weekly' }, { gst_net: 1234.5, payg_w: 800, super: 600 });
    expect(list.map((o) => o.due)).toEqual([...list.map((o) => o.due)].sort());
    const bas = list.filter((o) => o.type === 'bas');
    expect(bas[0]).toMatchObject({ due: '2027-03-02', amount: 1234.5, days_left: daysBetween('2026-11-09', '2027-03-02') });
    expect(bas[1].amount).toBeNull();
    const payg = list.filter((o) => o.type === 'payg');
    expect(payg[0]).toMatchObject({ due: '2026-12-21', amount: 800 });     // Nov 2026 → 21 Dec
    const sup = list.find((o) => o.type === 'super');
    expect(sup).toMatchObject({ due: '2026-11-23', amount: 600 });          // pay 12 Nov + 7 bd
    expect(sup.note).toMatch(/7 business days/);
  });
  it('before Payday Super the quarterly rule applies', () => {
    const list = upcomingObligations('2026-05-10', {}, {});
    expect(list.find((o) => o.type === 'super')).toMatchObject({ due: '2026-07-28' });
  });
  it('monthly BAS cycle uses the 21st', () => {
    const list = upcomingObligations('2026-11-09', { bas_cycle: 'monthly' }, {});
    expect(list.find((o) => o.type === 'bas').due).toBe('2026-12-21');
  });
});

describe('complianceEstimates / reminderLeads', () => {
  it('GST net from 1A−1B, PAYG and super from gross pay × rate', () => {
    expect(complianceEstimates({ bas: { gst_1a: 5000, gst_1b: 1200.5 }, grossPay: 10000, settings: { payg_rate_pct: 20, super_rate_pct: 12 } }))
      .toEqual({ gst_net: 3799.5, payg_w: 2000, super: 1200 });
  });
  it('reminder fires only on day 14 and day 3', () => {
    expect(reminderLeads(14)).toEqual([14]);
    expect(reminderLeads(3)).toEqual([3]);
    expect(reminderLeads(5)).toEqual([]);
  });
});
