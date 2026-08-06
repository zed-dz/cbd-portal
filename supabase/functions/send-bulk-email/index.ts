// Sends a bulk email blast to a list of recipients.
//
// GOOGLE (Gmail) ONLY — no third-party email provider. Fully self-contained
// like send-daily-digest: reads the connected team account from `gmail_tokens`
// (id=1), refreshes the OAuth access token at oauth2.googleapis.com/token when
// needed, and sends each message as RAW MIME via gmail.googleapis.com
// messages.send. It does NOT depend on a forwarded user JWT to reach Gmail, and
// there is no fallback provider — even without the (now legacy, ignored)
// `gmail_only` flag.
//
// If Gmail isn't connected it returns { gmail_not_connected } gracefully.
//
// Request body:
//   {
//     recipients: [{ id?, name?, email }],
//     subject:    string,
//     body:       string,                  // plain text — newlines preserved
//     audience?:  'workers' | 'clients' | 'mixed',
//     sent_by?:   UUID,
//   }
//   or { test: true, to: "addr" } for a single probe send.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const PORTAL_URL     = Deno.env.get('PORTAL_URL')  || 'https://cbd-portal-gray.vercel.app';
const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GMAIL_CLIENT_ID      = Deno.env.get('GMAIL_CLIENT_ID')  || '';
const GMAIL_CLIENT_SECRET  = Deno.env.get('GMAIL_CLIENT_SECRET') || '';
const SENDER_DISPLAY_NAME  = Deno.env.get('GMAIL_SENDER_NAME') || 'CBD Plant & Labour';

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

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function renderHtml(name: string, subject: string, body: string) {
  const safeName = escapeHtml(name || 'there');
  const safeBody = escapeHtml(body).replace(/\n/g, '<br>');
  return `<!doctype html><html><body style="margin:0;padding:0;background:#0b0e14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0e14;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#11151e;border:1px solid #222838;border-radius:14px;padding:32px;">
        <tr><td>
          <div style="font-size:28px;font-weight:800;color:#f97316;letter-spacing:-0.5px;line-height:1;">CBD</div>
          <div style="font-size:10px;color:#8a92a8;letter-spacing:2.5px;text-transform:uppercase;margin-top:4px;margin-bottom:24px;font-weight:600;">Plant &amp; Labour</div>
          <h1 style="color:#eef0f6;font-size:20px;margin:0 0 14px 0;font-weight:700;letter-spacing:-0.3px;">${escapeHtml(subject)}</h1>
          <p style="color:#eef0f6;font-size:14.5px;line-height:1.6;margin:0 0 14px 0;">Hi ${safeName},</p>
          <div style="color:#eef0f6;font-size:14.5px;line-height:1.6;margin:0 0 20px 0;">${safeBody}</div>
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

function renderText(name: string, subject: string, body: string) {
  return `Hi ${name || 'there'},\n\n${body}\n\n—\nCBD Plant & Labour\nABN 75 663 693 070\n${PORTAL_URL}`;
}

// base64url encoding required by the Gmail API.
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
  const encoded  = encodeHeader(safeName);
  return /^[\x00-\x7F]*$/.test(safeName) ? `"${safeName}" <${email}>` : `${encoded} <${email}>`;
}

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

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  let body: {
    recipients?: Array<{ id?: string; name?: string; email: string }>;
    subject?: string;
    body?: string;
    audience?: string;
    sent_by?: string;
    gmail_only?: boolean;
    admin_notification?: boolean;  // set by sendAdminEmail; scopes the allocator backstop   // legacy flag — Gmail is always the only sender now
    test?: boolean;
    to?: string;
  };
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

  // Probe mode: a single test recipient.
  let recipients = (body.recipients || []).filter(r => r && r.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email));
  let subject = (body.subject || '').trim();
  let text    = (body.body || '').trim();
  if (body.test) {
    const to = (body.to || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json({ error: 'test mode needs a valid `to`' }, 400);
    recipients = [{ email: to, name: 'Test' }];
    subject = subject || 'CBD bulk email — test send (via Gmail)';
    text    = text || 'This is a test of the bulk email path. It was sent via Gmail (Google) — the only email sender.';
  }

  // ── Allocator backstop (2026-08-04) ────────────────────────────────────────
  // Notification emails (the only ones that set `gmail_only`) must reach the
  // ALLOCATORS and nobody else on the admin roster. The client already filters,
  // but a browser tab left open since before the fix still runs the old code and
  // will happily post the whole admin list — which is exactly how Nick kept
  // receiving allocation emails after the fix shipped. Enforcing it here makes a
  // stale client harmless.
  //
  // Scope is deliberately tight: only admins who are NOT allocators are dropped.
  // Workers, clients and site supervisors are never touched, and the deliberate
  // blast paths (Bulk Messages / Send Blast) don't set `gmail_only`, so the
  // office can still email admins on purpose.
  //
  // Scope guard: this must fire ONLY on an admin broadcast. sendWorkerAllocationEmail
  // and the supervisor sign-off also set gmail_only, but they send to exactly ONE
  // person — and if that person happens to be an admin who isn't an allocator
  // (Nick, Chris, Mathew and Val all are), the filter emptied the list and their
  // own allocation email was dropped with a 400. An admin broadcast always has
  // the shared team inbox plus the allocators, so it is never a single recipient.
  const isAdminBroadcast = body.admin_notification === true || recipients.length > 1;
  if (body.gmail_only && !body.test && isAdminBroadcast) {
    // Own client: the shared `supa` is created further down, after this guard.
    const guardDb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: blocked } = await guardDb
      .from('workers')
      .select('email')
      .eq('access_level', 'admin')
      .or('is_allocator.is.null,is_allocator.eq.false')
      .is('archived_at', null);

    const deny = new Set((blocked || [])
      .map((w: { email: string | null }) => (w.email || '').trim().toLowerCase())
      .filter(Boolean));

    if (deny.size) {
      const before = recipients.length;
      recipients = recipients.filter(r => !deny.has(r.email.trim().toLowerCase()));
      if (recipients.length !== before) {
        console.log(`allocator backstop: dropped ${before - recipients.length} non-allocator admin recipient(s)`);
      }
    }
  }

  if (!recipients.length) return json({ error: 'no_valid_recipients' }, 400);
  if (!subject) return json({ error: 'missing_subject' }, 400);
  if (!text)    return json({ error: 'missing_body' }, 400);

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── Gmail (Google) only — no fallback provider ───────────────────────────
  let accessToken: string;
  let fromEmail: string | null;
  try {
    const t = await getValidAccessToken(supa);
    accessToken = t.accessToken;
    fromEmail   = t.emailAddress;
  } catch (e) {
    const msg = (e as Error).message;
    return json({ ok: false, via: 'gmail', error: msg, recipients: recipients.length }, msg === 'gmail_not_connected' ? 412 : 500);
  }
  if (!fromEmail) return json({ ok: false, via: 'gmail', error: 'no_from_address' }, 500);
  const fromHeader = formatFromHeader(SENDER_DISPLAY_NAME, fromEmail);

  const results: Array<{ email: string; ok: boolean; error?: string }> = [];

  // Send with low concurrency to stay under Gmail's per-user send quota.
  const CONCURRENCY = 4;
  let cursor = 0;
  async function sendWorker() {
    while (cursor < recipients.length) {
      const idx = cursor++;
      const r = recipients[idx];
      try {
        const mime = buildMime({
          from: fromHeader, to: r.email, subject,
          text: renderText(r.name || '', subject, text),
          html: renderHtml(r.name || '', subject, text),
        });
        const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw: b64url(mime) }),
        });
        if (res.ok) {
          results[idx] = { email: r.email, ok: true };
        } else {
          results[idx] = { email: r.email, ok: false, error: (await res.text()).slice(0, 200) };
        }
      } catch (e) {
        results[idx] = { email: r.email, ok: false, error: (e as Error).message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, recipients.length) }, () => sendWorker()));

  for (let i = 0; i < recipients.length; i++) {
    if (!results[i]) results[i] = { email: recipients[i].email, ok: false, error: 'no_result' };
  }

  const sent     = results.filter(r => r.ok).length;
  const failed   = results.filter(r => !r.ok);
  const firstErr = failed[0]?.error;

  // Audit log
  try {
    const batchId = crypto.randomUUID();
    const rows = results.map((r, idx) => ({
      batch_id:        batchId,
      channel:         'gmail',
      audience:        body.audience || null,
      recipient_id:    recipients[idx].id || null,
      recipient_name:  recipients[idx].name || null,
      recipient_email: r.email,
      subject,
      body:            text,
      status:          r.ok ? 'sent' : 'failed',
      error:           r.error || null,
      sent_by:         body.sent_by || null,
    }));
    const { error: logErr } = await supa.from('message_log').insert(rows);
    if (logErr) console.error('message_log insert failed:', logErr);
  } catch (e) {
    console.error('message_log write threw:', e);
  }

  return json({
    ok: sent > 0,
    via: 'gmail',
    sent,
    failed: failed.length,
    total:  results.length,
    firstError: firstErr,
    results,
  });
});
