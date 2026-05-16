// Pulls recent threads from Gmail and mirrors them into email_threads /
// email_messages. Matches participants against workers.email and
// clients.contact_email so the UI can show "this is from <Worker Name>".
//
// POST → { synced_threads: number, new_messages: number }
//
// Designed to be cheap to call frequently — uses Gmail's `q=newer_than:<n>d`
// to limit the working set, and skips messages we've already cached by id.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GMAIL_CLIENT_ID      = Deno.env.get('GMAIL_CLIENT_ID')  || '';
const GMAIL_CLIENT_SECRET  = Deno.env.get('GMAIL_CLIENT_SECRET') || '';

const SYNC_DAYS = 30;   // pull threads from the last 30 days
const MAX_THREADS = 60; // cap per call

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
  if (!expired) return { accessToken: row.access_token, emailAddress: row.email_address };
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
  return { accessToken: t.access_token, emailAddress: row.email_address };
}

function decodeB64Url(s: string) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  try { return new TextDecoder('utf-8').decode(Uint8Array.from(bin, c => c.charCodeAt(0))); }
  catch { return bin; }
}

function header(msg: any, name: string): string {
  const headers: Array<{ name: string; value: string }> = msg?.payload?.headers || [];
  const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

function parseAddressList(s: string): string[] {
  if (!s) return [];
  return s.split(',').map(p => {
    const m = p.match(/<([^>]+)>/);
    return (m ? m[1] : p).trim().toLowerCase();
  }).filter(Boolean);
}

function parseFrom(s: string): { name: string; email: string } {
  const m = s.match(/^(.*?)<([^>]+)>$/);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, ''), email: m[2].trim().toLowerCase() };
  return { name: '', email: (s || '').trim().toLowerCase() };
}

// Walks the Gmail payload tree and concatenates text/plain and text/html parts.
function extractBodies(payload: any): { text: string; html: string; hasAttachments: boolean } {
  let text = '', html = '', hasAttachments = false;
  const walk = (part: any) => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) hasAttachments = true;
    const mime = part.mimeType || '';
    const data = part.body?.data;
    if (data) {
      if (mime === 'text/plain' && !text) text = decodeB64Url(data);
      else if (mime === 'text/html' && !html) html = decodeB64Url(data);
    }
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  return { text, html, hasAttachments };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  let accessToken: string;
  let myEmail:     string | null;
  try {
    const t = await getValidAccessToken(supa);
    accessToken = t.accessToken;
    myEmail     = t.emailAddress;
  } catch (e) {
    const m = (e as Error).message;
    return json({ error: m }, m === 'not_connected' ? 412 : 500);
  }

  // Step 1 — list recent threads
  const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/threads');
  listUrl.searchParams.set('q', `newer_than:${SYNC_DAYS}d`);
  listUrl.searchParams.set('maxResults', String(MAX_THREADS));
  const listRes = await fetch(listUrl.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!listRes.ok) {
    return json({ error: 'gmail_list_failed', detail: (await listRes.text()).slice(0, 200) }, listRes.status);
  }
  const listData = await listRes.json();
  const threads = listData.threads || [];

  // Pre-load worker/client emails for participant matching
  const [{ data: workers }, { data: clients }] = await Promise.all([
    supa.from('workers').select('id, email').not('email', 'is', null),
    supa.from('clients').select('id, contact_email').not('contact_email', 'is', null),
  ]);
  const workerByEmail = new Map<string, string>();
  workers?.forEach((w: any) => { if (w.email) workerByEmail.set(w.email.toLowerCase(), w.id); });
  const clientByEmail = new Map<string, string>();
  clients?.forEach((c: any) => { if (c.contact_email) clientByEmail.set(c.contact_email.toLowerCase(), c.id); });

  // Pre-load already-cached message ids so we don't re-process
  const { data: existingMsgs } = await supa
    .from('email_messages').select('gmail_message_id')
    .order('received_at', { ascending: false }).limit(1000);
  const seenIds = new Set((existingMsgs || []).map((m: any) => m.gmail_message_id));

  let syncedThreads = 0;
  let newMessages = 0;

  for (const t of threads) {
    const threadRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${t.id}?format=full`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!threadRes.ok) continue;
    const thread = await threadRes.json();
    const msgs = thread.messages || [];
    if (!msgs.length) continue;

    const participants = new Set<string>();
    let workerId: string | null = null;
    let clientId: string | null = null;
    let subject = '';
    let unread = false;
    let lastMessageAt: string | null = null;

    for (const m of msgs) {
      const fromHdr = header(m, 'From');
      const from    = parseFrom(fromHdr);
      const toList  = parseAddressList(header(m, 'To'));
      const ccList  = parseAddressList(header(m, 'Cc'));
      subject = subject || header(m, 'Subject');

      [from.email, ...toList, ...ccList].forEach(e => { if (e && e !== myEmail) participants.add(e); });
      if (!workerId) for (const e of [from.email, ...toList, ...ccList]) {
        if (workerByEmail.has(e)) { workerId = workerByEmail.get(e)!; break; }
      }
      if (!clientId) for (const e of [from.email, ...toList, ...ccList]) {
        if (clientByEmail.has(e)) { clientId = clientByEmail.get(e)!; break; }
      }
      if ((m.labelIds || []).includes('UNREAD')) unread = true;
      const ts = parseInt(m.internalDate, 10);
      if (!isNaN(ts)) {
        const iso = new Date(ts).toISOString();
        if (!lastMessageAt || iso > lastMessageAt) lastMessageAt = iso;
      }
    }

    // Privacy: only mirror threads that involve a known worker or client.
    // Personal mail (newsletters, friends, etc.) is intentionally skipped so
    // the portal Inbox stays scoped to business conversations.
    if (!workerId && !clientId) continue;

    // Upsert the thread by gmail_thread_id
    const threadPayload = {
      gmail_thread_id: t.id,
      subject:         subject || '(no subject)',
      participants:    [...participants],
      last_message_at: lastMessageAt,
      unread,
      worker_id:       workerId,
      client_id:       clientId,
      updated_at:      new Date().toISOString(),
    };
    let { data: existing } = await supa.from('email_threads').select('id').eq('gmail_thread_id', t.id).maybeSingle();
    let localThreadId = existing?.id;
    if (!localThreadId) {
      const { data: created } = await supa.from('email_threads').insert(threadPayload).select('id').single();
      localThreadId = created?.id;
    } else {
      await supa.from('email_threads').update(threadPayload).eq('id', localThreadId);
    }
    if (!localThreadId) continue;
    syncedThreads++;

    // Insert any new messages we haven't cached yet
    const newRows: any[] = [];
    for (const m of msgs) {
      if (seenIds.has(m.id)) continue;
      const fromHdr = header(m, 'From');
      const from    = parseFrom(fromHdr);
      const toList  = parseAddressList(header(m, 'To'));
      const ccList  = parseAddressList(header(m, 'Cc'));
      const { text, html, hasAttachments } = extractBodies(m.payload);
      const ts = parseInt(m.internalDate, 10);
      const isOutbound = from.email === myEmail;
      newRows.push({
        thread_id:        localThreadId,
        gmail_message_id: m.id,
        direction:        isOutbound ? 'outbound' : 'inbound',
        from_email:       from.email,
        from_name:        from.name,
        to_emails:        toList,
        cc_emails:        ccList,
        subject:          header(m, 'Subject'),
        body_text:        text || (m.snippet || ''),
        body_html:        html || null,
        snippet:          m.snippet || (text || '').slice(0, 200),
        has_attachments:  hasAttachments,
        sent_at:          isNaN(ts) ? null : new Date(ts).toISOString(),
      });
      seenIds.add(m.id);
    }
    if (newRows.length) {
      const { error: insErr } = await supa.from('email_messages').insert(newRows);
      if (insErr) console.error('email_messages insert failed:', insErr);
      else newMessages += newRows.length;
    }
  }

  return json({ ok: true, synced_threads: syncedThreads, new_messages: newMessages });
});
