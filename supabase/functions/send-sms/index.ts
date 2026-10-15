// send-sms — Twilio SMS sender (office-only).
//
// Source recovered 2026-10-15 from the deployed v7 body (this function had no
// copy in the repo) and typed up; behaviour is unchanged except for the gate.
//
// Reads Twilio config from Edge Function secrets if present, otherwise from the
// RLS-locked `integration_secrets` table (service-role only, so no secrets live
// in this source). Prefers a scoped API Key (TWILIO_API_KEY_SID/SECRET) over the
// master Auth Token. Call with { to: '+61...', body: '...' }.
//
// GATE: OFFICE — the caller must be a signed-in office user (workers.role =
// 'admin', or access_level admin/accounts), or an internal caller presenting
// the service-role key. Workers texting the office from their phones no longer
// go through here: that path belongs to notify-admins.
//
// There is NO allow-list in this function (no SMS_ALLOWLIST env, no table):
// any `to` number the office supplies is sent to.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...cors } });

// ── Caller gate ─────────────────────────────────────────────────────────────
// OFFICE = anyone who uses the office portal (workers.role = 'admin', or an
// access_level of admin/accounts); MONEY = access_level admin/accounts only.
// Internal callers (other edge functions, cron) pass the service-role key as
// the bearer and skip the worker lookup. Email match is exact (lower-cased):
// `ilike` would treat `_` and `%` as wildcards.
type GateLevel = 'office' | 'money';
type GateResult =
  | { ok: true; via: 'service' | 'user'; email: string | null; worker: { id: string; name: string | null; role: string | null; access_level: string | null } | null }
  | { ok: false; status: number; error: string };
async function gateCaller(req: Request, level: GateLevel): Promise<GateResult> {
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return { ok: false, status: 401, error: 'Unauthorized' };
  if (bearer === SUPABASE_SERVICE_KEY) return { ok: true, via: 'service', email: null, worker: null };
  const { data: { user }, error } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY).auth.getUser(bearer);
  if (error || !user?.email) return { ok: false, status: 401, error: 'Unauthorized' };
  const { data: w } = await createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY).from('workers')
    .select('id, name, role, access_level')
    .eq('email', user.email.toLowerCase())
    .is('archived_at', null)
    .maybeSingle();
  const money  = !!w && ['admin', 'accounts'].includes(w.access_level || '');
  const office = money || (!!w && w.role === 'admin');
  if (level === 'money' ? !money : !office) {
    return { ok: false, status: 403, error: level === 'money' ? 'Admin or accounts only' : 'Office staff only' };
  }
  return { ok: true, via: 'user', email: user.email, worker: w };
}

type TwilioCfg = {
  accountSid?: string; apiKeySid?: string; apiKeySecret?: string; authToken?: string; from?: string;
};

async function loadConfig(): Promise<TwilioCfg> {
  const env = (k: string) => Deno.env.get(k) || undefined;
  const cfg: TwilioCfg = {
    accountSid:   env('TWILIO_ACCOUNT_SID'),
    apiKeySid:    env('TWILIO_API_KEY_SID'),
    apiKeySecret: env('TWILIO_API_KEY_SECRET'),
    authToken:    env('TWILIO_AUTH_TOKEN'),
    from:         env('TWILIO_FROM'),
  };
  const needTable = !cfg.accountSid || !cfg.from || (!cfg.apiKeySecret && !cfg.authToken);
  if (needTable) {
    try {
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
      const { data } = await sb.from('integration_secrets').select('key,value').like('key', 'twilio_%');
      const m: Record<string, string> = Object.fromEntries(
        ((data ?? []) as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]),
      );
      cfg.accountSid   ||= m.twilio_account_sid;
      cfg.apiKeySid    ||= m.twilio_api_key_sid;
      cfg.apiKeySecret ||= m.twilio_api_key_secret;
      cfg.authToken    ||= m.twilio_auth_token;
      cfg.from         ||= m.twilio_from;
    } catch (_) {
      // fall through; guard below returns a clear 503
    }
  }
  return cfg;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  const gate = await gateCaller(req, 'office');
  if (!gate.ok) return json({ error: gate.error }, gate.status);

  const cfg = await loadConfig();
  const user = cfg.apiKeySid || cfg.accountSid;
  const pass = cfg.apiKeySecret || cfg.authToken;
  if (!cfg.accountSid || !cfg.from || !user || !pass) {
    return json({ error: 'Twilio not configured (need account sid, from, and an api key or auth token).' }, 503);
  }

  try {
    const { to, body } = await req.json() as { to?: string; body?: string };
    if (!to || !body) return json({ error: 'to and body are required' }, 400);

    const form = new URLSearchParams();
    if (String(cfg.from).startsWith('MG')) form.set('MessagingServiceSid', cfg.from);
    else form.set('From', cfg.from);
    form.set('To', String(to));
    form.set('Body', String(body));

    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(`${user}:${pass}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    const data = await resp.json();
    if (!resp.ok) return json({ error: data.message ?? 'twilio error', code: data.code }, 502);
    return json({ sid: data.sid, status: data.status });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
