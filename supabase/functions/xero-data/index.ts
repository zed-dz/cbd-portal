// Xero Data Sync — reads all relevant Xero data and returns it to the portal
// Entities fetched:
//   employees      — full employee list (name, DOB, bank, tax, super, pay template)
//   payruns        — all posted pay runs with totals
//   payslips       — payslips for a specific pay run (?entity=payslips&payRunId=xxx)
//   leave          — all leave applications
//   leavebalances  — leave balances per employee (?entity=leavebalances&employeeId=xxx)
//   calendars      — payroll calendars
//   payitems       — earnings rates, leave rates, deductions, reimbursements
//   contacts       — Xero accounting contacts (clients/customers) — requires accounting.contacts.read
//   all            — everything in parallel (default)
//
// GATE: MONEY (hardening 2026-10-15) — this returns pay templates, bank and
// tax details, so only access_level admin/accounts may call it. Before, any
// valid login (a worker on their phone) could pull the whole payroll.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getXeroAccessToken } from './xeroToken.ts';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;
const XERO_CLIENT_ID       = Deno.env.get('XERO_CLIENT_ID')!;
const XERO_CLIENT_SECRET   = Deno.env.get('XERO_CLIENT_SECRET')!;

const PAYROLL    = 'https://api.xero.com/payroll.xro/1.0';
const ACCOUNTING = 'https://api.xero.com/api.xro/2.0';

// The live portal plus the two legacy Vercel hosts (still kept for roll-back).
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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}

// ── Caller gate (hardening 2026-10-15) ──────────────────────────────────────
// OFFICE = anyone who uses the office portal (workers.role = 'admin', or an
// access_level of admin/accounts); MONEY = access_level admin/accounts only.
// Internal callers (other edge functions, cron) pass the service-role key as
// the bearer and skip the worker lookup. Email match is exact (lower-cased):
// `ilike` would treat `_` and `%` as wildcards.
type GateLevel = 'office' | 'money';
type GateResult =
  | { ok: true; via: 'service' | 'user'; email: string | null; worker: { id: string; name: string | null; role: string | null; access_level: string | null } | null }
  | { ok: false; status: number; error: string };
async function gateCaller(req: Request, level: GateLevel): Promise<GateResult> {
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return { ok: false, status: 401, error: 'Unauthorized' };
  if (bearer === SUPABASE_SERVICE_KEY) return { ok: true, via: 'service', email: null, worker: null };
  const { data: { user }, error } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY).auth.getUser(bearer);
  if (error || !user?.email) return { ok: false, status: 401, error: 'Unauthorized' };
  const { data: w } = await createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY).from('workers')
    .select('id, name, role, access_level, is_allocator')
    .eq('email', user.email.toLowerCase())
    .is('archived_at', null)
    .maybeSingle();
  const money  = !!w && ['admin', 'accounts'].includes(w.access_level || '') && !w.is_allocator  /* allocators never see pay */;
  const office = money || (!!w && w.role === 'admin');
  if (level === 'money' ? !money : !office) {
    return { ok: false, status: 403, error: level === 'money' ? 'Admin or accounts only' : 'Office staff only' };
  }
  return { ok: true, via: 'user', email: user.email, worker: w };
}

serve(async (req) => {
  const origin = req.headers.get('Origin');
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });

  const gate = await gateCaller(req, 'money');
  if (!gate.ok) return json({ error: gate.error }, gate.status);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const url      = new URL(req.url);
  const entity   = url.searchParams.get('entity') || 'all';
  const payRunId = url.searchParams.get('payRunId');
  const empId    = url.searchParams.get('employeeId');

  const accessToken = await getAccessToken(supabase);
  if (!accessToken) return json({ error: 'Xero not connected. Connect Xero from the Payroll page first.' }, 400);

  const { data: tokenRow } = await supabase.from('xero_tokens').select('tenant_id, scope').eq('id', 1).single();
  const tenantId = tokenRow?.tenant_id;
  if (!tenantId) return json({ error: 'No Xero organisation linked. Reconnect Xero.' }, 400);

  const hasAccountingScope = (tokenRow?.scope || '').includes('accounting.contacts');

  // ── Single-entity endpoints ───────────────────────────────────────────────

  if (entity === 'payslips') {
    if (!payRunId) return json({ error: 'payRunId parameter required' }, 400);
    const res = await xeroGet(`${PAYROLL}/PayRuns/${payRunId}`, accessToken, tenantId);
    if (!res.ok) return json({ error: `Xero error ${res.status}: ${await res.text()}` }, 502);
    const data = await res.json();
    return json({ paySlips: data.PayRuns?.[0]?.PaySlips || [] });
  }

  if (entity === 'leavebalances') {
    if (!empId) return json({ error: 'employeeId parameter required' }, 400);
    const res = await xeroGet(`${PAYROLL}/Employees/${empId}/LeaveBalances`, accessToken, tenantId);
    if (!res.ok) return json({ error: `Xero error ${res.status}: ${await res.text()}` }, 502);
    return json(await res.json());
  }

  // ── Fetch all in parallel ─────────────────────────────────────────────────

  const fetches: Promise<Response>[] = [
    xeroGet(`${PAYROLL}/Employees`, accessToken, tenantId),
    xeroGet(`${PAYROLL}/PayRuns`, accessToken, tenantId),
    xeroGet(`${PAYROLL}/LeaveApplications`, accessToken, tenantId),
    xeroGet(`${PAYROLL}/PayrollCalendars`, accessToken, tenantId),
    xeroGet(`${PAYROLL}/PayItems`, accessToken, tenantId),
  ];

  // Only fetch contacts if we have the accounting scope
  if (hasAccountingScope) {
    fetches.push(xeroGet(`${ACCOUNTING}/Contacts?summaryOnly=true`, accessToken, tenantId));
  }

  const responses = await Promise.all(fetches);

  const safe = async (res: Response) => {
    if (!res.ok) {
      console.warn(`Xero fetch failed: ${res.status} ${res.url}`);
      return null;
    }
    try { return await res.json(); } catch { return null; }
  };

  const results = await Promise.all(responses.map(safe));
  const [emps, runs, leave, cals, items, contacts] = results;

  return json({
    employees:        emps?.Employees         || [],
    payRuns:          runs?.PayRuns           || [],
    leaveApplications: leave?.LeaveApplications || [],
    payrollCalendars: cals?.PayrollCalendars  || [],
    earningsRates:    items?.EarningsRates    || [],
    leaveTypes:       items?.LeaveTypes       || [],
    deductionTypes:   items?.DeductionTypes   || [],
    reimbursementTypes: items?.ReimbursementTypes || [],
    contacts:         contacts?.Contacts      || [],
    hasAccountingScope,
    syncedAt:         new Date().toISOString(),
  });
});

// ── Token helpers ─────────────────────────────────────────────────────────────

async function getAccessToken(supabase: ReturnType<typeof createClient>): Promise<string | null> {
  return getXeroAccessToken(supabase, XERO_CLIENT_ID, XERO_CLIENT_SECRET);   // shared, lock-safe refresh (xeroToken.ts)
}

function xeroGet(url: string, token: string, tenantId: string) {
  return fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Xero-Tenant-Id': tenantId,
      'Accept': 'application/json',
    },
  });
}
