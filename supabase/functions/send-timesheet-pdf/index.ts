// send-timesheet-pdf — when a timesheet is APPROVED, build the PDF server-side
// and email it to the client, automatically (owner request, meeting 2026-09-22:
// "once I hit that acceptance, I automatically want a PDF version sent back to
// the client so they've got a record").
//
// Called from three places, all fire-and-forget:
//   * ClientApprovePage after the supervisor taps Accept  { token }
//   * the admin approve paths in the portal               { header_id }
//   * auto_approve_stale_timesheets() via pg_net          { header_id, reason: 'auto' }
//
// Design rules:
//   * HOURS ONLY. No pay rates, no dollar figures — same rule as the printed
//     timesheet. The PDF is safe to hand to a client.
//   * The function trusts NOTHING from the caller beyond the id/token: it
//     re-reads the header and only sends when status = approved. So an anon
//     trigger can only cause a legitimate send of an approved sheet to the
//     contact already on file.
//   * Idempotent: pdf_emailed_at guards double sends (force:true to resend).
//   * Resend-first from the company domain with the PDF attached; Gmail is the
//     fallback (same attachment, raw MIME). Both fail -> admin bell lights up.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';
import { encodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY       = Deno.env.get('RESEND_API_KEY') || '';
const MAIL_FROM            = Deno.env.get('MAIL_FROM') || '';
const GMAIL_CLIENT_ID      = Deno.env.get('GMAIL_CLIENT_ID') || '';
const GMAIL_CLIENT_SECRET  = Deno.env.get('GMAIL_CLIENT_SECRET') || '';
const BRAND                = Deno.env.get('GMAIL_SENDER_NAME') || 'CBD Plant & Labour';
const RESEND_ON            = !!(RESEND_API_KEY && MAIL_FROM);

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

// LIKE/ILIKE treat % and _ as wildcards — a client literally named "100% Civil"
// must not match every client. Backslash is Postgres's default LIKE escape.
const escLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

// USER-entered text (comments, names, client/project strings) must never kill
// the send: strip "$" from it before drawing. The throw in text() stays as the
// money-leak tripwire for anything WE compose (layout strings, computed cells).
const stripUser = (s: unknown) => String(s ?? '').replace(/\$/g, '');

// ── PDF ─────────────────────────────────────────────────────────────────────
const fmtTime = (iso: string | null) => iso
  ? new Date(iso).toLocaleTimeString('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', minute: '2-digit' })
  : '—';
const fmtDate = (d: string | null) => d
  ? new Date(d + 'T12:00:00').toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' })
  : '—';
const dayName = (d: string | null) => d
  ? new Date(d + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'short' })
  : '';

async function buildPdf(header: any, lines: any[], workerName: string) {
  const doc  = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const A4: [number, number] = [595.28, 841.89];
  const M = 48;
  const ink    = rgb(0.12, 0.13, 0.16);
  const muted  = rgb(0.42, 0.44, 0.48);
  const accent = rgb(0.976, 0.451, 0.086);
  const line   = rgb(0.88, 0.87, 0.85);

  let page = doc.addPage(A4);
  let y = A4[1] - M;
  const newPageIfNeeded = (need: number) => {
    if (y - need < M) { page = doc.addPage(A4); y = A4[1] - M; }
  };
  // HOURS-ONLY CONTRACT: pdf-lib can't extract text back out, so the guard
  // sits in front of every draw — a "$" in anything we'd render (a comment,
  // a client name, a future field) aborts the whole build rather than leak
  // money onto a client-facing PDF. Keep this; there's a matching rule in
  // CLAUDE.md ("Client-facing PDFs show hours only").
  const text = (s: string, x: number, size = 10, f = font, color = ink) => {
    if (String(s ?? '').includes('$')) {
      throw new Error(`money leak blocked: refusing to draw "$" on a client PDF (${String(s).slice(0, 60)})`);
    }
    page.drawText(s ?? '', { x, y, size, font: f, color });
  };
  const wrap = (s: string, size: number, maxW: number) => {
    const words = String(s || '').split(/\s+/);
    const out: string[] = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (font.widthOfTextAtSize(t, size) > maxW && cur) { out.push(cur); cur = w; }
      else cur = t;
    }
    if (cur) out.push(cur);
    return out;
  };

  // Brand header
  text(BRAND, M, 18, bold, accent); y -= 20;
  text('Approved Timesheet', M, 13, bold); y -= 24;

  const meta: Array<[string, string]> = [
    ['Worker',  stripUser(workerName) || '—'],
    ['Client',  stripUser(header.client) || '—'],
    ['Project', stripUser(header.project) || '—'],
    ['Role',    stripUser(header.role) || '—'],
    ['Wet hire', header.wet_hire ? 'Yes' : 'No'],
  ];
  for (const [k, v] of meta) {
    text(k.toUpperCase(), M, 8, bold, muted);
    text(String(v), M + 90, 10);
    y -= 15;
  }
  y -= 8;

  // Hours table
  const cols = [
    { h: 'Date',  x: M },
    { h: 'Day',   x: M + 78 },
    { h: 'Start', x: M + 128 },
    { h: 'End',   x: M + 196 },
    { h: 'Break', x: M + 264 },
    { h: 'Total hrs', x: M + 330 },
  ];
  newPageIfNeeded(40);
  for (const c of cols) text(c.h.toUpperCase(), c.x, 8, bold, muted);
  y -= 6;
  page.drawLine({ start: { x: M, y }, end: { x: A4[0] - M, y }, thickness: 0.7, color: line });
  y -= 14;

  let total = 0;
  for (const l of lines) {
    newPageIfNeeded(20);
    const hrs = parseFloat(l.total_hours ?? l.pay_hours ?? 0) || 0;
    total += hrs;
    text(fmtDate(l.date), cols[0].x, 10);
    text(dayName(l.date), cols[1].x, 10, font, muted);
    text(fmtTime(l.start_time), cols[2].x, 10);
    text(fmtTime(l.end_time), cols[3].x, 10);
    const brk = parseFloat(l.total_break_hours ?? (l.break_minutes != null ? l.break_minutes / 60 : 0)) || 0;
    text(brk ? `${brk} h` : '—', cols[4].x, 10);
    text(hrs.toFixed(2), cols[5].x, 10, bold);
    y -= 16;
  }
  y -= 2;
  page.drawLine({ start: { x: M, y }, end: { x: A4[0] - M, y }, thickness: 0.7, color: line });
  y -= 16;
  newPageIfNeeded(20);
  text('TOTAL', cols[4].x, 9, bold, muted);
  text(`${(parseFloat(header.total_hours) || total).toFixed(2)} h`, cols[5].x, 11, bold);
  y -= 26;

  if (header.comments) {
    newPageIfNeeded(40);
    text('TASKS COMPLETED', M, 8, bold, muted); y -= 14;
    for (const ln of wrap(stripUser(header.comments), 10, A4[0] - 2 * M)) {
      newPageIfNeeded(14);
      text(ln, M, 10); y -= 13;
    }
    y -= 10;
  }

  newPageIfNeeded(50);
  const approvedNote = header.client_approved
    ? `Accepted by ${stripUser(header.client_approved_by) || 'the site representative'} on ${header.client_approved_at ? new Date(header.client_approved_at).toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney' }) : '—'}`
    : 'Approved by the office';
  text('APPROVAL', M, 8, bold, muted); y -= 14;
  text(approvedNote, M, 10); y -= 20;
  text(`Generated automatically by the ${BRAND} portal — hours only, no rates shown.`, M, 8, font, muted);

  return doc.save();
}

// ── Email delivery ──────────────────────────────────────────────────────────
async function sendViaResend(to: string[], cc: string[], subject: string, html: string, pdf: Uint8Array, filename: string) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${BRAND} <${MAIL_FROM}>`,
      to, ...(cc.length ? { cc } : {}),
      subject, html,
      attachments: [{ filename, content: encodeBase64(pdf) }],
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  const j = await res.json().catch(() => null);
  return (j?.id as string) || null;
}

async function sendViaGmail(sb: any, to: string[], cc: string[], subject: string, html: string, pdf: Uint8Array, filename: string) {
  const { data: tok } = await sb.from('gmail_tokens').select('*').eq('id', 1).maybeSingle();
  if (!tok?.refresh_token) throw new Error('no Gmail connection');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: tok.refresh_token, grant_type: 'refresh_token',
    }),
  });
  const t = await r.json();
  if (!t.access_token) throw new Error('Gmail token refresh failed');

  const boundary = 'ts_' + crypto.randomUUID().replace(/-/g, '');
  const b64pdf = encodeBase64(pdf).replace(/(.{76})/g, '$1\r\n');
  const mime = [
    `From: ${BRAND} <${tok.email_address}>`,
    `To: ${to.join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
    `--${boundary}`,
    `Content-Type: application/pdf; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    b64pdf,
    `--${boundary}--`,
  ].join('\r\n');
  const raw = encodeBase64(new TextEncoder().encode(mime)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const send = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!send.ok) throw new Error(`Gmail ${send.status}: ${await send.text()}`);
  const sent = await send.json().catch(() => null);
  return { id: (sent?.id as string) || null, from: (tok.email_address as string) || null };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  let body: { token?: string; header_id?: string; reason?: string; force?: boolean };
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const sel = 'id, client, project, role, status, comments, wet_hire, total_hours, client_approved, client_approved_by, client_approved_at, pdf_emailed_at, locked, version, worker_id, workers(name)';
  let q = sb.from('timesheet_headers').select(sel);
  if (body.token)          q = q.eq('client_approval_token', body.token);
  else if (body.header_id) q = q.eq('id', body.header_id);
  else return json({ error: 'token or header_id required' }, 400);

  const { data: h, error } = await q.maybeSingle();
  if (error || !h) return json({ error: 'timesheet not found' }, 404);
  if (h.status !== 'approved') return json({ error: 'timesheet is not approved yet' }, 409);

  // Approve = lock. The token/auto-approve RPCs don't set locked yet (central
  // owns them) — this backstop locks any approved sheet the moment it reaches
  // the send pipeline, so a supervisor-accepted sheet can't be edited after.
  if (!h.locked) {
    await sb.from('timesheet_headers').update({ locked: true }).eq('id', h.id);
  }

  if (h.pdf_emailed_at && !body.force) return json({ ok: true, skipped: 'already emailed', at: h.pdf_emailed_at });

  const { data: lines } = await sb.from('timesheets').select('*').eq('header_id', h.id).order('date');
  const workerName = (h as any).workers?.name || 'Worker';

  // Recipients: the project's site contact (who approves) + the client's main
  // contact copied in — both ends hold a copy (owner decision 2026-09-27).
  const to = new Set<string>();
  const cc = new Set<string>();
  const { data: clientRows } = await sb.from('clients')
    .select('id, contact_email').ilike('name', escLike((h.client || '').trim())).limit(1);
  const client = clientRows?.[0];
  if (client && h.project) {
    const { data: jobs } = await sb.from('client_jobs')
      .select('site_contact_email').eq('client_id', client.id).ilike('name', escLike(h.project.trim())).limit(1);
    const e = (jobs?.[0]?.site_contact_email || '').trim();
    if (e) to.add(e.toLowerCase());
  }
  if (client?.contact_email) {
    const e = client.contact_email.trim().toLowerCase();
    if (to.size === 0) to.add(e); else if (!to.has(e)) cc.add(e);
  }
  if (to.size === 0) {
    await sb.from('notifications').insert([{
      type: 'timesheet_pdf_blocked',
      title: `Timesheet PDF NOT emailed — ${workerName} / ${h.client || 'client'}`,
      body: 'No client email on file. Add a site contact email on the project, or a contact email on the client, then resend from Timesheets.',
    }]);
    // Ledger the failure too, so the Sent Timesheets screen surfaces it.
    await sb.from('timesheet_sends').insert([{
      header_id: h.id, client_id: client?.id ?? null,
      to_emails: [], cc_emails: [],
      from_email: RESEND_ON ? MAIL_FROM : null,
      subject: `Approved timesheet — ${workerName} — ${h.project || h.client || ''}`,
      status: 'failed', error: 'no client email on file',
      idempotency_key: `approve:${h.id}:v${(h as any).version || 1}:noaddr${Date.now()}`,
    }]);
    return json({ error: 'no client email on file' }, 422);
  }

  const dates = (lines || []).map((l: any) => l.date).filter(Boolean).sort();
  const label = `${workerName} — ${h.project || h.client}${h.total_hours ? ` (${Number(h.total_hours).toFixed(2)}h)` : ''}`;
  const filename = `timesheet-${workerName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${dates[0] || 'sheet'}.pdf`;
  const subject = `Approved timesheet — ${label}`;
  const rowsHtml = (lines || []).map((l: any) => {
    const brk = parseFloat(l.total_break_hours ?? (l.break_minutes != null ? l.break_minutes / 60 : 0)) || 0;
    return `<tr><td>${fmtDate(l.date)} (${dayName(l.date)})</td><td>${fmtTime(l.start_time)}</td><td>${fmtTime(l.end_time)}</td><td>${brk ? brk + ' h' : '—'}</td><td align="right"><strong>${(parseFloat(l.total_hours ?? l.pay_hours) || 0).toFixed(2)}</strong></td></tr>`;
  }).join('');
  const html = `
    <p>Hi,</p>
    <p>The timesheet for <strong>${label}</strong> has been accepted${h.client_approved_by ? ` by ${h.client_approved_by}` : ''}${body.reason === 'auto' ? ' (finalised automatically after 7 days with no response)' : ''}. A PDF copy is attached for your records.</p>
    <table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#ddd;font-family:Arial,sans-serif;font-size:13px">
      <tr style="background:#f6f4f1"><th align="left">Date</th><th align="left">Start</th><th align="left">Finish</th><th align="left">Break</th><th align="right">Hours</th></tr>
      ${rowsHtml}
      <tr><td colspan="4" align="right"><strong>Total</strong></td><td align="right"><strong>${Number(h.total_hours || 0).toFixed(2)} h</strong></td></tr>
    </table>
    <p style="color:#777;font-size:12px">Sent automatically by the ${BRAND} portal when a timesheet is approved. Hours only — no rates are shown.</p>`;

  const toArr = [...to], ccArr = [...cc];

  // ── 2.2: the exact PDF goes to storage + a timesheet_sends ledger row ────
  const slug = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const pdfPath = [
    dates[0] || new Date().toISOString().slice(0, 10),
    slug(h.client || 'client'),
    slug(h.project || 'site'),
    slug(workerName),
    h.id,
  ].join('-') + '.pdf';
  const version = (h as any).version || 1;

  // Nothing about a failed build may be silent: ledger row + admin bell + 500.
  // (User text can no longer trip the "$" guard — stripUser handles it — so a
  // throw here means a layout string leaked money, or pdf-lib itself failed.)
  let pdf: Uint8Array;
  let pdfSha256 = '';
  try {
    pdf = await buildPdf(h, lines || [], workerName);
    const shaBuf = await crypto.subtle.digest('SHA-256', pdf);
    pdfSha256 = [...new Uint8Array(shaBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (eBuild) {
    const reason = `pdf build failed: ${String((eBuild as Error).message).slice(0, 300)}`;
    await sb.from('timesheet_sends').insert([{
      header_id: h.id, client_id: client?.id ?? null,
      to_emails: toArr, cc_emails: ccArr,
      from_email: RESEND_ON ? MAIL_FROM : null,
      subject, status: 'failed', error: reason,
      idempotency_key: `approve:${h.id}:v${version}:builderr${Date.now()}`,
    }]);
    await sb.from('notifications').insert([{
      type: 'timesheet_pdf_blocked',
      title: `Timesheet PDF FAILED to build — ${workerName} / ${h.client || 'client'}`,
      body: `${reason}. Nothing was emailed. Fix the timesheet, then resend from Timesheets.`,
    }]);
    return json({ error: 'pdf build failed', detail: String((eBuild as Error).message) }, 500);
  }
  // A force resend gets its OWN ledger row — the canonical key stays with the
  // first send, so the unique index keeps double-taps out without blocking
  // deliberate resends.
  const idemKey = body.force
    ? `approve:${h.id}:v${version}:r${Date.now()}`
    : `approve:${h.id}:v${version}`;

  // Queue the ledger row BEFORE sending: a concurrent double-tap loses the
  // unique-key race here instead of double-emailing the client.
  const { data: sendRow, error: sendRowErr } = await sb.from('timesheet_sends').insert([{
    header_id: h.id, client_id: client?.id ?? null,
    to_emails: toArr, cc_emails: ccArr,
    from_email: RESEND_ON ? MAIL_FROM : null,
    subject, pdf_path: pdfPath, pdf_sha256: pdfSha256,
    status: 'queued', idempotency_key: idemKey,
  }]).select('id').single();
  if (sendRowErr) {
    if (/duplicate key|unique/i.test(sendRowErr.message) && !body.force) {
      return json({ ok: true, skipped: 'duplicate send (idempotency key)', idempotency_key: idemKey });
    }
    // Ledger unavailable — the email still matters more; carry on without it.
    console.error('timesheet_sends insert failed:', sendRowErr.message);
  }
  const sendId = sendRow?.id ?? null;
  const markSend = async (patch: Record<string, unknown>) => {
    if (sendId) await sb.from('timesheet_sends').update(patch).eq('id', sendId);
  };

  // Upload failure is fatal too — the ledger must always point at the exact
  // PDF the client received, so no stored copy means no send. Bell + 500;
  // resend (force:true) from Timesheets once storage is back.
  const up = await sb.storage.from('timesheet-pdfs')
    .upload(pdfPath, pdf, { contentType: 'application/pdf', upsert: true });
  if (up.error) {
    const reason = `pdf upload failed: ${String(up.error.message).slice(0, 300)}`;
    await markSend({ status: 'failed', error: reason });
    await sb.from('notifications').insert([{
      type: 'timesheet_pdf_blocked',
      title: `Timesheet PDF NOT emailed — ${workerName} / ${h.client || 'client'}`,
      body: `${reason}. Nothing was emailed. Resend from Timesheets once storage is back up.`,
    }]);
    return json({ error: 'pdf upload failed', detail: up.error.message }, 500);
  }

  let via = '';
  let providerMessageId: string | null = null;
  let fromUsed: string | null = RESEND_ON ? MAIL_FROM : null;
  try {
    if (!RESEND_ON) throw new Error('Resend not configured');
    providerMessageId = await sendViaResend(toArr, ccArr, subject, html, pdf, filename);
    via = 'resend';
  } catch (_e1) {
    try {
      const g = await sendViaGmail(sb, toArr, ccArr, subject, html, pdf, filename);
      providerMessageId = g.id;
      fromUsed = g.from || fromUsed;
      via = 'gmail-fallback';
    } catch (e2) {
      await markSend({
        status: 'failed',
        error: String((e2 as Error).message).slice(0, 300),
      });
      await sb.from('notifications').insert([{
        type: 'timesheet_pdf_blocked',
        title: `Timesheet PDF email FAILED — ${workerName} / ${h.client || 'client'}`,
        body: `Could not send to ${toArr.join(', ')}: ${String((e2 as Error).message).slice(0, 180)}. Resend from Timesheets once email is back up.`,
      }]);
      return json({ error: 'send failed on every channel', detail: String((e2 as Error).message) }, 502);
    }
  }

  await markSend({
    status: 'sent',
    provider: via === 'resend' ? 'resend' : 'gmail',
    provider_message_id: providerMessageId,
    from_email: fromUsed,
    sent_at: new Date().toISOString(),
    error: null,
  });

  await sb.from('timesheet_headers').update({
    pdf_emailed_at: new Date().toISOString(),
    pdf_emailed_to: [...toArr, ...ccArr.map(e => `cc:${e}`)].join(', '),
  }).eq('id', h.id);
  await sb.from('message_log').insert([{
    channel: 'email', audience: 'client',
    recipient_name: h.client || null, recipient_email: toArr.join(', '),
    subject, body: `Approved-timesheet PDF (${filename}) via ${via}`,
    status: 'sent', sent_by: 'send-timesheet-pdf',
  }]);

  await sb.from('activity_events').insert([{
    actor_name: 'portal', verb: 'sent', object_type: 'timesheet_header', object_id: h.id,
    after: { to: toArr, cc: ccArr, via, pdf_path: pdfPath },
  }]);

  return json({ ok: true, via, to: toArr, cc: ccArr, pdf_path: pdfPath, sha256: pdfSha256 });
});
