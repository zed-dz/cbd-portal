// Send an email via the connected Gmail account.
//
// POST body:
//   {
//     to: string | string[],       // required — recipient email(s)
//     subject: string,
//     body: string,                // plain text — converted to HTML server-side
//     thread_id?: string,          // gmail thread id to reply on (optional)
//     in_reply_to?: string,        // gmail message id this replies to (optional)
//     worker_id?: string,
//     client_id?: string,
//   }

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL        = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GMAIL_CLIENT_ID     = Deno.env.get('GMAIL_CLIENT_ID')  || '';
const GMAIL_CLIENT_SECRET = Deno.env.get('GMAIL_CLIENT_SECRET') || '';

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

// Refresh the Gmail access token if it's expired.
async function getValidAccessToken(supa: ReturnType<typeof createClient>) {
  const { data: row, error } = await supa.from('gmail_tokens').select('*').eq('id', 1).maybeSingle();
  if (error || !row) throw new Error('not_connected');

  const expired = new Date(row.expires_at).getTime() < Date.now() + 30_000;
  if (!expired) return { accessToken: row.access_token, emailAddress: row.email_address };

  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) throw new Error('not_configured');

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
    throw new Error('refresh_failed');
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

// base64url encoding required by the Gmail API.
function b64url(s: string) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildMime(opts: {
  from: string;
  to: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
}) {
  const safeHtml = escapeHtml(opts.text).replace(/\n/g, '<br>');
  const boundary = `cbd_${crypto.randomUUID().replace(/-/g, '')}`;
  const headers: string[] = [
    `From: ${opts.from}`,
    `To: ${opts.to.join(', ')}`,
    `Subject: ${opts.subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  if (opts.inReplyTo)  headers.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) headers.push(`References: ${opts.references}`);

  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14.5px;line-height:1.6;color:#1a1a1a">${safeHtml}</body></html>`;

  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    opts.text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    html,
    '',
    `--${boundary}--`,
  ].join('\r\n');

  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  let payload: {
    to?: string | string[]; subject?: string; body?: string;
    thread_id?: string; in_reply_to?: string;
    worker_id?: string; client_id?: string;
  };
  try { payload = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

  const toList = Array.isArray(payload.to) ? payload.to : payload.to ? [payload.to] : [];
  const cleanTo = toList.map(s => s.trim()).filter(s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
  if (!cleanTo.length)         return json({ error: 'missing_recipient' }, 400);
  if (!payload.subject?.trim()) return json({ error: 'missing_subject' }, 400);
  if (!payload.body?.trim())    return json({ error: 'missing_body' }, 400);

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  let accessToken: string;
  let fromEmail:   string | null;
  try {
    const t = await getValidAccessToken(supa);
    accessToken = t.accessToken;
    fromEmail   = t.emailAddress;
  } catch (e) {
    const msg = (e as Error).message;
    return json({ error: msg }, msg === 'not_connected' ? 412 : 500);
  }
  if (!fromEmail) return json({ error: 'no_from_address' }, 500);

  const mime = buildMime({
    from:    fromEmail,
    to:      cleanTo,
    subject: payload.subject.trim(),
    text:    payload.body.trim(),
    inReplyTo:  payload.in_reply_to,
    references: payload.in_reply_to,
  });

  const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      raw: b64url(mime),
      ...(payload.thread_id ? { threadId: payload.thread_id } : {}),
    }),
  });

  if (!sendRes.ok) {
    const detail = await sendRes.text();
    console.error('Gmail send failed:', sendRes.status, detail);
    return json({ error: 'send_failed', detail: detail.slice(0, 300) }, sendRes.status);
  }

  const sent = await sendRes.json();
  // sent: { id, threadId, labelIds }

  // Mirror into our local cache so the UI sees the outbound message immediately.
  const gmailThreadId = sent.threadId;
  let { data: existingThread } = await supa
    .from('email_threads').select('id').eq('gmail_thread_id', gmailThreadId).maybeSingle();
  let threadId = existingThread?.id;
  if (!threadId) {
    const { data: newThread, error: tErr } = await supa.from('email_threads').insert({
      gmail_thread_id: gmailThreadId,
      subject:         payload.subject.trim(),
      participants:    [fromEmail, ...cleanTo],
      last_message_at: new Date().toISOString(),
      unread:          false,
      worker_id:       payload.worker_id || null,
      client_id:       payload.client_id || null,
    }).select('id').single();
    if (tErr) console.error('thread insert failed:', tErr);
    threadId = newThread?.id;
  } else {
    await supa.from('email_threads').update({
      last_message_at: new Date().toISOString(),
      worker_id:       payload.worker_id ?? undefined,
      client_id:       payload.client_id ?? undefined,
      updated_at:      new Date().toISOString(),
    }).eq('id', threadId);
  }

  if (threadId) {
    await supa.from('email_messages').insert({
      thread_id:        threadId,
      gmail_message_id: sent.id,
      direction:        'outbound',
      from_email:       fromEmail,
      to_emails:        cleanTo,
      subject:          payload.subject.trim(),
      body_text:        payload.body.trim(),
      snippet:          payload.body.trim().slice(0, 200),
      sent_at:          new Date().toISOString(),
    });
  }

  // Audit log
  await supa.from('message_log').insert(cleanTo.map(email => ({
    batch_id:        crypto.randomUUID(),
    channel:         'gmail',
    audience:        payload.worker_id ? 'workers' : payload.client_id ? 'clients' : null,
    recipient_id:    payload.worker_id || payload.client_id || null,
    recipient_email: email,
    subject:         payload.subject!.trim(),
    body:            payload.body!.trim(),
    status:          'sent',
  })));

  return json({ ok: true, gmail_message_id: sent.id, gmail_thread_id: sent.threadId, thread_id: threadId });
});
