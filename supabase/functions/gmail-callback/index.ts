// Google OAuth callback: exchanges the auth code for access + refresh tokens,
// fetches the connected Gmail address, stores everything in gmail_tokens, then
// redirects the admin back to the portal.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GMAIL_CLIENT_ID     = Deno.env.get('GMAIL_CLIENT_ID')!;
const GMAIL_CLIENT_SECRET = Deno.env.get('GMAIL_CLIENT_SECRET')!;
const SUPABASE_URL        = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PORTAL_URL          = Deno.env.get('PORTAL_URL') || 'https://cbd-portal-gray.vercel.app';

const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/gmail-callback`;

serve(async (req) => {
  const url   = new URL(req.url);
  const code  = url.searchParams.get('code');
  const err   = url.searchParams.get('error');

  if (err || !code) {
    return Response.redirect(`${PORTAL_URL}?gmail_error=${encodeURIComponent(err || 'no_code')}`, 302);
  }

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      redirect_uri:  REDIRECT_URI,
      grant_type:    'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text();
    console.error('Google token exchange failed:', detail);
    return Response.redirect(`${PORTAL_URL}?gmail_error=token_exchange_failed`, 302);
  }

  const tokens = await tokenRes.json();
  // { access_token, refresh_token, expires_in, scope, token_type, id_token? }

  // Look up the connected email so we can show it in the UI.
  let emailAddress: string | null = null;
  try {
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (profileRes.ok) {
      const p = await profileRes.json();
      emailAddress = p.email || null;
    }
  } catch (e) {
    console.error('userinfo fetch failed:', e);
  }

  const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // If Google didn't return a refresh_token (it only does on the first consent
  // unless prompt=consent), keep the existing one to avoid breaking the connection.
  let refreshToken = tokens.refresh_token;
  if (!refreshToken) {
    const { data: existing } = await supabase.from('gmail_tokens').select('refresh_token').eq('id', 1).maybeSingle();
    refreshToken = existing?.refresh_token || '';
  }

  const { error: dbErr } = await supabase.from('gmail_tokens').upsert({
    id:            1,
    email_address: emailAddress,
    access_token:  tokens.access_token,
    refresh_token: refreshToken,
    expires_at:    expiresAt,
    scope:         tokens.scope || null,
    updated_at:    new Date().toISOString(),
  }, { onConflict: 'id' });

  if (dbErr) {
    console.error('gmail_tokens upsert failed:', dbErr);
    return Response.redirect(`${PORTAL_URL}?gmail_error=db_failed`, 302);
  }

  return Response.redirect(`${PORTAL_URL}?gmail_connected=1`, 302);
});
