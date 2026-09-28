// build-timesheet-bundle — one PDF holding EVERY approved timesheet for a
// client in a date range (owner request: "weekly PDF bundles" — Dashpivot
// sends clients one weekly pack, not one email per sheet).
//
// Called from the client register tab in the portal:  { client, project?, from, to }
// Returns { pdf_path, count, total_hours } — the UI signs a URL and opens it.
//
// Design rules (same contract as send-timesheet-pdf):
//   * HOURS ONLY. The "$" tripwire aborts the build before money could leak
//     onto a client-facing page; user text is stripped of "$" first.
//   * Admin-gated: deployed with verify_jwt, and the caller must pass
//     is_portal_admin() — a valid worker JWT alone is not enough.
//   * Nothing is emailed. The bundle lands in the timesheet-pdfs bucket under
//     bundles/ and the admin decides what to do with it.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;
const BRAND                = Deno.env.get('GMAIL_SENDER_NAME') || 'CBD Plant & Labour';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const escLike   = (s: string) => s.replace(/[\\%_]/g, '\\$&');
const stripUser = (s: unknown) => String(s ?? '').replace(/\$/g, '');
const slug      = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const fmtTime = (iso: string | null) => iso
  ? new Date(iso).toLocaleTimeString('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', minute: '2-digit' })
  : '—';
const fmtDate = (d: string | null) => d
  ? new Date(d + 'T12:00:00').toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' })
  : '—';
const dayName = (d: string | null) => d
  ? new Date(d + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'short' })
  : '';

const MAX_SHEETS = 200; // a "week" is dozens of sheets; 200 keeps memory sane.

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  let body: { client?: string; project?: string; from?: string; to?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const clientName = (body.client || '').trim();
  const from = (body.from || '').trim();
  const to   = (body.to || '').trim();
  if (!clientName || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return json({ error: 'client, from (YYYY-MM-DD) and to (YYYY-MM-DD) are required' }, 400);
  }
  if (from > to) return json({ error: 'from must be on or before to' }, 400);

  // Admin gate: verify_jwt already proved a valid login; is_portal_admin()
  // (SECURITY DEFINER, reads the caller's uid) proves it is an ADMIN login.
  const authHeader = req.headers.get('Authorization') || '';
  const sbUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: isAdmin, error: adminErr } = await sbUser.rpc('is_portal_admin');
  if (adminErr || !isAdmin) return json({ error: 'admin only' }, 403);

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Approved headers for the client (headers key the client by NAME snapshot),
  // then keep only those with at least one line date inside the range.
  let hq = sb.from('timesheet_headers')
    .select('id, client, project, role, comments, wet_hire, total_hours, client_approved, client_approved_by, client_approved_at, workers(name)')
    .eq('status', 'approved')
    .ilike('client', escLike(clientName));
  if ((body.project || '').trim()) hq = hq.ilike('project', escLike(body.project!.trim()));
  const { data: headers, error: hErr } = await hq.limit(1000);
  if (hErr) return json({ error: hErr.message }, 500);
  if (!headers?.length) return json({ error: 'no approved timesheets for this client' }, 404);

  const { data: allLines, error: lErr } = await sb.from('timesheets')
    .select('header_id, date, start_time, end_time, total_break_hours, break_minutes, total_hours, pay_hours')
    .in('header_id', headers.map((h: any) => h.id))
    .gte('date', from).lte('date', to)
    .order('date');
  if (lErr) return json({ error: lErr.message }, 500);

  const linesByHeader = new Map<string, any[]>();
  for (const l of allLines || []) {
    const arr = linesByHeader.get(l.header_id) || [];
    arr.push(l);
    linesByHeader.set(l.header_id, arr);
  }
  const sheets = headers
    .filter((h: any) => linesByHeader.get(h.id)?.length)
    .map((h: any) => ({ h, lines: linesByHeader.get(h.id)!, firstDate: linesByHeader.get(h.id)![0].date as string }))
    .sort((a, b) => a.firstDate.localeCompare(b.firstDate)
      || String((a.h as any).workers?.name || '').localeCompare(String((b.h as any).workers?.name || '')));
  if (!sheets.length) return json({ error: 'no approved timesheets in that date range' }, 404);
  if (sheets.length > MAX_SHEETS) return json({ error: `too many sheets (${sheets.length} > ${MAX_SHEETS}) — narrow the date range` }, 422);

  // ── One PDF, a page-set per timesheet, same layout as send-timesheet-pdf ──
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
  // Same money-leak tripwire as the single-sheet PDF: a "$" in ANYTHING we
  // would draw aborts the whole bundle rather than reach a client.
  const text = (s: string, x: number, size = 10, f = font, color = ink) => {
    if (String(s ?? '').includes('$')) {
      throw new Error(`money leak blocked: refusing to draw "$" on a client PDF (${String(s).slice(0, 60)})`);
    }
    page.drawText(s ?? '', { x, y, size, font: f, color });
  };
  const hr = () => {
    page.drawLine({ start: { x: M, y }, end: { x: A4[0] - M, y }, thickness: 0.7, color: line });
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

  // Cover
  const grandTotal = sheets.reduce((s, x) => s + x.lines.reduce((t, l) =>
    t + (parseFloat(l.total_hours ?? l.pay_hours ?? 0) || 0), 0), 0);
  text(BRAND, M, 18, bold, accent); y -= 22;
  text('Timesheet Bundle', M, 15, bold); y -= 26;
  const cover: Array<[string, string]> = [
    ['Client',     stripUser(clientName)],
    ...(body.project ? [['Project', stripUser(body.project)] as [string, string]] : []),
    ['Period',     `${fmtDate(from)} – ${fmtDate(to)}`],
    ['Timesheets', String(sheets.length)],
    ['Total hours', grandTotal.toFixed(2)],
  ];
  for (const [k, v] of cover) {
    text(k.toUpperCase(), M, 8, bold, muted);
    text(String(v), M + 90, 10);
    y -= 15;
  }
  y -= 4;
  text('All timesheets in this bundle are approved. Hours only — no rates shown.', M, 8, font, muted);

  for (const { h, lines } of sheets) {
    page = doc.addPage(A4);
    y = A4[1] - M;
    const workerName = (h as any).workers?.name || 'Worker';

    text(BRAND, M, 14, bold, accent); y -= 18;
    text('Approved Timesheet', M, 12, bold); y -= 22;
    const meta: Array<[string, string]> = [
      ['Worker',  stripUser(workerName) || '—'],
      ['Client',  stripUser(h.client) || '—'],
      ['Project', stripUser(h.project) || '—'],
      ['Role',    stripUser(h.role) || '—'],
      ['Wet hire', h.wet_hire ? 'Yes' : 'No'],
    ];
    for (const [k, v] of meta) {
      text(k.toUpperCase(), M, 8, bold, muted);
      text(String(v), M + 90, 10);
      y -= 15;
    }
    y -= 8;

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
    y -= 6; hr(); y -= 14;

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
    y -= 2; hr(); y -= 16;
    newPageIfNeeded(20);
    text('TOTAL', cols[4].x, 9, bold, muted);
    // NOTE: the range total, not header.total_hours — a header may hold lines
    // outside the requested week and those must not inflate the bundle.
    text(`${total.toFixed(2)} h`, cols[5].x, 11, bold);
    y -= 26;

    if (h.comments) {
      newPageIfNeeded(40);
      text('TASKS COMPLETED', M, 8, bold, muted); y -= 14;
      for (const ln of wrap(stripUser(h.comments), 10, A4[0] - 2 * M)) {
        newPageIfNeeded(14);
        text(ln, M, 10); y -= 13;
      }
      y -= 10;
    }

    newPageIfNeeded(50);
    const approvedNote = h.client_approved
      ? `Accepted by ${stripUser(h.client_approved_by) || 'the site representative'} on ${h.client_approved_at ? new Date(h.client_approved_at).toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney' }) : '—'}`
      : 'Approved by the office';
    text('APPROVAL', M, 8, bold, muted); y -= 14;
    text(approvedNote, M, 10);
  }

  let pdf: Uint8Array;
  try {
    pdf = await doc.save();
  } catch (e) {
    return json({ error: 'pdf build failed', detail: String((e as Error).message) }, 500);
  }

  const pdfPath = `bundles/${from}-to-${to}-${slug(clientName)}${body.project ? '-' + slug(body.project) : ''}-${Date.now()}.pdf`;
  const up = await sb.storage.from('timesheet-pdfs')
    .upload(pdfPath, pdf, { contentType: 'application/pdf', upsert: true });
  if (up.error) return json({ error: 'pdf upload failed', detail: up.error.message }, 500);

  await sb.from('activity_events').insert([{
    actor_name: 'portal', verb: 'bundled', object_type: 'client', object_id: null,
    after: { client: clientName, project: body.project || null, from, to, count: sheets.length, total_hours: Number(grandTotal.toFixed(2)), pdf_path: pdfPath },
  }]);

  return json({ ok: true, pdf_path: pdfPath, count: sheets.length, total_hours: Number(grandTotal.toFixed(2)) });
});
