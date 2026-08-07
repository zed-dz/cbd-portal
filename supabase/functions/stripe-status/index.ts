// stripe-status — READ-ONLY Stripe connection check (admin only).
// Reads the LIVE secret key from integration_secrets (service-role), then calls
// GET /v1/account + GET /v1/balance. Never moves money. Used by the admin
// Payments page to show what is wired and what is still needed for payouts.

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

serve(async (req) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });

  const auth = req.headers.get('Authorization');
  if (!auth) return json({ error: 'Unauthorized' }, 401);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Verify the caller is an admin/manager.
  const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    .auth.getUser(auth.replace('Bearer ', ''));
  if (authErr || !user?.email) return json({ error: 'Unauthorized' }, 401);
  const { data: worker } = await service.from('workers')
    .select('access_level').ilike('email', user.email).maybeSingle();
  if (!worker || !['admin', 'manager'].includes(worker.access_level)) {
    return json({ error: 'Admin only' }, 403);
  }

  const { data: secret } = await service.from('integration_secrets')
    .select('value').eq('key', 'stripe_secret_key').maybeSingle();
  const sk = secret?.value;
  if (!sk) return json({ connected: false, error: 'No stripe_secret_key configured in integration_secrets.' });

  const sh = { Authorization: `Bearer ${sk}` };
  const acctRes = await fetch('https://api.stripe.com/v1/account', { headers: sh });
  if (!acctRes.ok) {
    return json({ connected: false, error: `Stripe account check failed (${acctRes.status}).` });
  }
  const acct = await acctRes.json();
  const balRes = await fetch('https://api.stripe.com/v1/balance', { headers: sh });
  const bal = balRes.ok ? await balRes.json() : null;

  return json({
    connected: true,
    livemode: !!acct.charges_enabled && (bal?.livemode ?? null),
    account_id: acct.id,
    business_name: acct.business_profile?.name ?? acct.settings?.dashboard?.display_name ?? null,
    country: acct.country,
    default_currency: acct.default_currency,
    charges_enabled: acct.charges_enabled,
    payouts_enabled: acct.payouts_enabled,
    details_submitted: acct.details_submitted,
    available: bal?.available ?? null,
    pending: bal?.pending ?? null,
    // Surface what still has to happen for full auto-payout.
    payout_requirements: acct.payouts_enabled
      ? null
      : 'Stripe payouts are disabled for this account — complete Stripe verification (business/identity details) before real worker payouts can run.',
  });
});
