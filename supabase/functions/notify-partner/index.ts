// notify-partner — e-mail (+ optional SMS) + in-portal notification to ONE sales
// partner, and the opt-in Monday weekly summary (2026-11-09).
//
// verify_jwt = false because pg_cron calls it; the gate inside fails closed:
//   • x-digest-secret header == DIGEST_SECRET      → cron (weekly_summary only)
//   • bearer == service-role key                     → internal
//   • bearer = office user JWT (workers.role admin)  → any kind
//   • bearer = the partner's own JWT                 → kind 'referral_received'
//                                                      for a referral they own
//
// POST { partner_id, kind, referral_id?, text? }
//   kind: referral_received | status_changed | first_placement |
//         commission_approved | commission_paid | generic
// POST { weekly_summary: true }    (cron)
// → 200 { ok, email: 0|1, sms: 0|1 }  or  { ok, partners: n, sent: n }
//
// Honours sales_partners.notify_email / notify_sms. Delivery copied from
// notify-worker (Twilio via env/integration_secrets; Resend → Gmail fallback).
// Every send → message_log; every event → activity_events + partner_notifications.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const DIGEST_SECRET        = Deno.env.get('DIGEST_SECRET') || '';
const PORTAL_URL           = Deno.env.get('PORTAL_URL') || 'https://portal.cbdpnl.com.au';
const SENDER_DISPLAY_NAME  = Deno.env.get('GMAIL_SENDER_NAME') || 'CBD Plant & Labour';
const GMAIL_CLIENT_ID      = Deno.env.get('GMAIL_CLIENT_ID') || '';
const GMAIL_CLIENT_SECRET  = Deno.env.get('GMAIL_CLIENT_SECRET') || '';
const RESEND_API_KEY       = Deno.env.get('RESEND_API_KEY') || '';
const MAIL_FROM            = Deno.env.get('MAIL_FROM') || '';
const RESEND_ON            = !!(RESEND_API_KEY && MAIL_FROM);
const BRAND_SHORT          = Deno.env.get('BRAND_SHORT') || 'CBD';
const BRAND_FOOTER         = Deno.env.get('BRAND_FOOTER') || 'CBD PLANT &amp; LABOUR · ABN 75 663 693 070<br>ROAD · RAIL · WATER';

const KINDS = ['referral_received', 'status_changed', 'first_placement', 'commission_approved', 'commission_paid', 'generic'] as const;
type Kind = typeof KINDS[number];
const SUBJECTS: Record<Kind, string> = {
  referral_received:   'We received your referral',
  status_changed:      'Your referral status changed',
  first_placement:     'Your first placement is confirmed',
  commission_approved: 'Commission approved',
  commission_paid:     'Commission paid',
  generic:             'Message from the office',
};
const STATUS_LABEL: Record<string, string> = {
  submitted: 'Submitted', under_review: 'Under review', accepted: 'Accepted', placement_in_progress: 'Placement in progress',
  active: 'Active', completed: 'Completed', declined: 'Declined', duplicate: 'Duplicate / existing client',
};

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-digest-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const money = (n: unknown) => `$${(Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function normaliseAUMobile(mobile: unknown): string {
  if (!mobile) return '';
  let d = String(mobile).trim(); const hasPlus = d.startsWith('+'); d = d.replace(/[^\d]/g, '');
  if (!d) return ''; if (hasPlus) return `+${d}`; if (d.startsWith('61')) return `+${d}`;
  if (d.startsWith('0')) return `+61${d.slice(1)}`; if (d.startsWith('4') && d.length === 9) return `+61${d}`; return `+61${d}`;
}

// ── Twilio (copied from notify-worker) ───────────────────────────────────────
type TwilioCfg = { accountSid?: string; apiKeySid?: string; apiKeySecret?: string; authToken?: string; from?: string };
async function loadTwilioConfig(sb: ReturnType<typeof createClient>): Promise<TwilioCfg> {
  const env = (k: string) => Deno.env.get(k) || undefined;
  const cfg: TwilioCfg = { accountSid: env('TWILIO_ACCOUNT_SID'), apiKeySid: env('TWILIO_API_KEY_SID'), apiKeySecret: env('TWILIO_API_KEY_SECRET'), authToken: env('TWILIO_AUTH_TOKEN'), from: env('TWILIO_FROM') || env('TWILIO_SMS_FROM') };
  if (!cfg.accountSid || !cfg.from || (!cfg.apiKeySecret && !cfg.authToken)) {
    try {
      const { data } = await sb.from('integration_secrets').select('key,value').like('key', 'twilio_%');
      const m: Record<string, string> = Object.fromEntries((data ?? []).map((r: any) => [r.key, r.value]));
      cfg.accountSid ||= m.twilio_account_sid; cfg.apiKeySid ||= m.twilio_api_key_sid; cfg.apiKeySecret ||= m.twilio_api_key_secret;
      cfg.authToken ||= m.twilio_auth_token; cfg.from ||= m.twilio_from || m.twilio_messaging_service_sid;
    } catch (e) { console.error('integration_secrets read failed:', (e as Error).message); }
  }
  return cfg;
}
const twilioReady = (c: TwilioCfg) => !!(c.accountSid && c.from && (c.apiKeySid || c.accountSid) && (c.apiKeySecret || c.authToken));
async function sendSms(cfg: TwilioCfg, to: string, body: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const form = new URLSearchParams();
    if (String(cfg.from).startsWith('MG')) form.set('MessagingServiceSid', cfg.from!); else form.set('From', cfg.from!);
    form.set('To', to); form.set('Body', body);
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, {
      method: 'POST', headers: { Authorization: 'Basic ' + btoa(`${cfg.apiKeySid || cfg.accountSid}:${cfg.apiKeySecret || cfg.authToken}`), 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    if (resp.ok) return { ok: true };
    let detail = `twilio_${resp.status}`;
    try { const d = await resp.json(); detail = `twilio_${resp.status}: ${d?.message ?? ''} ${d?.code ?? ''}`.trim(); } catch { /* ignore */ }
    return { ok: false, error: detail.slice(0, 200) };
  } catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 200) }; }
}

// ── Email: Resend → Gmail (copied from notify-worker) ────────────────────────
async function sendViaResend(o: { to: string; subject: string; text: string; html: string }) {
  try {
    const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [o.to], subject: o.subject, text: o.text, html: o.html }) });
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
async function gmailSend(g: { accessToken: string; emailAddress: string }, o: { to: string; subject: string; text: string; html: string }) {
  const mime = buildMime({ from: `"${SENDER_DISPLAY_NAME.replace(/"/g, '')}" <${g.emailAddress}>`, ...o });
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: `Bearer ${g.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: b64url(mime) }) });
  return { ok: r.ok, detail: r.ok ? '' : (await r.text()).slice(0, 200) };
}
async function deliverEmail(sb: ReturnType<typeof createClient>, o: { to: string; subject: string; text: string; html: string }) {
  if (RESEND_ON) {
    const r = await sendViaResend(o);
    if (r.ok) return { ok: true, via: 'resend', detail: '' };
    const g = await getGmail(sb);
    if (!g) return { ok: false, via: 'resend', detail: r.detail };
    const gr = await gmailSend(g, o);
    return gr.ok ? { ok: true, via: 'gmail-fallback', detail: '' } : { ok: false, via: 'both-failed', detail: `resend: ${r.detail} | gmail: ${gr.detail}` };
  }
  const g = await getGmail(sb);
  if (!g) return { ok: false, via: 'none', detail: 'no sender configured' };
  const gr = await gmailSend(g, o);
  return { ok: gr.ok, via: 'gmail', detail: gr.detail };
}
function renderHtml(subject: string, lines: string[]) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#0b0e14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0e14;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#11151e;border:1px solid #222838;border-radius:14px;padding:32px;"><tr><td>
<div style="font-size:28px;font-weight:800;color:#f97316;letter-spacing:-0.5px;line-height:1;">${escapeHtml(BRAND_SHORT)}</div>
<div style="font-size:10px;color:#8a92a8;letter-spacing:2.5px;text-transform:uppercase;margin-top:4px;margin-bottom:24px;font-weight:600;">Sales partner portal</div>
<h1 style="color:#eef0f6;font-size:20px;margin:0 0 14px 0;font-weight:700;letter-spacing:-0.3px;">${escapeHtml(subject)}</h1>
<div style="color:#eef0f6;font-size:14.5px;line-height:1.6;margin:0 0 20px 0;">${lines.map(escapeHtml).join('<br>')}</div>
<p style="margin:0 0 20px 0;"><a href="${PORTAL_URL}" style="color:#f97316;text-decoration:none;font-weight:600;">Open the portal →</a></p>
<hr style="border:none;border-top:1px solid #222838;margin:24px 0 14px 0;">
<p style="color:#8a92a8;font-size:11px;line-height:1.5;margin:0;font-family:'SF Mono',Consolas,monospace;letter-spacing:0.5px;">${BRAND_FOOTER}</p>
</td></tr></table></td></tr></table></body></html>`;
}

type Partner = { id: string; name: string; email: string; phone: string | null; notify_email: boolean; notify_sms: boolean; weekly_summary: boolean; status: string; archived_at: string | null };

// Send to one partner: in-portal row always; e-mail / SMS per their switches.
async function notifyOne(sb: ReturnType<typeof createClient>, p: Partner, kind: string, subject: string, lines: string[], smsText: string, referralId: string | null, actor: { id: string | null; name: string }) {
  const batchId = crypto.randomUUID();
  const logRows: any[] = [];
  let emailSent = 0, smsSent = 0;
  const toEmail = String(p.email || '').trim();
  if (EMAIL_RE.test(toEmail) && p.notify_email !== false) {
    const d = await deliverEmail(sb, { to: toEmail, subject, text: `${lines.join('\n')}\n\nOpen the portal: ${PORTAL_URL}\n\n—\n${SENDER_DISPLAY_NAME}`, html: renderHtml(subject, lines) });
    if (d.ok) emailSent = 1;
    logRows.push({ batch_id: batchId, channel: 'email', audience: 'partner', recipient_id: p.id, recipient_email: toEmail, recipient_name: p.name, subject, body: lines.join('\n'), status: d.ok ? 'sent' : 'failed', error: d.ok ? null : d.detail.slice(0, 200), sent_by: actor.id });
  }
  const to = normaliseAUMobile(p.phone);
  if (to && p.notify_sms === true) {
    const cfg = await loadTwilioConfig(sb);
    if (twilioReady(cfg)) {
      const r = await sendSms(cfg, to, smsText);
      if (r.ok) smsSent = 1;
      logRows.push({ batch_id: batchId, channel: 'sms', audience: 'partner', recipient_id: p.id, recipient_name: p.name, subject: null, body: smsText, status: r.ok ? 'sent' : 'failed', error: r.ok ? null : (r.error || 'failed').slice(0, 200), sent_by: actor.id });
    }
  }
  try { await sb.from('partner_notifications').insert([{ partner_id: p.id, kind, title: subject, body: lines.slice(2).filter(Boolean).join(' '), referral_id: referralId }]); } catch (e) { console.error('partner_notifications insert failed:', (e as Error).message); }
  try { if (logRows.length) await sb.from('message_log').insert(logRows); } catch (e) { console.error('message_log insert failed:', (e as Error).message); }
  try {
    await sb.from('activity_events').insert([{ actor_id: actor.id, actor_name: actor.name, verb: 'notified', object_type: 'sales_partner', object_id: p.id, after: { kind, email: emailSent, sms: smsSent, referral_id: referralId, subject } }]);
  } catch (e) { console.error('activity_events insert failed:', (e as Error).message); }
  return { email: emailSent, sms: smsSent };
}

// ── Monday weekly summary for opted-in partners ──────────────────────────────
async function weeklySummary(sb: ReturnType<typeof createClient>) {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data: partners } = await sb.from('sales_partners').select('*').eq('weekly_summary', true).eq('status', 'active').is('archived_at', null);
  let sent = 0;
  for (const p of (partners || []) as Partner[]) {
    const [refs, lines, newRefs] = await Promise.all([
      sb.from('partner_referrals').select('status').eq('partner_id', p.id).is('archived_at', null),
      sb.from('partner_commission_lines').select('amount, status, paid_at, approved_at').eq('partner_id', p.id).neq('status', 'void'),
      sb.from('partner_referral_events').select('id, to_status, created_at, partner_referrals!inner(partner_id)').eq('partner_referrals.partner_id', p.id).eq('kind', 'status').gte('created_at', since),
    ]);
    const byStatus: Record<string, number> = {};
    for (const r of refs.data || []) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    const sum = (arr: any[]) => arr.reduce((a, l) => a + (Number(l.amount) || 0), 0);
    const ls = lines.data || [];
    const pending = sum(ls.filter((l: any) => l.status === 'pending'));
    const approved = sum(ls.filter((l: any) => l.status === 'approved'));
    const paidWeek = sum(ls.filter((l: any) => l.status === 'paid' && l.paid_at && l.paid_at >= since));
    const moves = (newRefs.data || []).length;
    const subject = 'Your weekly sales partner summary';
    const text = [
      `Hi ${p.name.split(/\s+/)[0] || 'there'}, here is your week.`, '',
      `Referrals: ${(refs.data || []).length} total · ${byStatus.active || 0} active · ${byStatus.under_review || 0} under review · ${byStatus.submitted || 0} submitted`,
      `Status changes this week: ${moves}`,
      `Commission: ${money(pending)} pending · ${money(approved)} approved · ${money(paidWeek)} paid this week`,
    ];
    const r = await notifyOne(sb, p, 'weekly_summary', subject, text, `${SENDER_DISPLAY_NAME}: weekly summary — ${money(pending)} pending, ${money(paidWeek)} paid this week. ${PORTAL_URL}`, null, { id: null, name: 'Weekly summary' });
    if (r.email) sent++;
  }
  return { partners: (partners || []).length, sent };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);
  try {
    let body: any = {};
    try { body = await req.json(); } catch { /* cron may send an empty body */ }
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Cron path: shared secret only (fail closed when it is not configured).
    const secret = req.headers.get('x-digest-secret');
    if (body?.weekly_summary) {
      const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
      const viaSecret = !!DIGEST_SECRET && secret === DIGEST_SECRET;
      if (!viaSecret && bearer !== SUPABASE_SERVICE_KEY) return json({ error: 'unauthorized' }, 401);
      const r = await weeklySummary(sb);
      return json({ ok: true, ...r });
    }

    // Caller gate.
    const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!bearer) return json({ error: 'unauthorized' }, 401);
    let actor = { id: null as string | null, name: 'System' };
    let callerPartnerId: string | null = null;
    let office = bearer === SUPABASE_SERVICE_KEY;
    if (!office) {
      const { data: userData, error: userErr } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY).auth.getUser(bearer);
      const email = (userData?.user?.email || '').trim().toLowerCase();
      if (userErr || !email) return json({ error: 'unauthorized' }, 401);
      const pattern = email.replace(/[\\%_]/g, (m: string) => `\\${m}`);
      const { data: ws } = await sb.from('workers').select('id, name, email, role, archived_at').ilike('email', pattern).limit(3);
      const w = (ws || []).find((x: any) => String(x.email || '').trim().toLowerCase() === email && !x.archived_at && x.role === 'admin');
      if (w) { office = true; actor = { id: w.id, name: w.name }; }
      else {
        const { data: ps } = await sb.from('sales_partners').select('id, name, email, status, archived_at').ilike('email', pattern).limit(3);
        const p = (ps || []).find((x: any) => String(x.email || '').trim().toLowerCase() === email && !x.archived_at && x.status !== 'archived');
        if (!p) return json({ error: 'unauthorized' }, 401);
        callerPartnerId = p.id; actor = { id: null, name: p.name };
      }
    }

    const partnerId = String(body.partner_id || '').trim();
    const kind = String(body.kind || 'generic') as Kind;
    const referralId = body.referral_id ? String(body.referral_id).trim() : null;
    const text = String(body.text || '').trim().slice(0, 600);
    if (!UUID_RE.test(partnerId)) return json({ error: 'invalid_partner_id' }, 400);
    if (!KINDS.includes(kind)) return json({ error: 'invalid_kind' }, 400);
    if (referralId && !UUID_RE.test(referralId)) return json({ error: 'invalid_referral_id' }, 400);
    // A partner may only trigger their own "we received it" confirmation.
    if (callerPartnerId && (callerPartnerId !== partnerId || kind !== 'referral_received')) return json({ error: 'not_office' }, 403);

    const { data: partner } = await sb.from('sales_partners').select('*').eq('id', partnerId).maybeSingle();
    if (!partner || partner.archived_at || partner.status === 'archived') return json({ error: 'partner_not_found' }, 404);

    let referral: any = null;
    if (referralId) {
      const { data: r } = await sb.from('partner_referrals').select('id, partner_id, company_name, status, declined_reason, reason_visible').eq('id', referralId).maybeSingle();
      if (!r || r.partner_id !== partnerId) return json({ error: 'referral_not_found' }, 404);
      referral = r;
    }

    const first = (partner.name || '').split(/\s+/)[0] || 'there';
    const company = referral?.company_name ? ` for ${referral.company_name}` : '';
    const statusLabel = referral ? (STATUS_LABEL[referral.status] || referral.status) : '';
    const lines: string[] = [`Hi ${first},`, ''];
    let subject = SUBJECTS[kind];
    let sms = '';
    switch (kind) {
      case 'referral_received':
        lines.push(`We received your referral${company}. It shows as "Submitted" in your list and the office will review it shortly.`);
        sms = `${SENDER_DISPLAY_NAME}: we received your referral${company}. Track it in the portal: ${PORTAL_URL}`;
        break;
      case 'status_changed':
        subject = `Referral${company}: ${statusLabel}`;
        lines.push(`Your referral${company} is now "${statusLabel}".`);
        if (referral?.status === 'declined' && referral?.reason_visible && referral?.declined_reason) lines.push(`Reason: ${referral.declined_reason}`);
        sms = `${SENDER_DISPLAY_NAME}: your referral${company} is now ${statusLabel}. ${PORTAL_URL}`;
        break;
      case 'first_placement':
        lines.push(`People are on site${company}. Your first placement is confirmed — commission will start to appear on your Commission page once the client pays.`);
        sms = `${SENDER_DISPLAY_NAME}: first placement confirmed${company}. ${PORTAL_URL}`;
        break;
      case 'commission_approved':
        lines.push(`A commission line${company} was approved${text ? `: ${text}` : '.'} It will be paid in the next pay run.`);
        sms = `${SENDER_DISPLAY_NAME}: commission approved${company}${text ? ` (${text})` : ''}. ${PORTAL_URL}`;
        break;
      case 'commission_paid':
        lines.push(`A commission payment${company} was sent${text ? `: ${text}` : '.'} The payment reference is on your Commission page.`);
        sms = `${SENDER_DISPLAY_NAME}: commission paid${company}${text ? ` (${text})` : ''}. ${PORTAL_URL}`;
        break;
      default:
        if (!text) return json({ error: 'empty_text' }, 400);
        lines.push(text);
        sms = `${SENDER_DISPLAY_NAME}: ${text}`;
    }
    if (kind !== 'generic' && text && !['commission_approved', 'commission_paid'].includes(kind)) { lines.push('', text); }

    const r = await notifyOne(sb, partner as Partner, kind, subject, lines, sms.slice(0, 300), referral?.id || null, actor);
    // The office bell: a new referral lands in the admin notifications list too.
    if (kind === 'referral_received') {
      try {
        await sb.from('notifications').insert([{ type: 'partner_referral', title: `New referral from ${partner.name}`, body: referral?.company_name ? `${referral.company_name} — open Sales partners → Referrals` : 'Open Sales partners → Referrals' }]);
      } catch (e) { console.error('admin notification insert failed:', (e as Error).message); }
    }
    return json({ ok: true, ...r });
  } catch (e) {
    console.error('notify-partner failed:', (e as Error)?.message);
    return json({ error: 'server_error' }, 500);
  }
});
