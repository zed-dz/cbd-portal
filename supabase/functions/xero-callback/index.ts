// Xero OAuth2 callback — two legs since 2026-11-09 (closes the A2Z audit's
// login-swap gap for good).
//
//  Leg 1  GET  (Xero → here, no portal session on this host)
//         Validates the `state` minted by xero-start (format, exists, not
//         expired) WITHOUT consuming it, then bounces the browser back to the
//         portal: ${PORTAL_URL}/?xero_finish=1&code=…&state=…
//         No token exchange happens here any more.
//
//  Leg 2  POST (portal → here, Authorization: the logged-in admin's JWT,
//         body { code, state })
//         The JWT's auth user id AND e-mail must equal the ones baked into the
//         state by xero-start ('<expiry ISO>|<auth user id>|<email>'). Only
//         then is the state consumed (single use), the person re-checked as a
//         money user (admin, not an allocator, not archived), the code
//         exchanged with Xero, the tokens written to Vault (xeroTokens.ts →
//         xero_tokens_write) and one activity_events row logged.
//         → 200 { ok: true } | 200 { ok: false, error: '<code>' }
//
// Why: Xero redirects to supabase.co, where the browser carries no portal
// session, so the old single-leg callback could only trust the state value.
// Now the exchange is done from the portal tab that is actually logged in, so a
// swapped login (admin A starts, someone logged in as B finishes) is refused.
//
// Hardening kept from 2026-10-15: state is random 256-bit, 10-minute, stored
// in integration_secrets as 'oauth_state:xero:<state>', mintable only by a money
// user through xero-start. Tokens never touch plain columns or logs.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { saveTokens } from './xeroTokens.ts';

const XERO_CLIENT_ID       = Deno.env.get('XERO_CLIENT_ID')!;
const XERO_CLIENT_SECRET   = Deno.env.get('XERO_CLIENT_SECRET')!;
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Function secret PORTAL_URL (production host since 2026-10-15). The fallback
// is the same host so a missing secret never sends anyone to a vercel.app page.
const PORTAL_URL   = (Deno.env.get('PORTAL_URL') || 'https://portal.cbdpnl.com.au').replace(/\/+$/, '');
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/xero-callback`;   // portal-agnostic (mirrors)

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
// Leg-1 exits are redirects to the portal root; App.jsx reads the query string.
const back = (query: string) => Response.redirect(`${PORTAL_URL}/?${query}`, 302);

const STATE_RE = /^[a-f0-9]{32,128}$/;
type StateRow = { expires: string; userId: string; email: string } | null;

// Read (and optionally consume) a state row. Also sweeps expired states.
async function readState(sb: ReturnType<typeof createClient>, state: string, consume: boolean): Promise<StateRow> {
  const key = `oauth_state:xero:${state}`;
  const { data: st } = await sb.from('integration_secrets').select('value').eq('key', key).maybeSingle();
  if (consume) await sb.from('integration_secrets').delete().eq('key', key);
  // The value starts with the expiry ISO stamp, so a plain string compare works.
  await sb.from('integration_secrets').delete().like('key', 'oauth_state:%').lt('value', new Date().toISOString());
  const [expires = '', userId = '', email = ''] = String(st?.value || '').split('|');
  if (!st || !expires || expires < new Date().toISOString()) {
    if (st) await sb.from('integration_secrets').delete().eq('key', key);   // expired: never reusable
    return null;
  }
  if (!userId || !email) return null;   // pre-2026-11-09 shape, refuse
  return { expires, userId, email: email.toLowerCase() };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── Leg 1: Xero's redirect ────────────────────────────────────────────────
  if (req.method === 'GET') {
    const url   = new URL(req.url);
    const code  = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const state = url.searchParams.get('state') || '';
    if (!STATE_RE.test(state)) return back('xero_error=bad_state');
    const st = await readState(sb, state, false);
    if (!st) return back('xero_error=bad_state');
    if (error || !code) {
      await sb.from('integration_secrets').delete().eq('key', `oauth_state:xero:${state}`);
      return back(`xero_error=${encodeURIComponent(error || 'no_code')}`);
    }
    return back(`xero_finish=1&code=${encodeURIComponent(code)}&state=${state}`);
  }

  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);

  // ── Leg 2: the logged-in portal finishes the exchange ─────────────────────
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt || jwt === SUPABASE_ANON_KEY) return json({ ok: false, error: 'unauthorized' }, 401);
  const { data: userData, error: userErr } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY).auth.getUser(jwt);
  const user = userData?.user;
  if (userErr || !user?.id || !user.email) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: { code?: unknown; state?: unknown } = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }
  const code  = typeof body.code === 'string' ? body.code : '';
  const state = typeof body.state === 'string' ? body.state : '';
  if (!code || !STATE_RE.test(state)) return json({ ok: false, error: 'bad_state' });

  // Consume the state (single use) and bind it to THIS login.
  const st = await readState(sb, state, true);
  if (!st) return json({ ok: false, error: 'bad_state' });
  if (st.userId !== user.id || st.email !== user.email.toLowerCase()) {
    console.error('xero finish: state user mismatch');
    return json({ ok: false, error: 'not_allowed' });
  }

  // Who started this flow must STILL be a money user.
  const { data: starter } = await sb.from('workers')
    .select('id, name, access_level, is_allocator')
    .eq('email', st.email).is('archived_at', null).maybeSingle();
  const stillMoney = !!starter && ['admin', 'accounts'].includes(starter.access_level || '') && !starter.is_allocator;
  if (!stillMoney) return json({ ok: false, error: 'not_allowed' });

  // Exchange code for tokens
  const tokenRes = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${btoa(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
  });
  if (!tokenRes.ok) {
    console.error('Token exchange failed:', tokenRes.status);
    return json({ ok: false, error: 'token_exchange_failed' });
  }
  const tokens = await tokenRes.json();   // { access_token, refresh_token, expires_in, token_type, scope }

  // Organisations connected — first one by default.
  const tenantsRes = await fetch('https://api.xero.com/connections', { headers: { 'Authorization': `Bearer ${tokens.access_token}` } });
  const tenants = tenantsRes.ok ? await tenantsRes.json() : [];
  const tenantId = tenants[0]?.tenantId || null;

  // Store — encrypted at rest (Vault) through the service-role-only SQL API.
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const dbErr = await saveTokens(sb, {
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    expiresAt,
    tenant_id:     tenantId,
    scope:         tokens.scope ?? null,
    connected_by:  st.email,
  });
  if (dbErr) {
    console.error('token store failed:', dbErr);
    return json({ ok: false, error: 'db_failed' });
  }

  // Office-readable audit line: who connected which organisation (no tokens).
  await sb.from('activity_events').insert([{
    actor_id: starter!.id, actor_name: starter!.name || st.email,
    verb: 'xero connected', object_type: 'xero', object_id: null,
    after: { tenant_id: tenantId, scope: tokens.scope ?? null, by: st.email },
  }]).then(({ error: aErr }) => { if (aErr) console.error('activity insert failed:', aErr.message); });

  return json({ ok: true, tenant_id: tenantId });
});
