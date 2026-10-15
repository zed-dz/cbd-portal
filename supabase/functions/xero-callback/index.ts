// Xero OAuth2 callback handler
// Receives the ?code= from Xero, exchanges it for access + refresh tokens,
// stores them in the xero_tokens table, then redirects back to the portal.
//
// Hardening 2026-10-15: the redirect must carry the `state` minted by
// xero-start (stored in integration_secrets as 'oauth_state:xero:<state>' with
// its expiry as the value). A missing, unknown or expired state is refused
// BEFORE any token exchange with ?xero_error=bad_state. The state row is
// single use — deleted on first sight.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
  // Sweep any other expired state rows while we are here (best-effort).
  await supabase.from('integration_secrets').delete().like('key', 'oauth_state:%').lt('value', new Date().toISOString());
  if (!st || String(st.value) < new Date().toISOString()) return back('xero_error=bad_state');

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
    const body = await tokenRes.text();
    console.error('Token exchange failed:', body);
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

  // Store in Supabase
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  const { error: dbErr } = await supabase.from('xero_tokens').upsert({
    id:            1,   // single-row table
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    expiresAt,
    tenant_id:     tenantId,
    scope:         tokens.scope,
    updated_at:    new Date().toISOString(),
  }, { onConflict: 'id' });

  if (dbErr) {
    console.error('DB upsert failed:', dbErr);
    return back('xero_error=db_failed');
  }

  return back('xero_connected=1');
});
