// worker-finalize — called from the public onboarding page once the worker
// submits their profile. Creates (or updates) a Supabase auth user so they can
// sign into the Worker Portal. Preferred path: the worker chose a password
// during onboarding, so we create the user WITH that password + mark the email
// confirmed → they can immediately log in with email + password (no email round
// trip, no magic-link confusion). Falls back to a passwordless email invite
// only when no password is supplied (legacy/back-compat).
//
// Idempotent: if an auth user already exists for that email we just (re)set the
// chosen password instead of erroring.
//
// POST { token: <profile_token uuid>, password?: string }
// →   { ok: true, auth_user_id, already_existed, method: "password"|"invite"|"existing" }
//
// SECURITY: anonymous-callable (no JWT verify) because the public onboarding
// page has no user session yet. The opaque profile_token is the bearer — only
// deliverable via the admin-sent invite link, and we refuse any token that
// doesn't match a live (non-archived) worker row.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PORTAL_URL           = Deno.env.get('PORTAL_URL') || 'https://cbd-portal-gray.vercel.app';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }

  const token = body?.token;
  if (!token) return json({ error: 'token_required' }, 400);

  // Only honour a password that meets the minimum policy; otherwise treat as
  // absent and fall back to the legacy invite.
  const rawPw = typeof body?.password === 'string' ? body.password : '';
  const password = rawPw.length >= 8 ? rawPw : null;

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { data: worker, error: lookupErr } = await supa
    .from('workers')
    .select('id, name, email, archived_at')
    .eq('profile_token', token)
    .maybeSingle();

  if (lookupErr) return json({ error: lookupErr.message }, 500);
  if (!worker)   return json({ error: 'invalid_token' }, 404);
  if (worker.archived_at) return json({ error: 'worker_archived' }, 410);
  if (!worker.email)      return json({ error: 'worker_has_no_email' }, 422);

  const targetEmail = worker.email.toLowerCase();

  // Find an existing auth user by email so we don't double-create.
  const { data: list, error: listErr } = await supa.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (listErr) return json({ error: listErr.message }, 500);
  const existing = list?.users?.find((u) => (u.email || '').toLowerCase() === targetEmail);

  if (existing) {
    // Already have an auth user. If the worker set a password now, apply it so
    // their email + password works (covers users previously created via the
    // passwordless invite path). Always ensure the email is confirmed.
    if (password) {
      const { error: updErr } = await supa.auth.admin.updateUserById(existing.id, {
        password,
        email_confirm: true,
      });
      if (updErr) return json({ error: 'update_failed', detail: updErr.message }, 500);
      return json({ ok: true, auth_user_id: existing.id, already_existed: true, method: 'password' });
    }
    return json({ ok: true, auth_user_id: existing.id, already_existed: true, method: 'existing' });
  }

  // Preferred: create the user WITH the chosen password, pre-confirmed.
  if (password) {
    const { data: created, error: createErr } = await supa.auth.admin.createUser({
      email: worker.email,
      password,
      email_confirm: true,
      user_metadata: { worker_id: worker.id, worker_name: worker.name },
    });
    if (createErr) return json({ error: 'create_failed', detail: createErr.message }, 500);
    return json({ ok: true, auth_user_id: created?.user?.id || null, already_existed: false, method: 'password' });
  }

  // Legacy fallback: passwordless email invite (magic link via project SMTP).
  const { data: invited, error: inviteErr } = await supa.auth.admin.inviteUserByEmail(
    worker.email,
    { redirectTo: PORTAL_URL, data: { worker_id: worker.id, worker_name: worker.name } },
  );
  if (inviteErr) return json({ error: 'invite_failed', detail: inviteErr.message }, 500);
  return json({ ok: true, auth_user_id: invited?.user?.id || null, already_existed: false, method: 'invite' });
});
