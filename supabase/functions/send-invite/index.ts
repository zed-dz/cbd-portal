// Sends a worker onboarding invite email.
//
// GOOGLE (Gmail) ONLY — no third-party email provider. Fully self-contained: it
// reads the connected team account from `gmail_tokens` (id=1), refreshes the
// OAuth access token at oauth2.googleapis.com/token when needed, and sends the
// invite as RAW MIME via gmail.googleapis.com messages.send — exactly the same
// pattern as send-daily-digest. Because it self-contains the OAuth refresh it
// does NOT depend on a forwarded user JWT to reach Gmail.
//
// If Gmail isn't connected it returns { gmail_not_connected } gracefully — it
// never falls back to any other provider.
//
// Request body:
//   { worker_id: UUID }          — send the real invite to that worker
//   { test: true, to: "addr" }   — probe send to confirm the Gmail path

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GMAIL_CLIENT_ID      = Deno.env.get('GMAIL_CLIENT_ID')  || '';
const GMAIL_CLIENT_SECRET  = Deno.env.get('GMAIL_CLIENT_SECRET') || '';
const SENDER_DISPLAY_NAME  = Deno.env.get('GMAIL_SENDER_NAME') || 'CBD Plant & Labour';
const PORTAL_URL           = Deno.env.get('PORTAL_URL')  || 'https://cbd-portal-gray.vercel.app';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// base64url encoding required by the Gmail API.
function b64url(s: string) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// RFC 2047 encoded-word for non-ASCII header values.
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
  const encoded  = encodeHeader(safeName);
  return /^[\x00-\x7F]*$/.test(safeName) ? `"${safeName}" <${email}>` : `${encoded} <${email}>`;
}

// Refresh the Gmail access token if it's expired. Mirrors send-daily-digest.
async function getValidAccessToken(supa: ReturnType<typeof createClient>) {
  const { data: row, error } = await supa.from('gmail_tokens').select('*').eq('id', 1).maybeSingle();
  if (error || !row) throw new Error('gmail_not_connected');

  const expired = new Date(row.expires_at).getTime() < Date.now() + 30_000;
  if (!expired) return { accessToken: row.access_token, emailAddress: row.email_address };

  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) throw new Error('gmail_not_configured');

  const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: row.refresh_token,
      grant_type:    'refresh_token',
    }),
  });
  if (!refreshRes.ok) {
    const detail = await refreshRes.text();
    console.error('token refresh failed:', detail);
    throw new Error('gmail_refresh_failed');
  }
  const t = await refreshRes.json();
  const newExpires = new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString();
  await supa.from('gmail_tokens').update({
    access_token: t.access_token,
    expires_at:   newExpires,
    updated_at:   new Date().toISOString(),
  }).eq('id', 1);
  return { accessToken: t.access_token, emailAddress: row.email_address };
}

function buildMime(opts: { from: string; to: string; subject: string; text: string; html: string }) {
  const boundary = `cbd_${crypto.randomUUID().replace(/-/g, '')}`;
  const headers = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${encodeHeader(opts.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const b64 = (s: string) => {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/(.{76})/g, '$1\r\n');
  };
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64', '', b64(opts.text), '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64', '', b64(opts.html), '',
    `--${boundary}--`,
  ].join('\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

async function sendViaGmail(accessToken: string, mime: string) {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: b64url(mime) }),
  });
  const ok = res.ok;
  const detail = ok ? '' : (await res.text()).slice(0, 300);
  return { ok, status: res.status, detail };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  let body: { worker_id?: string; test?: boolean; to?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Resolve the Gmail account up front — GOOGLE ONLY, never a fallback provider.
  let accessToken: string;
  let fromEmail: string | null;
  try {
    const t = await getValidAccessToken(sb);
    accessToken = t.accessToken;
    fromEmail   = t.emailAddress;
  } catch (e) {
    const msg = (e as Error).message;
    return json({ ok: false, via: 'gmail', error: msg }, msg === 'gmail_not_connected' ? 412 : 500);
  }
  if (!fromEmail) return json({ ok: false, via: 'gmail', error: 'no_from_address' }, 500);
  const fromHeader = formatFromHeader(SENDER_DISPLAY_NAME, fromEmail);

  // ── Probe mode: confirm the Gmail path without touching a real worker ──────
  if (body.test) {
    const to = (body.to || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json({ ok: false, error: 'test mode needs a valid `to`' }, 400);
    const subject = 'CBD invite path — test send (via Gmail)';
    const text = `This is a test of the worker invite email path. It was sent via Gmail (Google) — the only email sender.\n\n— ${SENDER_DISPLAY_NAME}`;
    const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14.5px;line-height:1.6;color:#1a1a1a">${escapeHtml(text).replace(/\n/g, '<br>')}</body></html>`;
    const r = await sendViaGmail(accessToken, buildMime({ from: fromHeader, to, subject, text, html }));
    return json({ ok: r.ok, via: 'gmail', to, detail: r.detail || undefined }, r.ok ? 200 : 502);
  }

  const workerId = body.worker_id;
  if (!workerId || !/^[0-9a-f-]{36}$/i.test(workerId)) return json({ error: 'invalid_worker_id' }, 400);

  const { data: worker, error } = await sb.from('workers').select('id, name, email, profile_token, app_status').eq('id', workerId).maybeSingle();
  if (error)         return json({ error: 'db_error', detail: error.message }, 500);
  if (!worker)       return json({ error: 'worker_not_found' }, 404);
  if (!worker.email) return json({ error: 'worker_has_no_email' }, 400);
  if (!worker.profile_token) return json({ error: 'worker_missing_token' }, 500);

  const inviteUrl = `${PORTAL_URL}/onboard/${worker.profile_token}`;
  const firstName = (worker.name || '').split(' ')[0] || 'there';
  const subject   = `Welcome to CBD Plant & Labour — finish your profile`;

  const plainText = `G'day ${firstName},

You've been added to the CBD Plant & Labour worker portal. To get on a job, we need a few details from you — mobile number, address, and your tickets/licences.

Complete your profile here:
${inviteUrl}

Takes about a minute.

—
CBD Plant & Labour
ABN 75 663 693 070`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#0d0f14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d0f14;padding:32px 16px;"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#131620;border:1px solid #2a2f40;border-radius:14px;padding:32px;"><tr><td><div style="font-size:30px;font-weight:800;color:#f97316;letter-spacing:-0.5px;">CBD</div><div style="font-size:11px;color:#8b90a8;letter-spacing:2px;text-transform:uppercase;margin-top:2px;margin-bottom:24px;">Plant &amp; Labour</div><h1 style="color:#e8eaf2;font-size:22px;margin:0 0 12px 0;font-weight:700;">G'day ${escapeHtml(firstName)},</h1><p style="color:#e8eaf2;font-size:15px;line-height:1.55;margin:0 0 16px 0;">You've been added to the CBD Plant &amp; Labour worker portal. To get on a job, we just need a few details from you — mobile number, address, and your tickets/licences.</p><p style="color:#8b90a8;font-size:14px;line-height:1.55;margin:0 0 28px 0;">Tap the button below to fill out your profile. It takes about a minute.</p><table role="presentation" cellpadding="0" cellspacing="0"><tr><td><a href="${inviteUrl}" style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 28px;border-radius:8px;">Complete my profile →</a></td></tr></table><p style="color:#8b90a8;font-size:12px;line-height:1.55;margin:28px 0 0 0;">Or copy this link into your browser:<br><a href="${inviteUrl}" style="color:#f97316;word-break:break-all;">${inviteUrl}</a></p><hr style="border:none;border-top:1px solid #2a2f40;margin:28px 0 16px 0;"><p style="color:#8b90a8;font-size:11px;line-height:1.5;margin:0;font-family:'SF Mono',Consolas,monospace;">CBD PLANT &amp; LABOUR · ABN 75 663 693 070<br>ROAD · RAIL · WATER</p></td></tr></table></td></tr></table></body></html>`;

  const r = await sendViaGmail(accessToken, buildMime({ from: fromHeader, to: worker.email, subject, text: plainText, html }));

  // Log every attempt — success AND failure. Without this there was no record
  // that an invite had been sent at all, so "I clicked Send Email and nothing
  // happened" was unanswerable (2026-08-04). Never let logging break the send.
  try {
    await sb.from('message_log').insert([{
      channel:         'gmail',
      audience:        'worker',
      recipient_id:    worker.id,
      recipient_name:  worker.name,
      recipient_email: worker.email,
      subject,
      status:          r.ok ? 'sent' : 'failed',
      error:           r.ok ? null : (r.detail || `gmail_status_${r.status}`),
      sent_at:         new Date().toISOString(),
    }]);
  } catch (_) { /* logging must never block delivery */ }

  if (!r.ok) {
    console.error('gmail send failed', r.status, r.detail);
    return json({ error: 'gmail_send_failed', detail: r.detail }, 502);
  }

  await sb.from('workers').update({
    profile_invite_sent_at: new Date().toISOString(),
    app_status: worker.app_status === 'Active' ? 'Invite Sent' : worker.app_status,
  }).eq('id', workerId);

  return json({ ok: true, via: 'gmail', email: worker.email, invite_url: inviteUrl });
});
