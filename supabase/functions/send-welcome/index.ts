// Sends a branded welcome email to a brand-new portal account, with a ONE-CLICK
// magic sign-in link (so the button actually logs them in, like the reset
// email) plus the email+password they chose as a fallback.
//
// Called from the signup page right after supabase.auth.signUp() succeeds.
// Runs with verify_jwt=false (the browser has no user JWT yet) and uses the
// service-role key to (a) mint a magic link via admin.generateLink and (b) send
// via Gmail directly, falling back to Resend.
//
// Request body: { email: string, name?: string }

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GMAIL_CLIENT_ID      = Deno.env.get('GMAIL_CLIENT_ID')  || '';
const GMAIL_CLIENT_SECRET  = Deno.env.get('GMAIL_CLIENT_SECRET') || '';
const SENDER_DISPLAY_NAME  = Deno.env.get('GMAIL_SENDER_NAME') || 'CBD Plant & Labour';
// Brand surface for the welcome email. Defaults are CBD's exact previous values,
// so CBD's output is unchanged; Hecate (and any future portal) overrides these
// four env vars instead of forking the file.
const BRAND_MARK    = Deno.env.get('BRAND_MARK')    || 'CBD';
const BRAND_SUB     = Deno.env.get('BRAND_SUB')     || 'Plant & Labour';
const BRAND_TAGLINE = Deno.env.get('BRAND_TAGLINE') || 'Road · Rail · Water';
const BRAND_ABN     = Deno.env.get('BRAND_ABN')     || 'ABN 75 663 693 070';
const BRAND_ACCENT  = Deno.env.get('BRAND_ACCENT')  || '#f97316';
const RESEND_API_KEY       = Deno.env.get('RESEND_API_KEY') || '';
const INVITE_FROM          = Deno.env.get('INVITE_FROM') || 'CBD Plant & Labour <onboarding@resend.dev>';
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
      client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: row.refresh_token, grant_type: 'refresh_token',
    }),
  });
  if (!refreshRes.ok) { console.error('token refresh failed:', await refreshRes.text()); throw new Error('refresh_failed'); }
  const t = await refreshRes.json();
  const newExpires = new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString();
  await supa.from('gmail_tokens').update({ access_token: t.access_token, expires_at: newExpires, updated_at: new Date().toISOString() }).eq('id', 1);
  return { accessToken: t.access_token, emailAddress: row.email_address };
}

function b64url(s: string) {
  const bytes = new TextEncoder().encode(s);
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function encodeHeader(value: string) {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(bin)}?=`;
}
function formatFromHeader(name: string, email: string) {
  const safeName = name.replace(/"/g, '\\"');
  return /^[\x00-\x7F]*$/.test(safeName) ? `"${safeName}" <${email}>` : `${encodeHeader(safeName)} <${email}>`;
}
function buildMime(opts: { from: string; to: string[]; subject: string; text: string; html: string; }) {
  const boundary = `cbd_${crypto.randomUUID().replace(/-/g, '')}`;
  const headers: string[] = [
    `From: ${opts.from}`, `To: ${opts.to.join(', ')}`, `Subject: ${encodeHeader(opts.subject)}`,
    'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const b64 = (s: string) => { const bytes = new TextEncoder().encode(s); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin).replace(/(.{76})/g, '$1\r\n'); };
  const body = [
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64(opts.text), '',
    `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64(opts.html), '',
    `--${boundary}--`,
  ].join('\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

function buildContent(firstName: string, signInUrl: string) {
  const subject = `Welcome to ${SENDER_DISPLAY_NAME} — your portal account is ready`;
  const safeName = escapeHtml(firstName);
  const safeUrl = escapeHtml(signInUrl);
  const plainText = `G'day ${firstName},\n\nYour ${SENDER_DISPLAY_NAME} portal account is ready.\n\nTap this link to sign straight in:\n${signInUrl}\n\n(The link signs you in automatically. You can also sign in any time at ${PORTAL_URL} with the email and password you just chose.)\n\nOnce an admin activates your account you'll be able to view your allocations, submit timesheets, and keep your tickets/licences up to date.\n\nIf you didn't create this account, you can ignore this email.\n\n—\n${SENDER_DISPLAY_NAME}\n${BRAND_TAGLINE.toUpperCase()}\n${BRAND_ABN}`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#0d0f14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d0f14;padding:32px 16px;"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#131620;border:1px solid #2a2f40;border-radius:14px;padding:32px;"><tr><td><div style="font-size:30px;font-weight:800;color:${BRAND_ACCENT};letter-spacing:-0.5px;">${BRAND_MARK}</div><div style="font-size:11px;color:#8b90a8;letter-spacing:2px;text-transform:uppercase;margin-top:2px;margin-bottom:24px;">${escapeHtml(BRAND_SUB)}</div><h1 style="color:#e8eaf2;font-size:22px;margin:0 0 12px 0;font-weight:700;">G'day ${safeName},</h1><p style="color:#e8eaf2;font-size:15px;line-height:1.55;margin:0 0 8px 0;">Your ${escapeHtml(SENDER_DISPLAY_NAME)} portal account is ready.</p><p style="color:#aeb4c8;font-size:14px;line-height:1.55;margin:0 0 20px 0;">Tap the button to sign straight in — it logs you in automatically. Once an admin activates your account you'll be able to view your allocations, submit timesheets, and keep your tickets &amp; licences up to date.</p><table role="presentation" cellpadding="0" cellspacing="0"><tr><td><a href="${safeUrl}" style="display:inline-block;background:${BRAND_ACCENT};color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 28px;border-radius:8px;">Sign in to the portal →</a></td></tr></table><p style="color:#8b90a8;font-size:13px;line-height:1.55;margin:18px 0 0 0;">Or sign in any time at <a href="${escapeHtml(PORTAL_URL)}" style="color:${BRAND_ACCENT};">the portal</a> with the email and password you just chose.</p><p style="color:#6b7185;font-size:12px;line-height:1.5;margin:20px 0 0 0;">If you didn't create this account, you can safely ignore this email.</p><div style="border-top:1px solid #2a2f40;margin-top:24px;padding-top:16px;color:#6b7185;font-size:11px;letter-spacing:1px;text-transform:uppercase;">${escapeHtml(BRAND_TAGLINE)} &nbsp;·&nbsp; ${escapeHtml(BRAND_ABN)}</div></td></tr></table></td></tr></table></body></html>`;
  return { subject, plainText, html };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  let body: { email?: string; name?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

  const email = (body.email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'invalid_email' }, 400);
  const firstName = (body.name || '').trim().split(/\s+/)[0] || 'there';

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Mint a one-click magic sign-in link (falls back to the plain portal URL).
  let signInUrl = PORTAL_URL;
  try {
    const { data: linkData, error: linkErr } = await sb.auth.admin.generateLink({
      type: 'magiclink', email, options: { redirectTo: PORTAL_URL },
    });
    const link = (linkData as any)?.properties?.action_link;
    if (!linkErr && link) signInUrl = link;
  } catch (e) { console.error('generateLink failed, using portal url:', (e as Error).message); }

  const { subject, plainText, html } = buildContent(firstName, signInUrl);

  let workerId: string | null = null;
  try { const { data: w } = await sb.from('workers').select('id').eq('email', email).maybeSingle(); workerId = w?.id ?? null; } catch { /* non-fatal */ }

  async function logSend(channel: string, status: string, error?: string) {
    await sb.from('message_log').insert({
      batch_id: crypto.randomUUID(), channel, audience: workerId ? 'workers' : null,
      recipient_id: workerId, recipient_name: firstName === 'there' ? null : firstName,
      recipient_email: email, subject, body: plainText, status, error: error ?? null,
    });
  }

  try {
    const { accessToken, emailAddress } = await getValidAccessToken(sb);
    if (emailAddress) {
      const mime = buildMime({ from: formatFromHeader(SENDER_DISPLAY_NAME, emailAddress), to: [email], subject, text: plainText, html });
      const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: b64url(mime) }),
      });
      if (sendRes.ok) { const sent = await sendRes.json(); await logSend('gmail', 'sent'); return json({ ok: true, via: 'gmail', email, gmail_message_id: sent.id }); }
      console.error('gmail send failed, will try Resend:', sendRes.status, (await sendRes.text()).slice(0, 300));
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (msg !== 'not_connected') console.error('gmail path error, will try Resend:', msg);
  }

  if (!RESEND_API_KEY) { await logSend('email', 'failed', 'no_provider'); return json({ error: 'email_not_configured' }, 503); }
  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: INVITE_FROM, to: [email], subject, html, text: plainText }),
  });
  if (!resendRes.ok) { const detail = await resendRes.text(); console.error('Resend error', resendRes.status, detail); await logSend('resend', 'failed', detail.slice(0, 300)); return json({ error: 'resend_failed', status: resendRes.status, detail }, 502); }
  const sent = await resendRes.json().catch(() => ({}));
  await logSend('resend', 'sent');
  return json({ ok: true, via: 'resend', email, resend_id: sent.id });
});
