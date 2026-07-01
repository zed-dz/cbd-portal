// Daily allocation digest.
//
// Triggered once a day by pg_cron (via pg_net). For each admin who chose
// "daily_digest" mode with the Email channel on, this emails a single summary
// of the day's allocation events (new / accepted / declined) instead of the
// per-event emails those admins have opted out of.
//
// Runs with verify_jwt=false and is guarded by a shared DIGEST_SECRET header so
// only the cron job (which knows the secret) can trigger it.
//
// Email goes via Resend directly (RESEND_API_KEY) because there is no user JWT
// in a cron context. On the Resend free tier delivery is limited to the Resend
// account address until a sending domain is verified — same limitation as the
// app's other outbound email.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const INVITE_FROM    = Deno.env.get('INVITE_FROM') || 'CBD Plant & Labour <onboarding@resend.dev>';
const DIGEST_SECRET  = Deno.env.get('DIGEST_SECRET') || '';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-digest-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (DIGEST_SECRET && req.headers.get('x-digest-secret') !== DIGEST_SECRET) return json({ error: 'unauthorized' }, 401);

  const supa = createClient(SUPABASE_URL, SERVICE_KEY);

  // Last 24h of allocation events.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: events } = await supa
    .from('notifications')
    .select('type, title, body, created_at')
    .like('type', 'allocation%')
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  const list = events || [];

  const { data: admins } = await supa
    .from('workers')
    .select('name, email, access_level, notify_mode, notify_email')
    .eq('access_level', 'admin');
  const recipients = (admins || []).filter((a: any) =>
    (a.notify_mode || 'per_event') === 'daily_digest' &&
    a.notify_email !== false &&
    a.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email)
  );

  if (!recipients.length) return json({ ok: true, sent: 0, note: 'no digest-mode admins', events: list.length });
  if (!list.length)       return json({ ok: true, sent: 0, note: 'no allocation events in the last 24h' });

  const lines   = list.map((e: any) => `• ${e.title || e.type}${e.body ? ` — ${e.body}` : ''}`).join('\n');
  const subject = `Daily allocation digest — ${list.length} event${list.length === 1 ? '' : 's'}`;
  const text    = `Here's a summary of the last day's allocation activity:\n\n${lines}\n\n— CBD Plant & Labour`;

  if (!RESEND_API_KEY) return json({ ok: false, error: 'email_not_configured', recipients: recipients.length });

  let sent = 0;
  const results: Array<{ email: string; ok: boolean; error?: string }> = [];
  for (const r of recipients) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: INVITE_FROM, to: [r.email], subject, text }),
      });
      const ok = res.ok;
      if (ok) sent++;
      results.push({ email: r.email, ok });
    } catch (e) {
      results.push({ email: r.email, ok: false, error: (e as Error).message });
    }
  }
  return json({ ok: sent > 0, sent, recipients: recipients.length, events: list.length, results });
});
