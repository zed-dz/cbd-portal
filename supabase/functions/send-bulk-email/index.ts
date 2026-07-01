// Sends a bulk email blast to a list of recipients.
//
// Sender selection (in order):
//   1. Connected Gmail account (calls `gmail-send` once per recipient) — used
//      whenever a `gmail_tokens` row exists. Slower than Resend's batch
//      endpoint but the only path that reaches arbitrary recipients
//      pre-domain-verification.
//   2. Resend batch endpoint — used if Gmail isn't connected and a
//      RESEND_API_KEY is set. Up to 100 messages per HTTP call.
//
// Request body:
//   {
//     recipients: [{ id?, name?, email }],
//     subject:    string,
//     body:       string,                  // plain text — newlines preserved
//     audience?:  'workers' | 'clients' | 'mixed',
//     sent_by?:   UUID,
//   }

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const INVITE_FROM    = Deno.env.get('INVITE_FROM') || 'CBD Plant & Labour <onboarding@resend.dev>';
const PORTAL_URL     = Deno.env.get('PORTAL_URL')  || 'https://cbd-portal-gray.vercel.app';
const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const MAX_PER_BATCH  = 100;

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

async function gmailIsConnected(sb: ReturnType<typeof createClient>) {
  const { data } = await sb.from('gmail_tokens').select('id').eq('id', 1).maybeSingle();
  return !!data?.id;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  // Forward the caller's Authorization header to gmail-send — Supabase's
  // gateway rejects service-role JWTs as Bearer tokens for inter-function
  // calls when verify_jwt=true.
  const callerAuth = req.headers.get('Authorization') || '';

  let body: {
    recipients?: Array<{ id?: string; name?: string; email: string }>;
    subject?: string;
    body?: string;
    audience?: string;
    sent_by?: string;
    gmail_only?: boolean;   // notification sends set this — Google only, never Resend
  };
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

  // Allocation-notification emails pass gmail_only:true so they are sent via
  // Google (Gmail) ONLY and never silently fall back to Resend.
  const gmailOnly = body.gmail_only === true;

  const recipients = (body.recipients || []).filter(r => r && r.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email));
  if (!recipients.length) return json({ error: 'no_valid_recipients' }, 400);
  if (!body.subject?.trim()) return json({ error: 'missing_subject' }, 400);
  if (!body.body?.trim())    return json({ error: 'missing_body' }, 400);

  const subject = body.subject.trim();
  const text    = body.body.trim();
  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const results: Array<{ email: string; ok: boolean; error?: string }> = [];

  // ── 1) Prefer Gmail when connected ────────────────────────────────────────
  const useGmail = await gmailIsConnected(supa) && !!callerAuth;
  let provider: 'gmail' | 'resend' = useGmail ? 'gmail' : 'resend';

  if (useGmail) {
    // Send one at a time via gmail-send. Slower than Resend batch but reaches
    // any recipient, not just verified addresses. Concurrency kept low to
    // avoid hitting Gmail's per-user send quotas.
    const CONCURRENCY = 4;
    let cursor = 0;
    async function worker() {
      while (cursor < recipients.length) {
        const idx = cursor++;
        const r = recipients[idx];
        try {
          const res = await fetch(`${SUPABASE_URL}/functions/v1/gmail-send`, {
            method: 'POST',
            headers: {
              'Authorization': callerAuth,
              'Content-Type':  'application/json',
            },
            body: JSON.stringify({ to: r.email, subject, body: text }),
          });
          const out = await res.json().catch(() => ({}));
          if (res.ok && out.ok) {
            results[idx] = { email: r.email, ok: true };
          } else {
            results[idx] = {
              email: r.email, ok: false,
              error: out.detail || out.error || `gmail-send ${res.status}`,
            };
          }
        } catch (e) {
          results[idx] = { email: r.email, ok: false, error: (e as Error).message };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, recipients.length) }, () => worker()));
  } else if (gmailOnly) {
    // Google-only notification path: Gmail isn't connected (or no caller JWT) —
    // refuse to route via Resend so notifications stay 100% Gmail.
    return json({
      ok: false,
      via: 'gmail',
      error: 'gmail_required',
      message: 'Gmail is not connected (or no auth was forwarded). Notification emails are Google-only and will not fall back to Resend. Connect Gmail in the Inbox page.',
    }, 412);
  } else if (RESEND_API_KEY) {
    // ── 2) Resend fallback (batch endpoint) ────────────────────────────────
    const emails = recipients.map(r => ({
      from: INVITE_FROM,
      to: [r.email],
      subject,
      html: renderHtml(r.name || '', subject, text),
      text: renderText(r.name || '', subject, text),
    }));
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
        slice.forEach((_, idx) => {
          results[i + idx] = { email: recipients[i + idx].email, ok: false, error: `Resend ${batchRes.status}: ${detail.slice(0, 160)}` };
        });
        if (batchRes.status === 403) break;
        continue;
      }
      const out = await batchRes.json();
      const okIds: any[] = out?.data || [];
      slice.forEach((_, idx) => {
        results[i + idx] = { email: recipients[i + idx].email, ok: !!okIds[idx]?.id };
      });
    }
  } else {
    return json({
      error: 'email_not_configured',
      message: 'No email provider configured. Connect Gmail in the Inbox page, or set RESEND_API_KEY.',
    }, 503);
  }

  // Fill any unset slots with a generic failure (shouldn't happen).
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
      channel:         provider === 'gmail' ? 'gmail' : 'email',
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
    via: provider,
    sent,
    failed: failed.length,
    total:  results.length,
    firstError: firstErr,
    results,
  });
});
