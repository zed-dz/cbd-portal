// books-chase — one debtor reminder for one open Xero sales invoice.
//
//   POST { xero_id, to?, subject?, body?, cc_me? }
//     → 200 { ok, to, via, chase_id }    the email went out and is logged in books_chases
//     → 200 { ok:false, error, message } nothing was sent (no address, item not open, …)
//
// GATE (verify_jwt = true at the edge, re-checked here): a signed-in MONEY user
// — access_level admin/accounts AND not an allocator — the same line as
// public.is_portal_admin() on the Books tables. Nobody else can chase.
//
// The email itself goes through the portal's existing office email path
// (send-bulk-email, service-role bearer: Resend from the company domain with
// the Gmail fallback), so Books never carries a mail credential of its own.
// Only OPEN items in books_open_items can be chased: a paid invoice is never
// chased, however stale the browser tab. The recipient defaults to the
// client's billing contact (clients.contact_email, matched by Xero contact id
// or name) and may be overridden with a typed address.
// Transaction text from Xero (contact names, numbers) is DATA, never trusted.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;
const BRAND                = Deno.env.get('GMAIL_SENDER_NAME') || 'the office';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const money = (n: number) => `$${Math.abs(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (s: string | null) => {
  if (!s) return '';
  const [y, m, d] = String(s).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

type Me = { id: string; name: string | null; email: string };
async function gate(req: Request): Promise<{ ok: true; me: Me } | { ok: false; status: number; error: string }> {
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return { ok: false, status: 401, error: 'Unauthorized' };
  const { data: { user }, error } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY).auth.getUser(bearer);
  if (error || !user?.email) return { ok: false, status: 401, error: 'Unauthorized' };
  const { data: w } = await createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY).from('workers')
    .select('id, name, access_level, is_allocator').eq('email', user.email.toLowerCase()).is('archived_at', null).maybeSingle();
  const isMoney = !!w && ['admin', 'accounts'].includes(w.access_level || '') && !w.is_allocator;
  if (!isMoney) return { ok: false, status: 403, error: 'Admin or accounts only' };
  return { ok: true, me: { id: w!.id, name: w!.name, email: user.email.toLowerCase() } };
}

export function defaultChase(item: { contact_name: string | null; number: string | null; due_date: string | null; amount_due: number; issue_date: string | null }, daysLate: number, brand: string) {
  const subject = daysLate > 0
    ? `Overdue invoice ${item.number || ''} — ${money(item.amount_due)} (${daysLate} day${daysLate === 1 ? '' : 's'} overdue)`.replace(/\s+/g, ' ').trim()
    : `Invoice ${item.number || ''} — ${money(item.amount_due)} due ${fmtDate(item.due_date)}`.replace(/\s+/g, ' ').trim();
  const body = [
    `A quick note about invoice ${item.number || ''}${item.issue_date ? ` dated ${fmtDate(item.issue_date)}` : ''}.`,
    '',
    daysLate > 0
      ? `The balance of ${money(item.amount_due)} was due on ${fmtDate(item.due_date)} and is now ${daysLate} day${daysLate === 1 ? '' : 's'} overdue.`
      : `The balance of ${money(item.amount_due)} is due on ${fmtDate(item.due_date)}.`,
    '',
    'Could you let us know when we can expect payment, or if anything on the invoice needs fixing on our side?',
    '',
    `Thanks,`,
    brand,
  ].join('\n');
  return { subject, body };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const g = await gate(req);
  if (!g.ok) return json({ error: g.error }, g.status);

  let body: { xero_id?: string; to?: string; subject?: string; body?: string; cc_me?: boolean };
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const xeroId = String(body.xero_id || '').trim();
  if (!xeroId) return json({ ok: false, error: 'missing_id', message: 'Which invoice?' }, 400);

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: item } = await sb.from('books_open_items')
    .select('xero_id, item_type, contact_id, contact_name, number, issue_date, due_date, total, amount_due, is_demo')
    .eq('xero_id', xeroId).eq('item_type', 'ACCREC').maybeSingle();
  if (!item || Number(item.amount_due) <= 0) return json({ ok: false, error: 'not_open', message: 'That invoice is not open any more — nothing to chase.' });

  // Recipient: typed address wins; else the client's billing contact.
  let to = String(body.to || '').trim().toLowerCase();
  let clientId: string | null = null;
  if (!to || !EMAIL_RE.test(to)) {
    let clients: { id: string; name: string; contact_email: string | null }[] = [];
    if (item.contact_id) {
      const { data } = await sb.from('clients').select('id, name, contact_email').is('archived_at', null).eq('xero_contact_id', item.contact_id).limit(5);
      clients = data || [];
    }
    if (!clients.length && item.contact_name) {
      const { data } = await sb.from('clients').select('id, name, contact_email').is('archived_at', null).eq('name', item.contact_name).limit(5);
      clients = data || [];
    }
    const hit = clients.find((c) => c.contact_email && EMAIL_RE.test(c.contact_email)) || clients[0];
    clientId = hit?.id || null;
    to = String(hit?.contact_email || '').trim().toLowerCase();
  }
  if (!to || !EMAIL_RE.test(to)) return json({ ok: false, error: 'no_address', message: 'No billing email for this client — type one, or add it on the Clients page.' });

  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Australia/Sydney' }));
  const daysLate = item.due_date ? Math.round((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.parse(`${item.due_date}T00:00:00Z`)) / 86400000) : 0;
  const def = defaultChase({ ...item, amount_due: Number(item.amount_due) }, daysLate, BRAND);
  const subject = String(body.subject || def.subject).slice(0, 200);
  const text = String(body.body || def.body).slice(0, 5000);

  // Demo rows never email anyone: logged as sent to a demo address.
  let via = 'demo';
  let ok = true;
  let error: string | null = null;
  if (!item.is_demo) {
    const recipients = [{ email: to, name: item.contact_name || undefined }];
    if (body.cc_me) recipients.push({ email: g.me.email, name: g.me.name || undefined });
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-bulk-email`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ recipients, subject, body: text, audience: 'clients', sent_by: g.me.id }),
    });
    const r = await res.json().catch(() => ({}));
    ok = !!r?.ok;
    via = r?.via || 'email';
    error = ok ? null : (r?.firstError || r?.error || `send failed (${res.status})`);
  }

  const { data: chase } = await sb.from('books_chases').insert([{
    open_item_xero_id: item.xero_id, invoice_number: item.number, contact_name: item.contact_name, client_id: clientId,
    kind: 'chase', to_email: to, subject, body: text, status: ok ? 'sent' : 'failed', error, provider: via, sent_by: g.me.email,
  }]).select('id').maybeSingle();

  await sb.from('activity_events').insert([{
    actor_id: g.me.id, actor_name: g.me.name || g.me.email, verb: ok ? 'books chase sent' : 'books chase failed',
    object_type: 'books_open_item', object_id: null, client_id: clientId,
    after: { xero_id: item.xero_id, number: item.number, to, amount_due: Number(item.amount_due), days_late: daysLate, via },
  }]).then(({ error: e }) => { if (e) console.error('activity insert failed:', e.message); });

  if (!ok) return json({ ok: false, error: 'send_failed', message: error, chase_id: chase?.id || null });
  return json({ ok: true, to, via, chase_id: chase?.id || null, subject });
});
