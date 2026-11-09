// Sales-partner commission engine — pure functions, no React, no Supabase.
//
// The rule, in plain words (the Commission page shows this text):
//   1. First placement bonus: a one-off amount the first time a NEW client the
//      partner introduced has an active placement. Once per partner per client.
//   2. Residual: a percentage of the gross margin on work the partner
//      originated. Year 1 (the first 12 months from that client's first
//      placement) pays the year-1 rate, then the year-2+ rate.
//   3. Commission is only ever calculated on money the client has actually
//      PAID (revenue_collected), never on what was billed.
//   gross margin = revenue collected − fully loaded cost.
//
// recompute() is idempotent: run it as often as you like. Lines that are
// already approved or paid are never touched; pending lines are rewritten.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

export const COMMISSION_RULE_TEXT = [
  'You earn a one-off bonus the first time a new client you introduced has people on site.',
  'You earn a share of the gross margin on every period of work you originated: the year-1 rate for the first 12 months of that client, the year-2 rate after that.',
  'Gross margin is what the client paid minus the full cost of the workers.',
  'Commission is only counted once the client has paid — billed but unpaid work shows as $0 until the money lands.',
  'Pending = calculated, waiting for the office. Approved = confirmed, in the next pay run. Paid = money sent, with the payment reference.',
];

export const REFERRAL_STATUSES = [
  { id: 'submitted',             label: 'Submitted',             color: 'gray' },
  { id: 'under_review',          label: 'Under review',          color: 'yellow' },
  { id: 'accepted',              label: 'Accepted',              color: 'blue' },
  { id: 'placement_in_progress', label: 'Placement in progress', color: 'purple' },
  { id: 'active',                label: 'Active',                color: 'green' },
  { id: 'completed',             label: 'Completed',             color: 'green' },
  { id: 'declined',              label: 'Declined',              color: 'red' },
  { id: 'duplicate',             label: 'Duplicate / existing',  color: 'orange' },
];
export const statusMeta = (id) => REFERRAL_STATUSES.find(s => s.id === id) || { id, label: id || '—', color: 'gray' };
// A referral counts as "won" from Accepted onwards (conversion rate uses this).
export const WON_STATUSES = ['accepted', 'placement_in_progress', 'active', 'completed'];
// Placements can only earn commission once the referral is Active or later.
export const EARNING_STATUSES = ['active', 'completed'];

export const REFERRAL_TYPES = [
  { id: 'new_client',   label: 'New client introduction' },
  { id: 'specific_job', label: 'Specific job' },
  { id: 'ongoing',      label: 'Ongoing requirement' },
];
export const SOURCE_OPTIONS = [
  { id: 'existing_relationship', label: 'Existing relationship' },
  { id: 'cold_outreach',         label: 'Cold outreach' },
  { id: 'other',                 label: 'Other' },
];

// Whole months between two ISO dates (floor). "2026-01-15" → "2027-01-14" = 11.
export function monthsBetween(fromISO, toISO) {
  if (!fromISO || !toISO) return 0;
  const a = new Date(fromISO + 'T00:00:00Z'), b = new Date(toISO + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0;
  let m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) m -= 1;
  return Math.max(0, m);
}

// Which residual rate applies to a period: year 1 = < 12 whole months after
// the client's first placement started.
export function residualRateFor(partner, clientFirstStart, periodStart) {
  const months = monthsBetween(clientFirstStart, periodStart);
  const y1 = num(partner?.residual_pct_y1), y2 = num(partner?.residual_pct_y2);
  return months < 12 ? { rate: y1, year: 1, months } : { rate: y2, year: 2, months };
}

// Group key for "the same client": the linked client id when the office has
// linked one, else the referral's company name (lower-cased).
export function clientKeyOf(placement, referralsById) {
  if (placement.client_id) return `id:${placement.client_id}`;
  const ref = referralsById?.[placement.referral_id];
  if (ref?.client_id) return `id:${ref.client_id}`;
  const name = (placement.client_name_snapshot || ref?.company_name || '').trim().toLowerCase();
  return name ? `name:${name}` : `placement:${placement.id}`;
}

// recompute({ partner, placements, referrals, existingLines, today })
//   placements    — this partner's non-archived placement periods
//   referrals     — this partner's referrals (status decides if a period earns)
//   existingLines — every current commission line for this partner
// Returns { upserts: [...lines to insert/update], voids: [...line ids to void] }
// Each line carries calc json explaining the number.
export function recompute({ partner, placements = [], referrals = [], existingLines = [] }) {
  const refsById = Object.fromEntries(referrals.map(r => [r.id, r]));
  const live = placements.filter(p => !p.archived_at).slice()
    .sort((a, b) => (a.period_start || '').localeCompare(b.period_start || '') || String(a.created_at || '').localeCompare(String(b.created_at || '')));

  // First placement per client (earliest period_start among EARNING referrals).
  const firstByClient = new Map();
  for (const p of live) {
    const ref = refsById[p.referral_id];
    if (!ref || !EARNING_STATUSES.includes(ref.status)) continue;
    const key = clientKeyOf(p, refsById);
    if (!firstByClient.has(key)) firstByClient.set(key, p);
  }

  // Locked lines (approved/paid) by placement+kind: never rewritten.
  const locked = new Set(existingLines.filter(l => ['approved', 'paid'].includes(l.status)).map(l => `${l.placement_id}:${l.kind}`));
  // If a bonus was already approved/paid for some placement of this client, no
  // second bonus for that client — whatever period sorts first today.
  const bonusLockedClients = new Set();
  for (const l of existingLines) {
    if (l.kind !== 'bonus' || !['approved', 'paid'].includes(l.status)) continue;
    const p = live.find(x => x.id === l.placement_id);
    if (p) bonusLockedClients.add(clientKeyOf(p, refsById));
  }

  const upserts = [];
  const wanted = new Set();
  for (const p of live) {
    const ref = refsById[p.referral_id];
    if (!ref || !EARNING_STATUSES.includes(ref.status)) continue;
    const key = clientKeyOf(p, refsById);
    const first = firstByClient.get(key);
    const collected = num(p.revenue_collected), cost = num(p.cost);
    const margin = r2(collected - cost);

    // Residual on collected margin (negative margin earns nothing).
    const { rate, year, months } = residualRateFor(partner, first?.period_start, p.period_start);
    const base = Math.max(0, margin);
    const residualAmount = r2(base * rate / 100);
    const rKey = `${p.id}:residual`;
    wanted.add(rKey);
    if (!locked.has(rKey)) {
      upserts.push({
        placement_id: p.id, partner_id: partner.id, kind: 'residual',
        rate, base_amount: base, amount: residualAmount, status: 'pending',
        calc: {
          rule: 'residual', year, months_since_first_placement: months,
          client_first_period_start: first?.period_start || null,
          revenue_collected: collected, cost, gross_margin: margin, rate_pct: rate,
          formula: `${base.toFixed(2)} × ${rate}% = ${residualAmount.toFixed(2)}`,
        },
      });
    }

    // Bonus once per client: on the first earning placement, only for a NEW
    // client introduction, and only when the client has actually paid something.
    const isFirst = first && first.id === p.id;
    const newClient = ref.referral_type === 'new_client';
    if (isFirst && newClient && !bonusLockedClients.has(key)) {
      const bKey = `${p.id}:bonus`;
      wanted.add(bKey);
      const bonus = collected > 0 ? r2(num(partner.first_placement_bonus)) : 0;
      if (!locked.has(bKey)) {
        upserts.push({
          placement_id: p.id, partner_id: partner.id, kind: 'bonus',
          rate: r2(num(partner.first_placement_bonus)), base_amount: collected, amount: bonus, status: 'pending',
          calc: {
            rule: 'first_placement_bonus', client_key: key, first_period_start: p.period_start,
            revenue_collected: collected, paid_by_client: collected > 0,
            formula: collected > 0 ? `one-off ${bonus.toFixed(2)}` : 'waits until the client pays the first invoice',
          },
        });
      }
    }
  }

  // Pending lines that no longer apply (placement archived, referral no longer
  // earning, bonus moved to an earlier period) are voided, never deleted.
  const voids = existingLines
    .filter(l => l.status === 'pending' && !wanted.has(`${l.placement_id}:${l.kind}`))
    .map(l => l.id);
  return { upserts, voids };
}

// Dashboard numbers from the partner's commission lines + placements.
export function summarise({ lines = [], placements = [], referrals = [], today = new Date() }) {
  const y = today.getFullYear(), m = today.getMonth();
  const ym = `${y}-${String(m + 1).padStart(2, '0')}`;
  const inMonth = (iso) => (iso || '').slice(0, 7) === ym;
  const inYear  = (iso) => (iso || '').slice(0, 4) === String(y);
  const liveLines = lines.filter(l => l.status !== 'void');
  const sum = (arr) => r2(arr.reduce((a, l) => a + num(l.amount), 0));
  const paid = liveLines.filter(l => l.status === 'paid');
  const activeRefs = referrals.filter(r => r.status === 'active');
  return {
    referrals_total: referrals.length,
    referrals_this_month: referrals.filter(r => inMonth(r.created_at)).length,
    active_placements: activeRefs.length,
    pending_commission: sum(liveLines.filter(l => l.status === 'pending')),
    approved_commission: sum(liveLines.filter(l => l.status === 'approved')),
    paid_this_month: sum(paid.filter(l => inMonth(l.paid_at))),
    paid_ytd: sum(paid.filter(l => inYear(l.paid_at))),
    paid_lifetime: sum(paid),
    revenue_collected: r2(placements.filter(p => !p.archived_at).reduce((a, p) => a + num(p.revenue_collected), 0)),
    gross_margin: r2(placements.filter(p => !p.archived_at).reduce((a, p) => a + (num(p.revenue_collected) - num(p.cost)), 0)),
    active_revenue_generating: new Set(placements.filter(p => !p.archived_at && activeRefs.some(r => r.id === p.referral_id)).map(p => p.referral_id)).size,
  };
}

// Statement rows (CSV + print) — one row per commission line with its placement.
export function statementRows({ lines = [], placements = [], referrals = [] }) {
  const pById = Object.fromEntries(placements.map(p => [p.id, p]));
  const rById = Object.fromEntries(referrals.map(r => [r.id, r]));
  return lines.filter(l => l.status !== 'void').map(l => {
    const p = pById[l.placement_id] || {};
    const r = rById[p.referral_id] || {};
    return {
      'Period': p.period_start ? `${p.period_start} → ${p.period_end}` : '—',
      'Client': p.client_name_snapshot || r.company_name || '—',
      'Role(s)': p.roles_text || (r.roles || []).join(', ') || '—',
      'Hours': num(p.hours).toFixed(2),
      'Revenue collected $': num(p.revenue_collected).toFixed(2),
      'Gross margin $': (num(p.revenue_collected) - num(p.cost)).toFixed(2),
      'Type': l.kind === 'bonus' ? 'First placement bonus' : 'Residual',
      'Rate': l.kind === 'bonus' ? `$${num(l.rate).toFixed(2)}` : `${num(l.rate)}%`,
      'Commission $': num(l.amount).toFixed(2),
      'Status': l.status,
      'Paid on': l.paid_at ? String(l.paid_at).slice(0, 10) : '',
      'Payment ref': l.payment_ref || '',
    };
  }).sort((a, b) => a.Period.localeCompare(b.Period));
}

// Admin reports: counts, conversion, revenue, commission paid.
export function partnerReport({ partners = [], referrals = [], placements = [], lines = [] }) {
  const byPartner = partners.map(p => {
    const refs = referrals.filter(r => r.partner_id === p.id);
    const won = refs.filter(r => WON_STATUSES.includes(r.status)).length;
    const pls = placements.filter(x => x.partner_id === p.id && !x.archived_at);
    const ls = lines.filter(l => l.partner_id === p.id && l.status !== 'void');
    return {
      partner_id: p.id, partner: p.name, company: p.company || '', status: p.status,
      referrals: refs.length, won,
      conversion_pct: refs.length ? r2(won * 100 / refs.length) : 0,
      active: refs.filter(r => r.status === 'active').length,
      revenue_collected: r2(pls.reduce((a, x) => a + num(x.revenue_collected), 0)),
      gross_margin: r2(pls.reduce((a, x) => a + num(x.revenue_collected) - num(x.cost), 0)),
      commission_pending: r2(ls.filter(l => l.status === 'pending').reduce((a, l) => a + num(l.amount), 0)),
      commission_approved: r2(ls.filter(l => l.status === 'approved').reduce((a, l) => a + num(l.amount), 0)),
      commission_paid: r2(ls.filter(l => l.status === 'paid').reduce((a, l) => a + num(l.amount), 0)),
    };
  });
  const totals = byPartner.reduce((t, r) => ({
    referrals: t.referrals + r.referrals, won: t.won + r.won, active: t.active + r.active,
    revenue_collected: r2(t.revenue_collected + r.revenue_collected), gross_margin: r2(t.gross_margin + r.gross_margin),
    commission_pending: r2(t.commission_pending + r.commission_pending), commission_approved: r2(t.commission_approved + r.commission_approved),
    commission_paid: r2(t.commission_paid + r.commission_paid),
  }), { referrals: 0, won: 0, active: 0, revenue_collected: 0, gross_margin: 0, commission_pending: 0, commission_approved: 0, commission_paid: 0 });
  totals.conversion_pct = totals.referrals ? r2(totals.won * 100 / totals.referrals) : 0;
  return { rows: byPartner, totals };
}

// Referral form validation — the same checks on the phone and before insert.
export function validateReferral(f) {
  const e = {};
  if (!f.referral_type) e.referral_type = 'Pick a type.';
  if (!String(f.company_name || '').trim()) e.company_name = 'Company name is required.';
  if (!String(f.contact_name || '').trim()) e.contact_name = 'Contact name is required.';
  const phone = String(f.contact_phone || '').trim(), email = String(f.contact_email || '').trim();
  if (!phone && !email) e.contact_phone = 'Phone or email is required.';
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) e.contact_email = 'That email does not look right.';
  if (phone && phone.replace(/\D/g, '').length < 8) e.contact_phone = 'That phone number is too short.';
  if (!String(f.site_address || '').trim()) e.site_address = 'Site address is required.';
  const roles = (f.roles || []).filter(Boolean);
  if (!roles.length && !String(f.roles_other || '').trim()) e.roles = 'Pick at least one role or type one.';
  const n = parseInt(f.people_count, 10);
  if (!Number.isInteger(n) || n < 1) e.people_count = 'How many people? At least 1.';
  if (!f.start_date) e.start_date = 'Start date is required.';
  if (!String(f.duration_text || '').trim()) e.duration_text = 'Expected duration is required.';
  if (f.map_link && !/^https?:\/\//i.test(String(f.map_link).trim())) e.map_link = 'Map link must start with http.';
  return e;
}

// Partner profile completeness — first login forces these.
export function profileMissing(partner, bank) {
  const m = [];
  if (!String(partner?.phone || '').trim()) m.push('phone');
  if (!/^\d{11}$/.test(String(partner?.abn || '').replace(/\s/g, ''))) m.push('abn');
  if (!String(bank?.account_name || '').trim()) m.push('account_name');
  if (!/^\d{6}$/.test(String(bank?.bsb || '').replace(/[\s-]/g, ''))) m.push('bsb');
  if (!/^\d{6,10}$/.test(String(bank?.account_no || '').replace(/\s/g, ''))) m.push('account_no');
  return m;
}

export const fmtMoney = (n) => `$${num(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
