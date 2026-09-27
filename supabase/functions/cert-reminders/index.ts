// cert-reminders — daily certificate/ticket expiry reminders (Dashpivot X5).
//
// Meant for pg_cron (daily 21:00 UTC = 7am Sydney; schedule statement lives in
// migrations/20260928_dashpivot_c.sql). Deploy with --no-verify-jwt: the cron
// caller only holds the anon key, and the function reads nothing from the
// request — worst case an anonymous hit just re-runs an idempotent scan.
//
// What one run does:
//   1. Finds certifications whose expiry is EXACTLY 30 / 14 / 7 / 0 days away,
//      measured in Sydney calendar dates (expiry is a plain DATE column).
//   2. Skips any cert whose last_reminded_stage already equals this run's
//      '<expiry>:<stage>' key — that is the whole idempotence story, so cron
//      can safely double-fire. Keyed on expiry+stage (not stage alone) so a
//      RENEWED cert — new expiry, same stage numbers — gets its reminders
//      again instead of being skipped forever.
//   3. Inserts one notifications row per hit (type 'cert_expiring') for the
//      admin bell, tagged with the worker.
//   4. Emails each affected WORKER one summary of all their hits this run —
//      Resend-first from the company domain (RESEND_API_KEY + MAIL_FROM, same
//      pattern as send-timesheet-pdf); if Resend is not configured or the send
//      fails, the email is skipped silently (bell rows still land).
//
// NOT here (owned elsewhere): blocking allocation of a role with an expired
// ticket — that belongs to the allocations owner.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY       = Deno.env.get('RESEND_API_KEY') || '';
const MAIL_FROM            = Deno.env.get('MAIL_FROM') || '';
const BRAND                = Deno.env.get('GMAIL_SENDER_NAME') || 'CBD Plant & Labour';
const RESEND_ON            = !!(RESEND_API_KEY && MAIL_FROM);

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const STAGES = [30, 14, 7, 0];

// Today's calendar date in Sydney as 'YYYY-MM-DD' (en-CA gives ISO order).
function sydneyToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
}
// Date-only arithmetic at UTC noon so DST can never shift the calendar day.
function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function stageLabel(days: number): string {
  return days === 0 ? 'today' : `in ${days} days`;
}

async function sendViaResend(to: string, subject: string, html: string) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${BRAND} <${MAIL_FROM}>`, to: [to], subject, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const today = sydneyToday();
  const targetByDate = new Map<string, number>(); // 'YYYY-MM-DD' -> days-until
  for (const d of STAGES) targetByDate.set(addDays(today, d), d);

  const { data: certs, error } = await sb.from('certifications')
    .select('id, worker_id, cert_name, expiry, last_reminded_stage, workers(name, email)')
    .in('expiry', [...targetByDate.keys()]);
  if (error) return json({ error: error.message }, 500);

  let notified = 0, skipped = 0;
  // worker_id -> { name, email, lines: [{ cert, label }] }
  const perWorker = new Map<string, { name: string; email: string; lines: string[] }>();

  for (const c of certs || []) {
    const days = targetByDate.get(c.expiry as string);
    if (days == null) continue;
    // '<expiry>:<stage>' — the column is text, so no DDL. Legacy plain-stage
    // values ('30') never match the new key; worst case is one repeat
    // reminder per cert right after this format lands, then it self-heals.
    const stage = `${c.expiry}:${days}`;
    if (c.last_reminded_stage === stage) { skipped++; continue; }

    const w = (c as any).workers || {};
    const workerName = w.name || 'Worker';
    const label = stageLabel(days);

    await sb.from('notifications').insert([{
      type: 'cert_expiring',
      title: `${workerName}: ${c.cert_name} expires ${label}`,
      body: `Expiry ${c.expiry}. Arrange renewal and upload the new document; the worker has been emailed.`,
      worker_id: c.worker_id,
    }]);

    await sb.from('certifications').update({
      last_reminded_at: new Date().toISOString(),
      last_reminded_stage: stage,
    }).eq('id', c.id);
    notified++;

    if (c.worker_id) {
      const key = String(c.worker_id);
      if (!perWorker.has(key)) perWorker.set(key, { name: workerName, email: (w.email || '').trim(), lines: [] });
      perWorker.get(key)!.lines.push(`<li><strong>${c.cert_name}</strong> — expires ${label} (${c.expiry})</li>`);
    }
  }

  // One summary email per worker per run. Silent skip when Resend is off,
  // the worker has no email, or the send fails — the bell rows already exist.
  let emailed = 0;
  const emailErrors: string[] = [];
  if (RESEND_ON) {
    for (const [, w] of perWorker) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(w.email)) continue;
      const html = `
        <p>Hi ${w.name.split(' ')[0]},</p>
        <p>The following ticket${w.lines.length === 1 ? ' is' : 's are'} coming up for expiry:</p>
        <ul>${w.lines.join('')}</ul>
        <p>Please arrange renewal and send the office a copy of the new certificate so your profile stays current.</p>
        <p style="color:#777;font-size:12px">Sent automatically by the ${BRAND} portal.</p>`;
      try {
        await sendViaResend(w.email, `Certificate expiry reminder — ${BRAND}`, html);
        emailed++;
      } catch (e) {
        emailErrors.push(`${w.email}: ${String((e as Error).message).slice(0, 120)}`);
      }
    }
  }

  return json({
    ok: true,
    date_sydney: today,
    checked: (certs || []).length,
    notified,
    skipped_already_sent: skipped,
    emailed,
    email_skipped_silently: !RESEND_ON,
    ...(emailErrors.length ? { email_errors: emailErrors } : {}),
  });
});
