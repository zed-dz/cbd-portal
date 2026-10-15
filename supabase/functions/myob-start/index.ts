// myob-start — kicks off the MYOB OAuth consent flow. INERT until the
// MYOB_CLIENT_ID / MYOB_CLIENT_SECRET secrets are set (the owner is getting
// API access from the bookkeeper; meeting 2026-09-22).
//
// HARDENING 2026-10-15: this used to be an open redirect-style endpoint
// (verify_jwt off, browser navigated straight to it). It is now OFFICE-gated
// and deployed with verify_jwt=true, so — like gmail-start — it is called
// with the user's JWT and returns { auth_url } for the browser to open:
//
//   const { data } = await supabase.functions.invoke('myob-start', { method: 'GET' });
//   window.location.href = data.auth_url;
//
// (MyobConnectCard.jsx currently sets window.location.href to this function
// directly; that must change to the call above.)
//
// It also mints an OAuth `state` (integration_secrets key
// 'oauth_state:myob:<state>', value = expiry, 10 minutes) that myob-callback
// verifies and consumes.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MYOB_CLIENT_ID       = Deno.env.get('MYOB_CLIENT_ID') || '';
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;
const STATE_TTL_MS         = 10 * 60 * 1000;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const gate = await gateCaller(req, 'office');
  if (!gate.ok) return json({ error: gate.error }, gate.status);

  if (!MYOB_CLIENT_ID) {
    return json({
      error: 'not_configured',
      message: 'MYOB is not configured yet. Set MYOB_CLIENT_ID and MYOB_CLIENT_SECRET in the Supabase edge function secrets, then try again.',
    }, 503);
  }

  // One-time state, 10-minute life, verified and consumed by myob-callback.
  const state = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const expires = new Date(Date.now() + STATE_TTL_MS).toISOString();
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { error: stErr } = await sb.from('integration_secrets')
    .insert({ key: `oauth_state:myob:${state}`, value: expires, updated_at: new Date().toISOString() });
  if (stErr) return json({ error: 'could not create oauth state', detail: stErr.message }, 500);

  const redirect = `${SUPABASE_URL}/functions/v1/myob-callback`;
  const auth_url = 'https://secure.myob.com/oauth2/account/authorize'
    + `?client_id=${encodeURIComponent(MYOB_CLIENT_ID)}`
    + `&redirect_uri=${encodeURIComponent(redirect)}`
    + '&response_type=code&scope=CompanyFile'
    + `&state=${encodeURIComponent(state)}`;
  return json({ auth_url, redirect_uri: redirect });
});
