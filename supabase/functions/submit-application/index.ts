// Public application intake endpoint.
//
// The marketing site (Lovable) and the portal's own /apply page POST form
// submissions here. The function validates the payload server-side and uses
// the service_role key to bypass RLS when inserting into worker_applications,
// so we never have to expose anon SELECT on that table (which would leak the
// PII of past applicants).
//
// verify_jwt is on at the platform level, so callers must pass any valid
// project JWT (the anon publishable key is fine — it just gates traffic to
// project clients). Field validation here is what actually protects against
// spam: name + email required, email shape, length limits.
//
// Request body:
//   {
//     type:       'worker' | 'client',
//     full_name:  string,
//     email:      string,
//     phone?:     string | null,
//     message?:   string | null,
//     source?:    string | null   // optional analytics tag, e.g. 'linkedin-ad'
//   }
//
// Response 200: { ok: true, id: <uuid> }
// Response 4xx: { error: 'code', message: <human description> }

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

  const type      = String(body.type || 'worker').toLowerCase().trim();
  const fullName  = String(body.full_name ?? body.fullName ?? body.name ?? '').trim();
  const email     = String(body.email ?? '').trim().toLowerCase();
  const phone     = body.phone ? String(body.phone).trim().slice(0, 40) : null;
  const message   = body.message ? String(body.message).trim().slice(0, 4000) : null;
  const source    = body.source ? String(body.source).trim().slice(0, 80) : null;

  if (type !== 'worker' && type !== 'client') {
    return json({ error: 'invalid_type', message: 'type must be worker or client' }, 400);
  }
  if (!fullName || fullName.length < 2 || fullName.length > 200) {
    return json({ error: 'invalid_name', message: 'full_name must be 2 to 200 characters' }, 400);
  }
  if (!EMAIL_RE.test(email) || email.length > 200) {
    return json({ error: 'invalid_email', message: 'email looks malformed' }, 400);
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data, error } = await sb
    .from('worker_applications')
    .insert({ type, full_name: fullName, email, phone, message, source })
    .select('id')
    .single();

  if (error) {
    console.error('worker_applications insert failed', error);
    return json({ error: 'insert_failed', message: error.message }, 500);
  }

  return json({ ok: true, id: data.id });
});
