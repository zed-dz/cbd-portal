// send-push — internal fan-out of one Web Push message to workers and/or the office.
//
// INTERNAL ONLY. verify_jwt = false; the caller must present EITHER
//   • Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>   (other edge functions), OR
//   • x-digest-secret: <DIGEST_SECRET>                      (pg_cron / ops scripts).
// Anything else is 401. No user JWT path on purpose — the browser never calls this;
// `push-on-allocation` (office-gated) is the user-facing door.
//
// Request:  POST {
//             worker_ids?: uuid[],      // push these workers' devices
//             office?: boolean,         // push every office user's devices (workers.role='admin', not archived)
//             title: string,            // ≤ 80 chars
//             body?: string,            // ≤ 300 chars
//             url?: string,             // path or absolute URL to open on tap (default '/')
//             tag?: string              // collapse key (same tag = replace previous)
//           }
// Response: 200 { ok: true, sent, failed, removed, recipients, no_subscriptions?: true }
//           400 { error: 'invalid_json' | 'missing_title' | 'no_targets' }
//           401 { error: 'unauthorized' } · 503 { error: 'not_configured' } · 500 { error: 'server_error' }
//
// Dead subscriptions (push service answers 404/410) are deleted on the spot.
// The payload is encrypted end-to-end (RFC 8291); Google/Apple/Mozilla only relay bytes.
// Nothing about money, phone numbers or emails is ever in a push body — callers only
// pass short operational text. No endpoint or key appears in the response or logs.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendWebPush, type VapidKeys } from './webpush.ts';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const DIGEST_SECRET        = Deno.env.get('DIGEST_SECRET') || '';
const VAPID: VapidKeys = {
  publicKey:  Deno.env.get('VAPID_PUBLIC_KEY')  || '',
  privateKey: Deno.env.get('VAPID_PRIVATE_KEY') || '',
  subject:    Deno.env.get('VAPID_SUBJECT')     || 'mailto:theteamcbd@gmail.com',
};
const PORTAL_URL = Deno.env.get('PORTAL_URL') || 'https://cbd-portal-gray.vercel.app';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-digest-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function callerAllowed(req: Request): boolean {
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (bearer && SUPABASE_SERVICE_KEY && bearer === SUPABASE_SERVICE_KEY) return true;
  const digest = req.headers.get('x-digest-secret') || '';
  if (digest && DIGEST_SECRET && digest === DIGEST_SECRET) return true;
  return false;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);
  if (!callerAllowed(req))      return json({ error: 'unauthorized' }, 401);
  if (!VAPID.publicKey || !VAPID.privateKey) return json({ error: 'not_configured' }, 503);

  try {
    let body: any;
    try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

    const title = String(body?.title || '').trim().slice(0, 80);
    if (!title) return json({ error: 'missing_title' }, 400);
    const text  = String(body?.body || '').trim().slice(0, 300);
    const tag   = body?.tag ? String(body.tag).slice(0, 32) : undefined;
    let url     = String(body?.url || '/').trim();
    if (!/^https?:\/\//.test(url)) url = PORTAL_URL.replace(/\/$/, '') + (url.startsWith('/') ? url : `/${url}`);

    const workerIds: string[] = Array.isArray(body?.worker_ids)
      ? Array.from(new Set(body.worker_ids.filter((x: unknown) => typeof x === 'string' && UUID_RE.test(x))))
      : [];
    const office = body?.office === true;
    if (!workerIds.length && !office) return json({ error: 'no_targets' }, 400);

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Resolve the target worker set.
    const targets = new Set<string>(workerIds);
    if (office) {
      const { data: admins, error } = await sb.from('workers').select('id').eq('role', 'admin').is('archived_at', null);
      if (error) throw error;
      for (const a of admins || []) targets.add(String(a.id));
    }
    if (!targets.size) return json({ ok: true, sent: 0, failed: 0, removed: 0, recipients: 0, no_subscriptions: true });

    const { data: subs, error: subErr } = await sb.from('push_subscriptions')
      .select('id, worker_id, endpoint, p256dh, auth')
      .in('worker_id', Array.from(targets));
    if (subErr) throw subErr;
    if (!subs?.length) return json({ ok: true, sent: 0, failed: 0, removed: 0, recipients: 0, no_subscriptions: true });

    const payload = JSON.stringify({ title, body: text, url, tag });
    let sent = 0, failed = 0, removed = 0;
    const dead: string[] = [];
    const seen = new Set<string>();

    // Modest concurrency: a handful of devices per worker, dozens at most.
    const queue = [...subs];
    const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
      while (queue.length) {
        const s = queue.shift()!;
        const r = await sendWebPush({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, payload, VAPID, { ttl: 24 * 3600, urgency: 'high', topic: tag });
        if (r.ok) { sent++; seen.add(String(s.worker_id)); }
        else if (r.gone) { removed++; dead.push(s.id); }
        else { failed++; console.error(`push failed ${r.status} ${r.detail || ''}`.trim()); }
      }
    });
    await Promise.all(workers);

    if (dead.length) {
      try { await sb.from('push_subscriptions').delete().in('id', dead); }
      catch (e) { console.error('dead subscription cleanup failed:', (e as Error).message); }
    }

    return json({ ok: true, sent, failed, removed, recipients: seen.size });
  } catch (e) {
    console.error('send-push failed:', (e as Error)?.message);
    return json({ error: 'server_error' }, 500);
  }
});
