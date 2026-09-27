// myob-callback — MYOB redirects the browser here after consent. Exchanges the
// code for tokens, stores them (service-role only table), fetches the list of
// company files, and bounces back to the portal. verify_jwt OFF (MYOB's
// redirect carries no Supabase JWT).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const MYOB_CLIENT_ID       = Deno.env.get('MYOB_CLIENT_ID') || '';
const MYOB_CLIENT_SECRET   = Deno.env.get('MYOB_CLIENT_SECRET') || '';
const PORTAL_URL           = Deno.env.get('PORTAL_URL') || '/';

Deno.serve(async (req) => {
  const code = new URL(req.url).searchParams.get('code');
  if (!code) return new Response('Missing ?code from MYOB.', { status: 400 });
  if (!MYOB_CLIENT_ID || !MYOB_CLIENT_SECRET) {
    return new Response('MYOB secrets are not configured on this project.', { status: 503 });
  }

  const redirect = `${SUPABASE_URL}/functions/v1/myob-callback`;
  const tokenRes = await fetch('https://secure.myob.com/oauth2/v1/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: MYOB_CLIENT_ID, client_secret: MYOB_CLIENT_SECRET,
      scope: 'CompanyFile', code, redirect_uri: redirect,
      grant_type: 'authorization_code',
    }),
  });
  const tok = await tokenRes.json();
  if (!tok.access_token) {
    return new Response(`MYOB token exchange failed: ${JSON.stringify(tok).slice(0, 300)}`, { status: 502 });
  }

  // Which company files can this login see? Stored so the office can pick the
  // right file when the push is wired up (two-entity structure incoming).
  let companyFiles: unknown = null;
  try {
    const cf = await fetch('https://api.myob.com/accountright/', {
      headers: {
        Authorization: `Bearer ${tok.access_token}`,
        'x-myobapi-key': MYOB_CLIENT_ID,
        'x-myobapi-version': 'v2',
        Accept: 'application/json',
      },
    });
    if (cf.ok) companyFiles = await cf.json();
  } catch (_e) { /* company-file listing is best-effort */ }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { error } = await sb.from('myob_tokens').upsert({
    id: 1,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || null,
    expires_at: new Date(Date.now() + (tok.expires_in || 1200) * 1000).toISOString(),
    company_files: companyFiles,
    connected_at: new Date().toISOString(),
  });
  if (error) return new Response(`Could not store MYOB tokens: ${error.message}`, { status: 500 });

  return Response.redirect(`${PORTAL_URL}?myob=connected`, 302);
});
