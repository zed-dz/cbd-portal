// notify-admins-ops — server-side admin broadcast for the worker "ops" events
// added 2026-10-19: incident reports, time-off requests, induction sign-ons.
//
// Sibling of notify-admins (which owns allocation accept / decline and is NOT
// edited here). Same shape: the worker only sends { kind, id }; the text is
// built from the database row, admin contact details never leave the server.
//
// verify_jwt = true (any signed-in worker). Caller = JWT email → workers row.
//
// Request:
//   POST { kind: 'incident_reported', id: incident_reports.id }
//   POST { kind: 'leave_requested',   id: leave_requests.id }
//   POST { kind: 'induction_signed',  id: site_induction_signatures.id }
//   The row must belong to the caller (worker_id = caller) or it is a 403.
//
// Dry run (2026-10-20, for proving a path end to end without sending):
//   Authorization: Bearer <service role key: the env key or the legacy service_role JWT>
//   x-acting-worker-id: <workers.id to act as>
//   POST { kind, id, dry_run: true }
//   -> 200 { ok, dry_run: true, kind, sms_text, subject, title, bell_body,
//            email_text, recipients: { sms, email, pool }, twilio_ready, would_dedupe }
//   Builds everything, sends nothing, writes nothing. Counts only, never the
//   admins' numbers or addresses. The service key is accepted ONLY with
//   dry_run: true (anything else is a 401).
//
// Response:
//   200 { ok: true, sms: n, email: n, bell: boolean, deduped?: true }
//   400 invalid_json | invalid_kind | invalid_id · 401 unauthorized
//   403 not_a_worker | not_yours · 404 not_found · 429 rate_limited · 500 server_error
//
// Recipients:
//   leave_requested / induction_signed → allocators (same rule as notify-admins)
//   incident_reported → EVERY admin on per-event mode (safety: never "allocators only")
//   + ADMIN_EMAIL always gets the email.
// Transport (Twilio via env/integration_secrets, Resend → Gmail) copied from
// notify-admins so the two stay byte-for-byte alike.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PORTAL_URL           = Deno.env.get('PORTAL_URL') || 'https://portal.cbdpnl.com.au';
const ADMIN_EMAIL          = (Deno.env.get('ADMIN_EMAIL') || 'theteamcbd@gmail.com').trim().toLowerCase();
const SENDER_DISPLAY_NAME  = Deno.env.get('GMAIL_SENDER_NAME') || 'CBD Plant & Labour';
const GMAIL_CLIENT_ID      = Deno.env.get('GMAIL_CLIENT_ID') || '';
const GMAIL_CLIENT_SECRET  = Deno.env.get('GMAIL_CLIENT_SECRET') || '';
const RESEND_API_KEY       = Deno.env.get('RESEND_API_KEY') || '';
const MAIL_FROM            = Deno.env.get('MAIL_FROM') || '';
const RESEND_ON            = !!(RESEND_API_KEY && MAIL_FROM);

const RATE_LIMIT_PER_HOUR  = 20;
const DEDUPE_WINDOW_MIN    = 10;
// fatigue_flagged → allocators (a sheet was submitted with >12h / <10h rest / >60h breaches)
// document_signed → no broadcast, no change (ip + user agent are stamped by the insert trigger)
const KINDS = ['incident_reported', 'leave_requested', 'induction_signed', 'fatigue_flagged', 'document_signed'] as const;
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
function ddmm(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return 'TBC';
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}
function sydney(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit', hour: 'numeric', minute: '2-digit' });
  } catch { return iso; }
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
async function deliverEmail(sb: ReturnType<typeof createClient>, gmailBox: { ctx?: GmailCtx; tried: boolean },
  opts: { to: string; subject: string; text: string; html: string }): Promise<{ ok: boolean; via: string; detail: string }> {
  const ensureGmail = async () => { if (!gmailBox.tried) { gmailBox.tried = true; gmailBox.ctx = await getGmail(sb); } return gmailBox.ctx || null; };
  if (RESEND_ON) {
    const g0 = gmailBox.tried ? gmailBox.ctx : null;
    const r = await sendViaResend({ to: opts.to, subject: opts.subject, text: opts.text, html: opts.html, replyTo: g0?.emailAddress || null });
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

// Constant-time compare for the service-key check (dry run only).
function sameSecret(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// A legacy service_role JWT that is not byte-equal to this function's env key
// (the env can hold a newer secret key). Only tokens whose payload claims
// service_role are probed, and the probe is an auth-admin call that succeeds
// for a genuine service-role key only — the claim alone is never trusted.
async function isServiceRoleJwt(jwt: string): Promise<boolean> {
  try {
    const part = jwt.split('.')[1];
    if (!part) return false;
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')));
    if (payload?.role !== 'service_role') return false;
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1`, { headers: { apikey: jwt, Authorization: `Bearer ${jwt}` } });
    try { await r.body?.cancel(); } catch { /* ignore */ }
    return r.ok;
  } catch { return false; }
}

// ── Handler ───────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  try {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!jwt) return json({ error: 'unauthorized' }, 401);
    const isService = sameSecret(jwt, SUPABASE_SERVICE_KEY) || await isServiceRoleJwt(jwt);

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    let worker: any = null;
    if (isService) {
      // Dry run only: act as the worker named in x-acting-worker-id.
      const acting = (req.headers.get('x-acting-worker-id') || '').trim();
      if (!UUID_RE.test(acting)) return json({ error: 'unauthorized' }, 401);
      ({ data: worker } = await sb.from('workers').select('id, name, email, archived_at').eq('id', acting).maybeSingle());
    } else {
      const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      const { data: userData, error: userErr } = await anon.auth.getUser(jwt);
      const email = (userData?.user?.email || '').trim().toLowerCase();
      if (userErr || !email) return json({ error: 'unauthorized' }, 401);

      ({ data: worker } = await sb.from('workers').select('id, name, email, archived_at').eq('email', email).maybeSingle());
      if (!worker) {
        const pattern = email.replace(/[\\%_]/g, (m: string) => `\\${m}`);
        const { data: alt } = await sb.from('workers').select('id, name, email, archived_at').ilike('email', pattern).limit(2);
        worker = (alt || []).find((w: any) => String(w.email || '').trim().toLowerCase() === email) || null;
      }
    }
    if (!worker || worker.archived_at) return json({ error: 'not_a_worker' }, 403);

    let body: { kind?: string; id?: string; dry_run?: boolean } = {};
    try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    // A worker's own call can never be a dry run, and the service key can
    // never be anything else.
    const dryRun = isService && body.dry_run === true;
    if (isService && !dryRun) return json({ error: 'unauthorized' }, 401);
    const kind = String(body.kind || '') as Kind;
    const id = String(body.id || '').trim();
    if (!KINDS.includes(kind)) return json({ error: 'invalid_kind' }, 400);
    if (!UUID_RE.test(id)) return json({ error: 'invalid_id' }, 400);

    // Evidence for e-signatures: the caller's IP + user agent, as seen by the server.
    // Same rule as the stamp_signature_evidence() trigger: the IP the edge
    // (Cloudflare) attached, else the RIGHT-most X-Forwarded-For hop (the
    // left-most is whatever the client chose to send).
    const xffHops = (req.headers.get('x-forwarded-for') || '').split(',').map((h) => h.trim()).filter(Boolean);
    const callerIp = ((req.headers.get('cf-connecting-ip') || '').trim() || xffHops[xffHops.length - 1] || '').slice(0, 64) || null;
    const callerUa = (req.headers.get('user-agent') || '').slice(0, 300) || null;

    if (kind === 'document_signed') {
      const { data: r } = await sb.from('document_signatures').select('id, worker_id').eq('id', id).maybeSingle();
      if (!r) return json({ error: 'not_found' }, 404);
      if (r.worker_id !== worker.id) return json({ error: 'not_yours' }, 403);
      if (dryRun) return json({ ok: true, dry_run: true, kind, would_record: true });
      // No-op in practice: stamp_signature_evidence() stamps ip + user agent on
      // every insert. Kept harmless — it only touches a row whose ip is null and
      // the write-once trigger never lets it overwrite evidence.
      await sb.from('document_signatures').update({ ip: callerIp, user_agent: callerUa }).eq('id', id).is('ip', null);
      return json({ ok: true, sms: 0, email: 0, bell: false, recorded: true });
    }

    // Rate limit — bell rows for this worker in the last hour.
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const { count: recent } = await sb.from('notifications').select('id', { count: 'exact', head: true }).eq('worker_id', worker.id).gte('created_at', hourAgo);
    if (!dryRun && (recent || 0) >= RATE_LIMIT_PER_HOUR) return json({ error: 'rate_limited' }, 429);

    // Load the row, verify ownership, build the text server-side.
    let objectType = '';
    let smsText = '';
    let subject = '';
    let lines: string[] = [];
    let title = '';
    let bellBody = '';
    let siteId: string | null = null;

    if (kind === 'incident_reported') {
      objectType = 'incident_report';
      const { data: r } = await sb.from('incident_reports').select('*').eq('id', id).maybeSingle();
      if (!r) return json({ error: 'not_found' }, 404);
      if (r.worker_id !== worker.id) return json({ error: 'not_yours' }, 403);
      siteId = r.site_id || null;
      const typeLabel = r.type === 'near_miss' ? 'NEAR MISS' : r.type === 'hazard' ? 'HAZARD' : 'INCIDENT';
      const where = [r.client, r.site].filter(Boolean).join(' — ') || 'location not given';
      const flags = [r.injured ? 'injured' : '', r.first_aid ? 'first aid given' : ''].filter(Boolean).join(', ');
      smsText = `${typeLabel} reported by ${worker.name} at ${where} (${sydney(r.occurred_at)})${flags ? ` — ${flags}` : ''}. Open Safety in the portal.`;
      subject = `${typeLabel} — ${worker.name} — ${where}`;
      title = `⚠️ ${typeLabel}: ${worker.name} at ${where}`;
      bellBody = `${sydney(r.occurred_at)}${flags ? ` · ${flags}` : ''} — ${String(r.description || '').slice(0, 120)}`;
      lines = [
        `${worker.name} has reported a ${typeLabel.toLowerCase()}.`, '',
        `Where: ${where}`, `When: ${sydney(r.occurred_at)}`,
        `Injured: ${r.injured ? 'YES' : 'No'}`, `First aid given: ${r.first_aid ? 'YES' : 'No'}`,
        `Photos: ${(r.photo_paths || []).length}`, '',
        'What happened:', String(r.description || ''), '',
        `Open Safety in the portal to review it: ${PORTAL_URL}`,
      ];
    } else if (kind === 'leave_requested') {
      objectType = 'leave_request';
      const { data: r } = await sb.from('leave_requests').select('*').eq('id', id).maybeSingle();
      if (!r) return json({ error: 'not_found' }, 404);
      if (r.worker_id !== worker.id) return json({ error: 'not_yours' }, 403);
      const when = r.from_date === r.to_date ? ddmm(r.from_date) : `${ddmm(r.from_date)}–${ddmm(r.to_date)}`;
      smsText = `${worker.name} requested time off ${when}${r.reason ? ` (${r.reason})` : ''}. Approve or decline in the portal.`;
      subject = `Time off request — ${worker.name} — ${when}`;
      title = `🏖 ${worker.name} requested time off ${when}`;
      bellBody = r.reason || null as any;
      lines = [
        `${worker.name} has asked for time off.`, '',
        `From: ${r.from_date}`, `To: ${r.to_date}`, `Reason: ${r.reason || '—'}`, '',
        `Open "Time off requests" in the portal to approve or decline: ${PORTAL_URL}`,
      ];
    } else if (kind === 'fatigue_flagged') {
      objectType = 'timesheet_header';
      const { data: r } = await sb.from('timesheet_headers').select('id, worker_id, client, project, fatigue_flags, total_hours, created_at').eq('id', id).maybeSingle();
      if (!r) return json({ error: 'not_found' }, 404);
      if (r.worker_id !== worker.id) return json({ error: 'not_yours' }, 403);
      const flags: any[] = Array.isArray(r.fatigue_flags) ? r.fatigue_flags : [];
      if (!flags.length) return json({ ok: true, sms: 0, email: 0, bell: false, no_flags: true });
      siteId = null;
      const where = [r.client, r.project].filter(Boolean).join(' — ') || 'a job';
      const list = flags.map((f: any) => String(f?.text || f?.type || '')).filter(Boolean);
      smsText = `FATIGUE: ${worker.name} submitted a timesheet (${where}) with ${list.length} breach${list.length === 1 ? '' : 'es'}: ${list.join('; ').slice(0, 220)}. Check it before approving.`;
      subject = `Fatigue check — ${worker.name} — ${where}`;
      title = `😴 Fatigue: ${worker.name} — ${list.length} breach${list.length === 1 ? '' : 'es'}`;
      bellBody = list.join(' · ').slice(0, 200);
      lines = [
        `${worker.name} confirmed these hours are correct, but they break the fatigue limits:`, '',
        ...list.map((t) => `• ${t}`), '',
        `Job: ${where}`, `Total on the sheet: ${r.total_hours ?? '—'} h`, '',
        `Open Timesheets in the portal (red "Fatigue" badge) before you approve it: ${PORTAL_URL}`,
      ];
    } else {
      objectType = 'site_induction_signature';
      const { data: r } = await sb.from('site_induction_signatures').select('*, site_inductions(title, site_id, client_sites(name))').eq('id', id).maybeSingle();
      if (!r) return json({ error: 'not_found' }, 404);
      if (r.worker_id !== worker.id) return json({ error: 'not_yours' }, 403);
      if (!dryRun) { try { await sb.from('site_induction_signatures').update({ ip: callerIp, user_agent: callerUa }).eq('id', id).is('ip', null); } catch { /* evidence only */ } }
      const ind: any = r.site_inductions || {};
      siteId = ind.site_id || null;
      const siteName = ind.client_sites?.name || 'site';
      smsText = `${worker.name} signed the induction "${ind.title || 'Site induction'}" for ${siteName}.`;
      subject = `Induction signed — ${worker.name} — ${siteName}`;
      title = `📝 ${worker.name} signed the ${siteName} induction`;
      bellBody = `${ind.title || 'Site induction'} · v${r.version} · signed as "${r.signed_name}"`;
      lines = [
        `${worker.name} has read and signed a site induction.`, '',
        `Site: ${siteName}`, `Induction: ${ind.title || '—'} (version ${r.version})`,
        `Signed as: ${r.signed_name}`, `At: ${sydney(r.signed_at)}`, '',
        `Open Clients & Sites → the site's Induction button to see every signature: ${PORTAL_URL}`,
      ];
    }

    // Idempotence on (kind, id).
    const windowStart = new Date(Date.now() - DEDUPE_WINDOW_MIN * 60_000).toISOString();
    const { data: prior } = await sb.from('activity_events').select('id')
      .eq('verb', 'notified').eq('object_type', objectType).eq('object_id', id).gte('created_at', windowStart).limit(1);
    if (!dryRun && prior && prior.length) return json({ ok: true, sms: 0, email: 0, bell: false, deduped: true });

    // Bell row (worker_id = caller, allowed by the notifications insert policy
    // too, but written here so the phone never has to).
    let bell = false;
    if (!dryRun) try {
      const { error: bellErr } = await sb.from('notifications').insert([{ type: kind, title, body: bellBody || null, allocation_id: null, worker_id: worker.id }]);
      bell = !bellErr;
      if (bellErr) console.error('bell insert failed:', bellErr.message);
    } catch (e) { console.error('bell step threw:', (e as Error).message); }

    // Recipients.
    const { data: roster, error: rosterErr } = await sb.rpc('get_admin_notification_recipients');
    if (rosterErr) console.error('roster rpc failed:', rosterErr.message);
    const pool = (roster || []).filter((w: any) => kind === 'incident_reported' ? true : w.is_allocator === true);

    const smsTargets: string[] = [];
    const seenMobile = new Set<string>();
    for (const w of pool) {
      if ((w.notify_mode || 'per_event') !== 'per_event' || w.notify_sms === false) continue;
      const to = normaliseAUMobile(w.mobile);
      if (!to || seenMobile.has(to)) continue;
      seenMobile.add(to); smsTargets.push(to);
    }
    const emailTargets: string[] = [ADMIN_EMAIL];
    const seenEmail = new Set<string>([ADMIN_EMAIL]);
    for (const w of pool) {
      const e = String(w.email || '').trim();
      if (!EMAIL_RE.test(e)) continue;
      if ((w.notify_mode || 'per_event') !== 'per_event' || w.notify_email === false) continue;
      const key = e.toLowerCase();
      if (seenEmail.has(key)) continue;
      seenEmail.add(key); emailTargets.push(e);
    }

    if (dryRun) {
      const cfg = smsTargets.length ? await loadTwilioConfig(sb) : null;
      return json({
        ok: true, dry_run: true, kind, sms_text: smsText, subject, title, bell_body: bellBody || null,
        email_text: lines.join('\n'),
        recipients: { sms: smsTargets.length, email: emailTargets.length, pool: pool.length },
        twilio_ready: cfg ? twilioReady(cfg) : null,
        would_dedupe: !!(prior && prior.length),
      });
    }

    // SMS
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
            status: r.ok ? 'sent' : 'failed', error: r.ok ? null : (r.error || 'failed').slice(0, 200), sent_by: null, recipient_name: `admin ${i + 1}` });
        });
      } else console.error('twilio not configured — admin SMS skipped');
    }

    // Email
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
      } catch (e) { console.error('email send threw:', (e as Error).message); }
    }

    try { if (logRows.length) await sb.from('message_log').insert(logRows); } catch (e) { console.error('message_log insert failed:', (e as Error).message); }
    try {
      await sb.from('activity_events').insert([{
        actor_id: worker.id, actor_name: worker.name, verb: 'notified', object_type: objectType, object_id: id,
        client_id: null, site_id: siteId,
        after: { kind, sms: smsSent, email: emailSent, sms_targets: smsTargets.length, email_targets: emailTargets.length, text: smsText },
      }]);
    } catch (e) { console.error('activity_events insert failed:', (e as Error).message); }

    return json({ ok: true, sms: smsSent, email: emailSent, bell });
  } catch (e) {
    console.error('notify-admins-ops failed:', (e as Error)?.message);
    return json({ error: 'server_error' }, 500);
  }
});
