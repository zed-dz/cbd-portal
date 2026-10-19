// Xero Payroll AU push handler
// Flow:
//   1. Validate caller — MONEY gate (access_level admin/accounts) or the service key
//   2. Get/refresh access token
//   3. Fetch payroll calendar (required for pay run creation)
//   4. Fetch timesheets + workers from Supabase
//   5. Fetch employees + pay items from Xero
//      match: workers.xero_employee_id FIRST, name match only when it is empty
//      (and the response says which employees were name-matched)
//   6. Group the sheets by Xero EmployeeID and SUM hours / allowances per employee
//   7. Create draft pay run in Xero
//   8. GET the new pay run → Xero auto-creates payslips for all employees on the calendar
//   9. PUT ONE updated payslip per employee — ordinary / OT 1.5x / OT 2x on their own
//      pay items, casual loading as its own line (see buildEmployeeLines)
//  10. Stamp xero_exported=true only on the sheets a successful PUT carried
//
// Why the grouping (fix 2026-10-15): a PUT replaces the payslip's earnings
// lines, so pushing sheet-by-sheet left only the LAST sheet's hours in Xero
// while every sheet in the period got stamped xero_exported=true. Two sheets
// for one worker in a pay period silently under-paid them.
//
// Line split (2026-10-19): the logic in buildEmployeeLines is a line-for-line
// copy of src/utils/xeroLines.js (unit-tested there). Change both together.

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
type WorkerPay = { worker_type?: string | null; pay_rate_regular?: unknown; pay_rate_base?: unknown; casual_loading_pct?: unknown };
type Summary = { ordinary: number; ot15: number; ot2: number; loading: number; pay_items_used: string[]; warnings: string[] };

// ── Line split (copy of src/utils/xeroLines.js — keep in step) ──────────────
const nameOf = (r: EarningsRate | undefined) => String(r?.Name || '');

function findOvertimeRate(earningsRates: EarningsRate[], mult: number): EarningsRate | null {
  const rates = earningsRates || [];
  const ot = rates.filter(r => String(r.EarningsType || '').toUpperCase() === 'OVERTIMEEARNINGS');
  const pool = ot.length ? ot : rates.filter(r => /overtime/i.test(nameOf(r)));
  const byMult = pool.find(r => Number(r.Multiplier) === mult);
  if (byMult) return byMult;
  if (mult === 1.5) {
    return pool.find(r => /overtime/i.test(nameOf(r)) && (/1\.5/.test(nameOf(r)) || /time\s*and\s*a\s*half/i.test(nameOf(r))))
      || pool.find(r => /overtime/i.test(nameOf(r)) && !/\b2(\.0)?\s*x?\b|double/i.test(nameOf(r)))
      || pool.find(r => /overtime/i.test(nameOf(r)))
      || null;
  }
  return pool.find(r => /overtime/i.test(nameOf(r)) && (/\b2(\.0)?\s*x?\b/i.test(nameOf(r)) || /double/i.test(nameOf(r))))
    || null;
}

function findCasualLoadingRate(earningsRates: EarningsRate[]): EarningsRate | null {
  return (earningsRates || []).find(r => /casual\s*loading/i.test(nameOf(r))) || null;
}

function findOrdinaryLineIndex(templateLines: any[], earningsRates: EarningsRate[]): number {
  const lines = templateLines || [];
  const ordIds = new Set((earningsRates || [])
    .filter(r => String(r.EarningsType || '').toUpperCase() === 'ORDINARYTIMEEARNINGS')
    .map(r => r.EarningsRateID));
  const i = lines.findIndex(l => ordIds.has(l.EarningsRateID));
  return i >= 0 ? i : (lines.length ? 0 : -1);
}

function casualLoadingFor(worker: WorkerPay): { base: number; pct: number } | null {
  if (!worker || worker.worker_type !== 'casual') return null;
  const base = num(worker.pay_rate_base);
  let pct = num(worker.casual_loading_pct);
  if (pct > 1) pct = pct / 100;
  if (base <= 0 || pct <= 0) return null;
  return { base, pct };
}

function buildEmployeeLines(args: { totals: Totals; worker: WorkerPay; earningsRates: EarningsRate[]; templateLines: any[] }) {
  const { worker, earningsRates, templateLines } = args;
  const t = { ordinary: num(args.totals.ordinary), ot15: num(args.totals.ot15), ot2x: num(args.totals.ot2x), unsplit: num(args.totals.unsplit) };
  const lines: any[] = (templateLines || []).map(l => ({ ...l }));
  const warnings: string[] = [];
  const payItemsUsed: string[] = [];
  const summary: Summary = { ordinary: 0, ot15: 0, ot2: 0, loading: 0, pay_items_used: payItemsUsed, warnings };

  const ordIdx = findOrdinaryLineIndex(lines, earningsRates);
  if (ordIdx < 0) {
    warnings.push('payslip has no earnings lines — add an ordinary earnings rate to the pay template in Xero');
    return { lines, summary, ok: false };
  }
  const ordLine = lines[ordIdx];
  const rateName = (id: string) => nameOf((earningsRates || []).find(r => r.EarningsRateID === id)) || 'Ordinary';

  let ordinaryUnits = t.ordinary;

  const place = (hours: number, mult: number, label: string, bucket: 'ot15' | 'ot2') => {
    if (hours <= 0) return;
    const rate = findOvertimeRate(earningsRates, mult);
    if (!rate) {
      ordinaryUnits += hours;
      warnings.push(`${round2(hours)}h ${label} folded into ordinary time: no ${label} overtime pay item in Xero`);
      return;
    }
    const existing = lines.find(l => l.EarningsRateID === rate.EarningsRateID);
    if (existing) existing.NumberOfUnits = round2(num(existing.NumberOfUnits) + hours);
    else lines.push({ EarningsRateID: rate.EarningsRateID, NumberOfUnits: round2(hours) });
    summary[bucket] = round2(summary[bucket] + hours);
    if (!payItemsUsed.includes(nameOf(rate))) payItemsUsed.push(nameOf(rate));
  };
  for (const l of lines) { if (l !== ordLine && /overtime/i.test(rateName(l.EarningsRateID))) l.NumberOfUnits = 0; }
  place(t.ot15, 1.5, 'OT 1.5x', 'ot15');
  place(t.ot2x, 2, 'OT 2x', 'ot2');
  if (t.unsplit > 0) place(t.unsplit, 1.5, 'overtime (unsplit, sent as 1.5x)', 'ot15');

  const loading = casualLoadingFor(worker);
  if (loading && ordinaryUnits > 0) {
    const lr = findCasualLoadingRate(earningsRates);
    if (lr) {
      ordLine.NumberOfUnits = round2(ordinaryUnits);
      ordLine.RatePerUnit = round2(loading.base);
      const loadLine: any = { EarningsRateID: lr.EarningsRateID, NumberOfUnits: round2(ordinaryUnits) };
      if (String(lr.RateType || 'RATEPERUNIT').toUpperCase() === 'RATEPERUNIT') {
        loadLine.RatePerUnit = round2(loading.base * loading.pct);
      }
      const existing = lines.find(l => l.EarningsRateID === lr.EarningsRateID);
      if (existing) Object.assign(existing, loadLine); else lines.push(loadLine);
      summary.loading = round2(ordinaryUnits);
      payItemsUsed.push(nameOf(lr));
    } else {
      ordLine.NumberOfUnits = round2(ordinaryUnits);
      if (num(worker.pay_rate_regular) > 0) ordLine.RatePerUnit = round2(num(worker.pay_rate_regular));
      warnings.push(`no "Casual Loading" pay item in Xero — ${round2(ordinaryUnits)}h ordinary sent at the loaded rate A ($${round2(num(worker.pay_rate_regular)).toFixed(2)}/h)`);
    }
  } else {
    ordLine.NumberOfUnits = round2(ordinaryUnits);
  }
  summary.ordinary = round2(ordinaryUnits);
  payItemsUsed.unshift(rateName(ordLine.EarningsRateID));
  return { lines, summary, ok: true };
}

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
    .from('xero_tokens').select('tenant_id, scope').eq('id', 1).single();
  const tenantId = tokenRow?.tenant_id;
  if (!tenantId) return json({ error: 'No Xero organisation linked. Reconnect Xero.' }, 400);
  const hasSettingsScope = String(tokenRow?.scope || '').includes('payroll.settings');

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
    .select('*, workers(name, worker_type, pay_rate_regular, pay_rate_base, casual_loading_pct, xero_employee_id)')
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

  // ── 4. Fetch Xero employees + pay items (once) ────────────────────────────
  const empRes = await xeroGet(`${XERO_PAYROLL_BASE}/Employees`, accessToken, tenantId);
  if (!empRes.ok) {
    return json({ error: `Xero employee fetch failed (${empRes.status}): ${await empRes.text()}` }, 502);
  }
  const xeroEmployees: XeroEmployee[] = (await empRes.json()).Employees || [];

  // Pay items let overtime and casual loading land on their own lines instead
  // of being counted as ordinary time. Needs the payroll.settings scope; with
  // no items the OT hours are folded back into ordinary (total unchanged) and
  // every result row says so.
  let earningsRates: EarningsRate[] = [];
  const globalWarnings: string[] = [];
  try {
    const piRes = await xeroGet(`${XERO_PAYROLL_BASE}/PayItems`, accessToken, tenantId);
    if (piRes.ok) earningsRates = ((await piRes.json()).PayItems?.EarningsRates || []) as EarningsRate[];
    else globalWarnings.push(`Xero PayItems not readable (${piRes.status})${hasSettingsScope ? '' : ' — reconnect Xero from the Payroll page to grant the payroll.settings scope'}; overtime folded into ordinary time`);
  } catch (_e) {
    globalWarnings.push('Xero PayItems fetch failed; overtime folded into ordinary time');
  }

  // ── 5. Group the sheets by Xero employee and sum ──────────────────────────
  const results: Array<{ timesheetId: string; status: string; detail?: string }> = [];
  const groups = new Map<string, { emp: XeroEmployee; workerName: string; workerId: string; matchedBy: 'id' | 'name'; pay: WorkerPay; t: Totals }>();

  for (const ts of staffSheets as any[]) {
    const workerName: string = ts.workers?.name || '';
    const linkedId: string | null = ts.workers?.xero_employee_id || null;

    // Linked by EmployeeID first (Xero Data → Employees → "Link to portal
    // worker"); a name match is the fallback and is reported as such.
    let xeroEmp: XeroEmployee | undefined;
    let matchedBy: 'id' | 'name' = 'id';
    if (linkedId) {
      xeroEmp = xeroEmployees.find(e => e.EmployeeID === linkedId);
      if (!xeroEmp) {
        results.push({ timesheetId: ts.id, status: 'skipped',
          detail: `${workerName} is linked to Xero employee ${linkedId}, but that employee is not in this Xero organisation. Re-link them on the Xero Data page.` });
        continue;
      }
    } else {
      const parts = workerName.trim().split(' ');
      const firstName = parts[0] || '';
      const lastName = parts.slice(1).join(' ');
      // Case-insensitive, whitespace-trimmed: the live Xero file has names
      // like "Aaron " with a trailing space.
      xeroEmp = xeroEmployees.find(e =>
        (e.FirstName || '').trim().toLowerCase() === firstName.toLowerCase() &&
        (e.LastName || '').trim().toLowerCase() === lastName.toLowerCase()
      );
      matchedBy = 'name';
      if (!xeroEmp) {
        results.push({
          timesheetId: ts.id,
          status: 'skipped',
          detail: `No Xero employee matching "${workerName}". ` +
                  `Link them on the Xero Data page (Employees → Link to portal worker), or add them in Xero Payroll.`,
        });
        continue;
      }
    }

    const payHours = num(ts.pay_hours ?? ts.hours);
    const ot15 = num(ts.ot15_hours);
    const ot2x = num(ts.ot2x_hours);
    const split = ot15 + ot2x;
    const unsplit = split > 0 ? 0 : num(ts.overtime_hours); // legacy rows: one OT bucket only
    const ordinary = Math.max(0, payHours - split - unsplit);

    let g = groups.get(xeroEmp.EmployeeID);
    if (!g) {
      g = { emp: xeroEmp, workerName, workerId: ts.worker_id, matchedBy, pay: ts.workers || {},
            t: { ordinary: 0, ot15: 0, ot2x: 0, unsplit: 0, travel: 0, meal: 0, sheetIds: [] } };
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
      pushed: 0, skipped: results.length, errors: 0, results, employees: [],
      warnings: globalWarnings,
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
  const employees: Array<{ worker: string; xero_employee_id: string; matched_by: 'id' | 'name'; sheets: number; status: string } & Summary> = [];
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
      employees.push({ worker: g.workerName, xero_employee_id: g.emp.EmployeeID, matched_by: g.matchedBy, sheets: g.t.sheetIds.length, status: 'skipped',
        ordinary: 0, ot15: 0, ot2: 0, loading: 0, pay_items_used: [], warnings: ['not on the payroll calendar'] });
      continue;
    }

    const built = buildEmployeeLines({ totals: g.t, worker: g.pay, earningsRates, templateLines: existingSlip.EarningsLines || [] });
    if (!built.ok) {
      for (const id of g.t.sheetIds) {
        results.push({ timesheetId: id, status: 'error',
          detail: `${g.workerName}'s Xero payslip has no earnings lines — add an ordinary earnings rate to their pay template in Xero.` });
      }
      employees.push({ worker: g.workerName, xero_employee_id: g.emp.EmployeeID, matched_by: g.matchedBy, sheets: g.t.sheetIds.length, status: 'error', ...built.summary });
      continue;
    }
    const notes: string[] = [...built.summary.warnings];
    if (g.matchedBy === 'name') notes.push('matched to the Xero employee by NAME (not linked by ID) — link them on the Xero Data page');

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
      { ...existingSlip, EarningsLines: built.lines, AllowanceLines: allowanceLines }
    );

    if (updateRes.ok) {
      const { error: stampErr } = await supabase.from('timesheets')
        .update({ xero_exported: true }).in('id', g.t.sheetIds);
      if (stampErr) notes.push(`pushed to Xero but xero_exported was NOT stamped: ${stampErr.message}`);
      const detail = notes.length ? notes.join('; ') : undefined;
      for (const id of g.t.sheetIds) results.push({ timesheetId: id, status: 'pushed', detail });
      employees.push({ worker: g.workerName, xero_employee_id: g.emp.EmployeeID, matched_by: g.matchedBy, sheets: g.t.sheetIds.length, status: 'pushed', ...built.summary, warnings: notes });
    } else {
      const detail = await updateRes.text();
      for (const id of g.t.sheetIds) results.push({ timesheetId: id, status: 'error', detail });
      employees.push({ worker: g.workerName, xero_employee_id: g.emp.EmployeeID, matched_by: g.matchedBy, sheets: g.t.sheetIds.length, status: 'error', ...built.summary, warnings: [...notes, detail.slice(0, 200)] });
    }
  }

  const pushed  = results.filter(r => r.status === 'pushed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const errors  = results.filter(r => r.status === 'error').length;
  const nameMatched = employees.filter(e => e.matched_by === 'name').map(e => e.worker);

  await supabase.from('activity_events').insert([{
    actor_name: gate.via === 'user' ? (gate.worker?.name || gate.email) : 'portal',
    actor_id: gate.worker?.id || null,
    verb: 'pushed', object_type: 'xero_pay_run', object_id: null,
    after: { payRunID, periodFrom, periodTo, pushed, skipped, errors, employees: employees.map(e => ({ worker: e.worker, status: e.status, matched_by: e.matched_by, ordinary: e.ordinary, ot15: e.ot15, ot2: e.ot2, loading: e.loading })) },
  }]).then(() => {}, () => {});

  return json({
    payRunID,
    payrollCalendar: calData.PayrollCalendars?.[0]?.Name,
    employees,
    name_matched: nameMatched,
    pay_items_seen: earningsRates.map(r => r.Name),
    warnings: globalWarnings,
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
