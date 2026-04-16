// Xero OAuth2 callback handler
// Receives the ?code= from Xero, exchanges it for access + refresh tokens,
// stores them in the xero_tokens table, then redirects back to the portal.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const XERO_CLIENT_ID     = Deno.env.get('XERO_CLIENT_ID')!;
const XERO_CLIENT_SECRET = Deno.env.get('XERO_CLIENT_SECRET')!;
const SUPABASE_URL       = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PORTAL_URL         = 'https://cbd-portal-gray.vercel.app';
const REDIRECT_URI       = `https://tsizneslellcqusjwtub.supabase.co/functions/v1/xero-callback`;

serve(async (req) => {
  const url  = new URL(req.url);
  const code  = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error || !code) {
    return Response.redirect(`${PORTAL_URL}?xero_error=${encodeURIComponent(error || 'no_code')}`, 302);
  }

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
    return Response.redirect(`${PORTAL_URL}?xero_error=token_exchange_failed`, 302);
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
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
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
    return Response.redirect(`${PORTAL_URL}?xero_error=db_failed`, 302);
  }

  return Response.redirect(`${PORTAL_URL}?xero_connected=1`, 302);
});
