// gmail-modify — toggle read/unread, star/unstar, archive/unarchive on a
// thread. Mirrors the change to Gmail via labels.modify, then to the local
// email_threads row so the UI reflects the new state without waiting for a
// full sync.
//
// POST { thread_id: <local UUID>, action: 'mark_read'|'mark_unread'|'star'|'unstar'|'archive'|'unarchive' }
// →   { ok: true, thread: { ...updated row } }

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GMAIL_CLIENT_ID      = Deno.env.get('GMAIL_CLIENT_ID')  || '';
const GMAIL_CLIENT_SECRET  = Deno.env.get('GMAIL_CLIENT_SECRET') || '';

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

async function getValidAccessToken(supa: ReturnType<typeof createClient>) {
  const { data: row } = await supa.from('gmail_tokens').select('*').eq('id', 1).maybeSingle();
  if (!row) throw new Error('not_connected');
  const expired = new Date(row.expires_at).getTime() < Date.now() + 30_000;
  if (!expired) return { accessToken: row.access_token };
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) throw new Error('not_configured');

  const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: row.refresh_token,
      grant_type:    'refresh_token',
    }),
  });
  if (!refreshRes.ok) throw new Error('refresh_failed');
  const t = await refreshRes.json();
  const newExpires = new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString();
  await supa.from('gmail_tokens').update({
    access_token: t.access_token,
    expires_at:   newExpires,
    updated_at:   new Date().toISOString(),
  }).eq('id', 1);
  return { accessToken: t.access_token };
}

interface Action {
  add:    string[];
  remove: string[];
  patch:  Record<string, unknown>;
}

function actionToLabels(action: string): Action | null {
  switch (action) {
    case 'mark_read':   return { add: [],           remove: ['UNREAD'],   patch: { unread: false } };
    case 'mark_unread': return { add: ['UNREAD'],   remove: [],           patch: { unread: true } };
    case 'star':        return { add: ['STARRED'],  remove: [],           patch: { starred: true } };
    case 'unstar':      return { add: [],           remove: ['STARRED'],  patch: { starred: false } };
    case 'archive':     return { add: [],           remove: ['INBOX'],    patch: { archived: true } };
    case 'unarchive':   return { add: ['INBOX'],    remove: [],           patch: { archived: false } };
    default: return null;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }

  const { thread_id, action } = body || {};
  if (!thread_id || !action) return json({ error: 'thread_id and action required' }, 400);

  const mapped = actionToLabels(action);
  if (!mapped) return json({ error: `unknown action: ${action}` }, 400);

  const { data: threadRow } = await supa
    .from('email_threads')
    .select('id, gmail_thread_id')
    .eq('id', thread_id)
    .maybeSingle();
  if (!threadRow) return json({ error: 'thread_not_found' }, 404);

  let accessToken: string;
  try {
    const t = await getValidAccessToken(supa);
    accessToken = t.accessToken;
  } catch (e) {
    const m = (e as Error).message;
    return json({ error: m }, m === 'not_connected' ? 412 : 500);
  }

  if (threadRow.gmail_thread_id) {
    const modRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadRow.gmail_thread_id}/modify`,
      {
        method: 'POST',
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          addLabelIds:    mapped.add,
          removeLabelIds: mapped.remove,
        }),
      }
    );
    if (!modRes.ok) {
      const detail = (await modRes.text()).slice(0, 200);
      return json({ error: 'gmail_modify_failed', detail }, modRes.status);
    }
  }

  const { data: updated, error: upErr } = await supa
    .from('email_threads')
    .update({ ...mapped.patch, updated_at: new Date().toISOString() })
    .eq('id', thread_id)
    .select()
    .single();

  if (upErr) return json({ error: upErr.message }, 500);

  return json({ ok: true, thread: updated });
});
