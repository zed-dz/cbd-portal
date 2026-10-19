// Builds the Xero OAuth2 consent URL so an admin/accounts user can connect the
// portal to Xero Payroll. Replaces the URL the client used to build itself in
// src/pages/Payroll/PayrollTrackerPage.jsx (hardening 2026-10-15): the OAuth
// `state` is now minted and stored server-side, so xero-callback can refuse a
// forged redirect instead of binding a stranger's Xero org to the portal.
//
// GET or POST (no body) → 200 { auth_url: string, redirect_uri: string }
//                        | 401 { error: 'Unauthorized' }
//                        | 403 { error: 'Admin or accounts only' }
//                        | 503 { error: 'not_configured', message }
// The client follows auth_url (window.location.href = auth_url).
//
// GATE: MONEY (access_level admin/accounts) — Xero is payroll.
// State: random hex token stored in integration_secrets as
// 'oauth_state:xero:<state>' with its expiry (10 minutes) as the value;
// xero-callback verifies and consumes it (single use).

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const XERO_CLIENT_ID       = Deno.env.get('XERO_CLIENT_ID') || '';
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')   || '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;

// Must match xero-callback's REDIRECT_URI byte-for-byte (Xero refuses the
// token exchange otherwise) and the redirect URI registered on the Xero app.
const REDIRECT_URI  = `${Deno.env.get('SUPABASE_URL')}/functions/v1/xero-callback`;   // portal-agnostic (mirrors)
const XERO_AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
const STATE_TTL_MS  = 10 * 60 * 1000;

// payroll employees/pay runs/payslips for the push, payroll.settings so the
// push can read PayItems (overtime + casual-loading lines, 2026-10-19),
// accounting.contacts + accounting.transactions so xero-invoice can match or
// create the client contact and create DRAFT sales invoices, offline_access
// for the refresh token. Adding a scope means the owner must click
// "Reconnect" once — the stored token keeps the old scope list until then.
const SCOPES = [
  'openid', 'profile', 'email', 'offline_access',
  'payroll.employees', 'payroll.payruns', 'payroll.payslip', 'payroll.settings',
  'accounting.contacts', 'accounting.transactions',
].join(' ');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  // MONEY only — connecting Xero exposes payroll.
  const gate = await gateCaller(req, 'money');
  if (!gate.ok) return json({ error: gate.error }, gate.status);

  if (!XERO_CLIENT_ID) {
    return json({
      error: 'not_configured',
      message: 'XERO_CLIENT_ID is not set in Supabase function secrets.',
    }, 503);
  }

  // One-time state, 10-minute life, verified and consumed by xero-callback.
  const state = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const expires = new Date(Date.now() + STATE_TTL_MS).toISOString();
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { error: stErr } = await sb.from('integration_secrets')
    .insert({ key: `oauth_state:xero:${state}`, value: expires, updated_at: new Date().toISOString() });
  if (stErr) return json({ error: 'could not create oauth state', detail: stErr.message }, 500);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     XERO_CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    scope:         SCOPES,
    state,
  });

  const auth_url = `${XERO_AUTH_URL}?${params.toString()}`;
  return json({ auth_url, redirect_uri: REDIRECT_URI });
});
