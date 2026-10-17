// send-signoff-request — server-side "send this timesheet to the site
// supervisor for sign-off". Replaces the client-side chain in
// src/utils/clientApproval.js, which (a) only looked at the project / client
// head-office contact and ignored the SITE's contacts and the allocation's
// supervisor, and (b) ran from the worker's phone, where the office-gated
// send-sms / send-bulk-email functions now refuse it — so nothing went out and
// nobody was told (Nick → Zeff, Appin, Oct 2026).
//
// verify_jwt = true. Caller = the sheet's own worker, or any office user, or
// an internal caller with the service key.
//
// POST { header_id: uuid, force?: boolean }
// 200 { ok: true, sentTo: 'Zeff Lunam — SMS +61…, email …', contact_source }
// 200 { ok: false, error, alreadySent?: true }   (soft failures, so the UI toasts)
// 401 / 403 / 404 as usual.
//
// Supervisor lookup order (first with an email or phone wins):
//   1. the sheet's site (site_id, else site name within the client): contacts
//      flagged approves_timesheets, then is_primary, then any
//   2. the worker's allocation covering the sheet's first day at that client/site:
//      site_manager + manager_phone (what the allocator typed)
//   3. the client's project (client_jobs) site contact
//   4. the client's head-office contact
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
    const authHeader = req.headers.get('Authorization') || '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!jwt) return json({ error: 'unauthorized' }, 401);
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Who is calling?
    let callerWorkerId: string | null = null;
    let callerName = 'portal';
    let office = false;
    if (jwt === SUPABASE_SERVICE_KEY) {
      office = true; callerName = 'system';
    } else {
      const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      const { data: userData, error: userErr } = await anon.auth.getUser(jwt);
      const email = (userData?.user?.email || '').trim().toLowerCase();
      if (userErr || !email) return json({ error: 'unauthorized' }, 401);
      let { data: worker } = await sb.from('workers').select('id, name, email, role, access_level, archived_at').eq('email', email).maybeSingle();
      if (!worker) {
        const pattern = email.replace(/[\\%_]/g, (m: string) => `\\${m}`);
        const { data: alt } = await sb.from('workers').select('id, name, email, role, access_level, archived_at').ilike('email', pattern).limit(2);
        worker = (alt || []).find((w: any) => String(w.email || '').trim().toLowerCase() === email) || null;
      }
      if (!worker || worker.archived_at) return json({ error: 'not_a_worker' }, 403);
      callerWorkerId = worker.id; callerName = worker.name || email;
      office = worker.role === 'admin' || ['admin', 'accounts'].includes(String(worker.access_level || ''));
    }

    let body: { header_id?: string; force?: boolean } = {};
    try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const headerId = String(body.header_id || '').trim();
    const force = !!body.force;
    if (!UUID_RE.test(headerId)) return json({ error: 'invalid_header_id' }, 400);

    const { data: h } = await sb.from('timesheet_headers')
      .select('id, worker_id, client, project, status, client_approval_token, client_approved, client_approval_sent_at, total_hours, client_id, site_id, site_name_snapshot, workers(name)')
      .eq('id', headerId).maybeSingle();
    if (!h) return json({ error: 'timesheet_not_found' }, 404);
    if (!office && h.worker_id !== callerWorkerId) return json({ error: 'not_your_timesheet' }, 403);

    if (h.client_approved) return json({ ok: false, error: 'already accepted by the client' });
    if (h.status === 'rejected') return json({ ok: false, error: 'timesheet was rejected' });
    if (h.client_approval_sent_at && !force) return json({ ok: false, error: 'already sent', alreadySent: true });

    let token: string = h.client_approval_token || '';
    if (!token) {
      token = crypto.randomUUID();
      await sb.from('timesheet_headers').update({ client_approval_token: token }).eq('id', h.id);
    }

    const workerName = (h as any).workers?.name || 'our worker';
    const clientName = String(h.client || '').trim();
    const siteName = String(h.site_name_snapshot || h.project || '').trim();

    // Resolve the client row (id first, else by exact name).
    let clientRow: any = null;
    if (h.client_id) ({ data: clientRow } = await sb.from('clients').select('id, name, contact, contact_email, contact_phone').eq('id', h.client_id).maybeSingle());
    if (!clientRow && clientName) {
      const { data: cs } = await sb.from('clients').select('id, name, contact, contact_email, contact_phone').ilike('name', clientName.replace(/[\\%_]/g, (m: string) => `\\${m}`)).limit(1);
      clientRow = cs?.[0] || null;
    }

    // Resolve the site row (id first, else by name within the client).
    let siteId: string | null = h.site_id || null;
    if (!siteId && clientRow && siteName) {
      const { data: ss } = await sb.from('client_sites').select('id').eq('client_id', clientRow.id).ilike('name', siteName.replace(/[\\%_]/g, (m: string) => `\\${m}`)).limit(1);
      siteId = ss?.[0]?.id || null;
    }

    type Contact = { name: string; email: string | null; phone: string | null; source: string };
    const clean = (s: unknown) => String(s || '').trim() || null;
    let contact: Contact | null = null;

    // 1. Site contacts
    if (siteId) {
      const { data: ks } = await sb.from('client_site_contacts').select('name, email, phone, is_primary, approves_timesheets').eq('site_id', siteId);
      const usable = (ks || []).filter((k: any) => clean(k.email) || clean(k.phone));
      const pick = usable.find((k: any) => k.approves_timesheets) || usable.find((k: any) => k.is_primary) || usable[0];
      if (pick) contact = { name: pick.name || 'Site Supervisor', email: clean(pick.email), phone: clean(pick.phone), source: 'site contact' };
    }
    // 2. The worker's allocation for this job (what the allocator typed as supervisor)
    if (!contact) {
      const { data: firstLine } = await sb.from('timesheets').select('date').eq('header_id', h.id).order('date').limit(1);
      const day = firstLine?.[0]?.date || null;
      let q = sb.from('allocations').select('site_manager, manager_phone, start_date, end_date, site, client, site_id')
        .eq('worker_id', h.worker_id).not('manager_phone', 'is', null).order('start_date', { ascending: false }).limit(20);
      if (day) q = q.lte('start_date', day);
      const { data: allocs } = await q;
      const match = (allocs || []).find((a: any) =>
        (siteId && a.site_id === siteId) ||
        (siteName && String(a.site || '').trim().toLowerCase() === siteName.toLowerCase()) ||
        (clientName && String(a.client || '').trim().toLowerCase() === clientName.toLowerCase()));
      const a = match || (allocs || [])[0];
      if (a && (clean(a.manager_phone) || clean(a.site_manager))) {
        contact = { name: clean(a.site_manager) || 'Site Supervisor', email: null, phone: clean(a.manager_phone), source: 'allocation supervisor' };
        // If that name is one of our own people, use their email too.
        const { data: own } = await sb.from('workers').select('email').is('archived_at', null).ilike('name', `${String(a.site_manager || '').trim().split(' ')[0]}%`).limit(1);
        if (own?.[0]?.email && clean(a.site_manager)) contact.email = own[0].email;
      }
    }
    // 3. Project site contact
    if (!contact && clientRow && siteName) {
      const { data: jobs } = await sb.from('client_jobs').select('site_contact_name, site_contact_email, site_contact_phone').eq('client_id', clientRow.id).ilike('name', siteName.replace(/[\\%_]/g, (m: string) => `\\${m}`)).limit(1);
      const job = jobs?.[0];
      if (job && (clean(job.site_contact_email) || clean(job.site_contact_phone))) contact = { name: job.site_contact_name || 'Site Supervisor', email: clean(job.site_contact_email), phone: clean(job.site_contact_phone), source: 'project contact' };
    }
    // 4. Client head office
    if (!contact && clientRow && (clean(clientRow.contact_email) || clean(clientRow.contact_phone))) {
      contact = { name: clientRow.contact || 'Site Supervisor', email: clean(clientRow.contact_email), phone: clean(clientRow.contact_phone), source: 'client contact' };
    }

    const bell = async (type: string, title: string, bodyTxt: string) => {
      try { await sb.from('notifications').insert([{ type, title, body: bodyTxt, worker_id: h.worker_id }]); } catch (e) { console.error('bell failed', (e as Error).message); }
    };

    if (!contact) {
      const err = `no site-supervisor contact on file for ${clientName || 'this client'}${siteName ? ` / ${siteName}` : ''} — add one under Clients & Rates → Manage sites`;
      await bell('timesheet_signoff_blocked', `Supervisor sign-off NOT sent — ${workerName} / ${clientName || 'client'}`, err);
      return json({ ok: false, error: err });
    }

    const link  = `${PORTAL_URL}/approve-ts/${token}`;
    const hours = h.total_hours ? ` (${Number(h.total_hours).toFixed(2)}h)` : '';
    const label = `${workerName} — ${siteName || clientName}${hours}`;
    const sentVia: string[] = [];
    const failures: string[] = [];
    const batchId = crypto.randomUUID();   // message_log.batch_id is NOT NULL; sent_by is a worker uuid

    if (contact.email) {
      const subject = `Timesheet approval requested — ${label}`;
      const lines = [
        `Hi ${contact.name},`, '',
        `Please review and accept the timesheet for ${label}.`, '',
        `Open it here (no login needed): ${link}`, '',
        'Once you accept, the hours are finalised for invoicing. If we do not hear back within 7 days, the hours are finalised automatically.', '',
        'Thanks!',
      ];
      const r = await deliverEmail(sb, { tried: false }, { to: contact.email, subject, text: lines.join('\n'), html: renderHtml(subject, lines) });
      if (r.ok) sentVia.push(`email ${contact.email}`); else failures.push(`email: ${r.detail || r.via}`);
      try { await sb.from('message_log').insert([{ channel: 'email', audience: 'client', recipient_name: contact.name, recipient_email: contact.email, subject, body: lines.join('\n'), status: r.ok ? 'sent' : 'failed', error: r.ok ? null : (r.detail || r.via).slice(0, 300), sent_by: callerWorkerId, batch_id: batchId }]); } catch { /* log only */ }
    }
    if (contact.phone) {
      const to = normaliseAUMobile(contact.phone);
      if (to) {
        const cfg = await loadTwilioConfig(sb);
        if (twilioReady(cfg)) {
          const text = `Timesheet approval: ${label}. Review & accept: ${link} (auto-finalises in 7 days)`;
          const r = await sendSms(cfg, to, text);
          if (r.ok) sentVia.push(`SMS ${to}`); else failures.push(`sms: ${r.error}`);
          try { await sb.from('message_log').insert([{ channel: 'sms', audience: 'client', recipient_name: contact.name, recipient_email: to, body: text, status: r.ok ? 'sent' : 'failed', error: r.ok ? null : String(r.error).slice(0, 300), sent_by: callerWorkerId, batch_id: batchId }]); } catch { /* log only */ }
        } else failures.push('sms: Twilio not configured');
      }
    }

    if (!sentVia.length) {
      const err = `send failed on every channel (${failures.join('; ') || 'no usable email or phone'})`;
      await bell('timesheet_signoff_blocked', `Supervisor sign-off NOT sent — ${workerName} / ${clientName || 'client'}`, `${contact.name} (${contact.source}): ${err}`);
      return json({ ok: false, error: err });
    }

    await sb.from('timesheet_headers').update({
      client_approval_sent_at: new Date().toISOString(),
      client_approval_sent_to: `${contact.name} (${sentVia.join(', ')})`,
    }).eq('id', h.id);
    await bell('timesheet_signoff_sent', `Sign-off sent to ${contact.name} — ${workerName} / ${siteName || clientName}`, `${sentVia.join(' + ')} · ${contact.source}${failures.length ? ` · not sent by ${failures.join('; ')}` : ''}`);
    try {
      await sb.from('activity_events').insert([{ actor_id: callerWorkerId, actor_name: callerName, verb: 'sent for sign-off', object_type: 'timesheet_header', object_id: h.id, client_id: clientRow?.id || null, site_id: siteId,
        after: { to: contact.name, via: sentVia, source: contact.source, worker: workerName, client: clientName, site: siteName } }]);
    } catch { /* log only */ }

    return json({ ok: true, sentTo: `${contact.name} — ${sentVia.join(' + ')}`, contact_source: contact.source, not_sent: failures });
  } catch (e) {
    console.error('send-signoff-request failed:', (e as Error).message);
    return json({ error: 'server_error' }, 500);
  }
});
