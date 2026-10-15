// stripe-status — READ-ONLY Stripe connection check (admin only).
// Reads the LIVE secret key from integration_secrets (service-role), then calls
// GET /v1/account + GET /v1/balance. Never moves money. Used by the admin
// Payments page to show what is wired and what is still needed for payouts.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;

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

serve(async (req) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });

  // MONEY gate: admin/accounts only (the old 'manager' acceptance is gone).
  const gate = await gateCaller(req, 'money');
  if (!gate.ok) return json({ error: gate.error }, gate.status);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

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
