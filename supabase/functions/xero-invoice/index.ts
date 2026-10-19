// xero-invoice — approved + client-accepted hours → ONE draft ACCREC invoice in Xero.
//
//   POST { client_id, from, to, preview?: true }
//   preview  → { lines, total, total_hours, headers, contact, xero_connected, scope_ok }
//   create   → the same + { invoice: { id, number, url } } and:
//               * a client_invoices row (source 'xero')
//               * timesheet_headers.invoiced_at / invoice_id stamped on every header carried
//               * an activity_events row
//
// Charging reuses the client register's rules (src/utils/payroll.js:
// findRateLine → chargeBands → computeChargeAmount), ported below so the draft
// invoice never disagrees with the Payroll screen. Lines are grouped by
// role × site × rate band so each Xero line is "hours × one unit rate".
// Plant hours (plant_hours × plant_items.hourly_charge) are separate lines.
//
// GATE: MONEY (access_level admin/accounts) or the service key.
// Money leaves this function only towards Xero and the admin who called it.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getXeroAccessToken } from './xeroToken.ts';

const XERO_CLIENT_ID       = Deno.env.get('XERO_CLIENT_ID')!;
const XERO_CLIENT_SECRET   = Deno.env.get('XERO_CLIENT_SECRET')!;
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;

const ACCOUNTING = 'https://api.xero.com/api.xro/2.0';

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
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

const num = (v: unknown) => { const n = parseFloat(String(v ?? 0)); return Number.isFinite(n) ? n : 0; };
const round2 = (n: number) => Math.round(n * 100) / 100;
const fmtAU = (d: string) => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';

// ── Caller gate (same as xero-push) ─────────────────────────────────────────
type GateResult =
  | { ok: true; via: 'service' | 'user'; email: string | null; worker: { id: string; name: string | null } | null }
  | { ok: false; status: number; error: string };
async function gateCaller(req: Request): Promise<GateResult> {
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return { ok: false, status: 401, error: 'Unauthorized' };
  if (bearer === SUPABASE_SERVICE_KEY) return { ok: true, via: 'service', email: null, worker: null };
  const { data: { user }, error } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY).auth.getUser(bearer);
  if (error || !user?.email) return { ok: false, status: 401, error: 'Unauthorized' };
  const { data: w } = await createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY).from('workers')
    .select('id, name, role, access_level').eq('email', user.email.toLowerCase()).is('archived_at', null).maybeSingle();
  const money = !!w && ['admin', 'accounts'].includes(w.access_level || '');
  if (!money) return { ok: false, status: 403, error: 'Admin or accounts only' };
  return { ok: true, via: 'user', email: user.email, worker: w };
}

// ── Charge logic (port of src/utils/payroll.js — keep in step) ──────────────
const PUBLIC_HOLIDAYS = new Set([
  '2025-01-01','2025-01-27','2025-04-18','2025-04-19','2025-04-20','2025-04-21',
  '2025-04-25','2025-06-09','2025-10-06','2025-12-25','2025-12-26',
  '2026-01-01','2026-01-26','2026-04-03','2026-04-04','2026-04-05','2026-04-06',
  '2026-04-25','2026-06-08','2026-10-05','2026-12-25','2026-12-28',
  '2027-01-01','2027-01-26','2027-03-26','2027-03-27','2027-03-28','2027-03-29',
  '2027-04-25','2027-06-14','2027-10-04','2027-12-25','2027-12-26','2027-12-27','2027-12-28',
]);
const CHARGE_DAY_THRESHOLD = 8;

const normRole = (s: unknown) => String(s || '').toLowerCase()
  .replace(/[^a-z0-9\s-]/g, ' ').replace(/\blabourers?\b/g, 'labour').replace(/\s+/g, ' ').trim();
const roleHead = (s: unknown) => normRole(s).split(/\s*-\s*/)[0].trim();

type RateLine = { role_name: string; rate_a?: unknown; rate_b?: unknown; rate_c?: unknown };
function findRateLine(rateLines: RateLine[], role: string): { line: RateLine | null; match: string } {
  const lines = rateLines || [];
  if (!lines.length || !role) return { line: null, match: 'none' };
  const want = normRole(role);
  const exact = lines.find(r => normRole(r.role_name) === want);
  if (exact) return { line: exact, match: 'exact' };
  const head = roleHead(role);
  const byHead = lines.find(r => normRole(r.role_name) === head) || lines.find(r => roleHead(r.role_name) === head);
  if (byHead) return { line: byHead, match: 'role-group' };
  return { line: null, match: 'none' };
}

function chargeBands(client: any, rateLine: RateLine | null) {
  const pick = (...vals: unknown[]) => { for (const v of vals) { const n = parseFloat(String(v)); if (Number.isFinite(n) && n > 0) return n; } return 0; };
  const A = pick(rateLine?.rate_a, client?.rate_a, client?.rate_regular);
  const B = pick(rateLine?.rate_b, client?.rate_b, client?.rate_overtime, A);
  const C = pick(rateLine?.rate_c, client?.rate_c, client?.rate_weekend, B);
  return { A, B, C };
}

// Same branches as computeChargeAmount, but returning the band segments so an
// invoice line can say "8h at A" and "2h at B" instead of one blended rate.
type Segment = { band: 'A' | 'B' | 'C'; hours: number; rate: number };
function chargeSegments(ts: any, client: any, rateLine: RateLine | null, geoPct: number): Segment[] {
  if ((ts.scenario || 'standard') === 'training_day') return [];
  const hours = num(ts.charge_hours);
  if (hours <= 0) return [];
  const { A, B, C } = chargeBands(client, rateLine);
  const d = ts.date ? new Date(ts.date + 'T12:00:00') : null;
  const dow = d ? d.getDay() : -1;
  const isPH = !!(ts.date && PUBLIC_HOLIDAYS.has(ts.date));
  const isSaturday = dow === 6;
  const isSundayOrPH = dow === 0 || isPH;
  const night = !!ts.is_night_shift;
  const geo = ts.geo_loading ? (1 + geoPct) : 1;
  const seg = (band: 'A' | 'B' | 'C', h: number, r: number): Segment => ({ band, hours: h, rate: round2(r * geo) });
  if (isSundayOrPH) return [seg('C', hours, C)];
  if (isSaturday)   return [seg(night ? 'C' : 'B', hours, night ? C : B)];
  if (night)        return [seg('B', hours, B)];
  const ordinary = Math.min(hours, CHARGE_DAY_THRESHOLD);
  const beyond = Math.max(0, hours - CHARGE_DAY_THRESHOLD);
  const out = [seg('A', ordinary, A)];
  if (beyond > 0) out.push(seg('B', beyond, B));
  return out;
}

const escLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

serve(async (req) => {
  const origin = req.headers.get('Origin');
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  const gate = await gateCaller(req);
  if (!gate.ok) return json({ error: gate.error }, gate.status);

  const body = await req.json().catch(() => ({}));
  const clientId = String(body.client_id || '').trim();
  const from = String(body.from || '').trim();
  const to = String(body.to || '').trim();
  const preview = !!body.preview;
  if (!clientId || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return json({ error: 'client_id, from (YYYY-MM-DD) and to (YYYY-MM-DD) are required' }, 400);
  }
  if (from > to) return json({ error: 'from must be on or before to' }, 400);

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── Xero state (connected? scope?) — the preview still works without it ──
  const { data: tokenRow } = await sb.from('xero_tokens').select('tenant_id, scope, expires_at').eq('id', 1).maybeSingle();
  const xeroConnected = !!tokenRow?.tenant_id;
  const scope = String(tokenRow?.scope || '');
  // Granular scope (Xero apps since 2026 refuse 'accounting.transactions' at consent).
  const scopeOk = scope.includes('accounting.invoices') || scope.includes('accounting.transactions');
  const scopeMsg = !xeroConnected
    ? 'Xero is not connected. Go to Payroll → "Connect Xero" first.'
    : (!scopeOk ? 'Xero is connected but without invoice permission. Go to Payroll → "Reconnect" once to grant invoice access.' : null);

  // ── Client + its Schedule of Rates ────────────────────────────────────────
  const { data: client, error: cErr } = await sb.from('clients').select('*').eq('id', clientId).maybeSingle();
  if (cErr) return json({ error: cErr.message }, 500);
  if (!client) return json({ error: 'client not found' }, 404);
  const [{ data: rateCards }, { data: cfg }] = await Promise.all([
    sb.from('client_rate_cards').select('role_name, rate_a, rate_b, rate_c').eq('client_id', clientId),
    sb.from('payroll_config').select('config_key, config_value').eq('config_key', 'geo_loading_pct').maybeSingle(),
  ]);
  const geoPct = num(cfg?.config_value ?? 0.10);

  // ── Headers: approved + client-accepted, not yet invoiced, keyed by id or name ─
  const { data: headers, error: hErr } = await sb.from('timesheet_headers')
    .select('id, client, project, role, client_id, site_name_snapshot, role_name_snapshot, client_approved, invoiced_at, workers(name)')
    .eq('status', 'approved')
    .or(`client_id.eq.${clientId},and(client_id.is.null,client.ilike."${escLike(String(client.name)).replace(/"/g, '\\"')}")`)
    .limit(2000);
  if (hErr) return json({ error: hErr.message }, 500);
  const eligible = (headers || []).filter((h: any) => h.client_approved && !h.invoiced_at);
  const notAccepted = (headers || []).filter((h: any) => !h.client_approved && !h.invoiced_at).length;
  const alreadyInvoiced = (headers || []).filter((h: any) => h.invoiced_at).length;
  if (!eligible.length) {
    return json({ lines: [], total: 0, total_hours: 0, headers: 0, skipped: { not_client_accepted: notAccepted, already_invoiced: alreadyInvoiced },
      xero_connected: xeroConnected, scope_ok: scopeOk, message: scopeMsg || 'No approved, client-accepted, un-invoiced timesheets for this client.' });
  }
  const headerIds = eligible.map((h: any) => h.id);
  const byHeader = new Map(eligible.map((h: any) => [h.id, h]));

  const [{ data: lines, error: lErr }, { data: plantRows, error: pErr }] = await Promise.all([
    sb.from('timesheets')
      .select('id, header_id, date, role, project, site, charge_hours, scenario, is_night_shift, geo_loading, status')
      .in('header_id', headerIds).gte('date', from).lte('date', to).eq('status', 'approved').order('date'),
    sb.from('plant_hours').select('id, header_id, hours, notes, plant_items(id, name, type, hourly_charge)').in('header_id', headerIds),
  ]);
  if (lErr) return json({ error: lErr.message }, 500);
  if (pErr) return json({ error: pErr.message }, 500);
  const carried = new Set<string>((lines || []).map((l: any) => l.header_id));
  if (!carried.size) {
    return json({ lines: [], total: 0, total_hours: 0, headers: 0, skipped: { not_client_accepted: notAccepted, already_invoiced: alreadyInvoiced },
      xero_connected: xeroConnected, scope_ok: scopeOk, message: scopeMsg || 'No approved shifts in that date range.' });
  }

  // ── Group labour: role × site × band ──────────────────────────────────────
  type Group = { kind: 'labour' | 'plant'; role: string; site: string; band: string; hours: number; rate: number; amount: number; source: string };
  const groups = new Map<string, Group>();
  let totalHours = 0;
  const fallbackRoles = new Set<string>();
  for (const l of lines || []) {
    const h: any = byHeader.get(l.header_id);
    const role = l.role || h?.role_name_snapshot || h?.role || '(no role)';
    const site = l.project || l.site || h?.site_name_snapshot || h?.project || '(no site)';
    const { line: rateLine, match } = findRateLine((rateCards || []) as RateLine[], role);
    if (!rateLine) fallbackRoles.add(role);
    for (const s of chargeSegments(l, client, rateLine, geoPct)) {
      const key = ['labour', role, site, s.band, s.rate].join('\u0000');
      const g = groups.get(key) || { kind: 'labour', role, site, band: s.band, hours: 0, rate: s.rate, amount: 0, source: rateLine ? (match === 'exact' ? 'schedule' : 'schedule-group') : 'client-fallback' };
      g.hours = round2(g.hours + s.hours);
      g.amount = round2(g.hours * g.rate);
      groups.set(key, g);
      totalHours += s.hours;
    }
  }
  // ── Plant: item × site ────────────────────────────────────────────────────
  const plantMissingRate: string[] = [];
  for (const p of plantRows || []) {
    if (!carried.has(p.header_id)) continue;   // the sheet's shifts fall outside the range
    const h: any = byHeader.get(p.header_id);
    const item: any = p.plant_items;
    if (!item) continue;
    const rate = num(item.hourly_charge);
    if (rate <= 0) { if (!plantMissingRate.includes(item.name)) plantMissingRate.push(item.name); continue; }
    const site = h?.site_name_snapshot || h?.project || '(no site)';
    const label = `${item.name}${item.type ? ` (${item.type})` : ''}`;
    const key = ['plant', label, site, '', rate].join('\u0000');
    const g = groups.get(key) || { kind: 'plant', role: label, site, band: '', hours: 0, rate, amount: 0, source: 'plant' };
    g.hours = round2(g.hours + num(p.hours));
    g.amount = round2(g.hours * g.rate);
    groups.set(key, g);
  }

  const range = `${fmtAU(from)} – ${fmtAU(to)}`;
  const outLines = [...groups.values()]
    .filter(g => g.hours > 0 && g.rate > 0)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.site.localeCompare(b.site) || a.role.localeCompare(b.role) || a.band.localeCompare(b.band))
    .map(g => ({
      kind: g.kind,
      description: g.kind === 'labour'
        ? `${g.role} — ${g.site} — ${range}${g.band ? ` (rate ${g.band})` : ''}`
        : `Plant: ${g.role} — ${g.site} — ${range}`,
      quantity: g.hours, unit_amount: g.rate, amount: g.amount, source: g.source,
    }));
  const total = round2(outLines.reduce((s, l) => s + l.amount, 0));
  const warnings: string[] = [];
  if (fallbackRoles.size) warnings.push(`No Schedule of Rates line for: ${[...fallbackRoles].join(', ')} — billed at the client's fallback A/B/C`);
  if (plantMissingRate.length) warnings.push(`Plant with no hourly charge (not invoiced): ${plantMissingRate.join(', ')}`);
  if (notAccepted) warnings.push(`${notAccepted} approved sheet(s) not yet accepted by the client — left out`);

  const base = {
    client: { id: client.id, name: client.name, xero_contact_id: client.xero_contact_id || null },
    period: { from, to },
    lines: outLines, total, total_hours: round2(totalHours),
    headers: carried.size, header_ids: [...carried],
    skipped: { not_client_accepted: notAccepted, already_invoiced: alreadyInvoiced },
    warnings, xero_connected: xeroConnected, scope_ok: scopeOk, message: scopeMsg,
  };
  if (preview) return json(base);

  // ── Create the draft in Xero ──────────────────────────────────────────────
  if (!xeroConnected || !scopeOk) return json({ ...base, error: scopeMsg }, 400);
  if (!outLines.length) return json({ ...base, error: 'Nothing billable in that range (training days and $0 rates never reach an invoice).' }, 400);
  const accessToken = await getAccessToken(sb);
  if (!accessToken) return json({ ...base, error: 'Xero token could not be refreshed. Reconnect Xero from the Payroll page.' }, 400);
  const tenantId = tokenRow!.tenant_id as string;

  // Contact: stored id → name search → let Xero create it by name.
  let contact: any = client.xero_contact_id ? { ContactID: client.xero_contact_id } : null;
  let contactMatchedBy: 'stored' | 'name' | 'created' = 'stored';
  if (!contact) {
    const where = encodeURIComponent(`Name=="${String(client.name).replace(/"/g, '\\"')}"`);
    const cRes = await xeroGet(`${ACCOUNTING}/Contacts?where=${where}`, accessToken, tenantId);
    const found = cRes.ok ? ((await cRes.json()).Contacts || [])[0] : null;
    if (found?.ContactID) { contact = { ContactID: found.ContactID }; contactMatchedBy = 'name'; }
    else { contact = { Name: client.name }; contactMatchedBy = 'created'; }
  }

  const today = new Date().toISOString().slice(0, 10);
  const due = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const payload = {
    Invoices: [{
      Type: 'ACCREC',
      Contact: contact,
      Date: today,
      DueDate: due,
      Status: 'DRAFT',
      LineAmountTypes: 'Exclusive',
      Reference: `Labour hire ${range}`,
      LineItems: outLines.map(l => ({ Description: l.description, Quantity: l.quantity, UnitAmount: l.unit_amount })),
    }],
  };
  const invRes = await fetch(`${ACCOUNTING}/Invoices?summarizeErrors=false`, {
    method: 'POST', headers: xeroHeaders(accessToken, tenantId), body: JSON.stringify(payload),
  });
  const invText = await invRes.text();
  let invData: any = {};
  try { invData = JSON.parse(invText); } catch { /* keep text */ }
  const inv = invData.Invoices?.[0];
  const validation = (inv?.ValidationErrors || invData.Elements?.[0]?.ValidationErrors || []).map((v: any) => v.Message).join('; ');
  if (!invRes.ok || !inv?.InvoiceID) {
    return json({ ...base, error: `Xero refused the invoice (${invRes.status}): ${validation || invText.slice(0, 300)}` }, 502);
  }
  const invoice = {
    id: inv.InvoiceID as string,
    number: (inv.InvoiceNumber || '') as string,
    status: (inv.Status || 'DRAFT') as string,
    url: `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${inv.InvoiceID}`,
    contact_matched_by: contactMatchedBy,
  };

  // Remember the contact for next time.
  const newContactId = inv.Contact?.ContactID;
  if (newContactId && newContactId !== client.xero_contact_id) {
    await sb.from('clients').update({ xero_contact_id: newContactId }).eq('id', client.id);
  }

  // Ledger row + header stamps + activity.
  const { data: row, error: rowErr } = await sb.from('client_invoices').insert([{
    client: client.name, client_id: client.id, source: 'xero',
    period_from: from, period_to: to,
    amount_cents: Math.round(total * 100), currency: 'aud',
    line_items: outLines, total_hours: round2(totalHours), header_ids: [...carried],
    xero_invoice_id: invoice.id, xero_invoice_number: invoice.number, xero_status: invoice.status, xero_url: invoice.url,
    status: 'created', created_by: gate.worker?.id || null,
  }]).select('id').single();
  const stampErrors: string[] = [];
  if (rowErr) stampErrors.push(`invoice ledger row not saved: ${rowErr.message}`);
  const { error: stErr } = await sb.from('timesheet_headers')
    .update({ invoiced_at: new Date().toISOString(), invoice_id: row?.id || null })
    .in('id', [...carried]);
  if (stErr) stampErrors.push(`headers not stamped invoiced: ${stErr.message}`);
  await sb.from('activity_events').insert([{
    actor_id: gate.worker?.id || null, actor_name: gate.via === 'user' ? (gate.worker?.name || gate.email) : 'portal',
    verb: 'invoiced', object_type: 'client', object_id: client.id, client_id: client.id,
    after: { xero_invoice_id: invoice.id, number: invoice.number, from, to, total, total_hours: round2(totalHours), headers: carried.size, lines: outLines.length },
  }]).then(() => {}, () => {});

  return json({ ...base, invoice, ledger_id: row?.id || null, warnings: [...warnings, ...stampErrors] });
});

// ── Token + HTTP helpers ─────────────────────────────────────────────────────
async function getAccessToken(sb: ReturnType<typeof createClient>): Promise<string | null> {
  return getXeroAccessToken(sb, XERO_CLIENT_ID, XERO_CLIENT_SECRET);   // shared, lock-safe refresh (xeroToken.ts)
}
function xeroHeaders(token: string, tenantId: string) {
  return { 'Authorization': `Bearer ${token}`, 'Xero-Tenant-Id': tenantId, 'Content-Type': 'application/json', 'Accept': 'application/json' };
}
function xeroGet(url: string, token: string, tenantId: string) {
  return fetch(url, { headers: xeroHeaders(token, tenantId) });
}
