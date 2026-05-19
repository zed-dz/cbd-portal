// Sends a worker onboarding invite email.
//
// Sender selection (in order):
//   1. Connected Gmail account (via `gmail-send` function) — if `gmail_tokens`
//      row exists AND the caller passed a valid Authorization header. We
//      forward that header so the function-to-function call satisfies the
//      gmail-send verify_jwt check.
//   2. Resend fallback — only delivers to your Resend account email until
//      a domain is verified. Useful before Gmail is connected.
//
// Request body: { worker_id: UUID }

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
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

async function gmailIsConnected(sb: ReturnType<typeof createClient>) {
  const { data } = await sb.from('gmail_tokens').select('id').eq('id', 1).maybeSingle();
  return !!data?.id;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  let body: { worker_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const workerId = body.worker_id;
  if (!workerId || !/^[0-9a-f-]{36}$/i.test(workerId)) return json({ error: 'invalid_worker_id' }, 400);

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
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

  // Prefer Gmail when connected. Forward the caller's Authorization header so
  // the function-to-function call passes gmail-send's verify_jwt check.
  const callerAuth = req.headers.get('Authorization') || '';
  const useGmail = await gmailIsConnected(sb);
  if (useGmail && callerAuth) {
    const gmailRes = await fetch(`${SUPABASE_URL}/functions/v1/gmail-send`, {
      method: 'POST',
      headers: { 'Authorization': callerAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: worker.email, subject, body: plainText, worker_id: worker.id }),
    });
    const gmailJson = await gmailRes.json().catch(() => ({}));
    if (gmailRes.ok && gmailJson.ok) {
      await sb.from('workers').update({
        profile_invite_sent_at: new Date().toISOString(),
        app_status: worker.app_status === 'Active' ? 'Invite Sent' : worker.app_status,
      }).eq('id', workerId);
      return json({ ok: true, via: 'gmail', email: worker.email, invite_url: inviteUrl });
    }
    console.error('gmail-send failed, falling back:', gmailRes.status, gmailJson);
    if (!RESEND_API_KEY) {
      return json({ error: 'gmail_send_failed', detail: gmailJson.detail || gmailJson.error || `Gmail returned ${gmailRes.status}` }, 502);
    }
  }

  // Resend fallback.
  if (!RESEND_API_KEY) {
    return json({ error: 'email_not_configured', message: 'No email provider configured. Connect Gmail in the Inbox page, or set RESEND_API_KEY.' }, 503);
  }

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#0d0f14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d0f14;padding:32px 16px;"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#131620;border:1px solid #2a2f40;border-radius:14px;padding:32px;"><tr><td><div style="font-size:30px;font-weight:800;color:#f97316;letter-spacing:-0.5px;">CBD</div><div style="font-size:11px;color:#8b90a8;letter-spacing:2px;text-transform:uppercase;margin-top:2px;margin-bottom:24px;">Plant &amp; Labour</div><h1 style="color:#e8eaf2;font-size:22px;margin:0 0 12px 0;font-weight:700;">G'day ${escapeHtml(firstName)},</h1><p style="color:#e8eaf2;font-size:15px;line-height:1.55;margin:0 0 16px 0;">You've been added to the CBD Plant &amp; Labour worker portal. To get on a job, we just need a few details from you — mobile number, address, and your tickets/licences.</p><p style="color:#8b90a8;font-size:14px;line-height:1.55;margin:0 0 28px 0;">Tap the button below to fill out your profile. It takes about a minute.</p><table role="presentation" cellpadding="0" cellspacing="0"><tr><td><a href="${inviteUrl}" style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 28px;border-radius:8px;">Complete my profile →</a></td></tr></table><p style="color:#8b90a8;font-size:12px;line-height:1.55;margin:28px 0 0 0;">Or copy this link into your browser:<br><a href="${inviteUrl}" style="color:#f97316;word-break:break-all;">${inviteUrl}</a></p><hr style="border:none;border-top:1px solid #2a2f40;margin:28px 0 16px 0;"><p style="color:#8b90a8;font-size:11px;line-height:1.5;margin:0;font-family:'SF Mono',Consolas,monospace;">CBD PLANT &amp; LABOUR · ABN 75 663 693 070<br>ROAD · RAIL · WATER</p></td></tr></table></td></tr></table></body></html>`;

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: INVITE_FROM, to: [worker.email], subject, html, text: plainText }),
  });

  if (!resendRes.ok) {
    const detail = await resendRes.text();
    console.error('Resend error', resendRes.status, detail);
    return json({ error: 'resend_failed', status: resendRes.status, detail }, 502);
  }

  await sb.from('workers').update({
    profile_invite_sent_at: new Date().toISOString(),
    app_status: worker.app_status === 'Active' ? 'Invite Sent' : worker.app_status,
  }).eq('id', workerId);

  return json({ ok: true, via: 'resend', email: worker.email, invite_url: inviteUrl });
});
