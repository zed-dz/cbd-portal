// Sends a bulk email blast to a list of recipients via Resend.
//
// Request body:
//   {
//     recipients: [{ name?: string, email: string }],
//     subject: string,
//     body: string,                  // plain text — newlines preserved
//     audience?: 'workers' | 'clients' | 'mixed'   // for header styling only
//   }
//
// Uses Resend's batch endpoint when >1 recipient (up to 100 per call).
// Returns per-recipient results. Falls back to clipboard message if no API key.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const INVITE_FROM    = Deno.env.get('INVITE_FROM') || 'CBD Plant & Labour <onboarding@resend.dev>';
const PORTAL_URL     = Deno.env.get('PORTAL_URL')  || 'https://cbd-portal-gray.vercel.app';
const MAX_PER_BATCH  = 100;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
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

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  if (!RESEND_API_KEY) {
    return json({ error: 'email_not_configured', message: 'RESEND_API_KEY is not set.' }, 503);
  }

  let body: { recipients?: Array<{ name?: string; email: string }>; subject?: string; body?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

  const recipients = (body.recipients || []).filter(r => r && r.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email));
  if (!recipients.length) return json({ error: 'no_valid_recipients' }, 400);
  if (!body.subject?.trim()) return json({ error: 'missing_subject' }, 400);
  if (!body.body?.trim())    return json({ error: 'missing_body' }, 400);

  const subject = body.subject.trim();
  const text    = body.body.trim();

  const emails = recipients.map(r => ({
    from: INVITE_FROM,
    to: [r.email],
    subject,
    html: renderHtml(r.name || '', subject, text),
    text: renderText(r.name || '', subject, text),
  }));

  // Resend batch endpoint accepts up to 100 messages per call.
  const results: Array<{ email: string; ok: boolean; error?: string }> = [];
  for (let i = 0; i < emails.length; i += MAX_PER_BATCH) {
    const slice = emails.slice(i, i + MAX_PER_BATCH);
    const batchRes = await fetch('https://api.resend.com/emails/batch', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(slice),
    });
    if (!batchRes.ok) {
      const detail = await batchRes.text();
      console.error('Resend batch error', batchRes.status, detail);
      // Mark all in this slice as failed.
      slice.forEach((_, idx) => {
        results.push({ email: recipients[i + idx].email, ok: false, error: `Resend ${batchRes.status}: ${detail.slice(0, 160)}` });
      });
      // On 403/domain errors we bail early — same error will hit the rest.
      if (batchRes.status === 403) break;
      continue;
    }
    const out = await batchRes.json();
    const okIds: any[] = out?.data || [];
    slice.forEach((_, idx) => {
      results.push({ email: recipients[i + idx].email, ok: !!okIds[idx]?.id });
    });
  }

  const sent     = results.filter(r => r.ok).length;
  const failed   = results.filter(r => !r.ok);
  const firstErr = failed[0]?.error;

  return json({
    ok: sent > 0,
    sent,
    failed: failed.length,
    total:  results.length,
    firstError: firstErr,
    results,
  });
});
