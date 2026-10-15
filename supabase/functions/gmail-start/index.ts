// Builds the Google OAuth consent URL so the admin can authorise the
// portal to send & read mail through their Gmail/Workspace account.
//
// GET → { auth_url: string } or { error: 'not_configured' }
//
// GATE: OFFICE (hardening 2026-10-15). Also mints an OAuth `state`: a random
// token stored in integration_secrets as key 'oauth_state:gmail:<state>' with
// the expiry (10 minutes) as the value. gmail-callback refuses any code that
// does not arrive with a live, unused state, so a forged redirect cannot bind
// an attacker's Google account to the portal inbox.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GMAIL_CLIENT_ID      = Deno.env.get('GMAIL_CLIENT_ID')  || '';
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')     || '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;

const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/gmail-callback`;
const STATE_TTL_MS = 10 * 60 * 1000;

// gmail.modify covers read + send + label updates. Includes everything the
// portal needs without granting full account access.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
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

  const gate = await gateCaller(req, 'office');
  if (!gate.ok) return json({ error: gate.error }, gate.status);

  if (!GMAIL_CLIENT_ID) {
    return json({
      error: 'not_configured',
      message: 'GMAIL_CLIENT_ID is not set in Supabase function secrets. See CLAUDE.md → Gmail setup.',
    }, 503);
  }

  // One-time state, 10-minute life, verified and consumed by gmail-callback.
  const state = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const expires = new Date(Date.now() + STATE_TTL_MS).toISOString();
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { error: stErr } = await sb.from('integration_secrets')
    .insert({ key: `oauth_state:gmail:${state}`, value: expires, updated_at: new Date().toISOString() });
  if (stErr) return json({ error: 'could not create oauth state', detail: stErr.message }, 500);

  const params = new URLSearchParams({
    client_id:     GMAIL_CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    scope:         SCOPES,
    access_type:   'offline',
    // 'consent' forces Google to issue a fresh refresh_token even if the user
    // has already granted access — needed so we can call refresh later.
    prompt:        'consent',
    include_granted_scopes: 'true',
    state,
  });

  const auth_url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  return json({ auth_url, redirect_uri: REDIRECT_URI });
});
