// Xero payroll push handler
// Called from the portal with a list of timesheet IDs + pay period dates.
// Creates a Xero Payroll AU pay run (or updates draft earnings lines) for each employee.
// Stamps xero_exported=true on each successfully pushed timesheet.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const XERO_CLIENT_ID       = Deno.env.get('XERO_CLIENT_ID')!;
const XERO_CLIENT_SECRET   = Deno.env.get('XERO_CLIENT_SECRET')!;
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const XERO_PAYROLL_BASE = 'https://api.xero.com/payroll/2.0';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }

  // Auth: portal sends its Supabase JWT
  const auth = req.headers.get('Authorization');
  if (!auth) return json({ error: 'Unauthorized' }, 401);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Validate caller is a logged-in portal user
  const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!)
    .auth.getUser(auth.replace('Bearer ', ''));
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

  const body = await req.json().catch(() => ({}));
  const { timesheetIds, periodFrom, periodTo } = body;

  if (!timesheetIds?.length || !periodFrom || !periodTo) {
    return json({ error: 'timesheetIds, periodFrom, periodTo are required' }, 400);
  }

  // 1. Get valid access token (refresh if needed)
  const accessToken = await getAccessToken(supabase);
  if (!accessToken) return json({ error: 'Xero not connected. Please connect Xero first.' }, 400);

  // 2. Get tenant ID
  const { data: tokenRow } = await supabase.from('xero_tokens').select('tenant_id').eq('id', 1).single();
  const tenantId = tokenRow?.tenant_id;
  if (!tenantId) return json({ error: 'No Xero tenant found. Reconnect Xero.' }, 400);

  // 3. Fetch timesheets with worker info
  const { data: timesheets, error: tsErr } = await supabase
    .from('timesheets')
    .select('*, workers(name, worker_type, pay_rate_regular, pay_rate_overtime)')
    .in('id', timesheetIds)
    .eq('status', 'approved')
    .neq('workers.worker_type', 'subcontractor');  // only employees

  if (tsErr) return json({ error: tsErr.message }, 500);
  if (!timesheets?.length) return json({ error: 'No approved employee timesheets found for those IDs.' }, 400);

  // 4. Get Xero Payroll employees (to match by name)
  const empRes = await xeroGet(`${XERO_PAYROLL_BASE}/Employees`, accessToken, tenantId);
  if (!empRes.ok) {
    const t = await empRes.text();
    return json({ error: `Xero employee fetch failed: ${t}` }, 502);
  }
  const empData = await empRes.json();
  const xeroEmployees: Array<{ EmployeeID: string; FirstName: string; LastName: string }> =
    empData.Employees || [];

  // 5. Create a draft Pay Run in Xero
  const payRunRes = await xeroPost(`${XERO_PAYROLL_BASE}/PayRuns`, accessToken, tenantId, {
    PayrollCalendarID: null,   // Xero will use the default calendar if null
    PayRunStatus: 'DRAFT',
    PaymentDate: periodTo,
  });

  let payRunID: string | null = null;
  if (payRunRes.ok) {
    const prData = await payRunRes.json();
    payRunID = prData.PayRuns?.[0]?.PayRunID || null;
  }

  const results: Array<{ timesheetId: string; status: string; detail?: string }> = [];

  // 6. For each timesheet, find the Xero employee and push earnings
  for (const ts of timesheets) {
    const workerName: string = ts.workers?.name || '';
    const [firstName, ...rest] = workerName.trim().split(' ');
    const lastName = rest.join(' ');

    const xeroEmp = xeroEmployees.find(e =>
      e.FirstName?.toLowerCase() === firstName?.toLowerCase() &&
      e.LastName?.toLowerCase() === lastName?.toLowerCase()
    );

    if (!xeroEmp) {
      results.push({ timesheetId: ts.id, status: 'skipped', detail: `No Xero employee found for "${workerName}"` });
      continue;
    }

    if (payRunID) {
      // Add earnings line to the pay run pay slip
      const earningsRes = await xeroPost(
        `${XERO_PAYROLL_BASE}/PayRuns/${payRunID}/PaySlips`,
        accessToken, tenantId,
        {
          EmployeeID: xeroEmp.EmployeeID,
          EarningsLines: [
            {
              EarningsRateID: null,      // null = default earnings rate
              RatePerUnit: ts.workers?.pay_rate_regular || 0,
              NumberOfUnits: ts.pay_hours || ts.hours || 0,
            },
          ],
          AllowanceLines: [
            ...(ts.travel_allowance > 0 ? [{
              AllowanceTypeID: null,
              Amount: ts.travel_allowance,
              Description: 'Travel Allowance',
            }] : []),
            ...(ts.meal_allowance > 0 ? [{
              AllowanceTypeID: null,
              Amount: ts.meal_allowance,
              Description: 'Meal Allowance',
            }] : []),
          ],
        }
      );

      if (earningsRes.ok) {
        // Stamp xero_exported
        await supabase.from('timesheets').update({ xero_exported: true }).eq('id', ts.id);
        results.push({ timesheetId: ts.id, status: 'pushed' });
      } else {
        const detail = await earningsRes.text();
        results.push({ timesheetId: ts.id, status: 'error', detail });
      }
    } else {
      // No pay run created — stamp with note
      results.push({ timesheetId: ts.id, status: 'no_pay_run', detail: 'Pay run creation failed; check Xero payroll calendar setup.' });
    }
  }

  const pushed  = results.filter(r => r.status === 'pushed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const errors  = results.filter(r => r.status === 'error').length;

  return json({ payRunID, pushed, skipped, errors, results });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getAccessToken(supabase: ReturnType<typeof createClient>): Promise<string | null> {
  const { data } = await supabase.from('xero_tokens').select('*').eq('id', 1).single();
  if (!data) return null;

  const now = new Date();
  const expiresAt = new Date(data.expires_at);

  // Refresh if token expires within 5 minutes
  if (expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
    const refreshed = await refreshAccessToken(data.refresh_token, supabase);
    return refreshed;
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
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) return null;

  const tokens = await res.json();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  await supabase.from('xero_tokens').update({
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    expiresAt,
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

function xeroPost(url: string, token: string, tenantId: string, body: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Xero-Tenant-Id': tenantId,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
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
    'Access-Control-Allow-Origin': 'https://cbd-portal-zeta.vercel.app',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
