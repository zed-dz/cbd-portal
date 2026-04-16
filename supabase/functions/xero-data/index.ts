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

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;
const XERO_CLIENT_ID       = Deno.env.get('XERO_CLIENT_ID')!;
const XERO_CLIENT_SECRET   = Deno.env.get('XERO_CLIENT_SECRET')!;

const PAYROLL    = 'https://api.xero.com/payroll.xro/1.0';
const ACCOUNTING = 'https://api.xero.com/api.xro/2.0';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });

  const auth = req.headers.get('Authorization');
  if (!auth) return json({ error: 'Unauthorized' }, 401);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    .auth.getUser(auth.replace('Bearer ', ''));
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

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
  const { data } = await supabase.from('xero_tokens').select('*').eq('id', 1).single();
  if (!data) return null;
  if (new Date(data.expires_at).getTime() - Date.now() < 5 * 60 * 1000) {
    return refreshAccessToken(data.refresh_token, supabase);
  }
  return data.access_token;
}

async function refreshAccessToken(refreshToken: string, supabase: ReturnType<typeof createClient>): Promise<string | null> {
  const res = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${btoa(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  if (!res.ok) return null;
  const tokens = await res.json();
  await supabase.from('xero_tokens').update({
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    updated_at:    new Date().toISOString(),
  }).eq('id', 1);
  return tokens.access_token;
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

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': 'https://cbd-portal-gray.vercel.app',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}
