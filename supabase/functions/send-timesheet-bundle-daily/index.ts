// send-timesheet-bundle-daily — Chris (2026-10-28): "site engineers get 4 emails from
// one site. Can all the timesheets in a day go out together at midnight, in a folder?"
//
// How it fits:
//   * send-timesheet-pdf still builds + stores every approved PDF the moment a sheet
//     is approved. When the CLIENT is on pdf_delivery = 'daily' it parks the ledger
//     row as status 'held' instead of emailing it.
//   * pg_cron calls this function every hour (timesheet-pdf-daily-bundle). It only
//     acts in the Sydney midnight hour — or when a held row is older than 26 h (a
//     missed night), or when the office forces it ({ force: true }).
//   * One email per client + site: every held PDF of that site attached, a table of
//     worker / date / hours / signed-by in the body. Recipients = the union of what
//     each sheet would have gone to (site list, signer, client inbox).
//   * Hours only, never money — the PDFs are the exact files already in storage.
//   * A failed bundle stays 'held' (so it retries next hour) and lights the bell.
//
// Guard: the shared DIGEST_SECRET header (same as send-daily-digest) or the service key.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { encodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY       = Deno.env.get('RESEND_API_KEY') || '';
const MAIL_FROM            = Deno.env.get('MAIL_FROM') || '';
const GMAIL_CLIENT_ID      = Deno.env.get('GMAIL_CLIENT_ID') || '';
const GMAIL_CLIENT_SECRET  = Deno.env.get('GMAIL_CLIENT_SECRET') || '';
const BRAND                = Deno.env.get('GMAIL_SENDER_NAME') || 'CBD Plant & Labour';
const DIGEST_SECRET        = Deno.env.get('DIGEST_SECRET') || '';
const RESEND_ON            = !!(RESEND_API_KEY && MAIL_FROM);
const MAX_ATTACH_BYTES     = 25 * 1024 * 1024;   // Resend caps a message at 40 MB; split well under it

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-digest-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const oneLine = (s: unknown) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
const stripMoney = (s: unknown) => String(s ?? '').replace(/\$/g, '');
const sydney = (d: Date, opts: Intl.DateTimeFormatOptions) => d.toLocaleString('en-AU', { timeZone: 'Australia/Sydney', ...opts });
const sydneyHour = (d: Date) => parseInt(sydney(d, { hour: '2-digit', hour12: false }), 10) % 24;
const sydneyDateLabel = (d: Date) => sydney(d, { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtDate = (d: string | null) => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit' }) : '—';

type Attachment = { filename: string; content: Uint8Array };

// ── Email delivery (multi-attachment versions of the send-timesheet-pdf helpers) ──
async function sendViaResend(to: string[], cc: string[], subject: string, html: string, files: Attachment[]) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${BRAND} <${MAIL_FROM}>`, to, ...(cc.length ? { cc } : {}), subject, html,
      attachments: files.map(f => ({ filename: f.filename, content: encodeBase64(f.content) })),
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  const j = await res.json().catch(() => null);
  return (j?.id as string) || null;
}
const encodeHeader = (value: string) => {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  let bin = ''; for (const b of new TextEncoder().encode(value)) bin += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(bin)}?=`;
};
const b64Lines = (s: string) => encodeBase64(new TextEncoder().encode(s)).replace(/(.{76})/g, '$1\r\n');
async function sendViaGmail(sb: any, to: string[], cc: string[], subject: string, html: string, files: Attachment[]) {
  const { data: tok } = await sb.from('gmail_tokens').select('*').eq('id', 1).maybeSingle();
  if (!tok?.refresh_token) throw new Error('no Gmail connection');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_CLIENT_SECRET, refresh_token: tok.refresh_token, grant_type: 'refresh_token' }),
  });
  const t = await r.json();
  if (!t.access_token) throw new Error('Gmail token refresh failed');
  const boundary = 'ts_' + crypto.randomUUID().replace(/-/g, '');
  const parts: string[] = [
    `From: ${encodeHeader(BRAND)} <${tok.email_address}>`,
    `To: ${to.join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64Lines(html),
  ];
  for (const f of files) {
    parts.push(`--${boundary}`, `Content-Type: application/pdf; name="${f.filename}"`, `Content-Disposition: attachment; filename="${f.filename}"`,
      'Content-Transfer-Encoding: base64', '', encodeBase64(f.content).replace(/(.{76})/g, '$1\r\n'));
  }
  parts.push(`--${boundary}--`);
  const raw = encodeBase64(new TextEncoder().encode(parts.join('\r\n'))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const send = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }),
  });
  if (!send.ok) throw new Error(`Gmail ${send.status}: ${await send.text()}`);
  const sent = await send.json().catch(() => null);
  return { id: (sent?.id as string) || null, from: (tok.email_address as string) || null };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const secretOk = !!DIGEST_SECRET && req.headers.get('x-digest-secret') === DIGEST_SECRET;
  if (!secretOk && bearer !== SUPABASE_SERVICE_KEY) return json({ error: 'Unauthorized' }, 401);

  let body: { force?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body from cron is fine */ }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const now = new Date();

  // No FK from the ledger to the headers (deliberate: a ledger row outlives its sheet),
  // so the headers are read in a second query and attached by id.
  const { data: heldRows, error: heldErr } = await sb.from('timesheet_sends')
    .select('id, header_id, client_id, to_emails, cc_emails, pdf_path, created_at')
    .eq('status', 'held').not('pdf_path', 'is', null).order('created_at');
  if (heldErr) return json({ error: heldErr.message }, 500);
  if (!heldRows?.length) return json({ ok: true, bundles: 0, note: 'nothing held' });
  const { data: hdrs } = await sb.from('timesheet_headers')
    .select('id, status, locked, client, project, site_id, site_name_snapshot, total_hours, client_approved_by, client_approved_at, signed_on_site_at, workers(name)')
    .in('id', [...new Set(heldRows.map((r: any) => r.header_id).filter(Boolean))]);
  const hmap = new Map((hdrs || []).map((h: any) => [h.id, h]));
  const held = heldRows.map((r: any) => ({ ...r, timesheet_headers: hmap.get(r.header_id) || null }));

  const oldest = Math.min(...held.map((r: any) => new Date(r.created_at).getTime()));
  const overdue = now.getTime() - oldest > 26 * 3600 * 1000;
  if (!body.force && sydneyHour(now) !== 0 && !overdue) {
    return json({ ok: true, bundles: 0, skipped: `not the midnight hour (Sydney ${sydneyHour(now)}:00); ${held.length} held` });
  }

  // A sheet that left 'approved' after it was held (office Reset workflow) must not go out.
  const stale = held.filter((r: any) => (r.timesheet_headers?.status || '') !== 'approved');
  if (stale.length) await sb.from('timesheet_sends').update({ status: 'failed', error: 'timesheet was no longer approved at bundle time' }).in('id', stale.map((r: any) => r.id));
  const live = held.filter((r: any) => (r.timesheet_headers?.status || '') === 'approved');

  // Group: one email per client + site + recipient set. Each address only ever gets the
  // PDFs whose own ledger row named it (a foreman who signed one sheet does not receive
  // the rest of the site's sheets unless the site list names him).
  const groups = new Map<string, any[]>();
  for (const r of live) {
    const h = (r as any).timesheet_headers || {};
    const rcpt = [...new Set([...(r.to_emails || []), ...(r.cc_emails || [])].map((e: string) => String(e).toLowerCase()))].sort().join(',');
    const key = `${r.client_id || h.client || 'client'}|${h.site_id || h.site_name_snapshot || h.project || 'site'}|${rcpt}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const bundleDay = sydneyDateLabel(new Date(now.getTime() - 3600 * 1000));   // the day that just ended
  const results: any[] = [];
  for (const [key, rows] of groups) {
    const h0 = (rows[0] as any).timesheet_headers || {};
    const clientName = h0.client || 'Client';
    const siteName = h0.site_name_snapshot || h0.project || '';
    const to = new Set<string>(); const cc = new Set<string>();
    for (const r of rows) { for (const e of (r.to_emails || [])) to.add(String(e).toLowerCase()); }
    for (const r of rows) { for (const e of (r.cc_emails || [])) { const x = String(e).toLowerCase(); if (!to.has(x)) cc.add(x); } }
    if (!to.size && cc.size) { const first = [...cc][0]; cc.delete(first); to.add(first); }
    if (!to.size) {
      await sb.from('timesheet_sends').update({ status: 'failed', error: 'no client email on file (nightly bundle)' }).in('id', rows.map((r: any) => r.id));
      results.push({ key, error: 'no recipients' }); continue;
    }

    // Pull the exact stored PDFs.
    const files: Attachment[] = []; const missing: string[] = [];
    for (const r of rows) {
      const dl = await sb.storage.from('timesheet-pdfs').download(r.pdf_path);
      if (dl.error || !dl.data) { missing.push(r.id); continue; }
      const base = String(r.pdf_path).split('/').pop()!.replace(/-[0-9a-f-]{36}\.pdf$/i, '.pdf');
      files.push({ filename: base, content: new Uint8Array(await dl.data.arrayBuffer()) });
      (r as any)._file = base;
    }
    const okRows = rows.filter((r: any) => !missing.includes(r.id));
    if (missing.length) await sb.from('timesheet_sends').update({ status: 'failed', error: 'stored PDF missing at bundle time — resend from Sent Timesheets' }).in('id', missing);
    if (!okRows.length) { results.push({ key, error: 'no PDFs' }); continue; }

    const totalHours = okRows.reduce((s: number, r: any) => s + (parseFloat(r.timesheet_headers?.total_hours) || 0), 0);
    const subject = oneLine(`Approved timesheets — ${clientName}${siteName ? ` — ${siteName}` : ''} — ${bundleDay} (${okRows.length} sheet${okRows.length === 1 ? '' : 's'}, ${totalHours.toFixed(2)} h)`);
    const { data: lineRows } = await sb.from('timesheets').select('header_id, date').in('header_id', okRows.map((r: any) => r.header_id));
    const datesFor = (hid: string) => [...new Set((lineRows || []).filter((l: any) => l.header_id === hid).map((l: any) => l.date))].sort().map(fmtDate).join(', ');
    const tr = okRows.map((r: any) => {
      const h = r.timesheet_headers || {};
      const signed = h.client_approved_by ? `${stripMoney(h.client_approved_by)}${h.signed_on_site_at ? ' (on site)' : ''}` : 'office';
      return `<tr><td>${esc(h.workers?.name || 'Worker')}</td><td>${esc(datesFor(r.header_id))}</td><td align="right"><strong>${(parseFloat(h.total_hours) || 0).toFixed(2)}</strong></td><td>${esc(signed)}</td><td style="color:#777">${esc(r._file)}</td></tr>`;
    }).join('');
    const html = `<meta charset="utf-8">
      <p>Hi,</p>
      <p>Here are the approved timesheets for <strong>${esc(clientName)}${siteName ? ` — ${esc(siteName)}` : ''}</strong> for <strong>${esc(bundleDay)}</strong>. One PDF per sheet is attached; each carries both signatures.</p>
      <table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#ddd;font-family:Arial,sans-serif;font-size:13px">
        <tr style="background:#f6f4f1"><th align="left">Worker</th><th align="left">Date</th><th align="right">Hours</th><th align="left">Signed by</th><th align="left">File</th></tr>
        ${tr}
        <tr><td colspan="2" align="right"><strong>Total</strong></td><td align="right"><strong>${totalHours.toFixed(2)} h</strong></td><td colspan="2"></td></tr>
      </table>
      <p style="color:#777;font-size:12px">Sent once a night by the ${esc(BRAND)} portal with every timesheet approved that day. Hours only — no rates are shown.</p>`;

    // Split into parts if the attachments would exceed the cap.
    const parts: { rows: any[]; files: Attachment[] }[] = [];
    let cur = { rows: [] as any[], files: [] as Attachment[] }, size = 0;
    okRows.forEach((r: any, i: number) => {
      const f = files[i];
      if (size + f.content.byteLength > MAX_ATTACH_BYTES && cur.files.length) { parts.push(cur); cur = { rows: [], files: [] }; size = 0; }
      cur.rows.push(r); cur.files.push(f); size += f.content.byteLength;
    });
    parts.push(cur);

    const batchId = crypto.randomUUID();
    const toArr = [...to], ccArr = [...cc];
    let partNo = 0;
    for (const part of parts) {
      partNo++;
      const subj = parts.length > 1 ? `${subject} — part ${partNo}/${parts.length}` : subject;
      let via = '', providerMessageId: string | null = null, fromUsed: string | null = RESEND_ON ? MAIL_FROM : null;
      try {
        if (!RESEND_ON) throw new Error('Resend not configured');
        providerMessageId = await sendViaResend(toArr, ccArr, subj, html, part.files); via = 'resend';
      } catch (_e1) {
        try { const g = await sendViaGmail(sb, toArr, ccArr, subj, html, part.files); providerMessageId = g.id; fromUsed = g.from || fromUsed; via = 'gmail'; }
        catch (e2) {
          const reason = String((e2 as Error).message).slice(0, 300);
          await sb.from('timesheet_sends').update({ error: `nightly bundle failed, will retry: ${reason}` }).in('id', part.rows.map((r: any) => r.id));
          await sb.from('notifications').insert([{ type: 'timesheet_pdf_blocked', title: `Nightly timesheet bundle FAILED — ${clientName}${siteName ? ` / ${siteName}` : ''}`, body: `${part.rows.length} approved PDF(s) could not be emailed to ${toArr.join(', ')}: ${reason}. They stay held and retry next hour; or press Resend on them in Sent Timesheets.` }]);
          results.push({ key, part: partNo, error: reason }); continue;
        }
      }
      const sentAt = new Date().toISOString();
      await sb.from('timesheet_sends').update({ status: 'sent', provider: via, provider_message_id: providerMessageId, from_email: fromUsed, sent_at: sentAt, error: null, batch_id: batchId, subject: subj, to_emails: toArr, cc_emails: ccArr }).in('id', part.rows.map((r: any) => r.id));
      await sb.from('timesheet_headers').update({ pdf_emailed_at: sentAt, pdf_emailed_to: [...toArr, ...ccArr.map(e => `cc:${e}`)].join(', ') }).in('id', part.rows.map((r: any) => r.header_id));
      await sb.from('message_log').insert([{ channel: 'email', audience: 'client', recipient_name: clientName, recipient_email: toArr.join(', '), subject: subj, body: `Nightly bundle: ${part.files.length} approved-timesheet PDF(s) via ${via}`, status: 'sent', sent_by: 'send-timesheet-bundle-daily' }]);
      await sb.from('activity_events').insert(part.rows.map((r: any) => ({ actor_name: 'portal', verb: 'sent', object_type: 'timesheet_header', object_id: r.header_id, after: { to: toArr, cc: ccArr, via, pdf_path: r.pdf_path, batch_id: batchId, bundle: true } })));
      results.push({ key, part: partNo, sheets: part.rows.length, via, to: toArr });
    }
  }
  return json({ ok: true, bundles: results.filter(r => !r.error).length, results });
});
