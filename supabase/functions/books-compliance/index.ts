// books-compliance — daily cron (books-compliance-daily, 20:05 UTC) that puts a
// bell notification in front of the admins 14 days and 3 days before each ATO
// obligation: BAS (quarterly or monthly per books_settings), PAYG withholding,
// super guarantee (quarterly for periods to 30 Jun 2026, Payday Super after).
//
//   POST {}  with header x-digest-secret == DIGEST_SECRET   (verify_jwt = false)
//   POST { preview: true } with a MONEY user's bearer         → the list, no writes
//   → 200 { ok, today, obligations: [...], notified: [...] }
//
// Amounts come from the compliance snapshot the Books page computed last
// (books_snapshots.key = 'compliance'); dates are computed here. One
// notification per (obligation, lead) — books_compliance_notified dedupes.
// Fails closed: no DIGEST_SECRET → 503.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { upcomingObligations, reminderLeads } from './compliance.ts';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;
const DIGEST_SECRET        = Deno.env.get('DIGEST_SECRET') || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-digest-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const todaySydney = () => {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Australia/Sydney' }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const money = (n: number | null) => n === null || n === undefined ? '' : ` · about $${Math.abs(Number(n)).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (s: string) => { const [y, m, d] = s.split('-'); return `${d}/${m}/${y}`; };

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body: { preview?: boolean } = {};
  try { body = await req.json(); } catch { body = {}; }

  const digest = req.headers.get('x-digest-secret');
  let preview = false;
  if (digest !== null) {
    if (!DIGEST_SECRET) return json({ error: 'not_configured' }, 503);
    if (digest !== DIGEST_SECRET) return json({ error: 'unauthorized' }, 401);
  } else {
    // A money user may preview the list (no writes).
    const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!bearer) return json({ error: 'unauthorized' }, 401);
    if (bearer !== SUPABASE_SERVICE_KEY) {
      const { data: { user }, error } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY).auth.getUser(bearer);
      if (error || !user?.email) return json({ error: 'unauthorized' }, 401);
      const { data: w } = await createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY).from('workers').select('access_level, is_allocator').eq('email', user.email.toLowerCase()).is('archived_at', null).maybeSingle();
      if (!w || !['admin', 'accounts'].includes(w.access_level || '') || w.is_allocator) return json({ error: 'forbidden' }, 403);
      preview = true;
    } else preview = !!body.preview;
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const today = todaySydney();
  const [{ data: settings }, { data: snap }] = await Promise.all([
    sb.from('books_settings').select('bas_cycle, payg_cycle, payroll_frequency, payroll_weekday').eq('id', 1).maybeSingle(),
    sb.from('books_snapshots').select('payload, computed_at').eq('key', 'compliance').maybeSingle(),
  ]);
  const est = (snap?.payload as { estimates?: Record<string, number> } | null)?.estimates || {};
  const obligations = upcomingObligations(today, settings || {}, est, 3);

  const notified: string[] = [];
  if (!preview) {
    for (const o of obligations) {
      for (const lead of reminderLeads(o.days_left)) {
        const key = `${o.key}:${lead}`;
        const { data: seen } = await sb.from('books_compliance_notified').select('key').eq('key', key).maybeSingle();
        if (seen) continue;
        const title = `${o.label} due ${fmtDate(o.due)}`;
        const bodyText = `${lead} day${lead === 1 ? '' : 's'} to go${money(o.amount ?? null)}${o.amount !== null && o.amount !== undefined ? ' (estimate from the Books page)' : ''}. Open Books › Compliance.`;
        const { error } = await sb.from('notifications').insert([{ type: 'books', title, body: bodyText }]);
        if (error) { console.error('notification insert failed:', error.message); continue; }
        await sb.from('books_compliance_notified').insert([{ key }]);
        notified.push(key);
      }
    }
    if (notified.length) {
      await sb.from('activity_events').insert([{ actor_id: null, actor_name: 'system', verb: 'books compliance reminder', object_type: 'books', object_id: null, after: { notified } }])
        .then(({ error }) => { if (error) console.error('activity insert failed:', error.message); });
    }
  }
  return json({ ok: true, today, preview, snapshot_at: snap?.computed_at || null, obligations, notified });
});
