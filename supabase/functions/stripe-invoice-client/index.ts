// stripe-invoice-client — invoice a client from APPROVED timesheets (admin only).
//
// Computes amount = sum(charge_hours * client charge rate) for the client over a
// period, then (unless dry_run) creates a Stripe Invoice: customer -> invoice item
// -> invoice -> finalize. Persists to client_invoices.
//
// SAFETY: dry_run defaults to TRUE. With dry_run=true NO Stripe write call is made
// — it only returns the computed breakdown. Set dry_run=false to actually create
// the invoice.

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
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function form(params: Record<string, string | number | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) sp.append(k, String(v));
  return sp;
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
  const { client, periodFrom, periodTo, customerEmail } = body;
  const dry_run = body.dry_run !== false; // default true
  if (!client || !periodFrom || !periodTo) {
    return json({ error: 'client, periodFrom, periodTo are required' }, 400);
  }

  // 1. Approved timesheets for this client in the period.
  const { data: sheets, error: tsErr } = await service.from('timesheets')
    .select('*')
    .eq('client', client)
    .eq('status', 'approved')
    .gte('date', periodFrom)
    .lte('date', periodTo);
  if (tsErr) return json({ error: `DB error: ${tsErr.message}` }, 500);
  if (!sheets || !sheets.length) {
    return json({ error: 'No approved timesheets for that client and period.' }, 400);
  }

  // 2. Client charge rate (client_rate_cards or clients.rate_regular).
  const { data: clientRow } = await service.from('clients')
    .select('*').ilike('name', client).maybeSingle();
  let chargeRate = parseFloat(clientRow?.rate_regular ?? '0') || 0;
  let rateSource = 'clients.rate_regular';
  if (!chargeRate) {
    const { data: card } = await service.from('client_rate_cards')
      .select('*').ilike('client', client).limit(1).maybeSingle()
      .then((r) => r, () => ({ data: null }));
    if (card?.rate_regular) { chargeRate = parseFloat(card.rate_regular) || 0; rateSource = 'client_rate_cards.rate_regular'; }
  }

  const totalChargeHours = sheets.reduce((s: number, t: any) => s + (parseFloat(t.charge_hours ?? t.total_hours ?? 0) || 0), 0);
  const amount = +(totalChargeHours * chargeRate).toFixed(2);
  const amount_cents = Math.round(amount * 100);
  const currency = (clientRow?.currency || 'aud').toLowerCase();

  const breakdown = {
    client, periodFrom, periodTo,
    timesheet_count: sheets.length,
    total_charge_hours: totalChargeHours,
    charge_rate: chargeRate,
    rate_source: rateSource,
    amount, amount_cents, currency,
    missing_rate: chargeRate <= 0,
  };

  if (chargeRate <= 0) {
    return json({ ok: false, dry_run, breakdown,
      error: `No client charge rate found for "${client}". Set clients.rate_regular (or a client_rate_cards entry) before invoicing.` });
  }

  if (dry_run) {
    return json({ ok: true, dry_run: true, breakdown,
      note: 'Dry run — no Stripe invoice was created. Send dry_run=false to create it for real.' });
  }

  // 3. Real Stripe invoice.
  const { data: secret } = await service.from('integration_secrets')
    .select('value').eq('key', 'stripe_secret_key').maybeSingle();
  const sk = secret?.value;
  if (!sk) return json({ error: 'No stripe_secret_key configured.' }, 400);
  const sh = { Authorization: `Bearer ${sk}`, 'Content-Type': 'application/x-www-form-urlencoded' };

  const invRowBase = {
    client, period_from: periodFrom, period_to: periodTo,
    amount_cents, currency, line_items: breakdown, created_by: caller.id,
  };

  try {
    // customer
    const custRes = await fetch('https://api.stripe.com/v1/customers', {
      method: 'POST', headers: sh,
      body: form({ name: client, email: customerEmail || clientRow?.email || undefined }),
    });
    if (!custRes.ok) throw new Error(`customer: ${await custRes.text()}`);
    const customer = await custRes.json();

    // invoice item
    const itemRes = await fetch('https://api.stripe.com/v1/invoiceitems', {
      method: 'POST', headers: sh,
      body: form({
        customer: customer.id, amount: amount_cents, currency,
        description: `Labour hire ${periodFrom}..${periodTo} — ${totalChargeHours}h @ ${chargeRate}/h`,
      }),
    });
    if (!itemRes.ok) throw new Error(`invoiceitem: ${await itemRes.text()}`);

    // invoice (collection: send_invoice, due in 14 days)
    const invRes = await fetch('https://api.stripe.com/v1/invoices', {
      method: 'POST', headers: sh,
      body: form({ customer: customer.id, collection_method: 'send_invoice', days_until_due: 14, auto_advance: 'true' }),
    });
    if (!invRes.ok) throw new Error(`invoice: ${await invRes.text()}`);
    const invoice = await invRes.json();

    // finalize
    const finRes = await fetch(`https://api.stripe.com/v1/invoices/${invoice.id}/finalize`, { method: 'POST', headers: sh });
    const finalized = finRes.ok ? await finRes.json() : invoice;

    const { data: saved } = await service.from('client_invoices').insert([{
      ...invRowBase,
      stripe_customer_id: customer.id,
      stripe_invoice_id: finalized.id,
      stripe_status: finalized.status,
      hosted_invoice_url: finalized.hosted_invoice_url,
      status: 'created',
    }]).select().single();

    return json({ ok: true, dry_run: false, breakdown,
      invoice: { id: finalized.id, status: finalized.status, hosted_invoice_url: finalized.hosted_invoice_url }, saved });
  } catch (e) {
    await service.from('client_invoices').insert([{ ...invRowBase, status: 'error', error: String(e) }]);
    return json({ ok: false, dry_run: false, breakdown, error: String(e) }, 502);
  }
});
