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
// Required env (Supabase project secrets):
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_SMS_FROM         — e.g. "+61498765432" (any of your Twilio numbers)
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

const TWILIO_ACCOUNT_SID    = Deno.env.get('TWILIO_ACCOUNT_SID')    || '';
const TWILIO_AUTH_TOKEN     = Deno.env.get('TWILIO_AUTH_TOKEN')     || '';
const TWILIO_SMS_FROM       = Deno.env.get('TWILIO_SMS_FROM')       || '';
const TWILIO_WHATSAPP_FROM  = Deno.env.get('TWILIO_WHATSAPP_FROM')  || '';
const SUPABASE_URL          = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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

async function sendOne(opts: {
  channel: 'sms' | 'whatsapp',
  to:      string,
  body:    string,
}): Promise<{ ok: true } | { ok: false, error: string }> {
  const e164 = normaliseAUE164(opts.to);
  if (!e164) return { ok: false, error: 'invalid_mobile' };

  const isWA = opts.channel === 'whatsapp';
  const fromEnv = isWA ? TWILIO_WHATSAPP_FROM : TWILIO_SMS_FROM;
  if (!fromEnv) return { ok: false, error: isWA ? 'twilio_whatsapp_from_not_set' : 'twilio_sms_from_not_set' };

  const to   = isWA ? `whatsapp:${e164}` : e164;
  const from = isWA && !fromEnv.startsWith('whatsapp:') ? `whatsapp:${fromEnv}` : fromEnv;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const form = new URLSearchParams();
  form.set('To', to);
  form.set('From', from);
  form.set('Body', opts.body);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
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

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    return json({
      error: 'twilio_not_configured',
      message: 'Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to Supabase Edge Function secrets.',
    }, 503);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }

  const channel = body?.channel;
  if (channel !== 'sms' && channel !== 'whatsapp') {
    return json({ error: "channel must be 'sms' or 'whatsapp'" }, 400);
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
      const result = await sendOne({ channel, to: mobile, body: text });
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
