// ops-health-check — daily operational health check for the office.
//
// Meant for pg_cron at 06:30 Sydney (see the schedule SQL in the deploy notes).
// verify_jwt = false; guarded by the `x-digest-secret` header, which must equal
// the DIGEST_SECRET project secret. FAILS CLOSED: if DIGEST_SECRET is unset the
// function refuses every call (503) rather than running open.
//
// What one run computes (all dates are Australia/Sydney calendar dates):
//   1. timesheets / headers still pending approval older than 3 days
//   2. approved sheets in the last 14 days with no 'sent' row in timesheet_sends
//   3. subcontractors with no pay rate and no worker_role_rates row; any active
//      worker with pay_rate_regular null       (NAMES + COUNTS ONLY — no money)
//   4. certifications / worker_certificates expired or expiring within 14 days
//   5. allocations still 'pending' (not accepted) that cover today or tomorrow
//   6. allocation groups starting within 2 days that are not yet full
//   7. workers with a confirmed allocation yesterday but no timesheet line
//
// Then it:
//   • inserts ONE `notifications` row (type 'ops_health') for the admin bell,
//   • inserts ONE `activity_events` row (verb 'ran', object_type 'health_check'),
//   • inserts the full summary into `ops_health_checks` (office-readable via RLS),
//   • returns the summary JSON.
// Idempotent in the sense that a second run simply records another row.
//
// Request:  POST (empty body) — optional { date?: 'YYYY-MM-DD', dry_run?: true }
//           `date` overrides "today" for testing; `dry_run` computes but writes nothing.
// Response: 200 { ok, date, run_at, issue_count, dry_run, checks: {...}, bullets: [...],
//                 notification_id, health_check_id }
//           401 { error: 'unauthorized' } · 503 { error: 'not_configured' }
//           500 { error: 'server_error' } (never a stack trace)
//
// Every check is wrapped so one failing query degrades to { error: 'query_failed' }
// for that check instead of killing the run. No money column is ever selected —
// the pay-rate checks use `is null` filters so the values never leave the DB.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const DIGEST_SECRET        = Deno.env.get('DIGEST_SECRET') || '';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-digest-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const ITEM_CAP = 40;           // list cap per check; counts are always complete
const DATE_RE  = /^\d{4}-\d{2}-\d{2}$/;

// ── Sydney date helpers (same approach as cert-reminders) ─────────────────
function sydneyToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
}
function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + 'T12:00:00Z').getTime() - new Date(a + 'T12:00:00Z').getTime()) / 86_400_000);
}
function plural(n: number, one: string, many = one + 's') { return `${n} ${n === 1 ? one : many}`; }

type Check = { count: number; items: string[]; [k: string]: unknown };
const failed = (): Check => ({ count: 0, items: [], error: 'query_failed' });
function cap(items: string[]) { return items.length > ITEM_CAP ? [...items.slice(0, ITEM_CAP), `… and ${items.length - ITEM_CAP} more`] : items; }

type WorkerLite = { id: string; name: string; archived: boolean; role: string | null; worker_type: string | null; app_status: string | null };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  // Guard — fail closed.
  if (!DIGEST_SECRET) return json({ error: 'not_configured' }, 503);
  if ((req.headers.get('x-digest-secret') || '') !== DIGEST_SECRET) {
    // `hdr:false` = the header never arrived (cron misconfigured); true = wrong value. No values leak.
    return json({ error: 'unauthorized', hdr: !!req.headers.get('x-digest-secret') }, 401);
  }

  try {
    let body: { date?: string; dry_run?: boolean } = {};
    try { body = await req.json(); } catch { /* empty body from cron */ }
    const dryRun = body?.dry_run === true;

    const today     = body?.date && DATE_RE.test(body.date) ? body.date : sydneyToday();
    const yesterday = addDays(today, -1);
    const tomorrow  = addDays(today, 1);
    const plus2     = addDays(today, 2);
    const plus14    = addDays(today, 14);
    const minus3    = addDays(today, -3);
    const minus14   = addDays(today, -14);
    const since14Iso = new Date(minus14 + 'T00:00:00Z').toISOString();
    const minus3Iso  = new Date(minus3  + 'T00:00:00Z').toISOString();

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Worker id → lite record (names for every list; archived flag for filtering).
    const workers = new Map<string, WorkerLite>();
    try {
      const { data } = await sb.from('workers').select('id, name, archived_at, role, worker_type, app_status');
      for (const w of data || []) workers.set(w.id, { id: w.id, name: w.name || 'Worker', archived: !!w.archived_at, role: w.role, worker_type: w.worker_type, app_status: w.app_status });
    } catch (e) { console.error('workers load failed:', (e as Error).message); }
    const nameOf = (id: string | null | undefined) => (id && workers.get(id)?.name) || 'Unknown worker';
    const isActiveWorker = (id: string | null | undefined) => !!id && workers.has(id) && !workers.get(id)!.archived;

    // ── 1. Pending approval > 3 days ─────────────────────────────────────────
    let pendingOld: Check = failed();
    try {
      const { data: heads, error } = await sb.from('timesheet_headers')
        .select('id, worker_id, client, client_name_snapshot, created_at')
        .eq('status', 'pending');
      if (error) throw error;
      const ids = (heads || []).map((h: any) => h.id);
      const firstLine = new Map<string, string>();
      if (ids.length) {
        const { data: lines } = await sb.from('timesheets').select('header_id, date').in('header_id', ids);
        for (const l of lines || []) {
          if (!l.date) continue;
          const cur = firstLine.get(l.header_id);
          if (!cur || l.date < cur) firstLine.set(l.header_id, l.date);
        }
      }
      const items: string[] = [];
      let oldest: string | null = null;
      for (const h of heads || []) {
        const d = firstLine.get(h.id) || String(h.created_at || '').slice(0, 10);
        if (!d || d > minus3) continue;           // not older than 3 days
        if (!oldest || d < oldest) oldest = d;
        items.push(`${nameOf(h.worker_id)} — ${h.client_name_snapshot || h.client || 'client'} (${d}, ${daysBetween(d, today)} days)`);
      }
      // Legacy stand-alone lines (no header).
      const { data: loose } = await sb.from('timesheets')
        .select('id, worker_id, client, date')
        .is('header_id', null).eq('status', 'pending').lte('date', minus3);
      for (const l of loose || []) {
        if (!oldest || (l.date && l.date < oldest)) oldest = l.date;
        items.push(`${nameOf(l.worker_id)} — ${l.client || 'client'} (${l.date}, line without header)`);
      }
      items.sort();
      pendingOld = { count: items.length, oldest_date: oldest, items: cap(items) };
    } catch (e) { console.error('check 1 failed:', (e as Error).message); }

    // ── 2. Approved in the last 14 days, PDF never sent ──────────────────────
    let approvedUnsent: Check = failed();
    try {
      const { data: heads, error } = await sb.from('timesheet_headers')
        .select('id, worker_id, client, client_name_snapshot, approved_at, updated_at, created_at, pdf_emailed_at')
        .eq('status', 'approved')
        .or(`approved_at.gte.${since14Iso},and(approved_at.is.null,updated_at.gte.${since14Iso})`);
      if (error) throw error;
      const ids = (heads || []).map((h: any) => h.id);
      const sent = new Set<string>();
      const firstLine = new Map<string, string>();
      if (ids.length) {
        const [{ data: sends }, { data: lines }] = await Promise.all([
          sb.from('timesheet_sends').select('header_id').in('header_id', ids).eq('status', 'sent'),
          sb.from('timesheets').select('header_id, date').in('header_id', ids),
        ]);
        for (const s of sends || []) if (s.header_id) sent.add(s.header_id);
        for (const l of lines || []) {
          if (!l.date) continue;
          const cur = firstLine.get(l.header_id);
          if (!cur || l.date < cur) firstLine.set(l.header_id, l.date);
        }
      }
      const items: string[] = [];
      for (const h of heads || []) {
        if (sent.has(h.id) || h.pdf_emailed_at) continue;
        const d = firstLine.get(h.id) || String(h.approved_at || h.updated_at || h.created_at || '').slice(0, 10);
        items.push(`${nameOf(h.worker_id)} — ${h.client_name_snapshot || h.client || 'client'} (${d})`);
      }
      items.sort();
      approvedUnsent = { count: items.length, items: cap(items) };
    } catch (e) { console.error('check 2 failed:', (e as Error).message); }

    // ── 3. Missing pay rates (names only, never values) ──────────────────────
    let missingRates: Check = failed();
    try {
      const { data: subs, error: e1 } = await sb.from('workers')
        .select('id, name')
        .is('archived_at', null).eq('worker_type', 'subcontractor')
        .is('pay_rate_regular', null).is('pay_rate_base', null).is('pay_rate_a', null);
      if (e1) throw e1;
      const subIds = (subs || []).map((w: any) => w.id);
      const withRoleRate = new Set<string>();
      if (subIds.length) {
        const { data: rr } = await sb.from('worker_role_rates').select('worker_id').in('worker_id', subIds).is('archived_at', null);
        for (const r of rr || []) withRoleRate.add(r.worker_id);
      }
      const subNames = (subs || []).filter((w: any) => !withRoleRate.has(w.id)).map((w: any) => w.name).sort();

      // "Active worker" = not archived, role 'worker', app_status 'Active'.
      const { data: act, error: e2 } = await sb.from('workers')
        .select('id, name')
        .is('archived_at', null).eq('role', 'worker').eq('app_status', 'Active')
        .is('pay_rate_regular', null);
      if (e2) throw e2;
      const activeNames = (act || []).map((w: any) => w.name).sort();

      const all = Array.from(new Set([...subNames, ...activeNames])).sort();
      missingRates = {
        count: all.length,
        items: cap(all),
        subcontractors_no_rate_no_role_rate: { count: subNames.length, names: cap(subNames) },
        active_workers_pay_rate_regular_null: { count: activeNames.length, names: cap(activeNames) },
      };
    } catch (e) { console.error('check 3 failed:', (e as Error).message); }

    // ── 4. Certificates expired / expiring within 14 days ────────────────────
    let certs: Check = failed();
    try {
      const [{ data: c1, error: e1 }, { data: c2, error: e2 }] = await Promise.all([
        sb.from('certifications').select('worker_id, cert_name, expiry').not('expiry', 'is', null).lte('expiry', plus14),
        sb.from('worker_certificates').select('worker_id, name, expiry_date').not('expiry_date', 'is', null).lte('expiry_date', plus14),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;
      const rows: Array<{ worker: string; cert: string; expiry: string }> = [];
      for (const c of c1 || []) if (isActiveWorker(c.worker_id)) rows.push({ worker: nameOf(c.worker_id), cert: c.cert_name || 'certificate', expiry: c.expiry });
      for (const c of c2 || []) if (isActiveWorker(c.worker_id)) rows.push({ worker: nameOf(c.worker_id), cert: c.name || 'certificate', expiry: c.expiry_date });
      rows.sort((a, b) => a.expiry.localeCompare(b.expiry) || a.worker.localeCompare(b.worker));
      const expired = rows.filter(r => r.expiry < today).length;
      const items = rows.map(r => {
        const n = daysBetween(today, r.expiry);
        const when = n < 0 ? `EXPIRED ${-n} day${n === -1 ? '' : 's'} ago` : n === 0 ? 'expires today' : `expires in ${n} day${n === 1 ? '' : 's'}`;
        return `${r.worker} — ${r.cert} (${r.expiry}, ${when})`;
      });
      certs = { count: rows.length, expired_count: expired, expiring_count: rows.length - expired, items: cap(items) };
    } catch (e) { console.error('check 4 failed:', (e as Error).message); }

    // ── 5. Allocations still pending that cover today or tomorrow ────────────
    let unaccepted: Check = failed();
    try {
      const { data, error } = await sb.from('allocations')
        .select('id, worker_id, client, site, role, start_date, end_date')
        .eq('status', 'pending')
        .not('start_date', 'is', null)
        .lte('start_date', tomorrow)
        .or(`end_date.is.null,end_date.gte.${today}`);
      if (error) throw error;
      const items = (data || [])
        .filter((a: any) => a.end_date || a.start_date >= today)   // null end_date ⇒ single day
        .map((a: any) => `${nameOf(a.worker_id)} — ${[a.client, a.site].filter(Boolean).join(' / ') || 'client'} (${a.role || 'role'}, ${a.start_date})`)
        .sort();
      unaccepted = { count: items.length, items: cap(items) };
    } catch (e) { console.error('check 5 failed:', (e as Error).message); }

    // ── 6. Groups starting within 2 days that are not full ───────────────────
    let groupsNotFull: Check = failed();
    try {
      const { data: groups, error } = await sb.from('allocation_groups')
        .select('id, positions, client, site, role, start_date')
        .gte('start_date', today).lte('start_date', plus2)
        .is('filled_at', null);
      if (error) throw error;
      const ids = (groups || []).map((g: any) => g.id);
      const confirmed = new Map<string, number>();
      if (ids.length) {
        const { data: rows } = await sb.from('allocations').select('group_id').in('group_id', ids).eq('status', 'confirmed');
        for (const r of rows || []) confirmed.set(r.group_id, (confirmed.get(r.group_id) || 0) + 1);
      }
      const items: string[] = [];
      for (const g of groups || []) {
        const c = confirmed.get(g.id) || 0;
        if (c >= (g.positions || 1)) continue;
        items.push(`${[g.client, g.site].filter(Boolean).join(' / ') || 'job'} (${g.role || 'role'}, ${g.start_date}) — ${c} of ${g.positions} confirmed`);
      }
      items.sort();
      groupsNotFull = { count: items.length, items: cap(items) };
    } catch (e) { console.error('check 6 failed:', (e as Error).message); }

    // ── 7. Confirmed yesterday, no timesheet line for that date ──────────────
    let missedTimesheets: Check = failed();
    try {
      const [{ data: allocs, error: e1 }, { data: lines, error: e2 }] = await Promise.all([
        sb.from('allocations')
          .select('worker_id, client, site, start_date, end_date')
          .in('status', ['confirmed', 'completed'])
          .eq('allocation_type', 'work')
          .lte('start_date', yesterday)
          .or(`end_date.is.null,end_date.gte.${yesterday}`),
        sb.from('timesheets').select('worker_id').eq('date', yesterday),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;
      const hasSheet = new Set((lines || []).map((l: any) => l.worker_id));
      const seen = new Set<string>();
      const items: string[] = [];
      for (const a of allocs || []) {
        if (!a.worker_id || seen.has(a.worker_id)) continue;
        if (!a.end_date && a.start_date !== yesterday) continue;   // null end_date ⇒ single day
        if (!isActiveWorker(a.worker_id) || hasSheet.has(a.worker_id)) continue;
        seen.add(a.worker_id);
        items.push(`${nameOf(a.worker_id)} — ${[a.client, a.site].filter(Boolean).join(' / ') || 'client'}`);
      }
      items.sort();
      missedTimesheets = { count: items.length, date: yesterday, items: cap(items) };
    } catch (e) { console.error('check 7 failed:', (e as Error).message); }

    // ── Summary ──────────────────────────────────────────────────────────────
    const checks = {
      pending_approval_over_3_days:       pendingOld,
      approved_not_sent_14_days:          approvedUnsent,
      missing_pay_rates:                  missingRates,
      certs_expired_or_expiring_14_days:  certs,
      unaccepted_allocations_today_tomorrow: unaccepted,
      groups_not_full_within_2_days:      groupsNotFull,
      missed_timesheets_yesterday:        missedTimesheets,
    };
    const queryErrors = Object.entries(checks).filter(([, c]) => c.error).map(([k]) => k);
    const issueCount  = Object.values(checks).reduce((n, c) => n + (c.count || 0), 0);

    const bullets: string[] = [];
    if (pendingOld.count)       bullets.push(`• ${plural(pendingOld.count, 'timesheet')} waiting for approval for over 3 days (oldest ${pendingOld.oldest_date})`);
    if (approvedUnsent.count)   bullets.push(`• ${plural(approvedUnsent.count, 'approved timesheet')} not yet sent to the client`);
    if (missingRates.count)     bullets.push(`• ${plural(missingRates.count, 'worker')} without a pay rate: ${(missingRates.items as string[]).slice(0, 5).join(', ')}`);
    if (certs.count)            bullets.push(`• ${plural(certs.count, 'certificate')} expired or expiring within 14 days (${certs.expired_count} expired)`);
    if (unaccepted.count)       bullets.push(`• ${plural(unaccepted.count, 'allocation')} not yet accepted for today/tomorrow: ${(unaccepted.items as string[]).slice(0, 3).join('; ')}`);
    if (groupsNotFull.count)    bullets.push(`• ${plural(groupsNotFull.count, 'crew')} not full within 2 days: ${(groupsNotFull.items as string[]).slice(0, 3).join('; ')}`);
    if (missedTimesheets.count) bullets.push(`• ${plural(missedTimesheets.count, 'missed timesheet')} for ${yesterday}: ${(missedTimesheets.items as string[]).slice(0, 5).join('; ')}`);
    if (queryErrors.length)     bullets.push(`• ${plural(queryErrors.length, 'check')} could not run: ${queryErrors.join(', ')}`);

    const runAt = new Date().toISOString();
    const title = issueCount ? `Daily health check: ${plural(issueCount, 'issue')}` : 'Daily health check: all clear';
    const summary = { date: today, run_at: runAt, issue_count: issueCount, checks, bullets, query_errors: queryErrors };

    let notificationId: string | null = null;
    let healthCheckId: number | null = null;
    if (!dryRun) {
      try {
        const { data, error } = await sb.from('notifications').insert([{
          type: 'ops_health', title,
          body: (bullets.length ? bullets.join('\n') : 'No issues found. Timesheets, rates, tickets, allocations and crews all look healthy.').slice(0, 1500),
        }]).select('id').single();
        if (error) throw error;
        notificationId = data?.id ?? null;
      } catch (e) { console.error('bell insert failed:', (e as Error).message); }

      try {
        const { error } = await sb.from('activity_events').insert([{
          actor_name: 'portal', verb: 'ran', object_type: 'health_check', object_id: null, after: summary,
        }]);
        if (error) throw error;
      } catch (e) { console.error('activity insert failed:', (e as Error).message); }

      try {
        const { data, error } = await sb.from('ops_health_checks').insert([{ run_at: runAt, issue_count: issueCount, summary }]).select('id').single();
        if (error) throw error;
        healthCheckId = data?.id ?? null;
      } catch (e) { console.error('ops_health_checks insert failed:', (e as Error).message); }
    }

    return json({ ok: true, dry_run: dryRun, ...summary, title, notification_id: notificationId, health_check_id: healthCheckId });
  } catch (e) {
    console.error('ops-health-check failed:', (e as Error)?.message);
    return json({ error: 'server_error' }, 500);
  }
});
