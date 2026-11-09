// books-receipt — reads ONE receipt / bill photo (or PDF page image) from the
// private books-receipts bucket and returns vendor, date, total, GST, ABN.
//
//   POST { path }   → 200 { ok, via, receipt_id, vendor, receipt_date, total, gst, abn, confidence }
//                   → 502 { error:'all_providers_failed', tried }
//
// GATE: money users only (admin/accounts, not an allocator) — the same line as
// is_portal_admin() on books_receipts. The file must sit in the caller's own
// folder (<auth uid>/…) — the bucket policies already enforce that on upload.
//
// Vision chain = the one worker-intake proved on 2026-11-09: Mistral Pixtral
// first, OpenRouter free vision models as backup, Groq if a vision model is
// configured. A row is written to books_receipts (status 'new') so the inbox
// shows the receipt even when no model could read it (fields null, admin types
// them). Nothing here logs the image or a key.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GROQ_API_KEY         = Deno.env.get('GROQ_API_KEY') || '';
const OPENROUTER_API_KEY   = Deno.env.get('OPENROUTER_API_KEY') || '';
const MISTRAL_API_KEY      = Deno.env.get('MISTRAL_API_KEY') || '';
const PORTAL_URL           = Deno.env.get('PORTAL_URL') || 'https://portal';

const BUCKET = 'books-receipts';
const MAX_BYTES = 10 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 40000;
const TOTAL_BUDGET_MS = 110000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const SYSTEM = `You read a photo of an Australian receipt, tax invoice or supplier bill for a construction labour-hire office and return ONE strict JSON object. No prose, no markdown fences.
{"vendor": string|null, "abn": string|null, "receipt_date": "YYYY-MM-DD"|null, "total": number|null, "gst": number|null, "subtotal": number|null, "payment_method": string|null, "items": [{"description": string, "amount": number}], "confidence": 0..1}
Rules:
- vendor is the trading name printed at the top, not the payment processor.
- total is the amount actually paid, including GST. gst is the GST shown; if the document says "GST included" with no figure, gst = round(total/11, 2). If it says GST-free or no GST line, gst = 0.
- Dates on Australian documents are day-first (DD/MM/YYYY). Convert to YYYY-MM-DD. If the year is missing or unclear, lower the confidence.
- ABN is 11 digits; print it without spaces or null.
- Never output card numbers, account numbers or anything not on the document. Transcribe exactly; do not guess digits.
- items: up to 8 lines, descriptions trimmed to 60 characters.`;

type Attempt = { name: string; url: string; key: string; model: string; jsonMode: boolean; extraHeaders?: Record<string, string> };
function providerChain(): Attempt[] {
  const a: Attempt[] = [];
  const or = 'https://openrouter.ai/api/v1/chat/completions';
  const orHeaders = { 'HTTP-Referer': PORTAL_URL, 'X-Title': 'Portal books receipt' };
  if (MISTRAL_API_KEY)    a.push({ name: 'mistral:pixtral-12b', url: 'https://api.mistral.ai/v1/chat/completions', key: MISTRAL_API_KEY, model: 'pixtral-12b-2409', jsonMode: true });
  if (OPENROUTER_API_KEY) a.push({ name: 'openrouter:gemma-4-31b', url: or, key: OPENROUTER_API_KEY, model: 'google/gemma-4-31b-it:free', jsonMode: false, extraHeaders: orHeaders });
  if (OPENROUTER_API_KEY) a.push({ name: 'openrouter:nemotron-3.5-super-vl', url: or, key: OPENROUTER_API_KEY, model: 'nvidia/nemotron-3.5-super-vl:free', jsonMode: false, extraHeaders: orHeaders });
  if (GROQ_API_KEY && Deno.env.get('GROQ_VISION_MODEL')) a.push({ name: 'groq:vision', url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_API_KEY, model: Deno.env.get('GROQ_VISION_MODEL')!, jsonMode: true });
  return a;
}

function parseJsonLoose(text: string): unknown {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no json object');
  return JSON.parse(t.slice(a, b + 1));
}

type OnceResult = { ok: true; parsed: unknown } | { ok: false; status: number; detail: string };
async function callOnce(a: Attempt, dataUrl: string, withJsonMode: boolean, deadline: number): Promise<OnceResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(1000, Math.min(PROVIDER_TIMEOUT_MS, deadline - Date.now())));
  try {
    const body: Record<string, unknown> = {
      model: a.model, temperature: 0.1, max_tokens: 1200,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: [{ type: 'text', text: 'Read this receipt and return the JSON.' }, { type: 'image_url', image_url: { url: dataUrl } }] }],
    };
    if (withJsonMode) body.response_format = { type: 'json_object' };
    const res = await fetch(a.url, { method: 'POST', signal: ctl.signal, headers: { Authorization: `Bearer ${a.key}`, 'Content-Type': 'application/json', ...(a.extraHeaders || {}) }, body: JSON.stringify(body) });
    if (!res.ok) return { ok: false, status: res.status, detail: (await res.text().catch(() => '')).slice(0, 200) };
    const d = await res.json();
    const text = String(d?.choices?.[0]?.message?.content ?? '');
    if (!text.trim()) return { ok: false, status: 0, detail: 'empty' };
    return { ok: true, parsed: parseJsonLoose(text) };
  } catch (e) {
    return { ok: false, status: 0, detail: (e as Error).name === 'AbortError' ? 'timeout' : `error:${(e as Error).message.slice(0, 120)}` };
  } finally { clearTimeout(timer); }
}

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
function toISODate(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim(); if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`;
  return null;
}
const numOrNull = (v: unknown) => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(String(v).replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };

export function normalise(parsed: unknown) {
  const o = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const total = numOrNull(o.total);
  let gst = numOrNull(o.gst);
  if (gst === null && total !== null) gst = Math.round((total / 11) * 100) / 100;
  const abn = String(o.abn ?? '').replace(/\D/g, '');
  return {
    vendor: o.vendor ? String(o.vendor).slice(0, 120) : null,
    abn: abn.length === 11 ? abn : null,
    receipt_date: toISODate(o.receipt_date),
    total, gst,
    subtotal: numOrNull(o.subtotal) ?? (total !== null && gst !== null ? Math.round((total - gst) * 100) / 100 : null),
    payment_method: o.payment_method ? String(o.payment_method).slice(0, 40) : null,
    items: Array.isArray(o.items) ? o.items.slice(0, 8).map((it: Record<string, unknown>) => ({ description: String(it?.description ?? '').slice(0, 60), amount: numOrNull(it?.amount) })) : [],
    confidence: Math.max(0, Math.min(1, Number(o.confidence) || 0)),
  };
}

const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
function b64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)) as unknown as number[]);
  return btoa(s);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const started = Date.now(); const deadline = started + TOTAL_BUDGET_MS;
  try {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!jwt) return json({ error: 'unauthorized' }, 401);
    const { data: ud, error: ue } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY).auth.getUser(jwt);
    const user = ud?.user;
    if (ue || !user?.id || !user.email) return json({ error: 'unauthorized' }, 401);
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: me } = await sb.from('workers').select('id, name, access_level, is_allocator').eq('email', user.email.toLowerCase()).is('archived_at', null).maybeSingle();
    const isMoney = !!me && ['admin', 'accounts'].includes(me.access_level || '') && !me.is_allocator;
    if (!isMoney) return json({ error: 'not_money', message: 'Admin or accounts only.' }, 403);

    let body: { path?: unknown } = {};
    try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const path = typeof body.path === 'string' ? body.path : '';
    if (!path || !path.startsWith(`${user.id}/`) || path.includes('..')) return json({ error: 'forbidden_path', message: 'That file is not yours to read.' }, 403);
    const ext = (path.split('.').pop() || '').toLowerCase();
    const isPdf = ext === 'pdf';
    if (!isPdf && !MIME[ext]) return json({ error: 'bad_type', message: 'Use a JPG, PNG, WEBP photo or a PDF.' }, 415);

    // Row first, so the inbox shows the receipt even if no model can read it.
    const { data: row, error: rowErr } = await sb.from('books_receipts')
      .upsert([{ path, uploaded_by: user.email.toLowerCase(), status: 'new' }], { onConflict: 'path' }).select('id').maybeSingle();
    if (rowErr) return json({ error: 'db', message: rowErr.message }, 500);

    if (isPdf) {
      // No PDF rasteriser in the edge runtime: keep the file, let the admin type the figures.
      return json({ ok: true, via: 'none', receipt_id: row?.id, vendor: null, receipt_date: null, total: null, gst: null, abn: null, confidence: 0, note: 'PDF stored — type the vendor, date and total (photos are read automatically).' });
    }

    const { data: file, error: dlErr } = await sb.storage.from(BUCKET).download(path);
    if (dlErr || !file) return json({ error: 'download_failed', message: dlErr?.message || 'not found' }, 400);
    if (file.size > MAX_BYTES) return json({ error: 'too_large', message: 'Over 10 MB.' }, 413);
    const dataUrl = `data:${MIME[ext]};base64,${b64(new Uint8Array(await file.arrayBuffer()))}`;

    const attempts = providerChain();
    if (!attempts.length) return json({ ok: true, via: 'none', receipt_id: row?.id, vendor: null, receipt_date: null, total: null, gst: null, abn: null, confidence: 0, note: 'No vision model key is configured — type the figures.' });
    const tried: string[] = [];
    let result: ReturnType<typeof normalise> | null = null; let via = 'none';
    for (const a of attempts) {
      if (Date.now() > deadline - 8000) { tried.push(`${a.name}:budget`); continue; }
      let r = await callOnce(a, dataUrl, a.jsonMode, deadline);
      if (!r.ok && r.status === 400 && a.jsonMode) r = await callOnce(a, dataUrl, false, deadline);
      if (!r.ok) { tried.push(`${a.name}:${r.status || r.detail}`); continue; }
      try { result = normalise(r.parsed); via = a.name; break; } catch { tried.push(`${a.name}:bad_json`); }
    }
    if (!result) return json({ error: 'all_providers_failed', message: 'Could not read the photo — type the vendor, date and total.', tried, receipt_id: row?.id }, 502);

    await sb.from('books_receipts').update({
      vendor: result.vendor, receipt_date: result.receipt_date, total: result.total, gst: result.gst, abn: result.abn,
      extracted: { ...result, tried }, via,
    }).eq('id', row!.id);

    await sb.from('activity_events').insert([{
      actor_id: me!.id, actor_name: me!.name || user.email, verb: 'books receipt read', object_type: 'books_receipt', object_id: row!.id,
      after: { via, confidence: result.confidence, has_total: result.total !== null, ms: Date.now() - started },
    }]).then(({ error }) => { if (error) console.error('activity insert failed:', error.message); });

    return json({ ok: true, via, tried, receipt_id: row!.id, ...result });
  } catch (e) {
    console.error('books-receipt failed:', (e as Error).message);
    return json({ error: 'server_error', message: (e as Error).message }, 500);
  }
});
