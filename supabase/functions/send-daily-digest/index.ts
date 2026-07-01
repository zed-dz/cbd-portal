// Daily allocation digest.
//
// Triggered once a day by pg_cron (via pg_net). For each admin who chose
// "daily_digest" mode with the Email channel on, this emails a single summary
// of the day's allocation events (new / accepted / declined) instead of the
// per-event emails those admins have opted out of.
//
// Runs with verify_jwt=false and is guarded by a shared DIGEST_SECRET header so
// only the cron job (which knows the secret) can trigger it.
//
// Email goes via the connected **Gmail** account only — GOOGLE ONLY, no Resend.
// Because a cron context has no user JWT it can't call the verify_jwt-protected
// `gmail-send` function, so it self-contains the OAuth refresh + Gmail API send
// using the stored refresh token in `gmail_tokens` (id=1), exactly like the
// gmail-send path. If Gmail isn't connected it returns { gmail_not_connected }
// gracefully rather than falling back to any other provider.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GMAIL_CLIENT_ID     = Deno.env.get('GMAIL_CLIENT_ID')  || '';
const GMAIL_CLIENT_SECRET = Deno.env.get('GMAIL_CLIENT_SECRET') || '';
const SENDER_DISPLAY_NAME = Deno.env.get('GMAIL_SENDER_NAME') || 'CBD Plant & Labour';
const DIGEST_SECRET  = Deno.env.get('DIGEST_SECRET') || '';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-digest-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
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

// RFC 2047 encoded-word for non-ASCII header values. ASCII passes through so
// chars like — survive Gmail's strict header parser.
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

// Refresh the Gmail access token if it's expired. Mirrors gmail-send.
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

function buildMime(opts: { from: string; to: string; subject: string; text: string }) {
  const safeHtml = escapeHtml(opts.text).replace(/\n/g, '<br>');
  const boundary = `cbd_${crypto.randomUUID().replace(/-/g, '')}`;
  const headers = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${encodeHeader(opts.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14.5px;line-height:1.6;color:#1a1a1a">${safeHtml}</body></html>`;
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
    'Content-Transfer-Encoding: base64', '', b64(html), '',
    `--${boundary}--`,
  ].join('\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (DIGEST_SECRET && req.headers.get('x-digest-secret') !== DIGEST_SECRET) return json({ error: 'unauthorized' }, 401);

  const supa = createClient(SUPABASE_URL, SERVICE_KEY);

  // Optional test mode: { test: true, to?: "addr" } sends one probe email so we
  // can confirm the Gmail path end-to-end without waiting for real events.
  let reqBody: { test?: boolean; to?: string } = {};
  try { reqBody = await req.json(); } catch { /* empty body from cron */ }

  // Last 24h of allocation events.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: events } = await supa
    .from('notifications')
    .select('type, title, body, created_at')
    .like('type', 'allocation%')
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  const list = events || [];

  const { data: admins } = await supa
    .from('workers')
    .select('name, email, access_level, notify_mode, notify_email')
    .eq('access_level', 'admin');
  let recipients = (admins || []).filter((a: any) =>
    (a.notify_mode || 'per_event') === 'daily_digest' &&
    a.notify_email !== false &&
    a.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email)
  ).map((a: any) => ({ name: a.name, email: a.email }));

  let subject: string;
  let text: string;

  if (reqBody.test) {
    // Probe send — bypass the digest-mode roster and event window.
    const to = (reqBody.to || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json({ ok: false, error: 'test mode needs a valid `to`' }, 400);
    recipients = [{ name: 'Test', email: to }];
    subject = 'Daily allocation digest — test send (via Gmail)';
    text = `This is a test of the daily allocation digest. It was sent via Gmail (Google), not Resend.\n\nEvents in the last 24h: ${list.length}.\n\n— ${SENDER_DISPLAY_NAME}`;
  } else {
    if (!recipients.length) return json({ ok: true, via: 'gmail', sent: 0, note: 'no digest-mode admins', events: list.length });
    if (!list.length)       return json({ ok: true, via: 'gmail', sent: 0, note: 'no allocation events in the last 24h' });
    const lines = list.map((e: any) => `• ${e.title || e.type}${e.body ? ` — ${e.body}` : ''}`).join('\n');
    subject = `Daily allocation digest — ${list.length} event${list.length === 1 ? '' : 's'}`;
    text    = `Here's a summary of the last day's allocation activity:\n\n${lines}\n\n— ${SENDER_DISPLAY_NAME}`;
  }

  // ── Gmail (Google) only — no Resend fallback ─────────────────────────────
  let accessToken: string;
  let fromEmail:   string | null;
  try {
    const t = await getValidAccessToken(supa);
    accessToken = t.accessToken;
    fromEmail   = t.emailAddress;
  } catch (e) {
    const msg = (e as Error).message;
    // Gmail not connected/configured — surface it, but never fall back off Google.
    return json({ ok: false, via: 'gmail', error: msg, recipients: recipients.length }, msg === 'gmail_not_connected' ? 412 : 500);
  }
  if (!fromEmail) return json({ ok: false, via: 'gmail', error: 'no_from_address' }, 500);

  const fromHeader = formatFromHeader(SENDER_DISPLAY_NAME, fromEmail);
  let sent = 0;
  const results: Array<{ email: string; ok: boolean; error?: string }> = [];
  const logRows: any[] = [];
  for (const r of recipients) {
    try {
      const mime = buildMime({ from: fromHeader, to: r.email, subject, text });
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: b64url(mime) }),
      });
      const ok = res.ok;
      if (ok) sent++;
      let err: string | undefined;
      if (!ok) err = (await res.text()).slice(0, 200);
      results.push({ email: r.email, ok, error: err });
      logRows.push({
        batch_id: crypto.randomUUID(), channel: 'gmail', audience: null,
        recipient_email: r.email, subject, body: text,
        status: ok ? 'sent' : 'failed', error: err || null,
      });
    } catch (e) {
      results.push({ email: r.email, ok: false, error: (e as Error).message });
    }
  }

  // Audit log (best-effort).
  try { if (logRows.length) await supa.from('message_log').insert(logRows); } catch (e) { console.error('message_log insert failed:', e); }

  return json({ ok: sent > 0, via: 'gmail', sent, recipients: recipients.length, events: list.length, results });
});
