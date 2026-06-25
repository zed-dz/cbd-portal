// stripe-pay-workers — pay workers from APPROVED timesheets (admin only).
//
// Computes each worker's pay for a period, creates a payment_run + worker_payments
// rows. For a worker WITH workers.stripe_account_id (Stripe Connect onboarded) it
// creates a Stripe Transfer; otherwise it records a manual payout row marked
// 'recorded' so the office can pay them outside Stripe.
//
// SAFETY: dry_run defaults to TRUE. With dry_run=true NO Stripe Transfer is created
// and NO rows are written — it only returns the computed per-worker breakdown.
// Real transfers also require payouts/transfers to be enabled on the Stripe account.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;

const ALLOWED_ORIGINS = [
  'https://cbd-portal-gray.vercel.app',
  'https://cbd-portal-zeta.vercel.app',
  'http://localhost:3000',
];

function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function form(params: Record<string, string | number | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) sp.append(k, String(v));
  return sp;
}

// Minimal pay estimate from a timesheet row: pay_hours * pay_rate_regular,
// + travel + meal allowance. (Loadings/OT multipliers are applied client-side in
// the payroll page; this is a conservative base-pay payout estimate.)
function workerPay(sheets: any[], worker: any): number {
  const rate = parseFloat(worker.pay_rate_regular || 0) || 0;
  const rateOT = parseFloat(worker.pay_rate_overtime || 0) || rate * 1.5;
  let total = 0;
  for (const t of sheets) {
    const payH = parseFloat(t.pay_hours ?? t.total_hours ?? t.hours ?? 0) || 0;
    const ot = parseFloat(t.overtime_hours ?? 0) || 0;
    const normal = Math.max(0, payH - ot);
    total += normal * rate + ot * rateOT;
    total += parseFloat(t.travel_allowance ?? 0) || 0;
    total += parseFloat(t.meal_allowance ?? 0) || 0;
  }
  return +total.toFixed(2);
}

serve(async (req) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });

  const auth = req.headers.get('Authorization');
  if (!auth) return json({ error: 'Unauthorized' }, 401);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    .auth.getUser(auth.replace('Bearer ', ''));
  if (authErr || !user?.email) return json({ error: 'Unauthorized' }, 401);
  const { data: caller } = await service.from('workers')
    .select('id, access_level').ilike('email', user.email).maybeSingle();
  if (!caller || !['admin', 'manager'].includes(caller.access_level)) return json({ error: 'Admin only' }, 403);

  const body = await req.json().catch(() => ({}));
  const { periodFrom, periodTo } = body;
  const dry_run = body.dry_run !== false; // default true
  if (!periodFrom || !periodTo) return json({ error: 'periodFrom, periodTo are required' }, 400);

  // Approved timesheets in the period, with their worker.
  const { data: sheets, error: tsErr } = await service.from('timesheets')
    .select('*, workers(id, name, pay_rate_regular, pay_rate_overtime, stripe_account_id, worker_type)')
    .eq('status', 'approved')
    .gte('date', periodFrom)
    .lte('date', periodTo);
  if (tsErr) return json({ error: `DB error: ${tsErr.message}` }, 500);
  if (!sheets || !sheets.length) return json({ error: 'No approved timesheets for that period.' }, 400);

  // Group by worker.
  const byWorker = new Map<string, { worker: any; rows: any[] }>();
  for (const t of sheets as any[]) {
    const w = t.workers;
    if (!w?.id) continue;
    if (!byWorker.has(w.id)) byWorker.set(w.id, { worker: w, rows: [] });
    byWorker.get(w.id)!.rows.push(t);
  }

  const currency = 'aud';
  const plan = [...byWorker.values()].map(({ worker, rows }) => {
    const amount = workerPay(rows, worker);
    return {
      worker_id: worker.id, worker_name: worker.name,
      timesheet_count: rows.length, amount, amount_cents: Math.round(amount * 100),
      method: worker.stripe_account_id ? 'stripe_transfer' : 'manual_recorded',
      stripe_account_id: worker.stripe_account_id || null,
    };
  }).filter((p) => p.amount_cents > 0);

  const total_cents = plan.reduce((s, p) => s + p.amount_cents, 0);
  const needing_connect = plan.filter((p) => p.method === 'manual_recorded').map((p) => p.worker_name);

  const summary = {
    periodFrom, periodTo, worker_count: plan.length, total_cents, currency, plan,
    workers_without_stripe_connect: needing_connect,
    note_connect: needing_connect.length
      ? `${needing_connect.length} worker(s) have no Stripe Connect account — they will be recorded as manual payouts, not auto-transferred. Onboard them via Stripe Connect to enable auto-transfer.`
      : null,
  };

  if (dry_run) {
    return json({ ok: true, dry_run: true, ...summary,
      note: 'Dry run — no payment_run was created and no Stripe transfers were made. Send dry_run=false to execute.' });
  }

  // Real run.
  const { data: secret } = await service.from('integration_secrets')
    .select('value').eq('key', 'stripe_secret_key').maybeSingle();
  const sk = secret?.value;
  if (!sk) return json({ error: 'No stripe_secret_key configured.' }, 400);
  const sh = { Authorization: `Bearer ${sk}`, 'Content-Type': 'application/x-www-form-urlencoded' };

  const { data: run } = await service.from('payment_runs').insert([{
    period_from: periodFrom, period_to: periodTo, status: 'draft',
    total_cents, currency, created_by: caller.id,
  }]).select().single();

  const results: any[] = [];
  for (const p of plan) {
    if (p.method === 'stripe_transfer' && p.stripe_account_id) {
      try {
        const tr = await fetch('https://api.stripe.com/v1/transfers', {
          method: 'POST', headers: sh,
          body: form({
            amount: p.amount_cents, currency, destination: p.stripe_account_id,
            description: `Wages ${periodFrom}..${periodTo} — ${p.worker_name}`,
          }),
        });
        if (!tr.ok) throw new Error(await tr.text());
        const transfer = await tr.json();
        const { data: row } = await service.from('worker_payments').insert([{
          run_id: run.id, worker_id: p.worker_id, amount_cents: p.amount_cents, currency,
          method: 'stripe_transfer', stripe_transfer_id: transfer.id, status: 'paid',
        }]).select().single();
        results.push({ ...p, status: 'paid', stripe_transfer_id: transfer.id, row_id: row?.id });
      } catch (e) {
        await service.from('worker_payments').insert([{
          run_id: run.id, worker_id: p.worker_id, amount_cents: p.amount_cents, currency,
          method: 'stripe_transfer', status: 'error', error: String(e),
        }]);
        results.push({ ...p, status: 'error', error: String(e) });
      }
    } else {
      await service.from('worker_payments').insert([{
        run_id: run.id, worker_id: p.worker_id, amount_cents: p.amount_cents, currency,
        method: 'manual_recorded', status: 'recorded',
      }]);
      results.push({ ...p, status: 'recorded' });
    }
  }

  const errors = results.filter((r) => r.status === 'error').length;
  const runStatus = errors ? (errors === results.length ? 'error' : 'partial') : 'completed';
  await service.from('payment_runs').update({ status: runStatus }).eq('id', run.id);

  return json({ ok: errors === 0, dry_run: false, run_id: run.id, run_status: runStatus, ...summary, results });
});
