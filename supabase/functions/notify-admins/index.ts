// notify-admins — server-side admin broadcast for a worker's accept / decline.
//
// WHY THIS EXISTS: the worker's phone used to call `get_admin_notification_recipients`
// itself and then text / email each admin — which meant every worker's browser
// received the admins' mobile numbers and email addresses. This function moves
// that whole step server-side: the worker only sends { kind, allocation_id } and
// gets back counts. No admin contact detail ever leaves the server.
//
// verify_jwt = true (any signed-in worker). The caller is identified from the JWT
// (anon client `auth.getUser`), then matched to a `workers` row by email with the
// service-role client. The allocation MUST belong to that worker.
//
// Request:
//   POST { kind: 'allocation_accepted' | 'allocation_declined', allocation_id: uuid }
//   — call it AFTER `respond_to_allocation` has returned, because the allocation's
//     status is checked against the kind (accepted ⇒ 'confirmed' / 'completed',
//     declined ⇒ 'declined'). A mismatch is a 409 and nothing is sent.
//
// Response:
//   200 { ok: true, sms: n, email: n, bell: boolean, deduped?: true }
//   400 { error: 'invalid_json' | 'invalid_kind' | 'invalid_allocation_id' }
//   401 { error: 'unauthorized' }            — no / bad user JWT
//   403 { error: 'not_a_worker' | 'not_your_allocation' }
//   404 { error: 'allocation_not_found' }
//   409 { error: 'status_mismatch', status }  — e.g. position already filled
//   429 { error: 'rate_limited' }             — > 20 calls per worker per hour
//   500 { error: 'server_error' }             — never a stack trace
//
// Recipient rule (copied from src/utils/notify.js + get_admin_notification_recipients):
//   roster  = workers where access_level = 'admin' and archived_at is null
//   SMS     = roster ∩ is_allocator ∩ notify_mode 'per_event' ∩ notify_sms ≠ false,
//             E.164-normalised and de-duplicated
//   email   = ADMIN_EMAIL (shared ops inbox, always) + roster ∩ is_allocator ∩
//             notify_mode 'per_event' ∩ notify_email ≠ false, de-duplicated
//   fail-safe: nobody flagged as allocator ⇒ no personal alerts (team inbox only)
//
// Transport (same env names as the existing functions):
//   SMS   — Twilio, config from TWILIO_* env, else the service-role-only
//           `integration_secrets` table (twilio_account_sid / twilio_auth_token /
//           twilio_from …) exactly like the deployed `send-sms`.
//   email — Resend first (RESEND_API_KEY + MAIL_FROM), Gmail fallback via the
//           stored `gmail_tokens` row, exactly like `send-bulk-email`.
//
// Rate limit: a count of `notifications` rows for this worker in the last hour
// (cross-isolate safe; an in-memory map would not be). Idempotence: a second
// call for the same (kind, allocation) within 10 minutes returns deduped:true
// and sends nothing, keyed on the activity_events row this function writes.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PORTAL_URL           = Deno.env.get('PORTAL_URL') || 'https://cbd-portal-gray.vercel.app';
const ADMIN_EMAIL          = (Deno.env.get('ADMIN_EMAIL') || 'theteamcbd@gmail.com').trim().toLowerCase();
const SENDER_DISPLAY_NAME  = Deno.env.get('GMAIL_SENDER_NAME') || 'CBD Plant & Labour';
const GMAIL_CLIENT_ID      = Deno.env.get('GMAIL_CLIENT_ID') || '';
const GMAIL_CLIENT_SECRET  = Deno.env.get('GMAIL_CLIENT_SECRET') || '';
const RESEND_API_KEY       = Deno.env.get('RESEND_API_KEY') || '';
const MAIL_FROM            = Deno.env.get('MAIL_FROM') || '';
const RESEND_ON            = !!(RESEND_API_KEY && MAIL_FROM);

const RATE_LIMIT_PER_HOUR  = 20;
const DEDUPE_WINDOW_MIN    = 10;
const KINDS = ['allocation_accepted', 'allocation_declined'] as const;
type Kind = typeof KINDS[number];

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Helpers ────────────────────────────────────────────────────────────────
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

// 'YYYY-MM-DD' → 'DD/MM'
function ddmm(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return 'TBC';
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
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
// Lazily resolve the connected team Gmail (refreshing the OAuth token if needed).
// Returns null when Gmail is not connected / not configured — callers then
// simply have no fallback.
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

// Resend → Gmail. `gmail` is resolved lazily only when needed.
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
          <p style="margin:0 0 20px 0;"><a href="${PORTAL_URL}" style="color:#f97316;text-decoration:none;font-weight:600;">Open the portal →</a></p>
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

  try {
    // 1. Who is calling? (user JWT → auth user → workers row)
    const authHeader = req.headers.get('Authorization') || '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!jwt) return json({ error: 'unauthorized' }, 401);

    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: userData, error: userErr } = await anon.auth.getUser(jwt);
    const email = (userData?.user?.email || '').trim().toLowerCase();
    if (userErr || !email) return json({ error: 'unauthorized' }, 401);

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    let { data: worker } = await sb.from('workers')
      .select('id, name, email, archived_at')
      .eq('email', email)
      .maybeSingle();
    if (!worker) {
      // Mixed-case email in the workers row: ilike with wildcards escaped, then
      // re-check exact (case-insensitive) equality so `_` can never widen the match.
      const pattern = email.replace(/[\\%_]/g, (m: string) => `\\${m}`);
      const { data: alt } = await sb.from('workers').select('id, name, email, archived_at').ilike('email', pattern).limit(2);
      worker = (alt || []).find((w: any) => String(w.email || '').trim().toLowerCase() === email) || null;
    }
    if (!worker || worker.archived_at) return json({ error: 'not_a_worker' }, 403);

    // 2. Body
    let body: { kind?: string; allocation_id?: string } = {};
    try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const kind = String(body.kind || '') as Kind;
    const allocationId = String(body.allocation_id || '').trim();
    if (!KINDS.includes(kind)) return json({ error: 'invalid_kind' }, 400);
    if (!UUID_RE.test(allocationId)) return json({ error: 'invalid_allocation_id' }, 400);

    // 3. Rate limit — bell rows for this worker in the last hour (cross-isolate safe).
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const { count: recent } = await sb.from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('worker_id', worker.id)
      .gte('created_at', hourAgo);
    if ((recent || 0) >= RATE_LIMIT_PER_HOUR) return json({ error: 'rate_limited' }, 429);

    // 4. The allocation must be the caller's own.
    const { data: alloc } = await sb.from('allocations')
      .select('id, worker_id, status, client, site, role, start_date, end_date, group_id, client_id, site_id')
      .eq('id', allocationId)
      .maybeSingle();
    if (!alloc) return json({ error: 'allocation_not_found' }, 404);
    if (alloc.worker_id !== worker.id) return json({ error: 'not_your_allocation' }, 403);

    // 5. The kind must agree with what respond_to_allocation actually did.
    //    'filled' = the position went to someone else, so it is NOT an acceptance.
    const status = String(alloc.status || '');
    const okStatus = kind === 'allocation_accepted' ? ['confirmed', 'completed'].includes(status) : status === 'declined';
    if (!okStatus) return json({ error: 'status_mismatch', status }, 409);

    // 6. Idempotence — same (kind, allocation) already broadcast in the window?
    const windowStart = new Date(Date.now() - DEDUPE_WINDOW_MIN * 60_000).toISOString();
    const { data: prior } = await sb.from('activity_events')
      .select('id')
      .eq('verb', 'notified').eq('object_type', 'allocation').eq('object_id', alloc.id)
      .eq('after->>kind', kind)
      .gte('created_at', windowStart)
      .limit(1);
    if (prior && prior.length) return json({ ok: true, sms: 0, email: 0, bell: false, deduped: true });

    // 7. Group fill ("2 of 3 filled") — confirmed rows only, exactly like the RPC.
    let positions: number | null = null;
    let filled: number | null = null;
    if (alloc.group_id) {
      const [{ data: g }, { count: c }] = await Promise.all([
        sb.from('allocation_groups').select('positions').eq('id', alloc.group_id).maybeSingle(),
        sb.from('allocations').select('id', { count: 'exact', head: true }).eq('group_id', alloc.group_id).eq('status', 'confirmed'),
      ]);
      positions = g?.positions ?? null;
      filled = c ?? null;
    }

    // 8. Text — built here, never by the client.
    const verb     = kind === 'allocation_accepted' ? 'ACCEPTED' : 'DECLINED';
    const where    = (alloc.site || alloc.client || 'job').toString().trim();
    const role     = (alloc.role || '').toString().trim();
    const when     = ddmm(alloc.start_date) + (alloc.end_date && alloc.end_date !== alloc.start_date ? `–${ddmm(alloc.end_date)}` : '');
    const fillTxt  = positions != null && filled != null ? ` — ${filled} of ${positions} filled` : '';
    const smsText  = `${worker.name} ${verb} ${where} (${[role, when].filter(Boolean).join(', ')})${fillTxt}`;
    const subject  = `${worker.name} ${kind === 'allocation_accepted' ? 'accepted' : 'declined'} — ${alloc.client || where}${alloc.site ? ` — ${alloc.site}` : ''}`;
    const lines    = [
      `${worker.name} has ${verb} the allocation below.`,
      '',
      `Client: ${alloc.client || '—'}`,
      `Site: ${alloc.site || '—'}`,
      `Role: ${role || '—'}`,
      `Dates: ${alloc.start_date || 'TBC'}${alloc.end_date && alloc.end_date !== alloc.start_date ? ` to ${alloc.end_date}` : ''}`,
      ...(positions != null ? [`Group: ${filled} of ${positions} positions filled`] : []),
      '',
      `Open the Allocations board in the portal to see the live picture: ${PORTAL_URL}`,
    ];

    // 9. Bell row — skipped if the client already wrote the same one for this worker.
    let bell = false;
    try {
      const { data: existingBell } = await sb.from('notifications').select('id')
        .eq('type', kind).eq('allocation_id', alloc.id).eq('worker_id', worker.id)
        .gte('created_at', windowStart).limit(1);
      if (!existingBell || !existingBell.length) {
        const { error: bellErr } = await sb.from('notifications').insert([{
          type: kind,
          title: `${worker.name} ${verb} ${alloc.client || where}`,
          body: `${[alloc.client, alloc.site, role].filter(Boolean).join(' · ')} — ${alloc.start_date || 'TBC'}${fillTxt}`,
          allocation_id: alloc.id,
          worker_id: worker.id,
        }]);
        bell = !bellErr;
        if (bellErr) console.error('bell insert failed:', bellErr.message);
      }
    } catch (e) { console.error('bell step threw:', (e as Error).message); }

    // 10. Recipients — exact rule from notify.js / get_admin_notification_recipients.
    const { data: roster, error: rosterErr } = await sb.rpc('get_admin_notification_recipients');
    if (rosterErr) console.error('roster rpc failed:', rosterErr.message);
    const allocators = (roster || []).filter((w: any) => w.is_allocator === true);

    const smsTargets: string[] = [];
    const seenMobile = new Set<string>();
    for (const w of allocators) {
      if ((w.notify_mode || 'per_event') !== 'per_event' || w.notify_sms === false) continue;
      const to = normaliseAUMobile(w.mobile);
      if (!to || seenMobile.has(to)) continue;
      seenMobile.add(to);
      smsTargets.push(to);
    }

    const emailTargets: string[] = [ADMIN_EMAIL];
    const seenEmail = new Set<string>([ADMIN_EMAIL]);
    for (const w of allocators) {
      const e = String(w.email || '').trim();
      if (!EMAIL_RE.test(e)) continue;
      if ((w.notify_mode || 'per_event') !== 'per_event' || w.notify_email === false) continue;
      const key = e.toLowerCase();
      if (seenEmail.has(key)) continue;
      seenEmail.add(key);
      emailTargets.push(e);
    }

    // 11. SMS
    let smsSent = 0;
    const logRows: any[] = [];
    const batchId = crypto.randomUUID();
    if (smsTargets.length) {
      const cfg = await loadTwilioConfig(sb);
      if (twilioReady(cfg)) {
        const results = await Promise.all(smsTargets.map((to) => sendSms(cfg, to, smsText)));
        results.forEach((r, i) => {
          if (r.ok) smsSent++;
          logRows.push({ batch_id: batchId, channel: 'sms', audience: 'mixed', recipient_email: null, subject: null, body: smsText,
            status: r.ok ? 'sent' : 'failed', error: r.ok ? null : (r.error || 'failed').slice(0, 200), sent_by: null, recipient_name: `allocator ${i + 1}` });
        });
      } else {
        console.error('twilio not configured — admin SMS skipped');
      }
    }

    // 12. Email
    let emailSent = 0;
    const gmailBox: { ctx?: GmailCtx; tried: boolean } = { tried: false };
    const html = renderHtml(subject, lines);
    const text = `${lines.join('\n')}\n\n—\n${SENDER_DISPLAY_NAME}\n${PORTAL_URL}`;
    for (const to of emailTargets) {
      try {
        const d = await deliverEmail(sb, gmailBox, { to, subject, text, html });
        if (d.ok) emailSent++;
        logRows.push({ batch_id: batchId, channel: 'email', audience: 'mixed', recipient_email: to, subject, body: text,
          status: d.ok ? 'sent' : 'failed', error: d.ok ? null : d.detail.slice(0, 200), sent_by: null, recipient_name: 'Admin' });
      } catch (e) {
        console.error('email send threw:', (e as Error).message);
      }
    }

    // 13. Audit — message_log (best effort) + the activity row that keys idempotence.
    try { if (logRows.length) await sb.from('message_log').insert(logRows); } catch (e) { console.error('message_log insert failed:', (e as Error).message); }
    try {
      await sb.from('activity_events').insert([{
        actor_id: worker.id, actor_name: worker.name,
        verb: 'notified', object_type: 'allocation', object_id: alloc.id,
        client_id: alloc.client_id || null, site_id: alloc.site_id || null,
        after: { kind, sms: smsSent, email: emailSent, sms_targets: smsTargets.length, email_targets: emailTargets.length,
                 text: smsText, positions, filled, status },
      }]);
    } catch (e) { console.error('activity_events insert failed:', (e as Error).message); }

    return json({ ok: true, sms: smsSent, email: emailSent, bell });
  } catch (e) {
    console.error('notify-admins failed:', (e as Error)?.message);
    return json({ error: 'server_error' }, 500);
  }
});
