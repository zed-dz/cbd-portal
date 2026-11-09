// compliance.ts — Deno copy of src/utils/booksCompliance.js (keep in step; the
// unit tests live on the JS side). ATO due-date rules + upcoming obligations.
// deno-lint-ignore-file no-explicit-any
const p = (n: any) => String(n).padStart(2, '0');
export const isoDate = (d: Date) => `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
const utc = (s: any): Date | null => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
const addDays = (s: any, n: number) => { const d = utc(s)!; d.setUTCDate(d.getUTCDate() + n); return isoDate(d); };
export const daysBetween = (a: any, b: any) => Math.round((utc(b)!.getTime() - utc(a)!.getTime()) / 86400000);

// National public holidays (fixed-date + published Easter dates) — enough for
// the roll-forward rule. State days are not applied (the ATO uses national).
export const NATIONAL_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-26', '2026-04-03', '2026-04-04', '2026-04-06', '2026-04-25', '2026-12-25', '2026-12-28',
  '2027-01-01', '2027-01-26', '2027-03-26', '2027-03-27', '2027-03-29', '2027-04-25', '2027-04-26', '2027-12-27', '2027-12-28',
  '2028-01-03', '2028-01-26', '2028-04-14', '2028-04-15', '2028-04-17', '2028-04-25', '2028-12-25', '2028-12-26',
]);
// Dates the ATO publishes that differ from the plain rule (WA Labour Day 2027).
const ATO_OVERRIDES = { '2027-02-28': '2027-03-02', '2027-03-01': '2027-03-02' };

export function isBusinessDay(s: string) {
  const d = utc(s); if (!d) return false;
  const dow = d.getUTCDay();
  return dow !== 0 && dow !== 6 && !NATIONAL_HOLIDAYS.has(s);
}
export function nextBusinessDay(s: string) {           // s itself if it is one
  let d = s; let guard = 0;
  while (!isBusinessDay(d) && guard++ < 14) d = addDays(d, 1);
  return d;
}
export function addBusinessDays(s: string, n: number) {
  let d = s; let left = n; let guard = 0;
  while (left > 0 && guard++ < 60) { d = addDays(d, 1); if (isBusinessDay(d)) left -= 1; }
  return d;
}
function rollForward(s: string) {
  const o = (ATO_OVERRIDES as Record<string, string>)[s];
  return o || nextBusinessDay(s);
}

// Quarter that holds `date`: { from, to, label, q } (q = 1..4, Jul–Sep = 1).
export function quarterOf(date: string) {
  const d = utc(date)!; const y = d.getUTCFullYear(); const mo = d.getUTCMonth() + 1;
  const qStart = mo - ((mo - 1) % 3);
  const endMonth = qStart + 2;
  const last = new Date(Date.UTC(y, endMonth, 0)).getUTCDate();
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return { from: `${y}-${p(qStart)}-01`, to: `${y}-${p(endMonth)}-${p(last)}`, label: `${names[qStart - 1]}–${names[endMonth - 1]} ${y}`, year: y, endMonth };
}
export function monthOf(date: string) {
  const d = utc(date)!; const y = d.getUTCFullYear(); const mo = d.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return { from: `${y}-${p(mo)}-01`, to: `${y}-${p(mo)}-${p(last)}`, label: `${names[mo - 1]} ${y}`, year: y, endMonth: mo };
}

// Due date for a quarterly BAS whose quarter ends `to` (YYYY-MM-DD).
export function basQuarterDue(to: string) {
  const d = utc(to)!; const y = d.getUTCFullYear(); const mo = d.getUTCMonth() + 1;
  const raw = mo === 12 ? `${y + 1}-02-28` : `${mo === 12 ? y + 1 : y}-${p(mo + 1)}-28`;
  return rollForward(raw);
}
// Due date for a monthly statement for the month ending `to`.
export function monthlyDue(to: string) {
  const d = utc(to)!; const y = d.getUTCFullYear(); const mo = d.getUTCMonth() + 1;
  const raw = mo === 12 ? `${y + 1}-01-21` : `${y}-${p(mo + 1)}-21`;
  return rollForward(raw);
}
// Super: quarterly 28 days (quarters ending ≤ 2026-06-30) — else per payday.
export const PAYDAY_SUPER_FROM = '2026-07-01';
export function superQuarterDue(to: string) {
  const d = utc(to)!; const y = d.getUTCFullYear(); const mo = d.getUTCMonth() + 1;
  const raw = mo === 12 ? `${y + 1}-01-28` : `${y}-${p(mo + 1)}-28`;
  return nextBusinessDay(raw);
}
export function superPaydayDue(payday: string) { return addBusinessDays(payday, 7); }

// Next pay day on/after `today` for a weekly/fortnightly cycle on `weekday` (0=Sun).
export function nextPayday(today: string, weekday: any = 4, frequency = 'weekly', anchor: string | null = null): string {
  const d = utc(today); if (!d) return today;
  const want = Number(weekday) || 0;
  const diff = (want - d.getUTCDay() + 7) % 7;
  let next = addDays(today, diff);
  if (frequency === 'fortnightly' && anchor) {
    const gap = daysBetween(anchor, next);
    if (((gap % 14) + 14) % 14 !== 0) next = addDays(next, 7);
  }
  return next;
}

// The list the Compliance tab + the cron both use.
// settings: { bas_cycle, payg_cycle, payroll_frequency, payroll_weekday }
// estimates: { gst_net, payg_w, super } for the CURRENT open period (optional)
// Returns upcoming obligations sorted by due date, each { key, type, label, period, due, days_left, amount }.
export function upcomingObligations(today: string, settings: any = {}, estimates: any = {}, count = 3) {
  const out: any[] = [];
  const basCycle = settings.bas_cycle === 'monthly' ? 'monthly' : 'quarterly';
  const paygCycle = settings.payg_cycle === 'quarterly' ? 'quarterly' : 'monthly';
  let cursor = today;
  // BAS (GST). Monthly withholders lodge PAYG W on the IAS (21st) in the months
  // between quarterly BASs; on the BAS month it rides with the BAS.
  for (let i = 0; i < count; i += 1) {
    const per = basCycle === 'monthly' ? monthOf(cursor) : quarterOf(cursor);
    const due = basCycle === 'monthly' ? monthlyDue(per.to) : basQuarterDue(per.to);
    if (daysBetween(today, due) >= 0) {
      out.push({ key: `bas:${per.to}`, type: 'bas', label: `BAS ${basCycle === 'monthly' ? 'monthly' : 'quarterly'} · ${per.label}`, period: per, due, days_left: daysBetween(today, due), amount: i === 0 ? estimates.gst_net ?? null : null });
    }
    cursor = addDays(per.to, 1);
  }
  cursor = today;
  for (let i = 0; i < count; i += 1) {
    const per = paygCycle === 'monthly' ? monthOf(cursor) : quarterOf(cursor);
    const due = paygCycle === 'monthly' ? monthlyDue(per.to) : basQuarterDue(per.to);
    if (daysBetween(today, due) >= 0) {
      out.push({ key: `payg:${per.to}`, type: 'payg', label: `PAYG withholding · ${per.label}`, period: per, due, days_left: daysBetween(today, due), amount: i === 0 ? estimates.payg_w ?? null : null });
    }
    cursor = addDays(per.to, 1);
  }
  // Super
  if (today < PAYDAY_SUPER_FROM) {
    const per = quarterOf(today);
    const due = superQuarterDue(per.to);
    out.push({ key: `super:${per.to}`, type: 'super', label: `Super guarantee · ${per.label}`, period: per, due, days_left: daysBetween(today, due), amount: estimates.super ?? null });
  } else {
    const payday = nextPayday(today, settings.payroll_weekday ?? 4, settings.payroll_frequency || 'weekly', settings.payroll_anchor || null);
    const due = superPaydayDue(payday);
    out.push({ key: `super:${payday}`, type: 'super', label: `Super (Payday Super) · pay run ${payday}`, period: { from: payday, to: payday, label: `pay run ${payday}` }, due, days_left: daysBetween(today, due), amount: estimates.super ?? null, note: '7 business days after each pay day' });
  }
  return out.sort((a, b) => a.due.localeCompare(b.due) || a.type.localeCompare(b.type));
}

// Estimates from the data we have (all labelled "estimate" in the UI):
//  gst_net  = 1A − 1B for the open BAS period (books_bas_figures)
//  payg_w   = gross pay × payg_rate_pct (no payslips in the portal)
//  super    = gross pay × super_rate_pct
export function complianceEstimates({ bas, grossPay, settings = {} }: any) {
  const gst = (Number(bas?.gst_1a) || 0) - (Number(bas?.gst_1b) || 0);
  const pay = Number(grossPay) || 0;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    gst_net: r2(gst),
    payg_w: r2(pay * ((Number(settings.payg_rate_pct) || 20) / 100)),
    super: r2(pay * ((Number(settings.super_rate_pct) || 12) / 100)),
  };
}

// Which lead-day reminders are due today for an obligation: [14], [3], or [].
export function reminderLeads(daysLeft: number, leads = [14, 3]) {
  return leads.filter((l) => l === daysLeft);
}
