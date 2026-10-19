// xero-invoice-sync — pull each client invoice's status back from Xero so the
// portal knows when it is Paid / Overdue / Voided.
//
//   POST {}                    → sync every Xero invoice that needs it
//   POST { client_id }         → only that client's invoices
//   200  { ok, checked, changed, errors: string[], overdue_notified, xero_connected, scope_ok, message? }
//
// Which rows: client_invoices with a xero_invoice_id that are still open
// (status anything but PAID / VOIDED / DELETED) or have never been synced. A row
// that Xero has reported in a final state (PAID / VOIDED / DELETED) is never
// asked about again. Order: never-synced first, then the longest-unchecked, at
// most MAX_ROWS (500) per run — so a new invoice is never starved by old ones
// and the rest rotate through on the next runs.
// Xero: GET /api.xro/2.0/Invoices?IDs=a,b,c in batches of 50.
// Per row: xero_status, amount_due / amount_paid / total (inc GST), due_date,
// fully_paid_on, xero_synced_at, sync_error. A status change writes ONE
// activity_events row (verb 'invoice status changed', before/after status —
// never amounts: the office can read activity). An invoice that turns overdue
// (AUTHORISED, still owing, due date before today in Sydney) gets ONE bell
// notification for the office, deduped by client_invoices.overdue_notified_on
// (no dollar amounts in the bell either — notifications are office-readable).
//
// "Xero not connected", "scope missing" and a failed token refresh are answers,
// not crashes: 200 { ok:false, reason, message } and the reason is written to
// sync_error on the rows that were due.
//
// GATE (verify_jwt = false):
//   • cron: header x-digest-secret == DIGEST_SECRET (fails closed if unset)
//   • service-role bearer (other functions)
//   • a signed-in user with access_level admin (same rule as the RLS on
//     client_invoices: is_portal_admin())
//   Anything else → 401 (no / bad credentials) or 403 (signed in, not admin).
//
// Token refresh: xeroToken.ts (shared with xero-invoice / xero-data /
// xero-push; a lease on the xero_tokens row so two refreshes never collide).

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getXeroAccessToken } from './xeroToken.ts';

const XERO_CLIENT_ID       = Deno.env.get('XERO_CLIENT_ID') || '';
const XERO_CLIENT_SECRET   = Deno.env.get('XERO_CLIENT_SECRET') || '';
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;
const DIGEST_SECRET        = Deno.env.get('DIGEST_SECRET') || '';

const ACCOUNTING = 'https://api.xero.com/api.xro/2.0';
const BATCH = 50;
const MAX_ROWS = 500;   // 10 Xero calls per run, well inside Xero's 60 calls / minute
const CLOSED = ['PAID', 'VOIDED', 'DELETED'];

const ALLOWED_ORIGINS = [
  'https://portal.cbdpnl.com.au',
  'https://cbd-portal-gray.vercel.app',
  'https://cbd-portal-zeta.vercel.app',
  'http://localhost:3000',
];
function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-digest-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

// ── Pure helpers (port of src/utils/invoiceStatus.js — keep in step) ───────
const numOrNull = (v: unknown) => {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};
function sydneyToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
}
function isOverdue(xeroStatus: unknown, dueDate: unknown, amountDue: unknown, today: string): boolean {
  if (String(xeroStatus || '').toUpperCase() !== 'AUTHORISED') return false;
  if (!dueDate || !today) return false;
  const due = numOrNull(amountDue);
  if (due !== null && due <= 0) return false;
  return String(dueDate).slice(0, 10) < today.slice(0, 10);
}
function parseXeroDate(v: unknown): string | null {
  if (!v) return null;
  const s = String(v);
  const ms = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(s);
  if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10);
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return iso ? iso[1] : null;
}
const fmtAU = (iso: string | null) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
};
const daysLate = (due: string, today: string) =>
  Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${due}T12:00:00Z`)) / 86400000);

// ── Caller gate ─────────────────────────────────────────────────────────────
type Gate =
  | { ok: true; via: 'cron' | 'service' | 'user'; worker: { id: string; name: string | null } | null; email: string | null }
  | { ok: false; status: number; error: string };
async function gateCaller(req: Request): Promise<Gate> {
  const digest = req.headers.get('x-digest-secret');
  if (digest !== null) {
    if (!DIGEST_SECRET) return { ok: false, status: 503, error: 'not_configured' };
    if (digest === DIGEST_SECRET) return { ok: true, via: 'cron', worker: null, email: null };
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return { ok: false, status: 401, error: 'Unauthorized' };
  if (bearer === SUPABASE_SERVICE_KEY) return { ok: true, via: 'service', worker: null, email: null };
  const { data: { user }, error } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY).auth.getUser(bearer);
  if (error || !user?.email) return { ok: false, status: 401, error: 'Unauthorized' };
  const { data: w } = await createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY).from('workers')
    .select('id, name, access_level').eq('email', user.email.toLowerCase()).is('archived_at', null).maybeSingle();
  if (!w || w.access_level !== 'admin') return { ok: false, status: 403, error: 'Admin only' };
  return { ok: true, via: 'user', worker: { id: w.id, name: w.name }, email: user.email };
}

serve(async (req) => {
  const origin = req.headers.get('Origin');
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  const gate = await gateCaller(req);
  if (!gate.ok) return json({ error: gate.error }, gate.status);

  try {
    const body = await req.json().catch(() => ({}));
    const clientId = typeof body?.client_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.client_id) ? body.client_id : null;
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const today = sydneyToday();

    // ── Which rows need a look ──────────────────────────────────────────────
    let q = sb.from('client_invoices')
      .select('id, client, client_id, xero_invoice_id, xero_invoice_number, xero_status, due_date, overdue_notified_on, xero_synced_at')
      .not('xero_invoice_id', 'is', null)
      .or(`xero_status.is.null,xero_status.not.in.(${CLOSED.join(',')}),xero_synced_at.is.null`)
      .order('xero_synced_at', { ascending: true, nullsFirst: true })
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS);
    if (clientId) q = q.eq('client_id', clientId);
    const { data: rows, error: rErr } = await q;
    if (rErr) { console.error('load failed:', rErr.message); return json({ ok: false, checked: 0, changed: 0, errors: ['Could not read the invoice list.'] }); }

    // ── Xero state ──────────────────────────────────────────────────────────
    const { data: tokenRow } = await sb.from('xero_tokens').select('tenant_id, scope').eq('id', 1).maybeSingle();
    const xeroConnected = !!tokenRow?.tenant_id;
    const scope = String(tokenRow?.scope || '');
    const scopeOk = scope.includes('accounting.transactions');   // full or .read both cover GET Invoices

    if (!rows || !rows.length) {
      return json({ ok: true, checked: 0, changed: 0, errors: [], overdue_notified: 0, xero_connected: xeroConnected, scope_ok: scopeOk,
        message: 'No Xero invoices need checking.' });
    }

    const ids = rows.map((r: any) => r.id);
    const failAll = async (reason: string, message: string) => {
      await sb.from('client_invoices').update({ sync_error: message }).in('id', ids);
      return json({ ok: false, reason, checked: 0, pending: rows.length, changed: 0, errors: [message],
        xero_connected: xeroConnected, scope_ok: scopeOk, message });
    };
    if (!xeroConnected) return await failAll('not_connected', 'Xero is not connected. Go to Payroll → "Connect Xero" first.');
    if (!scopeOk) return await failAll('scope_missing', 'Xero is connected without invoice permission. Go to Payroll → "Reconnect" once to grant accounting.transactions.');
    if (!XERO_CLIENT_ID || !XERO_CLIENT_SECRET) return await failAll('not_configured', 'Xero app keys are not set on the server.');
    const accessToken = await getAccessToken(sb);
    if (!accessToken) return await failAll('token_refresh_failed', 'Xero sign-in has expired. Reconnect Xero from the Payroll page.');
    const tenantId = String(tokenRow!.tenant_id);

    // ── Ask Xero, 50 at a time ──────────────────────────────────────────────
    const errors: string[] = [];
    let checked = 0; let changed = 0; let overdueNotified = 0;
    const actorName = gate.via === 'user' ? (gate.worker?.name || gate.email || 'office') : 'portal';
    const syncedAt = new Date().toISOString();

    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const byXeroId = new Map(batch.map((r: any) => [String(r.xero_invoice_id).toLowerCase(), r]));
      const res = await fetch(`${ACCOUNTING}/Invoices?IDs=${batch.map((r: any) => encodeURIComponent(r.xero_invoice_id)).join(',')}`, {
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Xero-Tenant-Id': tenantId, 'Accept': 'application/json' },
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 200);
        const msg = res.status === 401 || res.status === 403
          ? 'Xero refused the request (missing invoice permission). Go to Payroll → "Reconnect" once to grant accounting.transactions.'
          : res.status === 429 ? 'Xero rate limit hit — try again in a minute.'
          : `Xero error ${res.status}${text ? `: ${text}` : ''}`;
        console.error('xero batch failed:', res.status);
        errors.push(msg);
        await sb.from('client_invoices').update({ sync_error: msg }).in('id', batch.map((r: any) => r.id));
        if (res.status === 401 || res.status === 403) break;   // every other batch would fail the same way
        continue;
      }
      const data = await res.json().catch(() => ({}));
      const seen = new Set<string>();
      for (const inv of (data?.Invoices || []) as any[]) {
        const row: any = byXeroId.get(String(inv.InvoiceID || '').toLowerCase());
        if (!row) continue;
        seen.add(row.id);
        checked += 1;
        const newStatus = String(inv.Status || '').toUpperCase() || null;
        const dueDate = parseXeroDate(inv.DueDateString || inv.DueDate);
        const amountDue = numOrNull(inv.AmountDue);
        const overdue = isOverdue(newStatus, dueDate, amountDue, today);
        const patch: Record<string, unknown> = {
          xero_status: newStatus,
          amount_due: amountDue,
          amount_paid: numOrNull(inv.AmountPaid),
          total: numOrNull(inv.Total),
          due_date: dueDate,
          fully_paid_on: parseXeroDate(inv.FullyPaidOnDate),
          xero_synced_at: syncedAt,
          sync_error: null,
        };
        if (inv.InvoiceNumber && inv.InvoiceNumber !== row.xero_invoice_number) patch.xero_invoice_number = inv.InvoiceNumber;
        if (!overdue && row.overdue_notified_on) patch.overdue_notified_on = null;   // spell over → a new one may bell again

        // Overdue bell — once per overdue spell (and so never twice a day).
        if (overdue && !row.overdue_notified_on) {
          const number = inv.InvoiceNumber || row.xero_invoice_number || 'An invoice';
          const late = daysLate(dueDate!, today);
          const { error: nErr } = await sb.from('notifications').insert([{
            type: 'invoice_overdue',
            title: `${number} is overdue`,
            body: `${row.client || 'Client'} · was due ${fmtAU(dueDate)} · ${late} day${late === 1 ? '' : 's'} late. Finance → Invoices.`,
          }]);
          if (nErr) console.error('bell insert failed:', nErr.message);
          else { patch.overdue_notified_on = today; overdueNotified += 1; }
        }

        const { error: uErr } = await sb.from('client_invoices').update(patch).eq('id', row.id);
        if (uErr) { errors.push(`${row.xero_invoice_number || row.id}: not saved (${uErr.message})`); continue; }

        const oldStatus = row.xero_status ? String(row.xero_status).toUpperCase() : null;
        if (oldStatus !== newStatus) {
          changed += 1;
          const { error: aErr } = await sb.from('activity_events').insert([{
            actor_id: gate.via === 'user' ? gate.worker?.id || null : null,
            actor_name: actorName,
            verb: 'invoice status changed', object_type: 'client_invoice', object_id: row.id, client_id: row.client_id || null,
            before: { status: oldStatus },
            after: { status: newStatus, number: inv.InvoiceNumber || row.xero_invoice_number || null, overdue },
          }]);
          if (aErr) console.error('activity insert failed:', aErr.message);
        }
      }
      // Asked for but not returned → deleted in Xero or another organisation.
      const missing = batch.filter((r: any) => !seen.has(r.id));
      if (missing.length) {
        const msg = 'Not found in the connected Xero organisation.';
        await sb.from('client_invoices').update({ sync_error: msg, xero_synced_at: syncedAt }).in('id', missing.map((r: any) => r.id));
        for (const r of missing) errors.push(`${r.xero_invoice_number || r.xero_invoice_id}: ${msg}`);
      }
    }

    return json({ ok: errors.length === 0, checked, changed, errors, overdue_notified: overdueNotified,
      xero_connected: true, scope_ok: true, via: gate.via });
  } catch (e) {
    console.error('xero-invoice-sync failed:', (e as Error)?.message);
    return json({ ok: false, checked: 0, changed: 0, errors: ['Unexpected server error — see the function logs.'] }, 500);
  }
});

// ── Token helper: the shared, lock-safe refresh (xeroToken.ts) ────────────
async function getAccessToken(sb: ReturnType<typeof createClient>): Promise<string | null> {
  return getXeroAccessToken(sb, XERO_CLIENT_ID, XERO_CLIENT_SECRET);
}
