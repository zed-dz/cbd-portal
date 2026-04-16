// Xero Payroll AU push handler
// Flow:
//   1. Validate caller JWT
//   2. Get/refresh access token
//   3. Fetch payroll calendar (required for pay run creation)
//   4. Fetch timesheets + workers from Supabase
//   5. Fetch employees from Xero (match by first+last name)
//   6. Create draft pay run in Xero
//   7. GET the new pay run → Xero auto-creates payslips for all employees on the calendar
//   8. PUT each matching payslip with updated hours + allowances
//   9. Stamp xero_exported=true on success

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const XERO_CLIENT_ID       = Deno.env.get('XERO_CLIENT_ID')!;
const XERO_CLIENT_SECRET   = Deno.env.get('XERO_CLIENT_SECRET')!;
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;

const XERO_PAYROLL_BASE = 'https://api.xero.com/payroll/2.0';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }

  const auth = req.headers.get('Authorization');
  if (!auth) return json({ error: 'Unauthorized' }, 401);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Validate caller is an authenticated portal user
  const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    .auth.getUser(auth.replace('Bearer ', ''));
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

  const body = await req.json().catch(() => ({}));
  const { timesheetIds, periodFrom, periodTo } = body;

  if (!Array.isArray(timesheetIds) || !timesheetIds.length || !periodFrom || !periodTo) {
    return json({ error: 'timesheetIds (array), periodFrom, periodTo are required' }, 400);
  }

  // ── 1. Xero access token ──────────────────────────────────────────────────
  const accessToken = await getAccessToken(supabase);
  if (!accessToken) return json({ error: 'Xero not connected. Click "Connect Xero" first.' }, 400);

  const { data: tokenRow } = await supabase
    .from('xero_tokens').select('tenant_id').eq('id', 1).single();
  const tenantId = tokenRow?.tenant_id;
  if (!tenantId) return json({ error: 'No Xero organisation linked. Reconnect Xero.' }, 400);

  // ── 2. Fetch payroll calendar (required for pay run creation) ─────────────
  const calRes = await xeroGet(`${XERO_PAYROLL_BASE}/PayrollCalendars`, accessToken, tenantId);
  if (!calRes.ok) {
    const errBody = await calRes.text();
    return json({
      error: `Could not fetch Xero payroll calendars (status ${calRes.status}): ${errBody}. ` +
             `Make sure Payroll AU is enabled on your Xero account and the app has payroll scopes.`,
    }, 502);
  }
  const calData = await calRes.json();
  const calendarId: string | undefined = calData.PayrollCalendars?.[0]?.PayrollCalendarID;
  if (!calendarId) {
    return json({
      error: 'No payroll calendar found in Xero. ' +
             'Go to Xero → Payroll → Payroll Settings → Payroll Calendars and create one first.',
    }, 400);
  }

  // ── 3. Fetch timesheets + workers from Supabase ───────────────────────────
  const { data: timesheets, error: tsErr } = await supabase
    .from('timesheets')
    .select('*, workers(name, worker_type, pay_rate_regular)')
    .in('id', timesheetIds)
    .eq('status', 'approved');

  if (tsErr) return json({ error: `DB error fetching timesheets: ${tsErr.message}` }, 500);

  // Filter subcontractors in JS (PostgREST join filters are unreliable for this)
  const staffSheets = (timesheets || []).filter(
    (ts: any) => ts.workers?.worker_type !== 'subcontractor'
  );
  if (!staffSheets.length) {
    return json({ error: 'No approved employee (non-subcontractor) timesheets in the selection.' }, 400);
  }

  // ── 4. Fetch Xero employees ───────────────────────────────────────────────
  const empRes = await xeroGet(`${XERO_PAYROLL_BASE}/Employees`, accessToken, tenantId);
  if (!empRes.ok) {
    return json({ error: `Xero employee fetch failed (${empRes.status}): ${await empRes.text()}` }, 502);
  }
  const xeroEmployees: Array<{ EmployeeID: string; FirstName: string; LastName: string }> =
    (await empRes.json()).Employees || [];

  // ── 5. Create draft pay run ───────────────────────────────────────────────
  const payRunRes = await xeroPost(`${XERO_PAYROLL_BASE}/PayRuns`, accessToken, tenantId, {
    PayrollCalendarID: calendarId,
    PaymentDate: periodTo,
  });

  if (!payRunRes.ok) {
    const errBody = await payRunRes.text();
    return json({ error: `Failed to create Xero pay run (${payRunRes.status}): ${errBody}` }, 502);
  }
  const payRunData = await payRunRes.json();
  const payRunID: string | undefined = payRunData.PayRuns?.[0]?.PayRunID;
  if (!payRunID) {
    return json({ error: 'Pay run created but Xero returned no PayRunID.' }, 502);
  }

  // ── 6. Fetch the pay run to get auto-generated payslips ───────────────────
  const prRes = await xeroGet(`${XERO_PAYROLL_BASE}/PayRuns/${payRunID}`, accessToken, tenantId);
  const prData = prRes.ok ? await prRes.json() : {};
  const paySlips: any[] = prData.PayRuns?.[0]?.PaySlips || [];

  // ── 7. Update each matching employee's payslip ────────────────────────────
  const results: Array<{ timesheetId: string; status: string; detail?: string }> = [];

  for (const ts of staffSheets) {
    const workerName: string = (ts as any).workers?.name || '';
    const parts = workerName.trim().split(' ');
    const firstName = parts[0] || '';
    const lastName = parts.slice(1).join(' ');

    // Match Xero employee by name (case-insensitive)
    const xeroEmp = xeroEmployees.find(e =>
      e.FirstName?.toLowerCase() === firstName.toLowerCase() &&
      e.LastName?.toLowerCase() === lastName.toLowerCase()
    );

    if (!xeroEmp) {
      results.push({
        timesheetId: (ts as any).id,
        status: 'skipped',
        detail: `No Xero employee matching "${workerName}". ` +
                `Add them in Xero Payroll and ensure first/last name matches exactly.`,
      });
      continue;
    }

    // Find the auto-created payslip for this employee
    const existingSlip = paySlips.find((ps: any) => ps.EmployeeID === xeroEmp.EmployeeID);

    if (!existingSlip) {
      results.push({
        timesheetId: (ts as any).id,
        status: 'skipped',
        detail: `${workerName} is not on the "${calData.PayrollCalendars[0]?.Name}" payroll calendar. ` +
                `Assign them to a payroll calendar in Xero Payroll first.`,
      });
      continue;
    }

    // Update the first ordinary earnings line with portal hours.
    // Xero auto-populates earnings lines from the employee template — we just update NumberOfUnits.
    const payHours = parseFloat((ts as any).pay_hours ?? (ts as any).hours ?? 0);
    const earningsLines = (existingSlip.EarningsLines || []).map((line: any, idx: number) =>
      idx === 0 ? { ...line, NumberOfUnits: payHours } : line
    );

    // Build allowance lines — only add ours, keep any Xero-side ones
    const allowanceLines = [
      ...(existingSlip.AllowanceLines || []),
      ...((ts as any).travel_allowance > 0
        ? [{ Description: 'Travel Allowance', Amount: parseFloat((ts as any).travel_allowance) }]
        : []),
      ...((ts as any).meal_allowance > 0
        ? [{ Description: 'Meal Allowance', Amount: parseFloat((ts as any).meal_allowance) }]
        : []),
    ];

    // PUT the updated payslip back to Xero
    const updateRes = await xeroPut(
      `${XERO_PAYROLL_BASE}/PayRuns/${payRunID}/PaySlips/${xeroEmp.EmployeeID}`,
      accessToken,
      tenantId,
      { ...existingSlip, EarningsLines: earningsLines, AllowanceLines: allowanceLines }
    );

    if (updateRes.ok) {
      await supabase.from('timesheets').update({ xero_exported: true }).eq('id', (ts as any).id);
      results.push({ timesheetId: (ts as any).id, status: 'pushed' });
    } else {
      results.push({
        timesheetId: (ts as any).id,
        status: 'error',
        detail: await updateRes.text(),
      });
    }
  }

  const pushed  = results.filter(r => r.status === 'pushed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const errors  = results.filter(r => r.status === 'error').length;

  return json({
    payRunID,
    payrollCalendar: calData.PayrollCalendars?.[0]?.Name,
    pushed, skipped, errors, results,
  });
});

// ── Token helpers ─────────────────────────────────────────────────────────────

async function getAccessToken(supabase: ReturnType<typeof createClient>): Promise<string | null> {
  const { data } = await supabase.from('xero_tokens').select('*').eq('id', 1).single();
  if (!data) return null;

  const expiresAt = new Date(data.expires_at);
  if (expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
    return refreshAccessToken(data.refresh_token, supabase);
  }
  return data.access_token;
}

async function refreshAccessToken(
  refreshToken: string,
  supabase: ReturnType<typeof createClient>,
): Promise<string | null> {
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
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  await supabase.from('xero_tokens').update({
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    expiresAt,
    updated_at:    new Date().toISOString(),
  }).eq('id', 1);

  return tokens.access_token;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function xeroHeaders(token: string, tenantId: string) {
  return {
    'Authorization': `Bearer ${token}`,
    'Xero-Tenant-Id': tenantId,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

function xeroGet(url: string, token: string, tenantId: string) {
  return fetch(url, { headers: xeroHeaders(token, tenantId) });
}

function xeroPost(url: string, token: string, tenantId: string, body: unknown) {
  return fetch(url, { method: 'POST', headers: xeroHeaders(token, tenantId), body: JSON.stringify(body) });
}

function xeroPut(url: string, token: string, tenantId: string, body: unknown) {
  return fetch(url, { method: 'PUT', headers: xeroHeaders(token, tenantId), body: JSON.stringify(body) });
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
