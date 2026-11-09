// books-sync — pulls the money lines out of the connected Xero organisation into
// the Books tables (books_transactions, books_open_items, books_accounts), on
// the portal's EXISTING Xero connection. Read-only against Xero: only GETs.
//
//   POST {}                                   → sync every endpoint, in order
//   POST { endpoint: 'BankTransactions' }     → one endpoint
//   POST { full: true }                       → ignore If-Modified-Since, 12-month window
//   200 { ok, more, results: [{ endpoint, status, pages, rows, error? }] }
//   200 { ok:false, reason:'reconnect', missing:[...] }   ← token lacks the Books scopes
//   200 { ok:false, reason:'not_connected' }               ← no Xero connection at all
//
// GATE (verify_jwt = false):
//   • cron / self-invoke: header x-digest-secret == DIGEST_SECRET (fails closed if unset)
//   • service-role bearer (other functions)
//   • a signed-in MONEY user: access_level admin/accounts AND not an allocator
//     (the same line as public.is_portal_admin() on the tables)
//
// Audit fixes designed in (A2Z audit 2026-11-07):
//   #1 truncation — pages run 1..n until a short page; at most PAGE_BUDGET pages
//      per invocation, page_reached persisted on books_sync_runs, and
//      books_sync_state.modified_since advances ONLY when a run finishes every
//      page (status ok). A resumed run asks Xero for the same window.
//   #5 one request never runs the whole import — when pages remain the function
//      returns { more:true } and invokes itself once (digest header).
//   #6/#7 token refresh — shared xeroTokens.ts lease (xero_tokens.refresh_lock_*),
//      refresh only when the access token has < 2 minutes left.
//   #4 credit notes / prepayments / overpayments are synced; is_cash tells the
//      BAS which rows are cash movements so nothing is counted twice.
//   Rate limits: 1.1 s between calls; a 429 stops the run as 'partial'.
//
// Nothing here logs a token. Transaction text from Xero is stored as data.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { withRefreshLock, getXeroMeta, hasScope } from './xeroTokens.ts';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;
const XERO_CLIENT_ID       = Deno.env.get('XERO_CLIENT_ID') || '';
const XERO_CLIENT_SECRET   = Deno.env.get('XERO_CLIENT_SECRET') || '';
const DIGEST_SECRET        = Deno.env.get('DIGEST_SECRET') || '';

const ACCOUNTING    = 'https://api.xero.com/api.xro/2.0';
const PAGE_SIZE     = 100;    // Xero's page size for these endpoints
const PAGE_BUDGET   = 8;      // pages per invocation (≈ 9 s of pacing + upserts)
const PACE_MS       = 1100;   // Xero: 60 calls / minute
const WINDOW_MONTHS = 12;     // full sync looks this far back
const MAX_HOPS      = 24;     // self-invocations per chain (24 × 8 = 192 pages); cron picks up the rest
const STALE_RUN_MS  = 90_000; // a 'running' run with no heartbeat for this long is resumable
// Granular Xero scopes (this app rejects the umbrella accounting.transactions):
// bank transactions, payments (+ prepayments/overpayments), chart of accounts.
// Invoices + credit notes ride on accounting.invoices, which Payroll already had.
const REQUIRED_SCOPES    = ['accounting.banktransactions.read', 'accounting.payments.read', 'accounting.settings.read', 'accounting.invoices'];
const RECOMMENDED_SCOPES: string[] = [];

type Endpoint = 'BankTransactions' | 'Payments' | 'CreditNotes' | 'Prepayments' | 'Overpayments' | 'Invoices' | 'Accounts';
const ENDPOINTS: Endpoint[] = ['BankTransactions', 'Payments', 'CreditNotes', 'Prepayments', 'Overpayments', 'Invoices', 'Accounts'];

const ALLOWED_ORIGINS = [
  'https://portal.cbdpnl.com.au',
  'https://cbd-portal-gray.vercel.app',
  'https://cbd-portal-zeta.vercel.app',
  'http://localhost:3000',
  'http://localhost:3111',
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

// deno-lint-ignore no-explicit-any
type Any = any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};
function parseXeroDate(v: unknown): string | null {
  if (!v) return null;
  const s = String(v);
  const ms = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(s);
  if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10);
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return iso ? iso[1] : null;
}
function parseXeroStamp(v: unknown): string | null {
  if (!v) return null;
  const s = String(v);
  const ms = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(s);
  if (ms) return new Date(Number(ms[1])).toISOString();
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
const firstLine = (o: Any) => (Array.isArray(o?.LineItems) && o.LineItems.length ? o.LineItems[0] : null);
const trunc = (s: unknown, n: number) => (s === null || s === undefined ? null : String(s).slice(0, n));

// ── Caller gate ─────────────────────────────────────────────────────────────
type Gate =
  | { ok: true; via: 'cron' | 'service' | 'user'; label: string }
  | { ok: false; status: number; error: string };
async function gateCaller(req: Request): Promise<Gate> {
  const digest = req.headers.get('x-digest-secret');
  if (digest !== null) {
    if (!DIGEST_SECRET) return { ok: false, status: 503, error: 'not_configured' };
    if (digest === DIGEST_SECRET) return { ok: true, via: 'cron', label: 'cron' };
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return { ok: false, status: 401, error: 'Unauthorized' };
  if (bearer === SUPABASE_SERVICE_KEY) return { ok: true, via: 'service', label: 'service' };
  const { data: { user }, error } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY).auth.getUser(bearer);
  if (error || !user?.email) return { ok: false, status: 401, error: 'Unauthorized' };
  const { data: w } = await createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY).from('workers')
    .select('id, name, access_level, is_allocator').eq('email', user.email.toLowerCase()).is('archived_at', null).maybeSingle();
  const money = !!w && ['admin', 'accounts'].includes(w.access_level || '') && !w.is_allocator;
  if (!money) return { ok: false, status: 403, error: 'Admin or accounts only' };
  return { ok: true, via: 'user', label: user.email.toLowerCase() };
}

// ── Row mappers (Xero JSON → our tables) ────────────────────────────────────
type TxnRow = Record<string, unknown>;
function baseRow(o: Any, xeroId: string, kind: string, direction: 'in' | 'out', isCash: boolean): TxnRow {
  const li = firstLine(o);
  return {
    xero_id: xeroId, kind, direction, is_cash: isCash,
    txn_date: parseXeroDate(o.DateString || o.Date),
    contact_id: o.Contact?.ContactID ?? null,
    contact_name: trunc(o.Contact?.Name, 200),
    description: trunc(li?.Description ?? o.Reference ?? null, 500),
    reference: trunc(o.Reference, 200),
    total: num(o.Total), subtotal: num(o.SubTotal), gst: num(o.TotalTax),
    tax_type: li?.TaxType ?? null,
    account_code: li?.AccountCode ?? null,
    status: o.Status ?? null,
    is_reconciled: typeof o.IsReconciled === 'boolean' ? o.IsReconciled : null,
    raw: o,
    updated_utc: parseXeroStamp(o.UpdatedDateUTC),
    synced_at: new Date().toISOString(),
  };
}

function mapBankTransaction(o: Any): TxnRow | null {
  const type = String(o.Type || '').toUpperCase();
  // Transfers are not sales or purchases; prepayments / overpayments come from
  // their own endpoints (same money, one row).
  if (type.endsWith('-TRANSFER') || type.endsWith('-PREPAYMENT') || type.endsWith('-OVERPAYMENT')) return null;
  if (type !== 'SPEND' && type !== 'RECEIVE') return null;
  const row = baseRow(o, String(o.BankTransactionID), type === 'SPEND' ? 'spend' : 'receive', type === 'SPEND' ? 'out' : 'in', true);
  row.bank_account = trunc(o.BankAccount?.Name ?? o.BankAccount?.Code ?? null, 120);
  return row;
}

const PAYMENT_TYPES: Record<string, { kind: string; direction: 'in' | 'out'; sign: 1 | -1 }> = {
  ACCRECPAYMENT:        { kind: 'invoice_payment', direction: 'in',  sign: 1 },
  ACCPAYPAYMENT:        { kind: 'bill_payment',    direction: 'out', sign: 1 },
  ARCREDITPAYMENT:      { kind: 'credit_note',     direction: 'in',  sign: -1 },  // refund paid to a customer
  APCREDITPAYMENT:      { kind: 'credit_note',     direction: 'out', sign: -1 },  // refund received from a supplier
  AROVERPAYMENTPAYMENT: { kind: 'overpayment',     direction: 'in',  sign: -1 },
  APOVERPAYMENTPAYMENT: { kind: 'overpayment',     direction: 'out', sign: -1 },
  ARPREPAYMENTPAYMENT:  { kind: 'prepayment',      direction: 'in',  sign: -1 },
  APPREPAYMENTPAYMENT:  { kind: 'prepayment',      direction: 'out', sign: -1 },
};
function mapPayment(o: Any): TxnRow | null {
  const pt = PAYMENT_TYPES[String(o.PaymentType || '').toUpperCase()];
  if (!pt) return null;
  const doc = o.Invoice || o.CreditNote || o.Prepayment || o.Overpayment || {};
  const contact = doc.Contact || o.Contact || {};
  const amount = num(o.Amount);
  const number = doc.InvoiceNumber || doc.CreditNoteNumber || null;
  return {
    xero_id: String(o.PaymentID), kind: pt.kind, direction: pt.direction, is_cash: true,
    txn_date: parseXeroDate(o.DateString || o.Date),
    contact_id: contact.ContactID ?? null,
    contact_name: trunc(contact.Name, 200),
    description: trunc(number ? `${pt.sign < 0 ? 'Refund' : 'Payment'} ${number}` : (o.Reference || null), 500),
    reference: trunc(o.Reference, 200),
    invoice_number: trunc(number, 100),
    invoice_xero_id: doc.InvoiceID || doc.CreditNoteID || doc.PrepaymentID || doc.OverpaymentID || null,
    total: amount === null ? null : Math.round(amount * pt.sign * 100) / 100,
    // subtotal/gst/tax_type/account_code are NOT sent: PostgREST only updates the
    // columns present in the payload, so a re-sync never wipes what
    // books_enrich_payments filled in from the invoice (bug found 2026-11-09:
    // 1A read $0 because every hourly sync nulled the payments' GST).
    bank_account: trunc(o.Account?.Name ?? o.Account?.Code ?? null, 120),
    status: o.Status ?? null,
    is_reconciled: typeof o.IsReconciled === 'boolean' ? o.IsReconciled : null,
    raw: o, updated_utc: parseXeroStamp(o.UpdatedDateUTC), synced_at: new Date().toISOString(),
  };
}

function mapCreditNote(o: Any): TxnRow {
  const sales = String(o.Type || '').toUpperCase() === 'ACCRECCREDIT';
  // A credit note is a document; its cash effect (a refund) arrives as a Payment.
  const row = baseRow(o, String(o.CreditNoteID), 'credit_note', sales ? 'in' : 'out', false);
  row.invoice_number = trunc(o.CreditNoteNumber, 100);
  return row;
}
function mapPrepayment(o: Any): TxnRow {
  const receive = String(o.Type || '').toUpperCase().startsWith('RECEIVE');
  return baseRow(o, String(o.PrepaymentID), 'prepayment', receive ? 'in' : 'out', true);
}
function mapOverpayment(o: Any): TxnRow {
  const receive = String(o.Type || '').toUpperCase().startsWith('RECEIVE');
  return baseRow(o, String(o.OverpaymentID), 'overpayment', receive ? 'in' : 'out', true);
}
// Documents whose totals apportion GST onto their payments / refunds.
function enrichRecord(o: Any, id: string) {
  const li = firstLine(o);
  return { invoice_id: id, total: num(o.Total), total_tax: num(o.TotalTax), tax_type: li?.TaxType ?? null, account_code: li?.AccountCode ?? null };
}

// ── One endpoint, resumable, budgeted ───────────────────────────────────────
type EpResult = { endpoint: Endpoint; status: 'ok' | 'running' | 'partial' | 'error' | 'busy'; pages: number; rows: number; error?: string; retry_after?: number };

async function syncEndpoint(sb: Any, ep: Endpoint, token: string, tenantId: string, full: boolean, budget: number, triggeredBy: string): Promise<EpResult> {
  const out: EpResult = { endpoint: ep, status: 'ok', pages: 0, rows: 0 };
  const nowIso = () => new Date().toISOString();

  // ── Find or start the run ──────────────────────────────────────────────
  const { data: state } = await sb.from('books_sync_state').select('*').eq('endpoint', ep).maybeSingle();
  let run: Any = null;
  if (state?.in_progress_run) {
    const { data: r } = await sb.from('books_sync_runs').select('*').eq('id', state.in_progress_run).maybeSingle();
    if (r && r.status === 'running') {
      const hb = Date.parse(r.heartbeat_at || r.started_at);
      if (Date.now() - hb < STALE_RUN_MS) { out.status = 'busy'; out.error = 'another sync is working on this endpoint'; return out; }
      run = r;   // resume where it stopped: same window, next page (fix #1)
    }
  }
  if (!run) {
    const since: string | null = full ? null : (state?.modified_since ?? null);
    const { data: r, error: rErr } = await sb.from('books_sync_runs').insert([{
      endpoint: ep, triggered_by: triggeredBy, modified_since_used: since, full_sync: !since, heartbeat_at: nowIso(),
    }]).select('*').single();
    if (rErr || !r) { out.status = 'error'; out.error = `could not open a run: ${rErr?.message || 'no row'}`; return out; }
    run = r;
    await sb.from('books_sync_state').upsert({ endpoint: ep, in_progress_run: run.id, modified_since: state?.modified_since ?? null, last_ok_at: state?.last_ok_at ?? null, last_error: state?.last_error ?? null }, { onConflict: 'endpoint' });
  }

  const since: string | null = run.modified_since_used ?? null;
  let page = Number(run.page_reached || 0) + 1;
  let rowsTotal = Number(run.rows_upserted || 0);
  const runStarted = run.started_at as string;

  const finish = async (status: 'ok' | 'partial' | 'error', error: string | null, retryAfter?: number) => {
    await sb.from('books_sync_runs').update({ status, finished_at: nowIso(), error, page_reached: page - 1, rows_upserted: rowsTotal, heartbeat_at: nowIso() }).eq('id', run.id);
    const patch: Record<string, unknown> = { endpoint: ep, in_progress_run: null, last_error: error };
    if (status === 'ok') {
      // Only a COMPLETE run moves the window forward (fix #1). Five minutes of
      // overlap guards against clock skew between us and Xero.
      patch.modified_since = new Date(Date.parse(runStarted) - 5 * 60_000).toISOString();
      patch.last_ok_at = nowIso();
    }
    await sb.from('books_sync_state').upsert({ ...(state || {}), ...patch }, { onConflict: 'endpoint' });
    out.status = status; out.rows = rowsTotal; if (error) out.error = error; if (retryAfter) out.retry_after = retryAfter;
    return out;
  };

  // ── Pages ──────────────────────────────────────────────────────────────
  const windowFrom = new Date(); windowFrom.setUTCMonth(windowFrom.getUTCMonth() - WINDOW_MONTHS);
  const headers: Record<string, string> = { 'Authorization': `Bearer ${token}`, 'Xero-Tenant-Id': tenantId, 'Accept': 'application/json' };
  if (since) headers['If-Modified-Since'] = new Date(since).toUTCString();

  while (out.pages < budget) {
    const params = new URLSearchParams();
    if (ep !== 'Accounts') {
      params.set('page', String(page));
      params.set('order', 'UpdatedDateUTC ASC');
      if (!since) params.set('where', `Date>=DateTime(${windowFrom.getUTCFullYear()},${windowFrom.getUTCMonth() + 1},${windowFrom.getUTCDate()})`);
    }
    const url = `${ACCOUNTING}/${ep}${params.toString() ? `?${params}` : ''}`;
    await sleep(PACE_MS);
    let res: Response;
    try { res = await fetch(url, { headers }); }
    catch (e) { return finish('error', `Xero unreachable: ${(e as Error)?.message || 'network'}`); }
    out.pages += 1;

    if (res.status === 429 || res.headers.get('X-Rate-Limit-Problem')) {
      const ra = parseInt(res.headers.get('Retry-After') || '60', 10) || 60;
      return finish('partial', `Xero rate limit (${res.headers.get('X-Rate-Limit-Problem') || '429'}); retry after ${ra} s`, ra);
    }
    if (res.status === 304) {   // nothing modified since: a complete, empty run
      return finish('ok', null);
    }
    if (res.status === 401 || res.status === 403) {
      return finish('error', `Xero refused ${ep} (${res.status}) — reconnect Xero to grant the Books scopes`);
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      return finish('error', `Xero error ${res.status} on ${ep}${text ? `: ${text}` : ''}`);
    }
    const data = await res.json().catch(() => ({}));
    const items: Any[] = Array.isArray(data?.[ep]) ? data[ep] : [];

    // ── Store ────────────────────────────────────────────────────────────
    let n = 0;
    if (ep === 'Accounts') {
      const rows = items.filter((a) => a.Code).map((a) => ({
        code: String(a.Code), name: trunc(a.Name, 200), type: a.Type ?? null, tax_type: a.TaxType ?? null,
        class: a.Class ?? null, status: a.Status ?? null, synced_at: nowIso(),
      }));
      if (rows.length) {
        const { error } = await sb.from('books_accounts').upsert(rows, { onConflict: 'code' });
        if (error) return finish('error', `save failed (accounts): ${error.message}`);
        n = rows.length;
      }
    } else if (ep === 'Invoices') {
      const open: Any[] = []; const closed: string[] = []; const enrich: Any[] = [];
      for (const inv of items) {
        const id = String(inv.InvoiceID || ''); if (!id) continue;
        const status = String(inv.Status || '').toUpperCase();
        const type = String(inv.Type || '').toUpperCase();
        if (status === 'AUTHORISED' && (num(inv.AmountDue) ?? 0) > 0 && (type === 'ACCREC' || type === 'ACCPAY')) {
          open.push({
            xero_id: id, item_type: type, contact_id: inv.Contact?.ContactID ?? null, contact_name: trunc(inv.Contact?.Name, 200),
            number: trunc(inv.InvoiceNumber, 100), issue_date: parseXeroDate(inv.DateString || inv.Date), due_date: parseXeroDate(inv.DueDateString || inv.DueDate),
            total: num(inv.Total), amount_due: num(inv.AmountDue), amount_paid: num(inv.AmountPaid), status, raw: inv, synced_at: nowIso(),
          });
        } else {
          closed.push(id);   // paid, voided, deleted, or back to draft: no longer open
        }
        if ((status === 'AUTHORISED' || status === 'PAID') && (num(inv.Total) ?? 0) !== 0) enrich.push(enrichRecord(inv, id));
      }
      if (open.length) {
        const { error } = await sb.from('books_open_items').upsert(open, { onConflict: 'xero_id' });
        if (error) return finish('error', `save failed (open items): ${error.message}`);
      }
      if (closed.length) await sb.from('books_open_items').delete().in('xero_id', closed);
      if (enrich.length) {
        const { error } = await sb.rpc('books_enrich_payments', { p_invoices: enrich });
        if (error) console.error('books_enrich_payments failed:', error.message);
      }
      n = items.length;
    } else {
      const rows: TxnRow[] = []; const enrich: Any[] = [];
      for (const o of items) {
        let row: TxnRow | null = null;
        if (ep === 'BankTransactions') row = mapBankTransaction(o);
        else if (ep === 'Payments')    row = mapPayment(o);
        else if (ep === 'CreditNotes') { row = mapCreditNote(o); enrich.push(enrichRecord(o, String(o.CreditNoteID))); }
        else if (ep === 'Prepayments') { row = mapPrepayment(o); enrich.push(enrichRecord(o, String(o.PrepaymentID))); }
        else if (ep === 'Overpayments') { row = mapOverpayment(o); enrich.push(enrichRecord(o, String(o.OverpaymentID))); }
        if (row && row.xero_id && row.xero_id !== 'undefined') rows.push(row);
      }
      if (rows.length) {
        const { error } = await sb.from('books_transactions').upsert(rows, { onConflict: 'xero_id' });
        if (error) return finish('error', `save failed (${ep}): ${error.message}`);
        n = rows.length;
      }
      if (enrich.length) {
        const { error } = await sb.rpc('books_enrich_payments', { p_invoices: enrich });
        if (error) console.error('books_enrich_payments failed:', error.message);
      }
    }

    rowsTotal += n;
    await sb.from('books_sync_runs').update({ page_reached: page, rows_upserted: rowsTotal, heartbeat_at: nowIso() }).eq('id', run.id);
    out.rows = rowsTotal;

    const done = ep === 'Accounts' || items.length < PAGE_SIZE;
    page += 1;
    if (done) return finish('ok', null);
  }

  // Budget spent, pages remain: leave the run 'running' for the next hop.
  out.status = 'running';
  return out;
}

// ── HTTP ────────────────────────────────────────────────────────────────────
serve(async (req) => {
  const origin = req.headers.get('Origin');
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  const gate = await gateCaller(req);
  if (!gate.ok) return json({ error: gate.error }, gate.status);

  const body = await req.json().catch(() => ({})) as { endpoint?: string; full?: boolean; hop?: number; check?: boolean };
  const only = ENDPOINTS.find((e) => e.toLowerCase() === String(body?.endpoint || '').toLowerCase()) || null;
  const full = body?.full === true;
  const hop = Number(body?.hop || 0);
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    // ── Connection + scopes (no Xero call yet) ─────────────────────────────
    const meta = await getXeroMeta(sb);
    if (!meta.connected) return json({ ok: false, reason: 'not_connected', message: 'Xero is not connected. Go to Payroll → "Connect Xero" first.' });
    const missing = [...REQUIRED_SCOPES, ...RECOMMENDED_SCOPES].filter((s) => !hasScope(meta.scope, s));
    const missingRequired = REQUIRED_SCOPES.filter((s) => !hasScope(meta.scope, s));
    if (missingRequired.length) {
      return json({ ok: false, reason: 'reconnect', missing, message: 'Reconnect Xero once to turn on Books (the connection was made before the Books permissions existed).' });
    }
    if (!XERO_CLIENT_ID || !XERO_CLIENT_SECRET) return json({ ok: false, reason: 'not_configured', message: 'Xero app keys are not set on the server.' });
    // { check:true } — the Books page asking "are the scopes there?" on load.
    // Answers from the stored scope list; no Xero call, no sync.
    if (body?.check === true) return json({ ok: true, reason: 'ready', missing, connected: true });

    // Refresh only inside the last 2 minutes of the access token's life (fix #6).
    const token = await withRefreshLock(sb, XERO_CLIENT_ID, XERO_CLIENT_SECRET, 120);
    if (!token) return json({ ok: false, reason: 'reconnect', missing, message: 'Xero sign-in has expired. Reconnect Xero from the Payroll page.' });

    // ── Endpoints, in order, inside the page budget ────────────────────────
    const list: Endpoint[] = only ? [only] : ENDPOINTS;
    const results: EpResult[] = [];
    let budget = PAGE_BUDGET;
    let more = false;
    let stop = false;
    for (const ep of list) {
      if (budget <= 0) { more = true; break; }
      const r = await syncEndpoint(sb, ep, token, meta.tenant_id!, full, budget, gate.label);
      results.push(r);
      budget -= r.pages;
      if (r.status === 'running') { more = true; break; }                 // pages remain: next hop continues here
      if (r.status === 'partial') { stop = true; break; }                 // rate limited: let the hour pass
      if (r.status === 'error' && /refused|reconnect/.test(r.error || '')) { stop = true; break; }
      if (r.status === 'ok') {
        await sb.from('activity_events').insert([{
          actor_id: null, actor_name: gate.via === 'user' ? gate.label : 'portal',
          verb: 'books synced', object_type: 'books', object_id: null,
          after: { endpoint: ep, rows: r.rows, pages: r.pages, full: full || undefined },
        }]).then(({ error }: Any) => { if (error) console.error('activity insert failed:', error.message); });
      }
    }
    if (results.some((r) => r.endpoint === 'Accounts' && r.status === 'ok') || results.some((r) => r.status === 'ok')) {
      await sb.rpc('books_post_sync').then(({ error }: Any) => { if (error) console.error('books_post_sync failed:', error.message); });
    }

    // ── Continue in a fresh invocation rather than inside this one (fix #5) ─
    if (more && !stop && hop < MAX_HOPS && DIGEST_SECRET) {
      const next = fetch(`${SUPABASE_URL}/functions/v1/books-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-digest-secret': DIGEST_SECRET },
        body: JSON.stringify({ endpoint: only || undefined, full, hop: hop + 1 }),
      }).then(() => undefined).catch((e) => console.error('self-invoke failed:', (e as Error)?.message));
      // deno-lint-ignore no-explicit-any
      const rt = (globalThis as any).EdgeRuntime;
      if (rt?.waitUntil) rt.waitUntil(next);
    }

    const ok = results.every((r) => r.status === 'ok' || r.status === 'running' || r.status === 'busy');
    return json({ ok, more, hop, results, via: gate.via });
  } catch (e) {
    console.error('books-sync failed:', (e as Error)?.message);
    return json({ ok: false, reason: 'server_error', message: 'Unexpected server error — see the function logs.' }, 500);
  }
});
