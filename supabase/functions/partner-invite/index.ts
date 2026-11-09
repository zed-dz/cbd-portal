// partner-invite — office-gated. Creates the auth user for a sales partner and
// e-mails them the portal's set-password link (2026-11-09).
//
// verify_jwt = true. Caller must be office (workers.role = 'admin' or a money
// access level) — same test as send-invite's gate. Internal callers may pass
// the service-role key.
//
// POST { partner_id: uuid }
//  →  200 { ok: true, via, email, already_existed }
//     400 invalid_json | invalid_partner_id · 401/403 gate · 404 partner_not_found
//     502 email_failed (the auth user still exists: "Resend invite" tries again)
//
// Flow: generateLink(type 'invite') creates the auth user and returns a
// one-click link; for an address that already has an account it falls back to
// a 'magiclink'. Both land on the portal with #type=invite|magiclink, which
// App.jsx turns into the Set-password screen. Email goes Resend → Gmail
// fallback like every other transactional send here. Every attempt is logged
// to message_log; the partner row gets invite_sent_at + auth_user_id.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PORTAL_URL           = Deno.env.get('PORTAL_URL') || 'https://portal.cbdpnl.com.au';
const SENDER_DISPLAY_NAME  = Deno.env.get('GMAIL_SENDER_NAME') || 'CBD Plant & Labour';
const GMAIL_CLIENT_ID      = Deno.env.get('GMAIL_CLIENT_ID') || '';
const GMAIL_CLIENT_SECRET  = Deno.env.get('GMAIL_CLIENT_SECRET') || '';
const RESEND_API_KEY       = Deno.env.get('RESEND_API_KEY') || '';
const MAIL_FROM            = Deno.env.get('MAIL_FROM') || '';
const RESEND_ON            = !!(RESEND_API_KEY && MAIL_FROM);
const BRAND_SHORT          = Deno.env.get('BRAND_SHORT') || 'CBD';
const BRAND_FOOTER         = Deno.env.get('BRAND_FOOTER') || 'CBD PLANT &amp; LABOUR · ABN 75 663 693 070<br>ROAD · RAIL · WATER';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// ── caller gate (copied from send-invite) ────────────────────────────────────
async function gateCaller(req: Request) {
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return { ok: false as const, status: 401, error: 'unauthorized' };
  if (bearer === SUPABASE_SERVICE_KEY) return { ok: true as const, worker: null };
  const { data: { user }, error } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY).auth.getUser(bearer);
  if (error || !user?.email) return { ok: false as const, status: 401, error: 'unauthorized' };
  const { data: w } = await createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY).from('workers')
    .select('id, name, role, access_level').eq('email', user.email.toLowerCase()).is('archived_at', null).maybeSingle();
  const money  = !!w && ['admin', 'accounts'].includes(w.access_level || '');
  const office = money || (!!w && w.role === 'admin');
  if (!office) return { ok: false as const, status: 403, error: 'office_only' };
  return { ok: true as const, worker: w };
}

// ── email delivery: Resend → Gmail (copied from notify-worker) ───────────────
async function sendViaResend(opts: { to: string; subject: string; text: string; html: string }) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [opts.to], subject: opts.subject, text: opts.text, html: opts.html }),
    });
    return { ok: res.ok, detail: res.ok ? '' : (await res.text()).slice(0, 300) };
  } catch (e) { return { ok: false, detail: (e as Error).message }; }
}
function b64url(s: string) { const bytes = new TextEncoder().encode(s); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function encodeHeader(v: string) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(v)) return v;
  const bytes = new TextEncoder().encode(v); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return `=?UTF-8?B?${btoa(bin)}?=`;
}
function buildMime(o: { from: string; to: string; subject: string; text: string; html: string }) {
  const boundary = `pt_${crypto.randomUUID().replace(/-/g, '')}`;
  const b64 = (s: string) => { const bytes = new TextEncoder().encode(s); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin).replace(/(.{76})/g, '$1\r\n'); };
  return [`From: ${o.from}`, `To: ${o.to}`, `Subject: ${encodeHeader(o.subject)}`, 'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64(o.text), '',
    `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64(o.html), '', `--${boundary}--`].join('\r\n');
}
async function getGmail(sb: ReturnType<typeof createClient>) {
  try {
    const { data: row } = await sb.from('gmail_tokens').select('*').eq('id', 1).maybeSingle();
    if (!row) return null;
    if (new Date(row.expires_at).getTime() >= Date.now() + 30_000) return { accessToken: row.access_token, emailAddress: row.email_address };
    if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) return null;
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_CLIENT_SECRET, refresh_token: row.refresh_token, grant_type: 'refresh_token' }) });
    if (!r.ok) return null;
    const t = await r.json();
    await sb.from('gmail_tokens').update({ access_token: t.access_token, expires_at: new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString(), updated_at: new Date().toISOString() }).eq('id', 1);
    return { accessToken: t.access_token, emailAddress: row.email_address };
  } catch { return null; }
}
async function deliverEmail(sb: ReturnType<typeof createClient>, o: { to: string; subject: string; text: string; html: string }) {
  if (RESEND_ON) {
    const r = await sendViaResend(o);
    if (r.ok) return { ok: true, via: 'resend', detail: '' };
    const g = await getGmail(sb);
    if (!g) return { ok: false, via: 'resend', detail: r.detail };
    const mime = buildMime({ from: `"${SENDER_DISPLAY_NAME.replace(/"/g, '')}" <${g.emailAddress}>`, ...o });
    const gr = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: `Bearer ${g.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: b64url(mime) }) });
    return gr.ok ? { ok: true, via: 'gmail-fallback', detail: '' } : { ok: false, via: 'both-failed', detail: `resend: ${r.detail} | gmail: ${(await gr.text()).slice(0, 200)}` };
  }
  const g = await getGmail(sb);
  if (!g) return { ok: false, via: 'none', detail: 'no sender configured' };
  const mime = buildMime({ from: `"${SENDER_DISPLAY_NAME.replace(/"/g, '')}" <${g.emailAddress}>`, ...o });
  const gr = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: `Bearer ${g.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: b64url(mime) }) });
  return { ok: gr.ok, via: 'gmail', detail: gr.ok ? '' : (await gr.text()).slice(0, 200) };
}

function isDuplicate(err: { message?: string; code?: string } | null | undefined) {
  if (!err) return false;
  const code = String((err as { code?: string }).code || '').toLowerCase();
  const msg  = String(err.message || '').toLowerCase();
  return code === 'email_exists' || code === 'user_already_exists' || /already (been )?registered|already exists|duplicate key/.test(msg);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);
  try {
    const gate = await gateCaller(req);
    if (!gate.ok) return json({ error: gate.error }, gate.status);

    let body: { partner_id?: string } = {};
    try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const partnerId = String(body.partner_id || '').trim();
    if (!UUID_RE.test(partnerId)) return json({ error: 'invalid_partner_id' }, 400);

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: partner } = await sb.from('sales_partners').select('id, name, email, status, archived_at, auth_user_id').eq('id', partnerId).maybeSingle();
    if (!partner || partner.archived_at || partner.status === 'archived') return json({ error: 'partner_not_found' }, 404);
    const email = String(partner.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'partner_has_no_email' }, 400);

    // Mint the link. 'invite' creates the auth user; an existing account gets a magic link instead.
    let link = ''; let authUserId: string | null = partner.auth_user_id || null; let alreadyExisted = false;
    const meta = { partner_id: partner.id, partner_name: partner.name, portal_role: 'sales_partner' };
    const inv = await sb.auth.admin.generateLink({ type: 'invite', email, options: { redirectTo: PORTAL_URL, data: meta } });
    if (!inv.error) {
      link = (inv.data as any)?.properties?.action_link || '';
      authUserId = (inv.data as any)?.user?.id || authUserId;
    } else if (isDuplicate(inv.error)) {
      alreadyExisted = true;
      const ml = await sb.auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo: PORTAL_URL } });
      if (ml.error) return json({ error: 'link_failed', detail: ml.error.message }, 500);
      link = (ml.data as any)?.properties?.action_link || '';
      authUserId = (ml.data as any)?.user?.id || authUserId;
    } else {
      return json({ error: 'link_failed', detail: inv.error.message }, 500);
    }
    if (!link) return json({ error: 'link_failed', detail: 'no action_link returned' }, 500);

    const firstName = (partner.name || '').split(/\s+/)[0] || 'there';
    const subject = `Your ${SENDER_DISPLAY_NAME} sales partner login`;
    const text = `Hi ${firstName},\n\nYou're set up as a sales partner with ${SENDER_DISPLAY_NAME}. Open the link below, choose a password, then fill in your profile (ABN, bank details for payouts) and start referring work.\n\n${link}\n\nThe link works once and expires in 24 hours. If it has expired, go to ${PORTAL_URL}, enter your email and tap "Forgot your password?" for a fresh one.\n\n—\n${SENDER_DISPLAY_NAME}`;
    const html = `<!doctype html><html><body style="margin:0;padding:0;background:#0b0e14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0e14;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#11151e;border:1px solid #222838;border-radius:14px;padding:32px;"><tr><td>
<div style="font-size:28px;font-weight:800;color:#f97316;letter-spacing:-0.5px;line-height:1;">${escapeHtml(BRAND_SHORT)}</div>
<div style="font-size:10px;color:#8a92a8;letter-spacing:2.5px;text-transform:uppercase;margin-top:4px;margin-bottom:24px;font-weight:600;">Sales partner portal</div>
<h1 style="color:#eef0f6;font-size:20px;margin:0 0 14px 0;font-weight:700;">Hi ${escapeHtml(firstName)},</h1>
<p style="color:#eef0f6;font-size:14.5px;line-height:1.6;margin:0 0 18px 0;">You're set up as a sales partner with ${escapeHtml(SENDER_DISPLAY_NAME)}. Tap the button, choose a password, then fill in your profile (ABN, bank details for payouts) and start referring work.</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td><a href="${link}" style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 28px;border-radius:8px;">Set my password →</a></td></tr></table>
<p style="color:#8a92a8;font-size:12px;line-height:1.55;margin:24px 0 0 0;">The link works once and expires in 24 hours. Expired? Go to <a href="${PORTAL_URL}" style="color:#f97316;">${PORTAL_URL}</a>, enter your email and tap “Forgot your password?”.</p>
<hr style="border:none;border-top:1px solid #222838;margin:24px 0 14px 0;">
<p style="color:#8a92a8;font-size:11px;line-height:1.5;margin:0;font-family:'SF Mono',Consolas,monospace;letter-spacing:0.5px;">${BRAND_FOOTER}</p>
</td></tr></table></td></tr></table></body></html>`;

    const d = await deliverEmail(sb, { to: email, subject, text, html });

    try {
      await sb.from('message_log').insert([{ batch_id: crypto.randomUUID(), channel: 'email', audience: 'partner', recipient_id: partner.id, recipient_name: partner.name,
        recipient_email: email, subject, body: `Sales partner invite (${alreadyExisted ? 'existing account' : 'new account'})`, status: d.ok ? 'sent' : 'failed', error: d.ok ? null : d.detail.slice(0, 200), sent_by: gate.worker?.id || null }]);
    } catch (e) { console.error('message_log insert failed:', (e as Error).message); }
    try {
      await sb.from('activity_events').insert([{ actor_id: gate.worker?.id || null, actor_name: gate.worker?.name || 'System', verb: d.ok ? 'invited' : 'invite_failed', object_type: 'sales_partner', object_id: partner.id,
        after: { name: partner.name, email, via: d.via, already_existed: alreadyExisted } }]);
    } catch (e) { console.error('activity_events insert failed:', (e as Error).message); }

    const upd: Record<string, unknown> = { auth_user_id: authUserId };
    if (d.ok) { upd.invite_sent_at = new Date().toISOString(); if (partner.status !== 'active') upd.status = 'invited'; }
    await sb.from('sales_partners').update(upd).eq('id', partner.id);

    if (!d.ok) return json({ ok: false, error: 'email_failed', detail: d.detail, via: d.via }, 502);
    return json({ ok: true, via: d.via, email, already_existed: alreadyExisted });
  } catch (e) {
    console.error('partner-invite failed:', (e as Error)?.message);
    return json({ error: 'server_error', detail: String((e as Error)?.message || e) }, 500);
  }
});
