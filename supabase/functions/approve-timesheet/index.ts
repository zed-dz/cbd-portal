// approve-timesheet — the ADMIN approve action, server-side (Dashpivot parity
// prompt 2.1). Approve = state change + lock, never a client-side update.
//
// Input: { header_id }. Caller must be a signed-in worker with
// access_level = 'admin' (verify_jwt = true on deploy; the admin check here is
// the real gate — verify_jwt only proves a valid JWT).
//
// What it does, in order:
//   1. loads the header + line rows, rejects if already locked or no lines
//   2. recomputes every line's penalty split on the SERVER via the DB function
//      split_shift_hours_v2 (profile from clients.award_profile, same lookup
//      save_daily_timesheet uses) and REJECTS the approval if any stored
//      bucket differs from the recomputation by more than 0.01 h — never
//      trust client totals
//   3. sets lines then header to status='approved', approved_by/approved_at,
//      locked=true on the header (lines first: once the block_locked_edits
//      trigger is live, line updates under a locked header are restricted)
//      (version is deliberately untouched — only Reset workflow bumps it)
//   4. writes activity_events verb 'approved'
//   5. POSTs to send-timesheet-pdf with the service-role key so the client
//      gets the hours-only PDF automatically (failure there never un-approves;
//      that function raises its own admin bell)

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const num = (v: unknown) => {
  const n = parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  let body: { header_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  if (!body.header_id) return json({ error: 'header_id required' }, 400);

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── Caller must be an active admin worker ────────────────────────────────
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: userData, error: userErr } = await sb.auth.getUser(jwt);
  const email = userData?.user?.email;
  if (userErr || !email) return json({ error: 'not authenticated' }, 401);

  const { data: adminRows } = await sb.from('workers')
    .select('id, name, access_level')
    .ilike('email', email)
    .eq('access_level', 'admin')
    .is('archived_at', null)
    .limit(1);
  const admin = adminRows?.[0];
  if (!admin) return json({ error: 'admins only' }, 403);

  // ── Load header + lines ───────────────────────────────────────────────────
  const { data: h, error: hErr } = await sb.from('timesheet_headers')
    .select('id, worker_id, client, project, role, status, locked, version, total_hours, workers(name, worker_type)')
    .eq('id', body.header_id)
    .maybeSingle();
  if (hErr || !h) return json({ error: 'timesheet not found' }, 404);
  if (h.locked) return json({ ok: true, already: 'approved and locked', version: h.version ?? 1 });

  const { data: lines, error: lErr } = await sb.from('timesheets')
    .select('*').eq('header_id', h.id).order('date');
  if (lErr) return json({ error: lErr.message }, 500);
  if (!lines?.length) return json({ error: 'this timesheet has no shift lines — nothing to approve' }, 422);

  const workerType = (h as any).workers?.worker_type || 'casual';

  // Same profile lookup as save_daily_timesheet: the CLIENT's award_profile.
  const { data: clientRows } = await sb.from('clients')
    .select('id, award_profile')
    .ilike('name', (h.client || '').trim())
    .order('created_at')
    .limit(1);
  const client = clientRows?.[0];
  const profile = client?.award_profile ?? null;

  // ── Server-side recomputation — never trust client totals ────────────────
  const TOL = 0.01 + 1e-9;
  const mismatches: string[] = [];
  for (const l of lines) {
    const { data: split, error: sErr } = await sb.rpc('split_shift_hours_v2', {
      p_total:       num(l.total_hours),
      p_worker_type: workerType,
      p_date:        l.date,
      p_shift_type:  l.shift_type,
      p_scenario:    l.scenario,
      p_profile:     profile,
      p_start:       l.start_time,
      p_end:         l.end_time,
      p_break:       l.total_break_hours != null ? num(l.total_break_hours)
                     : (l.break_minutes != null ? num(l.break_minutes) / 60 : 0),
    });
    if (sErr) return json({ error: `hours recomputation failed for ${l.date}: ${sErr.message}` }, 500);
    const r = Array.isArray(split) ? split[0] : split;
    if (!r) return json({ error: `hours recomputation returned nothing for ${l.date}` }, 500);

    const checks: Array<[string, number, number]> = [
      ['normal (1.0x)', num(l.regular_hours), num(r.ordinary)],
      ['RDO',           num(l.rdo_hours),     num(r.rdo)],
      ['OT 1.5x',       num(l.ot15_hours),    num(r.ot15)],
      ['OT 2.0x',       num(l.ot2x_hours),    num(r.ot2x)],
    ];
    for (const [label, stored, recomputed] of checks) {
      if (Math.abs(stored - recomputed) > TOL) {
        mismatches.push(`${l.date} ${label}: stored ${stored.toFixed(2)}h, server says ${recomputed.toFixed(2)}h`);
      }
    }
  }
  if (mismatches.length) {
    return json({
      error: `Approval refused — stored hours do not match the server recomputation. ${mismatches.join('; ')}. Open Edit and re-save the timesheet (that recomputes the split), then approve again.`,
      mismatches,
    }, 409);
  }

  // ── Approve: lines first, then header + lock ─────────────────────────────
  const now = new Date().toISOString();
  const { error: linesErr } = await sb.from('timesheets')
    .update({ status: 'approved', approved_by: admin.name, approved_at: now })
    .eq('header_id', h.id);
  if (linesErr) return json({ error: `could not approve line rows: ${linesErr.message}` }, 500);

  const { error: headErr } = await sb.from('timesheet_headers')
    .update({ status: 'approved', approved_by: admin.name, approved_at: now, locked: true })
    .eq('id', h.id);
  if (headErr) return json({ error: `could not approve header: ${headErr.message}` }, 500);

  await sb.from('activity_events').insert([{
    actor_id: admin.id, actor_name: admin.name,
    verb: 'approved', object_type: 'timesheet_header', object_id: h.id,
    client_id: client?.id ?? null,
    before: { status: h.status, locked: !!h.locked },
    after:  { status: 'approved', locked: true, version: h.version ?? 1 },
  }]);

  // ── PDF to the client, via the existing send function (service role) ─────
  let pdf: unknown = null;
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/send-timesheet-pdf`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        apikey: SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ header_id: h.id, reason: 'admin-approve' }),
    });
    pdf = await r.json().catch(() => ({ error: `send-timesheet-pdf HTTP ${r.status}` }));
  } catch (e) {
    pdf = { error: `send-timesheet-pdf unreachable: ${String((e as Error).message)}` };
  }

  return json({ ok: true, approved: true, locked: true, lines: lines.length, version: h.version ?? 1, pdf });
});
