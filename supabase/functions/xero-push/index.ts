// Xero Payroll AU push handler
// Flow:
//   1. Validate caller — MONEY gate (access_level admin/accounts) or the service key
//   2. Get/refresh access token
//   3. Fetch payroll calendar (required for pay run creation)
//   4. Fetch timesheets + workers from Supabase
//   5. Fetch employees + earnings rates from Xero (match employees by first+last name)
//   6. Group the sheets by Xero EmployeeID and SUM hours / allowances per employee
//   7. Create draft pay run in Xero
//   8. GET the new pay run → Xero auto-creates payslips for all employees on the calendar
//   9. PUT ONE updated payslip per employee
//  10. Stamp xero_exported=true only on the sheets a successful PUT carried
//
// Why the grouping (fix 2026-10-15): a PUT replaces the payslip's earnings
// lines, so pushing sheet-by-sheet left only the LAST sheet's hours in Xero
// while every sheet in the period got stamped xero_exported=true. Two sheets
// for one worker in a pay period silently under-paid them.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const XERO_CLIENT_ID       = Deno.env.get('XERO_CLIENT_ID')!;
const XERO_CLIENT_SECRET   = Deno.env.get('XERO_CLIENT_SECRET')!;
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;

const XERO_PAYROLL_BASE = 'https://api.xero.com/payroll.xro/1.0';

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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

const num = (v: unknown) => { const n = parseFloat(String(v ?? 0)); return Number.isFinite(n) ? n : 0; };
const round2 = (n: number) => Math.round(n * 100) / 100;

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
    .select('id, name, role, access_level')
    .eq('email', user.email.toLowerCase())
    .is('archived_at', null)
    .maybeSingle();
  const money  = !!w && ['admin', 'accounts'].includes(w.access_level || '');
  const office = money || (!!w && w.role === 'admin');
  if (level === 'money' ? !money : !office) {
    return { ok: false, status: 403, error: level === 'money' ? 'Admin or accounts only' : 'Office staff only' };
  }
  return { ok: true, via: 'user', email: user.email, worker: w };
}

type XeroEmployee = { EmployeeID: string; FirstName: string; LastName: string };
type EarningsRate = { EarningsRateID: string; Name?: string; EarningsType?: string; RateType?: string; Multiplier?: number };
type Totals = {
  ordinary: number;   // pay_hours minus the overtime buckets
  ot15: number;       // ot15_hours
  ot2x: number;       // ot2x_hours
  unsplit: number;    // legacy rows that only carry overtime_hours
  travel: number;
  meal: number;
  sheetIds: string[];
};

serve(async (req) => {
  const origin = req.headers.get('Origin');
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  // MONEY gate: pushing payroll to Xero is admin/accounts only.
  const gate = await gateCaller(req, 'money');
  if (!gate.ok) return json({ error: gate.error }, gate.status);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

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

  // ── 4. Fetch Xero employees + earnings rates ──────────────────────────────
  const empRes = await xeroGet(`${XERO_PAYROLL_BASE}/Employees`, accessToken, tenantId);
  if (!empRes.ok) {
    return json({ error: `Xero employee fetch failed (${empRes.status}): ${await empRes.text()}` }, 502);
  }
  const xeroEmployees: XeroEmployee[] = (await empRes.json()).Employees || [];

  // Earnings rates let overtime land on its own line instead of being counted
  // as ordinary time. Best-effort: with no OVERTIMEEARNINGS rate in Xero the
  // OT hours are folded back into the ordinary line (total hours unchanged)
  // and the result row says so.
  let earningsRates: EarningsRate[] = [];
  try {
    const piRes = await xeroGet(`${XERO_PAYROLL_BASE}/PayItems`, accessToken, tenantId);
    if (piRes.ok) earningsRates = ((await piRes.json()).PayItems?.EarningsRates || []) as EarningsRate[];
  } catch (_e) { /* fold OT into ordinary below */ }
  const otRateFor = (mult: number): EarningsRate | undefined => {
    const ot = earningsRates.filter(r => (r.EarningsType || '').toUpperCase() === 'OVERTIMEEARNINGS');
    return ot.find(r => Number(r.Multiplier) === mult)
      || ot.find(r => (mult === 1.5 ? /1\.5|time\s*and\s*a\s*half/i : /\b2(\.0)?\s*x\b|double/i).test(r.Name || ''));
  };

  // ── 5. Group the sheets by Xero employee and sum ──────────────────────────
  const results: Array<{ timesheetId: string; status: string; detail?: string }> = [];
  const groups = new Map<string, { emp: XeroEmployee; workerName: string; t: Totals }>();

  for (const ts of staffSheets as any[]) {
    const workerName: string = ts.workers?.name || '';
    const parts = workerName.trim().split(' ');
    const firstName = parts[0] || '';
    const lastName = parts.slice(1).join(' ');

    // Match Xero employee by name (case-insensitive, whitespace-trimmed: the
    // live Xero file has names like "Aaron " with a trailing space).
    const xeroEmp = xeroEmployees.find(e =>
      (e.FirstName || '').trim().toLowerCase() === firstName.toLowerCase() &&
      (e.LastName || '').trim().toLowerCase() === lastName.toLowerCase()
    );

    if (!xeroEmp) {
      results.push({
        timesheetId: ts.id,
        status: 'skipped',
        detail: `No Xero employee matching "${workerName}". ` +
                `Add them in Xero Payroll and ensure first/last name matches exactly.`,
      });
      continue;
    }

    const payHours = num(ts.pay_hours ?? ts.hours);
    const ot15 = num(ts.ot15_hours);
    const ot2x = num(ts.ot2x_hours);
    const split = ot15 + ot2x;
    const unsplit = split > 0 ? 0 : num(ts.overtime_hours); // legacy rows: one OT bucket only
    const ordinary = Math.max(0, payHours - split - unsplit);

    let g = groups.get(xeroEmp.EmployeeID);
    if (!g) {
      g = { emp: xeroEmp, workerName, t: { ordinary: 0, ot15: 0, ot2x: 0, unsplit: 0, travel: 0, meal: 0, sheetIds: [] } };
      groups.set(xeroEmp.EmployeeID, g);
    }
    g.t.ordinary += ordinary;
    g.t.ot15     += ot15;
    g.t.ot2x     += ot2x;
    g.t.unsplit  += unsplit;
    g.t.travel   += num(ts.travel_allowance);
    g.t.meal     += num(ts.meal_allowance);
    g.t.sheetIds.push(ts.id);
  }

  if (!groups.size) {
    return json({
      payRunID: null,
      payrollCalendar: calData.PayrollCalendars?.[0]?.Name,
      pushed: 0, skipped: results.length, errors: 0, results,
      note: 'No sheet matched a Xero employee, so no pay run was created.',
    });
  }

  // ── 6. Create draft pay run ───────────────────────────────────────────────
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

  // ── 7. Fetch the pay run to get auto-generated payslips ───────────────────
  const prRes = await xeroGet(`${XERO_PAYROLL_BASE}/PayRuns/${payRunID}`, accessToken, tenantId);
  const prData = prRes.ok ? await prRes.json() : {};
  const paySlips: any[] = prData.PayRuns?.[0]?.PaySlips || [];

  // ── 8. ONE PUT per employee, stamp only what that PUT carried ─────────────
  for (const [, g] of groups) {
    const existingSlip = paySlips.find((ps: any) => ps.EmployeeID === g.emp.EmployeeID);

    if (!existingSlip) {
      for (const id of g.t.sheetIds) {
        results.push({
          timesheetId: id,
          status: 'skipped',
          detail: `${g.workerName} is not on the "${calData.PayrollCalendars[0]?.Name}" payroll calendar. ` +
                  `Assign them to a payroll calendar in Xero Payroll first.`,
        });
      }
      continue;
    }

    // Xero auto-populates earnings lines from the employee template; line 0 is
    // the ordinary-time line and gets the summed ordinary hours. Overtime goes
    // on the matching OT rate line (updated if the template has it, appended
    // otherwise), or is folded into ordinary when Xero has no such rate.
    const lines: any[] = (existingSlip.EarningsLines || []).map((l: any) => ({ ...l }));
    if (!lines.length) {
      for (const id of g.t.sheetIds) {
        results.push({
          timesheetId: id,
          status: 'error',
          detail: `${g.workerName}'s Xero payslip has no earnings lines — add an ordinary earnings rate to their pay template in Xero.`,
        });
      }
      continue;
    }
    const notes: string[] = [];
    let ordinaryUnits = g.t.ordinary;
    const place = (hours: number, mult: number, label: string) => {
      if (hours <= 0) return;
      const rate = otRateFor(mult);
      if (!rate) {
        ordinaryUnits += hours;
        notes.push(`${round2(hours)}h ${label} folded into ordinary time: no ${label} overtime rate in Xero`);
        return;
      }
      const existing = lines.find((l: any) => l.EarningsRateID === rate.EarningsRateID);
      if (existing) existing.NumberOfUnits = round2(hours);
      else lines.push({ EarningsRateID: rate.EarningsRateID, NumberOfUnits: round2(hours) });
    };
    place(g.t.ot15, 1.5, 'OT 1.5x');
    place(g.t.ot2x, 2, 'OT 2x');
    if (g.t.unsplit > 0) place(g.t.unsplit, 1.5, 'overtime (unsplit, sent as 1.5x)');
    lines[0] = { ...lines[0], NumberOfUnits: round2(ordinaryUnits) };

    // Build allowance lines — only add ours, keep any Xero-side ones
    const allowanceLines = [
      ...(existingSlip.AllowanceLines || []),
      ...(g.t.travel > 0 ? [{ Description: 'Travel Allowance', Amount: round2(g.t.travel) }] : []),
      ...(g.t.meal   > 0 ? [{ Description: 'Meal Allowance',   Amount: round2(g.t.meal) }]   : []),
    ];

    const updateRes = await xeroPut(
      `${XERO_PAYROLL_BASE}/PayRuns/${payRunID}/PaySlips/${g.emp.EmployeeID}`,
      accessToken,
      tenantId,
      { ...existingSlip, EarningsLines: lines, AllowanceLines: allowanceLines }
    );

    if (updateRes.ok) {
      const { error: stampErr } = await supabase.from('timesheets')
        .update({ xero_exported: true }).in('id', g.t.sheetIds);
      if (stampErr) notes.push(`pushed to Xero but xero_exported was NOT stamped: ${stampErr.message}`);
      const detail = notes.length ? notes.join('; ') : undefined;
      for (const id of g.t.sheetIds) results.push({ timesheetId: id, status: 'pushed', detail });
    } else {
      const detail = await updateRes.text();
      for (const id of g.t.sheetIds) results.push({ timesheetId: id, status: 'error', detail });
    }
  }

  const pushed  = results.filter(r => r.status === 'pushed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const errors  = results.filter(r => r.status === 'error').length;

  return json({
    payRunID,
    payrollCalendar: calData.PayrollCalendars?.[0]?.Name,
    employees: groups.size,
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
