// push-on-allocation — office-triggered push to the worker(s) on newly created
// allocations ("New job: <client> — <site>, starts DD/MM. Tap to accept.").
//
// verify_jwt = true. The caller must be an OFFICE user (workers.role = 'admin',
// not archived — same rule as public.is_office_user()). It never takes free text:
// the message is built server-side from the allocation rows, and only the worker
// on each allocation is pushed. The actual delivery is delegated to `send-push`
// with the service key, so the VAPID private key stays in one function.
//
// Request:  POST { allocation_ids: uuid[] }        (1–50 ids)
// Response: 200 { ok: true, allocations, sent, failed, removed, recipients, no_subscriptions? }
//           400 { error: 'invalid_json' | 'invalid_allocation_ids' }
//           401 { error: 'unauthorized' } · 403 { error: 'office_only' }
//           404 { error: 'allocations_not_found' } · 500 { error: 'server_error' }
//
// Merger wiring (one line, after the allocation insert returns its rows):
//   supabase.functions.invoke('push-on-allocation', { body: { allocation_ids: rows.map(r => r.id) } }).catch(() => {});

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ddmm(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return 'TBC';
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  try {
    // Caller: user JWT → workers row by email → must be office.
    const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!jwt) return json({ error: 'unauthorized' }, 401);
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: userData, error: userErr } = await anon.auth.getUser(jwt);
    const email = userData?.user?.email?.trim().toLowerCase();
    if (userErr || !email) return json({ error: 'unauthorized' }, 401);

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: caller } = await sb.from('workers').select('id, role, archived_at').eq('email', email).maybeSingle();
    if (!caller || caller.role !== 'admin' || caller.archived_at) return json({ error: 'office_only' }, 403);

    let body: any;
    try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const ids: string[] = Array.isArray(body?.allocation_ids)
      ? Array.from(new Set(body.allocation_ids.filter((x: unknown) => typeof x === 'string' && UUID_RE.test(x))))
      : [];
    if (!ids.length || ids.length > 50) return json({ error: 'invalid_allocation_ids' }, 400);

    const { data: allocs, error: aErr } = await sb.from('allocations')
      .select('id, worker_id, client, site, role, start_date, status')
      .in('id', ids);
    if (aErr) throw aErr;
    const rows = (allocs || []).filter((a: any) => a.worker_id);
    if (!rows.length) return json({ error: 'allocations_not_found' }, 404);

    // One push per worker (a crew booking may create several allocations per person).
    const byWorker = new Map<string, any[]>();
    for (const a of rows) {
      const list = byWorker.get(String(a.worker_id)) || [];
      list.push(a); byWorker.set(String(a.worker_id), list);
    }

    let sent = 0, failed = 0, removed = 0, recipients = 0, anySubs = false;
    for (const [workerId, list] of byWorker) {
      const a = list[0];
      const where = [a.client, a.site].filter(Boolean).join(' — ') || 'a new job';
      const title = list.length > 1 ? `${list.length} new jobs` : 'New job';
      const text = `${where}${a.role ? ` · ${a.role}` : ''}, starts ${ddmm(a.start_date)}. Tap to accept.`;
      const res = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ worker_ids: [workerId], title, body: text, url: '/', tag: `alloc-${a.id}` }),
      });
      const r = await res.json().catch(() => ({}));
      if (res.ok) {
        sent += r.sent || 0; failed += r.failed || 0; removed += r.removed || 0; recipients += r.recipients || 0;
        if (!r.no_subscriptions) anySubs = true;
      } else {
        failed++;
        console.error('send-push call failed:', res.status, r?.error || '');
      }
    }

    try {
      await sb.from('activity_events').insert([{
        actor_id: caller.id, actor_name: 'office', verb: 'pushed', object_type: 'allocation', object_id: rows[0].id,
        after: { allocation_ids: rows.map((r: any) => r.id), workers: byWorker.size, sent, failed, removed },
      }]);
    } catch (e) { console.error('activity insert failed:', (e as Error).message); }

    return json({ ok: true, allocations: rows.length, sent, failed, removed, recipients, ...(anySubs ? {} : { no_subscriptions: true }) });
  } catch (e) {
    console.error('push-on-allocation failed:', (e as Error)?.message);
    return json({ error: 'server_error' }, 500);
  }
});
