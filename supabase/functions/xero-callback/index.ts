// Xero OAuth2 callback handler
// Receives the ?code= from Xero, exchanges it for access + refresh tokens,
// stores them (Supabase Vault, via xeroTokens.ts → xero_tokens_write), then
// redirects back to the portal.
//
// Hardening 2026-10-15: the redirect must carry the `state` minted by
// xero-start (stored in integration_secrets as 'oauth_state:xero:<state>'). A
// missing, unknown or expired state is refused BEFORE any token exchange with
// ?xero_error=bad_state. The state row is single use — deleted on first sight.
//
// Hardening 2026-11-09 (A2Z audit fix #2, login-swap): the state value is now
// '<expiry ISO>|<auth user id>|<email>' — bound to the admin who started the
// flow. Before the exchange the callback re-checks that this person is STILL a
// money user (admin/accounts, not an allocator, not archived); otherwise
// ?xero_error=not_allowed. Who connected is written to xero_tokens.connected_by
// and one activity_events row ('xero connected') so the office can see it.
// Limit, stated plainly: Xero redirects the browser here with no portal session
// attached (this host is supabase.co, the portal is cbdpnl.com.au), so the
// callback cannot compare a live login against the state's user id. The state
// itself (random 256-bit, 10-minute, single use, mintable only by a money user
// through xero-start) is the proof of who started the flow.
//
// Tokens (2026-11-09): never written to plain columns any more — see
// 20261109_xero_tokens_vault.sql. Nothing here logs a token.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { saveTokens } from './xeroTokens.ts';

const XERO_CLIENT_ID     = Deno.env.get('XERO_CLIENT_ID')!;
const XERO_CLIENT_SECRET = Deno.env.get('XERO_CLIENT_SECRET')!;
const SUPABASE_URL       = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Function secret PORTAL_URL (production host since 2026-10-15). The fallback
// is the same host so a missing secret never sends anyone to a vercel.app page.
const PORTAL_URL         = (Deno.env.get('PORTAL_URL') || 'https://portal.cbdpnl.com.au').replace(/\/+$/, '');
const REDIRECT_URI       = `${Deno.env.get('SUPABASE_URL')}/functions/v1/xero-callback`;   // portal-agnostic (mirrors)

// Every exit is a redirect to the portal root; App.jsx reads xero_connected /
// xero_error off the query string and shows a toast.
const back = (query: string) => Response.redirect(`${PORTAL_URL}/?${query}`, 302);

serve(async (req) => {
  const url   = new URL(req.url);
  const code  = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // OAuth state: verified and consumed before anything else happens.
  const state = url.searchParams.get('state') || '';
  if (!/^[a-f0-9]{32,128}$/.test(state)) return back('xero_error=bad_state');
  const stateKey = `oauth_state:xero:${state}`;
  const { data: st } = await supabase.from('integration_secrets').select('value').eq('key', stateKey).maybeSingle();
  await supabase.from('integration_secrets').delete().eq('key', stateKey);
  // Sweep any other expired state rows while we are here (best-effort). The
  // value starts with the expiry ISO stamp, so a plain string compare works.
  await supabase.from('integration_secrets').delete().like('key', 'oauth_state:%').lt('value', new Date().toISOString());
  const now = new Date().toISOString();
  const [stateExpires = '', stateUserId = '', stateEmail = ''] = String(st?.value || '').split('|');
  if (!st || !stateExpires || stateExpires < now) return back('xero_error=bad_state');

  // Who started this flow must STILL be a money user (fix #2). States minted
  // before 2026-11-09 carry no user: refuse them too — they are expired anyway.
  if (!stateUserId || !stateEmail) return back('xero_error=bad_state');
  const { data: starter } = await supabase.from('workers')
    .select('id, name, access_level, is_allocator')
    .eq('email', stateEmail.toLowerCase()).is('archived_at', null).maybeSingle();
  const stillMoney = !!starter && ['admin', 'accounts'].includes(starter.access_level || '') && !starter.is_allocator;
  if (!stillMoney) return back('xero_error=not_allowed');

  if (error || !code) return back(`xero_error=${encodeURIComponent(error || 'no_code')}`);

  // Exchange code for tokens
  const tokenRes = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${btoa(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!tokenRes.ok) {
    console.error('Token exchange failed:', tokenRes.status);
    return back('xero_error=token_exchange_failed');
  }

  const tokens = await tokenRes.json();
  // tokens: { access_token, refresh_token, expires_in, token_type, scope }

  // Get tenant IDs (organisations connected)
  const tenantsRes = await fetch('https://api.xero.com/connections', {
    headers: { 'Authorization': `Bearer ${tokens.access_token}` },
  });
  const tenants = tenantsRes.ok ? await tenantsRes.json() : [];
  const tenantId = tenants[0]?.tenantId || null;  // use first org by default

  // Store — encrypted at rest (Vault) through the service-role-only SQL API.
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const dbErr = await saveTokens(supabase, {
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    expiresAt,
    tenant_id:     tenantId,
    scope:         tokens.scope ?? null,
    connected_by:  stateEmail.toLowerCase(),
  });
  if (dbErr) {
    console.error('token store failed:', dbErr);
    return back('xero_error=db_failed');
  }

  // Office-readable audit line: who connected which organisation (no tokens).
  await supabase.from('activity_events').insert([{
    actor_id: null, actor_name: starter!.name || stateEmail.toLowerCase(),
    verb: 'xero connected', object_type: 'xero', object_id: null,
    after: { tenant_id: tenantId, scope: tokens.scope ?? null, by: stateEmail.toLowerCase() },
  }]).then(({ error: aErr }) => { if (aErr) console.error('activity insert failed:', aErr.message); });

  return back('xero_connected=1');
});
