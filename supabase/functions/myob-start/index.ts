// myob-start — kicks off the MYOB OAuth consent flow. INERT until the
// MYOB_CLIENT_ID / MYOB_CLIENT_SECRET secrets are set (the owner is getting
// API access from the bookkeeper; meeting 2026-09-22). verify_jwt is OFF so a
// browser can open this directly — it only redirects to MYOB's own consent
// page and carries no secrets.
const MYOB_CLIENT_ID = Deno.env.get('MYOB_CLIENT_ID') || '';
const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')!;

Deno.serve((_req) => {
  if (!MYOB_CLIENT_ID) {
    return new Response(
      'MYOB is not configured yet. Set MYOB_CLIENT_ID and MYOB_CLIENT_SECRET in the Supabase edge function secrets, then open this link again.',
      { status: 503, headers: { 'Content-Type': 'text/plain' } },
    );
  }
  const redirect = `${SUPABASE_URL}/functions/v1/myob-callback`;
  const url = 'https://secure.myob.com/oauth2/account/authorize'
    + `?client_id=${encodeURIComponent(MYOB_CLIENT_ID)}`
    + `&redirect_uri=${encodeURIComponent(redirect)}`
    + '&response_type=code&scope=CompanyFile';
  return Response.redirect(url, 302);
});
