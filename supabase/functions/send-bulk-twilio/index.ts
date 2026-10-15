// Sends an SMS or WhatsApp blast via Twilio. Sibling of send-bulk-email —
// same shape of request, same message_log audit trail, just a different
// transport.
//
// POST body:
//   {
//     channel:    'sms' | 'whatsapp',
//     recipients: [{ id?, name?, mobile }],
//     body:       string,                  // plain text, ≤1600 chars
//     audience?:  'workers' | 'clients' | 'mixed',
//     sent_by?:   UUID,
//   }
//
// Response:
//   { ok, sent, failed, total, batch_id, firstError? }
//
// Twilio config (2026-10-15): read from Edge Function secrets if present,
// otherwise from the RLS-locked `integration_secrets` table — the same rows
// the deployed send-sms uses (twilio_account_sid, twilio_auth_token,
// twilio_from, twilio_messaging_service_sid; optionally twilio_api_key_sid /
// twilio_api_key_secret and twilio_whatsapp_from). Env names, when set:
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN       — or TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET
//   TWILIO_SMS_FROM         — "+61..." number, or an "MG…" Messaging Service SID
//   TWILIO_WHATSAPP_FROM    — e.g. "whatsapp:+14155238886" (sandbox)
//                                  or "whatsapp:+61498765432" (production sender)
//
// WhatsApp note: outside a 24-hour user-initiated session, Meta requires the
// message to match a pre-approved template. Free-form text only works when
// the recipient has messaged you recently. This function does not enforce
// that — it relays Twilio's error verbatim so you can spot template
// rejections in the message_log.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL          = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY     = Deno.env.get('SUPABASE_ANON_KEY')!;

const CONCURRENCY = 4;

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

// ── Caller gate (hardening 2026-10-15) ──────────────────────────────────────
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

// ── Twilio config: env first, then integration_secrets (as send-sms does) ───
type TwilioCfg = {
  accountSid?: string; apiKeySid?: string; apiKeySecret?: string; authToken?: string;
  smsFrom?: string; whatsappFrom?: string;
};

async function loadConfig(): Promise<TwilioCfg> {
  const env = (k: string) => Deno.env.get(k) || undefined;
  const cfg: TwilioCfg = {
    accountSid:   env('TWILIO_ACCOUNT_SID'),
    apiKeySid:    env('TWILIO_API_KEY_SID'),
    apiKeySecret: env('TWILIO_API_KEY_SECRET'),
    authToken:    env('TWILIO_AUTH_TOKEN'),
    smsFrom:      env('TWILIO_SMS_FROM') || env('TWILIO_FROM'),
    whatsappFrom: env('TWILIO_WHATSAPP_FROM'),
  };
  const needTable = !cfg.accountSid || !cfg.smsFrom || (!cfg.apiKeySecret && !cfg.authToken);
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
      // send-sms sends from twilio_from (an "MG…" value there is a Messaging
      // Service); the explicit messaging-service row is the fallback.
      cfg.smsFrom      ||= m.twilio_from || m.twilio_messaging_service_sid;
      cfg.whatsappFrom ||= m.twilio_whatsapp_from;
    } catch (_) {
      // fall through; guard below returns a clear 503
    }
  }
  return cfg;
}

// Normalise an AU mobile to E.164 ("+61..."). Accepts: "0412 345 678",
// "+61 412 345 678", "0412345678", "61412345678".
function normaliseAUE164(mobile: string): string {
  if (!mobile) return '';
  const d = mobile.toString().replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d;
  if (d.startsWith('614')) return `+${d}`;
  if (d.startsWith('04') && d.length === 10) return `+61${d.slice(1)}`;
  if (d.startsWith('4')  && d.length === 9)  return `+61${d}`;
  return d.startsWith('+') ? d : `+${d}`;
}

async function sendOne(cfg: TwilioCfg, opts: {
  channel: 'sms' | 'whatsapp',
  to:      string,
  body:    string,
}): Promise<{ ok: true } | { ok: false, error: string }> {
  const e164 = normaliseAUE164(opts.to);
  if (!e164) return { ok: false, error: 'invalid_mobile' };

  const isWA   = opts.channel === 'whatsapp';
  const sender = isWA ? cfg.whatsappFrom : cfg.smsFrom;
  if (!sender) return { ok: false, error: isWA ? 'twilio_whatsapp_from_not_set' : 'twilio_sms_from_not_set' };

  const form = new URLSearchParams();
  form.set('To', isWA ? `whatsapp:${e164}` : e164);
  form.set('Body', opts.body);
  if (isWA)                         form.set('From', sender.startsWith('whatsapp:') ? sender : `whatsapp:${sender}`);
  else if (sender.startsWith('MG')) form.set('MessagingServiceSid', sender);   // Messaging Service, as send-sms does
  else                              form.set('From', sender);

  // Prefer a scoped API key over the master auth token, as send-sms does.
  const user = cfg.apiKeySid || cfg.accountSid;
  const pass = cfg.apiKeySecret || cfg.authToken;
  const url  = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(`${user}:${pass}`),
    },
    body: form.toString(),
  });
  if (res.ok) return { ok: true };
  const detail = (await res.text()).slice(0, 300);
  return { ok: false, error: `twilio_${res.status}: ${detail}` };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  // OFFICE only — an SMS/WhatsApp blast is an office action.
  const gate = await gateCaller(req, 'office');
  if (!gate.ok) return json({ error: gate.error }, gate.status);

  const cfg = await loadConfig();
  if (!cfg.accountSid || (!cfg.apiKeySecret && !cfg.authToken)) {
    return json({
      error: 'twilio_not_configured',
      message: 'No Twilio account sid + auth token (or api key) in Edge Function secrets or integration_secrets.',
    }, 503);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }

  const channel = body?.channel;
  if (channel !== 'sms' && channel !== 'whatsapp') {
    return json({ error: "channel must be 'sms' or 'whatsapp'" }, 400);
  }
  // A missing sender is a config problem, not 200 "failed" rows in message_log.
  if (channel === 'sms' && !cfg.smsFrom) {
    return json({ error: 'twilio_sms_from_not_set', message: 'Set TWILIO_SMS_FROM or the integration_secrets row twilio_from / twilio_messaging_service_sid.' }, 503);
  }
  if (channel === 'whatsapp' && !cfg.whatsappFrom) {
    return json({ error: 'twilio_whatsapp_from_not_set', message: 'Set TWILIO_WHATSAPP_FROM or the integration_secrets row twilio_whatsapp_from.' }, 503);
  }
  const text = (body?.body || '').toString();
  if (!text.trim()) return json({ error: 'body_required' }, 400);

  const recipients: Array<{ id?: string; name?: string; mobile?: string }>
    = Array.isArray(body?.recipients) ? body.recipients : [];
  if (!recipients.length) return json({ error: 'recipients_required' }, 400);

  const audience = body?.audience || null;
  const sentBy   = body?.sent_by  || null;
  const batchId  = crypto.randomUUID();
  const supa     = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  let sent = 0, failed = 0, firstError: string | null = null;

  // Send with bounded concurrency so a 200-recipient blast doesn't open 200
  // sockets at once and trip Twilio's per-account rate limits.
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= recipients.length) return;
      const r = recipients[i];
      const mobile = (r.mobile || '').toString();
      if (!mobile) {
        failed++;
        if (!firstError) firstError = 'missing_mobile';
        await supa.from('message_log').insert({
          batch_id: batchId, channel, audience,
          recipient_id: r.id || null,
          recipient_name: r.name || null,
          recipient_mobile: null,
          subject: null, body: text,
          status: 'failed', error: 'missing_mobile', sent_by: sentBy,
        });
        continue;
      }
      const result = await sendOne(cfg, { channel, to: mobile, body: text });
      await supa.from('message_log').insert({
        batch_id: batchId, channel, audience,
        recipient_id: r.id || null,
        recipient_name: r.name || null,
        recipient_mobile: mobile,
        subject: null, body: text,
        status: result.ok ? 'sent' : 'failed',
        error:  result.ok ? null   : result.error,
        sent_by: sentBy,
      });
      if (result.ok) sent++;
      else {
        failed++;
        if (!firstError) firstError = result.error;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  return json({
    ok: failed === 0,
    sent, failed, total: recipients.length,
    batch_id: batchId,
    firstError: firstError || undefined,
  });
});
