import {
  recompute, monthsBetween, residualRateFor, summarise, statementRows, partnerReport,
  validateReferral, profileMissing, clientKeyOf,
} from './commission';

const partner = { id: 'p1', name: 'QA', first_placement_bonus: 1500, residual_pct_y1: 10, residual_pct_y2: 5 };
const ref = (over = {}) => ({ id: 'r1', partner_id: 'p1', referral_type: 'new_client', company_name: 'Acme Hire', status: 'active', client_id: 'c1', ...over });
const pl = (over = {}) => ({ id: 'pl1', referral_id: 'r1', partner_id: 'p1', client_id: 'c1', period_start: '2026-02-01', period_end: '2026-02-28', revenue_collected: 10000, cost: 7000, ...over });

describe('monthsBetween / residual rate', () => {
  test('whole months, floor', () => {
    expect(monthsBetween('2026-01-15', '2026-01-15')).toBe(0);
    expect(monthsBetween('2026-01-15', '2027-01-14')).toBe(11);
    expect(monthsBetween('2026-01-15', '2027-01-15')).toBe(12);
    expect(monthsBetween('2026-03-01', '2026-01-01')).toBe(0);
  });
  test('year 1 for the first 12 months, year 2 after', () => {
    expect(residualRateFor(partner, '2026-01-01', '2026-12-31')).toMatchObject({ rate: 10, year: 1 });
    expect(residualRateFor(partner, '2026-01-01', '2027-01-01')).toMatchObject({ rate: 5, year: 2 });
    expect(residualRateFor(partner, null, '2027-01-01')).toMatchObject({ rate: 10, year: 1 });
  });
});

describe('recompute', () => {
  test('first active placement of a new client earns bonus + residual on collected margin', () => {
    const { upserts, voids } = recompute({ partner, placements: [pl()], referrals: [ref()] });
    expect(voids).toEqual([]);
    const bonus = upserts.find(u => u.kind === 'bonus');
    const res = upserts.find(u => u.kind === 'residual');
    expect(bonus.amount).toBe(1500);
    expect(res).toMatchObject({ rate: 10, base_amount: 3000, amount: 300, status: 'pending' });
    expect(res.calc.formula).toBe('3000.00 × 10% = 300.00');
  });
  test('commission only on collected money — billed but unpaid earns 0 and bonus waits', () => {
    const { upserts } = recompute({ partner, placements: [pl({ revenue_billed: 10000, revenue_collected: 0, cost: 0 })], referrals: [ref()] });
    expect(upserts.find(u => u.kind === 'residual').amount).toBe(0);
    expect(upserts.find(u => u.kind === 'bonus').amount).toBe(0);
  });
  test('negative margin earns no residual', () => {
    const { upserts } = recompute({ partner, placements: [pl({ revenue_collected: 100, cost: 500 })], referrals: [ref()] });
    expect(upserts.find(u => u.kind === 'residual')).toMatchObject({ base_amount: 0, amount: 0 });
  });
  test('bonus once per client; second period gets residual only; year-2 rate after 12 months', () => {
    const placements = [pl(), pl({ id: 'pl2', period_start: '2027-03-01', period_end: '2027-03-31', revenue_collected: 2000, cost: 1000 })];
    const { upserts } = recompute({ partner, placements, referrals: [ref()] });
    expect(upserts.filter(u => u.kind === 'bonus')).toHaveLength(1);
    const second = upserts.find(u => u.kind === 'residual' && u.placement_id === 'pl2');
    expect(second).toMatchObject({ rate: 5, amount: 50 });
    expect(second.calc.year).toBe(2);
  });
  test('specific-job referral: residual but no bonus', () => {
    const { upserts } = recompute({ partner, placements: [pl()], referrals: [ref({ referral_type: 'specific_job' })] });
    expect(upserts.find(u => u.kind === 'bonus')).toBeUndefined();
    expect(upserts.find(u => u.kind === 'residual').amount).toBe(300);
  });
  test('nothing earns until the referral is Active', () => {
    const { upserts } = recompute({ partner, placements: [pl()], referrals: [ref({ status: 'accepted' })] });
    expect(upserts).toEqual([]);
  });
  test('idempotent: approved/paid lines are never rewritten, stale pending lines are voided', () => {
    const existing = [
      { id: 'l1', placement_id: 'pl1', kind: 'bonus', status: 'paid', amount: 1500 },
      { id: 'l2', placement_id: 'pl1', kind: 'residual', status: 'pending', amount: 999 },
      { id: 'l3', placement_id: 'gone', kind: 'residual', status: 'pending', amount: 5 },
    ];
    const { upserts, voids } = recompute({ partner, placements: [pl()], referrals: [ref()], existingLines: existing });
    expect(upserts.find(u => u.kind === 'bonus')).toBeUndefined();
    expect(upserts.find(u => u.kind === 'residual').amount).toBe(300);
    expect(voids).toEqual(['l3']);
  });
  test('a paid bonus on an earlier placement blocks a second bonus for the same client', () => {
    const placements = [pl({ id: 'old', period_start: '2025-06-01', period_end: '2025-06-30', archived_at: null }), pl()];
    const existing = [{ id: 'lb', placement_id: 'old', kind: 'bonus', status: 'paid', amount: 1500 }];
    const { upserts } = recompute({ partner, placements, referrals: [ref()], existingLines: existing });
    expect(upserts.filter(u => u.kind === 'bonus')).toHaveLength(0);
  });
  test('archived placements are ignored', () => {
    const { upserts } = recompute({ partner, placements: [pl({ archived_at: '2026-03-01' })], referrals: [ref()] });
    expect(upserts).toEqual([]);
  });
  test('client key falls back to company name when nothing is linked', () => {
    const r = ref({ client_id: null });
    expect(clientKeyOf(pl({ client_id: null }), { r1: r })).toBe('name:acme hire');
  });
});

describe('summarise / statement / report', () => {
  const lines = [
    { id: 'a', placement_id: 'pl1', partner_id: 'p1', kind: 'bonus', amount: 1500, status: 'paid', paid_at: '2026-11-03', rate: 1500 },
    { id: 'b', placement_id: 'pl1', partner_id: 'p1', kind: 'residual', amount: 300, status: 'pending', rate: 10 },
    { id: 'c', placement_id: 'pl1', partner_id: 'p1', kind: 'residual', amount: 1, status: 'void', rate: 10 },
  ];
  test('summary cards', () => {
    const s = summarise({ lines, placements: [pl()], referrals: [ref({ created_at: '2026-11-02' })], today: new Date('2026-11-09T10:00:00') });
    expect(s).toMatchObject({ referrals_total: 1, referrals_this_month: 1, active_placements: 1, pending_commission: 300, paid_this_month: 1500, paid_ytd: 1500, paid_lifetime: 1500, revenue_collected: 10000, gross_margin: 3000 });
  });
  test('statement rows skip void lines and never show cost directly', () => {
    const rows = statementRows({ lines, placements: [pl({ client_name_snapshot: 'Acme Hire', roles_text: 'Labourer' })], referrals: [ref()] });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ Client: 'Acme Hire', 'Gross margin $': '3000.00' });
    expect(Object.keys(rows[0])).not.toContain('Cost');
  });
  test('admin report conversion and totals', () => {
    const refs = [ref(), ref({ id: 'r2', status: 'declined' }), ref({ id: 'r3', status: 'submitted', partner_id: 'p2' })];
    const rep = partnerReport({ partners: [partner, { id: 'p2', name: 'B', status: 'active' }], referrals: refs, placements: [pl()], lines });
    expect(rep.rows[0]).toMatchObject({ referrals: 2, won: 1, conversion_pct: 50, commission_paid: 1500, commission_pending: 300, revenue_collected: 10000 });
    expect(rep.totals).toMatchObject({ referrals: 3, won: 1 });
  });
});

describe('validation', () => {
  const good = { referral_type: 'new_client', company_name: 'Acme', contact_name: 'Jo', contact_phone: '0412 345 678', site_address: '1 Rail St', roles: ['Labourer'], people_count: 2, start_date: '2026-12-01', duration_text: '3 weeks' };
  test('a complete referral passes', () => { expect(validateReferral(good)).toEqual({}); });
  test('required fields and formats', () => {
    const e = validateReferral({ ...good, company_name: '', contact_phone: '', contact_email: 'nope', roles: [], people_count: 0, start_date: '', duration_text: '', map_link: 'maps.google.com' });
    expect(Object.keys(e).sort()).toEqual(['company_name', 'contact_email', 'duration_text', 'map_link', 'people_count', 'roles', 'start_date']);
  });
  test('free-text role satisfies the roles rule; phone or email', () => {
    expect(validateReferral({ ...good, roles: [], roles_other: 'Dogman' })).toEqual({});
    expect(validateReferral({ ...good, contact_phone: '', contact_email: 'jo@acme.com' })).toEqual({});
    expect(validateReferral({ ...good, contact_phone: '', contact_email: '' }).contact_phone).toBeTruthy();
  });
  test('profile completeness', () => {
    expect(profileMissing({ phone: '', abn: '12' }, {})).toEqual(['phone', 'abn', 'account_name', 'bsb', 'account_no']);
    expect(profileMissing({ phone: '0412', abn: '51 824 753 556' }, { account_name: 'QA', bsb: '062-000', account_no: '12345678' })).toEqual([]);
  });
});
