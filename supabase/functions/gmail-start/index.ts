// Builds the Google OAuth consent URL so the admin can authorise the
// portal to send & read mail through their Gmail/Workspace account.
//
// GET → { auth_url: string } or { error: 'not_configured' }

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const GMAIL_CLIENT_ID  = Deno.env.get('GMAIL_CLIENT_ID')  || '';
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')     || '';

const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/gmail-callback`;

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

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  if (!GMAIL_CLIENT_ID) {
    return json({
      error: 'not_configured',
      message: 'GMAIL_CLIENT_ID is not set in Supabase function secrets. See CLAUDE.md → Gmail setup.',
    }, 503);
  }

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
  });

  const auth_url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  return json({ auth_url, redirect_uri: REDIRECT_URI });
});
