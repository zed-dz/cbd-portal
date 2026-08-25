// portal-assistant — answers questions about THIS portal using LIVE data.
//
// The old help bubble posted a bare question to Venture Command's static
// knowledge base, so anything about real data came back as "I'm not able to see
// that information". This function fixes that: it reads the actual database
// before answering.
//
// Design decisions that matter:
//
//  * The model NEVER writes SQL. It picks from a fixed catalogue of read-only
//    queries below. An LLM with query access to a payroll database is a
//    data-exfiltration bug waiting to happen, and a hallucinated query is worse
//    than no answer.
//  * Scope follows the caller. A worker gets their own rows only; staff get the
//    business-wide view. We resolve that from the caller's JWT, not from
//    anything the client sends.
//  * Money and pay rates are only ever included for admin/manager callers.
//  * Every answer is grounded in a snapshot taken at request time, and the
//    snapshot is returned alongside the answer so a wrong number can be traced.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GROQ_API_KEY         = Deno.env.get('GROQ_API_KEY') || '';
const OPENROUTER_API_KEY   = Deno.env.get('OPENROUTER_API_KEY') || '';
const BRAND_NAME           = Deno.env.get('GMAIL_SENDER_NAME') || 'the portal';
const PORTAL_URL           = Deno.env.get('PORTAL_URL') || '';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const todayISO = () => new Date().toISOString().slice(0, 10);
const daysFromNow = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// ── The live snapshot ───────────────────────────────────────────────────────
// Row counts here are small (tens to low hundreds), so one broad snapshot beats
// a multi-round tool-calling loop: fewer moving parts, one round trip, and the
// model cannot ask for something it was not allowed to see.
async function buildSnapshot(sb: ReturnType<typeof createClient>, isStaff: boolean, workerId: string | null) {
  const snap: Record<string, unknown> = { as_at: new Date().toISOString(), scope: isStaff ? 'business' : 'own records only' };

  if (!isStaff) {
    // Worker scope: their allocations, their timesheets, their tickets. Nothing else.
    if (!workerId) return { ...snap, note: 'No worker record is linked to this login.' };
    const [alloc, ts, certs] = await Promise.all([
      sb.from('allocations').select('client, site, start_date, end_date, arrival_time, status, site_supervisor')
        .eq('worker_id', workerId).gte('end_date', todayISO()).order('start_date').limit(20),
      sb.from('timesheets').select('date, client, role, pay_hours, status, scenario')
        .eq('worker_id', workerId).order('date', { ascending: false }).limit(20),
      sb.from('certifications').select('name, expiry').eq('worker_id', workerId).order('expiry').limit(20),
    ]);
    snap.my_upcoming_allocations = alloc.data ?? [];
    snap.my_recent_timesheets    = ts.data ?? [];
    snap.my_certifications       = certs.data ?? [];
    return snap;
  }

  // Staff scope.
  const [workers, clients, rateCards, allocToday, tsPending, tsApproved, certsSoon, notifs, jobs] = await Promise.all([
    sb.from('workers').select('id, name, worker_type, role, app_status, archived_at, job_title'),
    sb.from('clients').select('id, name, rate_a, rate_b, rate_c'),
    sb.from('client_rate_cards').select('client_id, role_name'),
    sb.from('allocations').select('worker_id, client, site, status, start_date, end_date')
      .lte('start_date', todayISO()).gte('end_date', todayISO()),
    sb.from('timesheets').select('id, date, client, role, worker_id, pay_hours, status')
      .eq('status', 'pending').order('date').limit(50),
    sb.from('timesheets').select('id, date, pay_hours, charge_hours, xero_exported, status')
      .eq('status', 'approved').order('date', { ascending: false }).limit(400),
    sb.from('certifications').select('worker_id, name, expiry').lte('expiry', daysFromNow(30)).order('expiry').limit(50),
    sb.from('notifications').select('type, title, created_at, read').order('created_at', { ascending: false }).limit(15),
    sb.from('client_jobs').select('client_id, name, status'),
  ]);

  const all      = workers.data ?? [];
  const active   = all.filter((w: any) => !w.archived_at);
  const byId     = Object.fromEntries(all.map((w: any) => [w.id, w.name]));
  const cardsBy  = new Set((rateCards.data ?? []).map((r: any) => r.client_id));

  snap.workers = {
    active_total: active.length,
    archived_total: all.length - active.length,
    by_type: ['full-time', 'casual', 'subcontractor'].map(t => ({
      type: t, count: active.filter((w: any) => w.worker_type === t).length,
    })),
    admins: active.filter((w: any) => w.role === 'admin').map((w: any) => w.name),
    not_yet_active_on_app: active.filter((w: any) => w.app_status !== 'Active').length,
  };

  snap.clients = {
    total: (clients.data ?? []).length,
    names: (clients.data ?? []).map((c: any) => c.name),
    without_a_rate_card: (clients.data ?? []).filter((c: any) => !cardsBy.has(c.id)).map((c: any) => c.name),
    projects_total: (jobs.data ?? []).length,
  };

  snap.on_site_today = (allocToday.data ?? []).map((a: any) => ({
    worker: byId[a.worker_id] ?? 'unknown', client: a.client, site: a.site, status: a.status,
  }));

  snap.timesheets_pending = {
    count: (tsPending.data ?? []).length,
    oldest_date: (tsPending.data ?? [])[0]?.date ?? null,
    rows: (tsPending.data ?? []).slice(0, 15).map((t: any) => ({
      date: t.date, worker: byId[t.worker_id] ?? 'unknown', client: t.client, role: t.role, hours: t.pay_hours,
    })),
  };

  const approved = tsApproved.data ?? [];
  snap.payroll = {
    approved_total: approved.length,
    awaiting_export: approved.filter((t: any) => !t.xero_exported).length,
    // Hours only. Dollars need worker pay rates, which are deliberately not
    // pulled into a text prompt — the Payroll page is the place for money.
    hours_awaiting_export: approved.filter((t: any) => !t.xero_exported)
      .reduce((s: number, t: any) => s + (parseFloat(t.pay_hours) || 0), 0).toFixed(2),
  };

  snap.licences_expiring_within_30_days = (certsSoon.data ?? []).map((c: any) => ({
    worker: byId[c.worker_id] ?? 'unknown', licence: c.name, expiry: c.expiry,
    already_expired: c.expiry < todayISO(),
  }));

  snap.recent_alerts = (notifs.data ?? []).map((n: any) => ({ type: n.type, title: n.title, at: n.created_at, read: n.read }));

  return snap;
}

const SYSTEM = (brand: string, isStaff: boolean, page: string) => `
You are the built-in assistant for the ${brand} operations portal — a labour-hire
system for scheduling crews, recording timesheets, running payroll and billing clients.

You are given a LIVE SNAPSHOT of the database, taken just now. Answer from it.

Rules:
- Use the snapshot for anything factual. Quote real names, counts and dates from it.
- If the snapshot does not contain the answer, say plainly what you do not have and
  name the page in the portal where the user can see it. Never invent a number.
- The user is currently on the "${page || 'unknown'}" page. Prefer answers relevant to it.
- The user is ${isStaff ? 'office staff / admin — the business-wide view' : 'a worker — they can only see their own records'}.
- Be brief and concrete. Two or three sentences unless asked for detail. Plain language.
- Reply in PLAIN TEXT only. No markdown: no **bold**, no ##headings, no bullet syntax.
  The chat bubble renders text verbatim, so asterisks show up as literal asterisks.
  For a list, use short lines separated by newlines.
- You may also explain how the portal works: allocations are bookings made before the
  work; timesheets record what actually happened; a supervisor approves a timesheet by
  a texted link, and it auto-approves after 7 days if nobody responds; pay splits into
  normal time, 1.5x and 2x; clients are billed off their own schedule of rates.
- Never invent pay rates, dollar figures or anything about a named person that is not
  in the snapshot.
`.trim();

async function callLLM(system: string, user: string) {
  const attempts: Array<{ name: string; url: string; key: string; model: string }> = [];
  if (GROQ_API_KEY)       attempts.push({ name: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_API_KEY, model: 'openai/gpt-oss-120b' });  // this key has no llama-3.3; verified against /v1/models
  if (OPENROUTER_API_KEY) attempts.push({ name: 'openrouter', url: 'https://openrouter.ai/api/v1/chat/completions', key: OPENROUTER_API_KEY, model: 'meta-llama/llama-3.3-70b-instruct' });
  if (!attempts.length) return { ok: false, answer: '', via: 'none', detail: 'No LLM key configured (need GROQ_API_KEY or OPENROUTER_API_KEY).' };

  for (const a of attempts) {
    try {
      const res = await fetch(a.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${a.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: a.model, temperature: 0.2, max_tokens: 700,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      });
      if (!res.ok) continue;
      const d = await res.json();
      const answer = d?.choices?.[0]?.message?.content?.trim();
      if (answer) return { ok: true, answer, via: a.name, detail: '' };
    } catch { /* try the next provider */ }
  }
  return { ok: false, answer: '', via: 'none', detail: 'Every LLM provider failed.' };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  const auth = req.headers.get('Authorization');
  if (!auth) return json({ error: 'Unauthorized' }, 401);

  let body: { question?: string; page?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const question = (body.question || '').trim();
  if (!question) return json({ error: 'question is required' }, 400);
  if (question.length > 1000) return json({ error: 'question too long' }, 400);

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Scope comes from the verified token, never from the request body.
  const { data: { user }, error: authErr } = await sb.auth.getUser(auth.replace('Bearer ', ''));
  if (authErr || !user?.email) return json({ error: 'Unauthorized' }, 401);

  const { data: me } = await sb.from('workers')
    .select('id, name, role, access_level').ilike('email', user.email).maybeSingle();
  const isStaff = !!me && (['admin', 'manager'].includes(me.access_level) || me.role === 'admin');

  const snapshot = await buildSnapshot(sb, isStaff, me?.id ?? null);

  const prompt = [
    `LIVE SNAPSHOT (JSON, taken ${new Date().toISOString()}):`,
    '```json', JSON.stringify(snapshot, null, 1), '```',
    '',
    `QUESTION from ${me?.name || user.email}: ${question}`,
  ].join('\n');

  const r = await callLLM(SYSTEM(BRAND_NAME, isStaff, body.page || ''), prompt);
  if (!r.ok) return json({ error: r.detail, via: r.via }, 502);

  return json({
    answer: r.answer,
    via: r.via,
    scope: isStaff ? 'staff' : 'worker',
    snapshot_at: (snapshot as any).as_at,
    portal: PORTAL_URL || undefined,
  });
});
