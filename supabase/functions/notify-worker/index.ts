// notify-worker — office-gated SMS + email to ONE worker (2026-10-19).
//
// Built for the time-off decision ("your request was approved / declined"):
// a `notifications` row is admin-only, so the worker sees the status in the
// Time off tab AND gets a text / email through here. Generic enough for any
// office → worker message.
//
// verify_jwt = true. The caller's JWT email must map to a workers row with
// role = 'admin' (the same test as public.is_office_user()). Workers cannot
// call this for each other: 403 not_office.
//
// Request:  POST { worker_id: uuid, kind: 'leave_approved' | 'leave_declined' | 'generic', text: string (≤ 600) }
// Response: 200 { ok: true, sms: 0|1, email: 0|1 }
//           400 invalid_json | invalid_worker_id | invalid_kind | empty_text
//           401 unauthorized · 403 not_office · 404 worker_not_found · 500 server_error
//
// Honours the worker's own notify_sms / notify_email switches (default on).
// Transport copied from notify-admins (Twilio via env / integration_secrets,
// Resend → Gmail fallback). Every send is logged to message_log.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PORTAL_URL           = Deno.env.get('PORTAL_URL') || 'https://cbd-portal-gray.vercel.app';
const SENDER_DISPLAY_NAME  = Deno.env.get('GMAIL_SENDER_NAME') || 'CBD Plant & Labour';
const GMAIL_CLIENT_ID      = Deno.env.get('GMAIL_CLIENT_ID') || '';
const GMAIL_CLIENT_SECRET  = Deno.env.get('GMAIL_CLIENT_SECRET') || '';
const RESEND_API_KEY       = Deno.env.get('RESEND_API_KEY') || '';
const MAIL_FROM            = Deno.env.get('MAIL_FROM') || '';
const RESEND_ON            = !!(RESEND_API_KEY && MAIL_FROM);

const KINDS = ['leave_approved', 'leave_declined', 'generic'] as const;
type Kind = typeof KINDS[number];
const SUBJECTS: Record<Kind, string> = {
  leave_approved: 'Your time off request was approved',
  leave_declined: 'Your time off request was declined',
  generic: 'Message from the office',
};

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function normaliseAUMobile(mobile: unknown): string {
  if (!mobile) return '';
  let d = String(mobile).trim();
  const hasPlus = d.startsWith('+');
  d = d.replace(/[^\d]/g, '');
  if (!d) return '';
  if (hasPlus) return `+${d}`;
  if (d.startsWith('61')) return `+${d}`;
  if (d.startsWith('0')) return `+61${d.slice(1)}`;
  if (d.startsWith('4') && d.length === 9) return `+61${d}`;
  return `+61${d}`;
}

// ── Twilio ────────────────────────────────────────────────────────────────
type TwilioCfg = { accountSid?: string; apiKeySid?: string; apiKeySecret?: string; authToken?: string; from?: string };
async function loadTwilioConfig(sb: ReturnType<typeof createClient>): Promise<TwilioCfg> {
  const env = (k: string) => Deno.env.get(k) || undefined;
  const cfg: TwilioCfg = {
    accountSid: env('TWILIO_ACCOUNT_SID'), apiKeySid: env('TWILIO_API_KEY_SID'),
    apiKeySecret: env('TWILIO_API_KEY_SECRET'), authToken: env('TWILIO_AUTH_TOKEN'),
    from: env('TWILIO_FROM') || env('TWILIO_SMS_FROM'),
  };
  if (!cfg.accountSid || !cfg.from || (!cfg.apiKeySecret && !cfg.authToken)) {
    try {
      const { data } = await sb.from('integration_secrets').select('key,value').like('key', 'twilio_%');
      const m: Record<string, string> = Object.fromEntries((data ?? []).map((r: any) => [r.key, r.value]));
      cfg.accountSid   ||= m.twilio_account_sid;
      cfg.apiKeySid    ||= m.twilio_api_key_sid;
      cfg.apiKeySecret ||= m.twilio_api_key_secret;
      cfg.authToken    ||= m.twilio_auth_token;
      cfg.from         ||= m.twilio_from || m.twilio_messaging_service_sid;
    } catch (e) { console.error('integration_secrets read failed:', (e as Error).message); }
  }
  return cfg;
}
function twilioReady(cfg: TwilioCfg) {
  return !!(cfg.accountSid && cfg.from && (cfg.apiKeySid || cfg.accountSid) && (cfg.apiKeySecret || cfg.authToken));
}
async function sendSms(cfg: TwilioCfg, to: string, body: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const user = cfg.apiKeySid || cfg.accountSid!;
    const pass = cfg.apiKeySecret || cfg.authToken!;
    const form = new URLSearchParams();
    if (String(cfg.from).startsWith('MG')) form.set('MessagingServiceSid', cfg.from!); else form.set('From', cfg.from!);
    form.set('To', to); form.set('Body', body);
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + btoa(`${user}:${pass}`), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (resp.ok) return { ok: true };
    let detail = `twilio_${resp.status}`;
    try { const d = await resp.json(); detail = `twilio_${resp.status}: ${d?.message ?? ''} ${d?.code ?? ''}`.trim(); } catch { /* ignore */ }
    return { ok: false, error: detail.slice(0, 200) };
  } catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 200) }; }
}

// ── Email: Resend → Gmail ─────────────────────────────────────────────────
async function sendViaResend(opts: { to: string; subject: string; text: string; html?: string; replyTo?: string | null }) {
  const payload: Record<string, unknown> = { from: MAIL_FROM, to: [opts.to], subject: opts.subject, text: opts.text };
  if (opts.html) payload.html = opts.html;
  if (opts.replyTo) payload.reply_to = opts.replyTo;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    return { ok: res.ok, detail: res.ok ? '' : (await res.text()).slice(0, 300) };
  } catch (e) { return { ok: false, detail: (e as Error).message }; }
}
function b64url(s: string) {
  const bytes = new TextEncoder().encode(s); let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function encodeHeader(value: string) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value); let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(bin)}?=`;
}
function formatFromHeader(name: string, email: string) {
  const safeName = name.replace(/"/g, '\\"');
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(safeName) ? `"${safeName}" <${email}>` : `${encodeHeader(safeName)} <${email}>`;
}
function buildMime(opts: { from: string; to: string; subject: string; text: string; html: string }) {
  const boundary = `cbd_${crypto.randomUUID().replace(/-/g, '')}`;
  const b64 = (s: string) => { const bytes = new TextEncoder().encode(s); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin).replace(/(.{76})/g, '$1\r\n'); };
  const headers = [`From: ${opts.from}`, `To: ${opts.to}`, `Subject: ${encodeHeader(opts.subject)}`, 'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`];
  const body = [
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64(opts.text), '',
    `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"',  'Content-Transfer-Encoding: base64', '', b64(opts.html), '',
    `--${boundary}--`,
  ].join('\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}
type GmailCtx = { accessToken: string; emailAddress: string } | null;
async function getGmail(sb: ReturnType<typeof createClient>): Promise<GmailCtx> {
  try {
    const { data: row, error } = await sb.from('gmail_tokens').select('*').eq('id', 1).maybeSingle();
    if (error || !row) return null;
    if (new Date(row.expires_at).getTime() >= Date.now() + 30_000) return { accessToken: row.access_token, emailAddress: row.email_address };
    if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) return null;
    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_CLIENT_SECRET, refresh_token: row.refresh_token, grant_type: 'refresh_token' }),
    });
    if (!refreshRes.ok) { console.error('gmail token refresh failed'); return null; }
    const t = await refreshRes.json();
    await sb.from('gmail_tokens').update({ access_token: t.access_token, expires_at: new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString(), updated_at: new Date().toISOString() }).eq('id', 1);
    return { accessToken: t.access_token, emailAddress: row.email_address };
  } catch (e) { console.error('getGmail threw:', (e as Error).message); return null; }
}
async function sendGmailRaw(accessToken: string, mime: string) {
  try {
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: b64url(mime) }),
    });
    return { ok: res.ok, detail: res.ok ? '' : (await res.text()).slice(0, 300) };
  } catch (e) { return { ok: false, detail: (e as Error).message }; }
}
async function deliverEmail(sb: ReturnType<typeof createClient>, opts: { to: string; subject: string; text: string; html: string }): Promise<{ ok: boolean; via: string; detail: string }> {
  let gmail: GmailCtx = null; let tried = false;
  const ensureGmail = async () => { if (!tried) { tried = true; gmail = await getGmail(sb); } return gmail; };
  if (RESEND_ON) {
    const r = await sendViaResend({ to: opts.to, subject: opts.subject, text: opts.text, html: opts.html });
    if (r.ok) return { ok: true, via: 'resend', detail: '' };
    const g = await ensureGmail();
    if (!g) return { ok: false, via: 'resend', detail: r.detail };
    const gr = await sendGmailRaw(g.accessToken, buildMime({ from: formatFromHeader(SENDER_DISPLAY_NAME, g.emailAddress), to: opts.to, subject: opts.subject, text: opts.text, html: opts.html }));
    return gr.ok ? { ok: true, via: 'gmail-fallback', detail: '' } : { ok: false, via: 'both-failed', detail: `resend: ${r.detail} | gmail: ${gr.detail}` };
  }
  const g = await ensureGmail();
  if (!g) return { ok: false, via: 'none', detail: 'no sender configured' };
  const gr = await sendGmailRaw(g.accessToken, buildMime({ from: formatFromHeader(SENDER_DISPLAY_NAME, g.emailAddress), to: opts.to, subject: opts.subject, text: opts.text, html: opts.html }));
  return { ok: gr.ok, via: 'gmail', detail: gr.detail };
}
function renderHtml(subject: string, lines: string[]) {
  const safeBody = lines.map(escapeHtml).join('<br>');
  return `<!doctype html><html><body style="margin:0;padding:0;background:#0b0e14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0e14;padding:32px 16px;"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#11151e;border:1px solid #222838;border-radius:14px;padding:32px;"><tr><td>
    <div style="font-size:28px;font-weight:800;color:#f97316;letter-spacing:-0.5px;line-height:1;">CBD</div>
    <div style="font-size:10px;color:#8a92a8;letter-spacing:2.5px;text-transform:uppercase;margin-top:4px;margin-bottom:24px;font-weight:600;">Plant &amp; Labour</div>
    <h1 style="color:#eef0f6;font-size:20px;margin:0 0 14px 0;font-weight:700;letter-spacing:-0.3px;">${escapeHtml(subject)}</h1>
    <div style="color:#eef0f6;font-size:14.5px;line-height:1.6;margin:0 0 20px 0;">${safeBody}</div>
    <p style="margin:0 0 20px 0;"><a href="${PORTAL_URL}" style="color:#f97316;text-decoration:none;font-weight:600;">Open the portal →</a></p>
    <hr style="border:none;border-top:1px solid #222838;margin:24px 0 14px 0;">
    <p style="color:#8a92a8;font-size:11px;line-height:1.5;margin:0;font-family:'SF Mono',Consolas,monospace;letter-spacing:0.5px;">CBD PLANT &amp; LABOUR · ABN 75 663 693 070<br>ROAD · RAIL · WATER · <a href="${PORTAL_URL}" style="color:#f97316;text-decoration:none;">portal</a></p>
  </td></tr></table></td></tr></table></body></html>`;
}

// ── Handler ───────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  try {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!jwt) return json({ error: 'unauthorized' }, 401);
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: userData, error: userErr } = await anon.auth.getUser(jwt);
    const email = (userData?.user?.email || '').trim().toLowerCase();
    if (userErr || !email) return json({ error: 'unauthorized' }, 401);

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const pattern = email.replace(/[\\%_]/g, (m: string) => `\\${m}`);
    const { data: callers } = await sb.from('workers').select('id, name, email, role, archived_at').ilike('email', pattern).limit(3);
    const caller = (callers || []).find((w: any) => String(w.email || '').trim().toLowerCase() === email) || null;
    if (!caller || caller.archived_at) return json({ error: 'unauthorized' }, 401);
    if (caller.role !== 'admin') return json({ error: 'not_office' }, 403);

    let body: { worker_id?: string; kind?: string; text?: string } = {};
    try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const workerId = String(body.worker_id || '').trim();
    const kind = String(body.kind || 'generic') as Kind;
    const text = String(body.text || '').trim().slice(0, 600);
    if (!UUID_RE.test(workerId)) return json({ error: 'invalid_worker_id' }, 400);
    if (!KINDS.includes(kind)) return json({ error: 'invalid_kind' }, 400);
    if (!text) return json({ error: 'empty_text' }, 400);

    const { data: worker } = await sb.from('workers').select('id, name, email, mobile, notify_sms, notify_email, archived_at').eq('id', workerId).maybeSingle();
    if (!worker || worker.archived_at) return json({ error: 'worker_not_found' }, 404);

    const subject = SUBJECTS[kind];
    const smsText = `Hi ${worker.name || 'there'}, ${text} — ${SENDER_DISPLAY_NAME}`;
    const lines = [`Hi ${worker.name || 'there'},`, '', text, '', `Open the portal: ${PORTAL_URL}`];
    const logRows: any[] = [];
    const batchId = crypto.randomUUID();

    let smsSent = 0;
    const to = normaliseAUMobile(worker.mobile);
    if (to && worker.notify_sms !== false) {
      const cfg = await loadTwilioConfig(sb);
      if (twilioReady(cfg)) {
        const r = await sendSms(cfg, to, smsText);
        if (r.ok) smsSent = 1;
        logRows.push({ batch_id: batchId, channel: 'sms', audience: 'workers', recipient_email: null, subject: null, body: smsText,
          status: r.ok ? 'sent' : 'failed', error: r.ok ? null : (r.error || 'failed').slice(0, 200), sent_by: caller.name, recipient_name: worker.name });
      } else console.error('twilio not configured — worker SMS skipped');
    }

    let emailSent = 0;
    const toEmail = String(worker.email || '').trim();
    if (EMAIL_RE.test(toEmail) && worker.notify_email !== false) {
      const d = await deliverEmail(sb, { to: toEmail, subject, text: `${lines.join('\n')}\n\n—\n${SENDER_DISPLAY_NAME}`, html: renderHtml(subject, lines) });
      if (d.ok) emailSent = 1;
      logRows.push({ batch_id: batchId, channel: 'email', audience: 'workers', recipient_email: toEmail, subject, body: lines.join('\n'),
        status: d.ok ? 'sent' : 'failed', error: d.ok ? null : d.detail.slice(0, 200), sent_by: caller.name, recipient_name: worker.name });
    }

    try { if (logRows.length) await sb.from('message_log').insert(logRows); } catch (e) { console.error('message_log insert failed:', (e as Error).message); }
    try {
      await sb.from('activity_events').insert([{
        actor_id: caller.id, actor_name: caller.name, verb: 'notified', object_type: 'worker', object_id: worker.id,
        after: { kind, sms: smsSent, email: emailSent, text },
      }]);
    } catch (e) { console.error('activity_events insert failed:', (e as Error).message); }

    return json({ ok: true, sms: smsSent, email: emailSent });
  } catch (e) {
    console.error('notify-worker failed:', (e as Error)?.message);
    return json({ error: 'server_error' }, 500);
  }
});
