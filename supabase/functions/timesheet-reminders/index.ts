// timesheet-reminders — evening nudge to workers who worked today but have not
// submitted a timesheet.
//
// Meant for pg_cron at 19:00 Sydney (see the schedule SQL in the deploy notes).
// verify_jwt = false; guarded by the `x-digest-secret` header, which must equal
// the DIGEST_SECRET project secret. FAILS CLOSED when DIGEST_SECRET is unset.
//
// One run, for TODAY (Australia/Sydney):
//   1. workers (not archived) with a 'confirmed' or 'completed' WORK allocation
//      covering today (start_date ≤ today ≤ end_date; null end_date = single day)
//   2. minus anyone with a `timesheets` line dated today, or a `timesheet_headers`
//      row created today (Sydney)
//   3. minus anyone already reminded today — an `activity_events` row with
//      verb 'reminded', object_type 'timesheet' and after->>'date' = today
//   4. each remaining worker gets ONE push (every device that opted in, via the
//      internal `send-push` function) + ONE SMS + ONE email:
//        "Hi Sam, please submit today's timesheet for Bonnyrigg in the CBD portal: <PORTAL_URL>"
//      honouring workers.notify_sms / notify_email. SMS via Twilio with the same
//      config lookup as `send-sms` (TWILIO_* env, else `integration_secrets`) and
//      the same E.164 normaliser as the client; email Resend-first with the Gmail
//      fallback, like `send-bulk-email`.
//   5. one `activity_events` row per reminder actually delivered (verb 'reminded',
//      object_type 'timesheet', object_id = worker id, after = { date, … }) —
//      that row is what stops a second run re-texting the same worker.
//
// Request:  POST (empty body) — optional { date?: 'YYYY-MM-DD', dry_run?: true }
// Response: 200 { ok, date, dry_run, reminded, skipped, failed,
//                 breakdown: { has_timesheet, already_reminded, no_channel }, workers: [names] }
//           401 { error: 'unauthorized' } · 503 { error: 'not_configured' }
//           500 { error: 'server_error' } (never a stack trace)
// No money, no phone numbers and no email addresses appear in the response.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const DIGEST_SECRET        = Deno.env.get('DIGEST_SECRET') || '';
const PORTAL_URL           = Deno.env.get('PORTAL_URL') || 'https://cbd-portal-gray.vercel.app';
const SENDER_DISPLAY_NAME  = Deno.env.get('GMAIL_SENDER_NAME') || 'CBD Plant & Labour';
const GMAIL_CLIENT_ID      = Deno.env.get('GMAIL_CLIENT_ID') || '';
const GMAIL_CLIENT_SECRET  = Deno.env.get('GMAIL_CLIENT_SECRET') || '';
const RESEND_API_KEY       = Deno.env.get('RESEND_API_KEY') || '';
const MAIL_FROM            = Deno.env.get('MAIL_FROM') || '';
const RESEND_ON            = !!(RESEND_API_KEY && MAIL_FROM);

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-digest-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DATE_RE  = /^\d{4}-\d{2}-\d{2}$/;

// ── Web push (delegated to the internal `send-push` function) ─────────────
// Free + instant; shows on the phone even with the app closed. Never throws
// on a transport problem — a missing device just means { sent: 0 }.
async function sendPush(msg: { worker_ids?: string[]; office?: boolean; title: string; body?: string; url?: string; tag?: string })
  : Promise<{ sent: number; failed: number; removed: number }> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) { console.error('send-push:', res.status, r?.error || ''); return { sent: 0, failed: 1, removed: 0 }; }
    return { sent: r.sent || 0, failed: r.failed || 0, removed: r.removed || 0 };
  } catch (e) {
    console.error('send-push unreachable:', (e as Error).message);
    return { sent: 0, failed: 1, removed: 0 };
  }
}

// ── Sydney date helpers ───────────────────────────────────────────────────
function sydneyToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
}
// UTC instant of 00:00 Sydney on the given date, DST-safe (tries AEDT then AEST
// and keeps the offset that maps back onto midnight of that calendar day).
function sydneyStartOfDayUtc(iso: string): string {
  for (const off of ['+11:00', '+10:00']) {
    const d = new Date(`${iso}T00:00:00${off}`);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(d);
    const get = (t: string) => parts.find(p => p.type === t)?.value || '';
    const hour = get('hour');
    if (`${get('year')}-${get('month')}-${get('day')}` === iso && (hour === '00' || hour === '24')) return d.toISOString();
  }
  return new Date(`${iso}T00:00:00+10:00`).toISOString();
}
function ddmm(iso: string) { return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`; }
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// AU mobile → E.164 ("+61…"). Same rules as src/utils/notify.js normaliseAUMobile.
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

// ── Twilio (mirrors the deployed send-sms loadConfig) ─────────────────────
type TwilioCfg = { accountSid?: string; apiKeySid?: string; apiKeySecret?: string; authToken?: string; from?: string };

async function loadTwilioConfig(sb: ReturnType<typeof createClient>): Promise<TwilioCfg> {
  const env = (k: string) => Deno.env.get(k) || undefined;
  const cfg: TwilioCfg = {
    accountSid:   env('TWILIO_ACCOUNT_SID'),
    apiKeySid:    env('TWILIO_API_KEY_SID'),
    apiKeySecret: env('TWILIO_API_KEY_SECRET'),
    authToken:    env('TWILIO_AUTH_TOKEN'),
    from:         env('TWILIO_FROM') || env('TWILIO_SMS_FROM'),
  };
  const needTable = !cfg.accountSid || !cfg.from || (!cfg.apiKeySecret && !cfg.authToken);
  if (needTable) {
    try {
      const { data } = await sb.from('integration_secrets').select('key,value').like('key', 'twilio_%');
      const m: Record<string, string> = Object.fromEntries((data ?? []).map((r: any) => [r.key, r.value]));
      cfg.accountSid   ||= m.twilio_account_sid;
      cfg.apiKeySid    ||= m.twilio_api_key_sid;
      cfg.apiKeySecret ||= m.twilio_api_key_secret;
      cfg.authToken    ||= m.twilio_auth_token;
      cfg.from         ||= m.twilio_from || m.twilio_messaging_service_sid;
    } catch (e) {
      console.error('integration_secrets read failed:', (e as Error).message);
    }
  }
  return cfg;
}
function twilioReady(cfg: TwilioCfg) {
  const user = cfg.apiKeySid || cfg.accountSid;
  const pass = cfg.apiKeySecret || cfg.authToken;
  return !!(cfg.accountSid && cfg.from && user && pass);
}
async function sendSms(cfg: TwilioCfg, to: string, body: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const user = cfg.apiKeySid || cfg.accountSid!;
    const pass = cfg.apiKeySecret || cfg.authToken!;
    const form = new URLSearchParams();
    if (String(cfg.from).startsWith('MG')) form.set('MessagingServiceSid', cfg.from!);
    else form.set('From', cfg.from!);
    form.set('To', to);
    form.set('Body', body);
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + btoa(`${user}:${pass}`), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (resp.ok) return { ok: true };
    let detail = `twilio_${resp.status}`;
    try { const d = await resp.json(); detail = `twilio_${resp.status}: ${d?.message ?? ''} ${d?.code ?? ''}`.trim(); } catch { /* ignore */ }
    return { ok: false, error: detail.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: String((e as Error).message).slice(0, 200) };
  }
}

// ── Email: Resend first, Gmail fallback (mirrors send-bulk-email) ──────────
async function sendViaResend(opts: { to: string; subject: string; text: string; html?: string; replyTo?: string | null }) {
  const payload: Record<string, unknown> = { from: MAIL_FROM, to: [opts.to], subject: opts.subject, text: opts.text };
  if (opts.html) payload.html = opts.html;
  if (opts.replyTo) payload.reply_to = opts.replyTo;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, detail: res.ok ? '' : (await res.text()).slice(0, 300) };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
function b64url(s: string) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function encodeHeader(value: string) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let bin = '';
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
  const b64 = (s: string) => {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/(.{76})/g, '$1\r\n');
  };
  const headers = [
    `From: ${opts.from}`, `To: ${opts.to}`, `Subject: ${encodeHeader(opts.subject)}`,
    'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
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
    const expired = new Date(row.expires_at).getTime() < Date.now() + 30_000;
    if (!expired) return { accessToken: row.access_token, emailAddress: row.email_address };
    if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) return null;
    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_CLIENT_SECRET,
        refresh_token: row.refresh_token, grant_type: 'refresh_token',
      }),
    });
    if (!refreshRes.ok) { console.error('gmail token refresh failed'); return null; }
    const t = await refreshRes.json();
    const newExpires = new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString();
    await sb.from('gmail_tokens').update({ access_token: t.access_token, expires_at: newExpires, updated_at: new Date().toISOString() }).eq('id', 1);
    return { accessToken: t.access_token, emailAddress: row.email_address };
  } catch (e) {
    console.error('getGmail threw:', (e as Error).message);
    return null;
  }
}
async function sendGmailRaw(accessToken: string, mime: string) {
  try {
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: b64url(mime) }),
    });
    return { ok: res.ok, detail: res.ok ? '' : (await res.text()).slice(0, 300) };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
async function deliverEmail(sb: ReturnType<typeof createClient>, gmailBox: { ctx?: GmailCtx; tried: boolean },
  opts: { to: string; subject: string; text: string; html: string }): Promise<{ ok: boolean; via: string; detail: string }> {
  const ensureGmail = async () => { if (!gmailBox.tried) { gmailBox.tried = true; gmailBox.ctx = await getGmail(sb); } return gmailBox.ctx || null; };
  if (RESEND_ON) {
    const g0 = gmailBox.tried ? gmailBox.ctx : null;
    const r = await sendViaResend({ to: opts.to, subject: opts.subject, text: opts.text, html: opts.html, replyTo: g0?.emailAddress || null });
    if (r.ok) return { ok: true, via: 'resend', detail: '' };
    const g = await ensureGmail();
    if (!g) return { ok: false, via: 'resend', detail: r.detail };
    const mime = buildMime({ from: formatFromHeader(SENDER_DISPLAY_NAME, g.emailAddress), to: opts.to, subject: opts.subject, text: opts.text, html: opts.html });
    const gr = await sendGmailRaw(g.accessToken, mime);
    return gr.ok ? { ok: true, via: 'gmail-fallback', detail: '' } : { ok: false, via: 'both-failed', detail: `resend: ${r.detail} | gmail: ${gr.detail}` };
  }
  const g = await ensureGmail();
  if (!g) return { ok: false, via: 'none', detail: 'no sender configured' };
  const mime = buildMime({ from: formatFromHeader(SENDER_DISPLAY_NAME, g.emailAddress), to: opts.to, subject: opts.subject, text: opts.text, html: opts.html });
  const gr = await sendGmailRaw(g.accessToken, mime);
  return { ok: gr.ok, via: 'gmail', detail: gr.detail };
}
function renderHtml(subject: string, lines: string[]) {
  const safeBody = lines.map(escapeHtml).join('<br>');
  return `<!doctype html><html><body style="margin:0;padding:0;background:#0b0e14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0e14;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#11151e;border:1px solid #222838;border-radius:14px;padding:32px;">
        <tr><td>
          <div style="font-size:28px;font-weight:800;color:#f97316;letter-spacing:-0.5px;line-height:1;">CBD</div>
          <div style="font-size:10px;color:#8a92a8;letter-spacing:2.5px;text-transform:uppercase;margin-top:4px;margin-bottom:24px;font-weight:600;">Plant &amp; Labour</div>
          <h1 style="color:#eef0f6;font-size:20px;margin:0 0 14px 0;font-weight:700;letter-spacing:-0.3px;">${escapeHtml(subject)}</h1>
          <div style="color:#eef0f6;font-size:14.5px;line-height:1.6;margin:0 0 20px 0;">${safeBody}</div>
          <p style="margin:0 0 20px 0;"><a href="${PORTAL_URL}" style="display:inline-block;background:#f97316;color:#0b0e14;text-decoration:none;font-weight:700;padding:10px 18px;border-radius:8px;">Submit my timesheet</a></p>
          <hr style="border:none;border-top:1px solid #222838;margin:24px 0 14px 0;">
          <p style="color:#8a92a8;font-size:11px;line-height:1.5;margin:0;font-family:'SF Mono',Consolas,monospace;letter-spacing:0.5px;">
            CBD PLANT &amp; LABOUR · ABN 75 663 693 070<br>
            ROAD · RAIL · WATER · <a href="${PORTAL_URL}" style="color:#f97316;text-decoration:none;">portal</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ── Handler ────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  if (!DIGEST_SECRET) return json({ error: 'not_configured' }, 503);
  if ((req.headers.get('x-digest-secret') || '') !== DIGEST_SECRET) return json({ error: 'unauthorized' }, 401);

  try {
    let body: { date?: string; dry_run?: boolean } = {};
    try { body = await req.json(); } catch { /* empty body from cron */ }
    const dryRun = body?.dry_run === true;
    const today  = body?.date && DATE_RE.test(body.date) ? body.date : sydneyToday();
    const dayStartUtc = sydneyStartOfDayUtc(today);
    const dayEndUtc   = new Date(new Date(dayStartUtc).getTime() + 24 * 3600_000).toISOString();

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // 1. Who worked today? (confirmed / completed WORK allocations covering today)
    const { data: allocs, error: allocErr } = await sb.from('allocations')
      .select('worker_id, client, site, start_date, end_date')
      .in('status', ['confirmed', 'completed'])
      .eq('allocation_type', 'work')
      .not('worker_id', 'is', null)
      .lte('start_date', today)
      .or(`end_date.is.null,end_date.gte.${today}`);
    if (allocErr) throw allocErr;

    const byWorker = new Map<string, { sites: Set<string>; clients: Set<string> }>();
    for (const a of allocs || []) {
      if (!a.end_date && a.start_date !== today) continue;   // null end_date ⇒ single day
      const cur = byWorker.get(a.worker_id) || { sites: new Set<string>(), clients: new Set<string>() };
      if (a.site)   cur.sites.add(String(a.site).trim());
      if (a.client) cur.clients.add(String(a.client).trim());
      byWorker.set(a.worker_id, cur);
    }
    const workerIds = Array.from(byWorker.keys());
    const breakdown = { has_timesheet: 0, already_reminded: 0, no_channel: 0 };
    if (!workerIds.length) {
      return json({ ok: true, date: today, dry_run: dryRun, reminded: 0, skipped: 0, failed: 0, breakdown, workers: [] });
    }

    // 2. Who already has a timesheet line / header for today?
    const [{ data: lines }, { data: heads }, { data: reminded }, { data: wrows }] = await Promise.all([
      sb.from('timesheets').select('worker_id').eq('date', today).in('worker_id', workerIds),
      sb.from('timesheet_headers').select('worker_id').in('worker_id', workerIds).gte('created_at', dayStartUtc).lt('created_at', dayEndUtc),
      sb.from('activity_events').select('object_id').eq('verb', 'reminded').eq('object_type', 'timesheet').eq('after->>date', today).in('object_id', workerIds),
      sb.from('workers').select('id, name, mobile, email, notify_sms, notify_email, archived_at').in('id', workerIds),
    ]);
    const hasSheet    = new Set((lines || []).map((l: any) => l.worker_id).concat((heads || []).map((h: any) => h.worker_id)));
    const alreadyDone = new Set((reminded || []).map((r: any) => r.object_id));
    const workers     = new Map<string, any>((wrows || []).map((w: any) => [String(w.id), w] as [string, any]));

    // 3. Send.
    let remindedCount = 0, failedCount = 0;
    const names: string[] = [];
    let twilio: TwilioCfg | null = null;
    const gmailBox: { ctx?: GmailCtx; tried: boolean } = { tried: false };
    const logRows: any[] = [];
    const batchId = crypto.randomUUID();

    for (const wid of workerIds) {
      const w = workers.get(wid);
      if (!w || w.archived_at) continue;
      if (hasSheet.has(wid))    { breakdown.has_timesheet++; continue; }
      if (alreadyDone.has(wid)) { breakdown.already_reminded++; continue; }

      const info  = byWorker.get(wid)!;
      const where = Array.from(info.sites).join(' / ') || Array.from(info.clients).join(' / ') || 'today\'s job';
      const first = String(w.name || 'there').trim().split(/\s+/)[0] || 'there';
      const smsText = `Hi ${first}, please submit today's timesheet for ${where} in the CBD portal: ${PORTAL_URL}`;
      const subject = `Timesheet reminder — ${where} (${ddmm(today)})`;
      const lines   = [
        `Hi ${first},`,
        '',
        `Please submit today's timesheet for ${where} in the CBD portal.`,
        `Date: ${today}`,
        ...(info.clients.size ? [`Client: ${Array.from(info.clients).join(' / ')}`] : []),
        '',
        `It only takes a minute: ${PORTAL_URL}`,
      ];
      const text = `${lines.join('\n')}\n\n—\n${SENDER_DISPLAY_NAME}\n${PORTAL_URL}`;

      const wantSms   = w.notify_sms !== false && !!normaliseAUMobile(w.mobile);
      const wantEmail = w.notify_email !== false && EMAIL_RE.test(String(w.email || '').trim());

      let smsOk = false, emailOk = false, pushOk = false;
      if (!dryRun) {
        // Push first: free and instant; the phone shows it even with the app closed.
        try {
          const p = await sendPush({ worker_ids: [wid], title: 'Timesheet reminder', body: `Please submit today's timesheet for ${where}.`, url: '/', tag: `ts-${today}` });
          pushOk = p.sent > 0;
        } catch (e) { console.error('push threw:', (e as Error).message); }
      }
      // Push counts as a channel; a worker with no SMS/email AND no device is skipped.
      if (!wantSms && !wantEmail && !pushOk) { breakdown.no_channel++; continue; }

      if (!dryRun) {
        if (wantSms) {
          try {
            if (!twilio) twilio = await loadTwilioConfig(sb);
            if (twilioReady(twilio)) {
              const r = await sendSms(twilio, normaliseAUMobile(w.mobile), smsText);
              smsOk = r.ok;
              logRows.push({ batch_id: batchId, channel: 'sms', audience: 'workers', recipient_id: wid, recipient_name: w.name, recipient_email: null,
                subject: null, body: smsText, status: r.ok ? 'sent' : 'failed', error: r.ok ? null : (r.error || 'failed').slice(0, 200) });
            } else {
              console.error('twilio not configured — SMS reminder skipped');
            }
          } catch (e) { console.error('sms threw:', (e as Error).message); }
        }
        if (wantEmail) {
          try {
            const d = await deliverEmail(sb, gmailBox, { to: String(w.email).trim(), subject, text, html: renderHtml(subject, lines) });
            emailOk = d.ok;
            logRows.push({ batch_id: batchId, channel: 'email', audience: 'workers', recipient_id: wid, recipient_name: w.name, recipient_email: String(w.email).trim(),
              subject, body: text, status: d.ok ? 'sent' : 'failed', error: d.ok ? null : d.detail.slice(0, 200) });
          } catch (e) { console.error('email threw:', (e as Error).message); }
        }
      }

      if (dryRun || smsOk || emailOk || pushOk) {
        remindedCount++;
        names.push(w.name);
        if (!dryRun) {
          try {
            await sb.from('activity_events').insert([{
              actor_name: 'portal', verb: 'reminded', object_type: 'timesheet', object_id: wid,
              after: { date: today, worker_id: wid, worker: w.name, site: where, clients: Array.from(info.clients), sms: smsOk, email: emailOk, push: pushOk },
            }]);
          } catch (e) { console.error('activity insert failed:', (e as Error).message); }
        }
      } else {
        failedCount++;   // nothing delivered — no 'reminded' row, so a re-run can retry
      }
    }

    try { if (logRows.length) await sb.from('message_log').insert(logRows); } catch (e) { console.error('message_log insert failed:', (e as Error).message); }

    const skipped = breakdown.has_timesheet + breakdown.already_reminded + breakdown.no_channel;
    return json({ ok: true, date: today, dry_run: dryRun, reminded: remindedCount, skipped, failed: failedCount, breakdown, workers: names });
  } catch (e) {
    console.error('timesheet-reminders failed:', (e as Error)?.message);
    return json({ error: 'server_error' }, 500);
  }
});
