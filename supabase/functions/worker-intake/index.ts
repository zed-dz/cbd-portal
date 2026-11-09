// worker-intake — read a new hire's paperwork photos with a vision model and
// hand back the worker profile as JSON so the Add Worker form can be pre-filled.
//
// Flow (2026-11-09): the office uploads photos (employment form, driver licence,
// white card, plant tickets, Statements of Attainment) to the PRIVATE
// `worker-intake` bucket under their own auth uid, then calls this with the
// object paths. Nothing from the images is stored by this function: it returns
// the fields and the caller decides what to save. The uploads stay in place so
// the form can attach each ticket's photo to the ticket row.
//
// Rules that matter:
//  * Caller must be an office user — the same public.is_office_user() test the
//    portal's RLS uses, evaluated with the caller's own JWT. Workers get 403.
//  * Only paths under the caller's own uid folder are read.
//  * TFN, bank BSB / account numbers, super member numbers, passport numbers and
//    Medicare numbers are NEVER extracted: the prompt says to ignore them and
//    any key matching them is stripped from the model's answer before it leaves.
//  * No face crop, no photo_url. The activity log gets counts only.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GROQ_API_KEY         = Deno.env.get('GROQ_API_KEY') || '';
const OPENROUTER_API_KEY   = Deno.env.get('OPENROUTER_API_KEY') || '';
const MISTRAL_API_KEY      = Deno.env.get('MISTRAL_API_KEY') || '';

const BUCKET        = 'worker-intake';
const MAX_IMAGES    = 12;
const MAX_BYTES     = 8 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 45000;
const TOTAL_BUDGET_MS     = 125000;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-digest-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const sydneyDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(d);

// ── Fields ─────────────────────────────────────────────────────────────────
const FIELDS = [
  'name', 'preferred_name', 'email', 'mobile', 'alternate_phone', 'date_of_birth', 'gender',
  'address', 'postal_address', 'drivers_licence_number', 'drivers_licence_class',
  'drivers_licence_expiry', 'licence_conditions', 'citizenship_status', 'visa_subclass',
  'visa_expiry', 'emergency_name', 'emergency_relationship', 'emergency_phone',
  'emergency_phone_alt', 'usi', 'white_card_number', 'white_card_issuer', 'job_title_hint',
  'drivers_licence_image_index',
] as const;
type FieldName = typeof FIELDS[number];
const DATE_FIELDS: FieldName[] = ['date_of_birth', 'drivers_licence_expiry', 'visa_expiry'];
const FORBIDDEN = /tfn|tax_file|bsb|account_number|passport|medicare/i;

type Ticket = {
  name: string; number: string | null; issuer: string | null; expiry: string | null;
  class_or_units: string | null; source_image_index: number | null; confidence: number;
};
type Extract = {
  fields: Record<FieldName, string | null>;
  confidence: Record<FieldName, number>;
  tickets: Ticket[];
  warnings: string[];
};

const SYSTEM = `You read photos of Australian employment paperwork for a construction labour-hire office and return ONE strict JSON object. No prose, no markdown fences.

The photos may include: a completed employment / new-starter form, a driver licence (front and back), a General Construction Induction "white card", High Risk Work licences, plant / machinery tickets, VOC cards, RIW cards, and Statements of Attainment from an RTO (unit codes like RIIMPO320F). Several photos can describe the same person; combine them.

Return exactly this shape:
{
  "fields": {
    "<field>": { "value": <string or null>, "confidence": <0..1> }, ...
  },
  "tickets": [
    { "name": <string>, "number": <string|null>, "issuer": <string|null>, "expiry": <"YYYY-MM-DD"|null>,
      "class_or_units": <string|null>, "source_image_index": <0-based index of the photo this came from, or null>, "confidence": <0..1> }
  ],
  "warnings": [<short strings about anything unclear or contradictory>]
}

Fields (every one must be present; use null when it is not on any photo):
name (full legal name as printed), preferred_name, email, mobile (Australian format as written), alternate_phone,
date_of_birth (YYYY-MM-DD), gender, address (residential, one line), postal_address (only if different),
drivers_licence_number, drivers_licence_class (e.g. C, LR, MR, HR, HC, MC, R), drivers_licence_expiry (YYYY-MM-DD),
licence_conditions (e.g. "S", "P1", "P2", "A" exactly as printed), citizenship_status (e.g. "Australian citizen", "Permanent resident", "Visa holder"),
visa_subclass (digits only), visa_expiry (YYYY-MM-DD), emergency_name, emergency_relationship, emergency_phone, emergency_phone_alt,
usi (Unique Student Identifier, 10 characters), white_card_number, white_card_issuer, job_title_hint (one of the trades the paperwork points to, e.g. "Excavator Operator", "General Labourer"),
drivers_licence_image_index (the 0-based index of the photo showing the FRONT of the driver licence, as a string, or null).

Rules:
- Dates on Australian documents are day-first (DD/MM/YYYY or DD MMM YYYY). Convert to YYYY-MM-DD. If a year is ambiguous, lower the confidence.
- The white card is a ticket too: add it to "tickets" (name "White Card (General Construction Induction)") AND fill white_card_number / white_card_issuer.
- A driver licence is NOT a ticket; it goes in the drivers_licence_* fields only.
- Every High Risk Work class, plant ticket, VOC, RIW card and Statement of Attainment is one ticket. For a Statement of Attainment put the RTO in issuer and the unit codes in class_or_units; expiry is usually null.
- NEVER output a Tax File Number, bank BSB or account number, superannuation member number, passport number or Medicare number — not in any field, not in warnings. If a photo shows one, ignore it.
- Do not describe the person's face, photo or appearance.
- Transcribe exactly what is printed; do not guess missing characters. Confidence is your honest estimate that the value is read correctly.`;

// ── Providers ──────────────────────────────────────────────────────────────
type Attempt = { name: string; url: string; key: string; model: string; maxImages: number; jsonMode: boolean; extraHeaders?: Record<string, string> };
function providerChain(): Attempt[] {
  // Checked against each vendor's /models on 2026-11-09: Groq lists NO vision
  // model any more (llama-4-scout is gone, 404), so the chain starts at
  // OpenRouter's free vision models and ends on Mistral's Pixtral, which read
  // the synthetic test cards correctly. Add Groq back here if it regains one.
  const a: Attempt[] = [];
  const or = 'https://openrouter.ai/api/v1/chat/completions';
  const orHeaders = { 'HTTP-Referer': 'https://portal.cbdpnl.com.au', 'X-Title': 'CBD portal worker intake' };
  // Pixtral first: it read both test cards perfectly in ~18 s; the OpenRouter
  // free models answered 429 / empty on the same run, so they are the backup.
  if (MISTRAL_API_KEY)    a.push({ name: 'mistral:pixtral-12b', url: 'https://api.mistral.ai/v1/chat/completions', key: MISTRAL_API_KEY, model: 'pixtral-12b-2409', maxImages: 8, jsonMode: true });
  if (OPENROUTER_API_KEY) a.push({ name: 'openrouter:gemma-4-31b', url: or, key: OPENROUTER_API_KEY, model: 'google/gemma-4-31b-it:free', maxImages: 8, jsonMode: false, extraHeaders: orHeaders });
  if (OPENROUTER_API_KEY) a.push({ name: 'openrouter:nemotron-3.5-super-vl', url: or, key: OPENROUTER_API_KEY, model: 'nvidia/nemotron-3.5-super-vl:free', maxImages: 8, jsonMode: false, extraHeaders: orHeaders });
  if (GROQ_API_KEY && Deno.env.get('GROQ_VISION_MODEL')) a.push({ name: 'groq:vision', url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_API_KEY, model: Deno.env.get('GROQ_VISION_MODEL')!, maxImages: 5, jsonMode: true });
  return a;
}

type Img = { dataUrl: string; index: number };

function parseJsonLoose(text: string): unknown {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no json object');
  return JSON.parse(t.slice(a, b + 1));
}

type OnceResult = { ok: true; parsed: unknown } | { ok: false; status: number; detail: string };

async function callOnce(a: Attempt, imgs: Img[], withJsonMode: boolean, deadline: number): Promise<OnceResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(1000, Math.min(PROVIDER_TIMEOUT_MS, deadline - Date.now())));
  try {
    const content: unknown[] = [{ type: 'text', text: `There are ${imgs.length} photos, numbered ${imgs.map(i => i.index).join(', ')} in order. Read them all and return the JSON.` }];
    for (const im of imgs) content.push({ type: 'image_url', image_url: { url: im.dataUrl } });
    const body: Record<string, unknown> = {
      model: a.model, temperature: 0.1, max_tokens: 2500,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }],
    };
    if (withJsonMode) body.response_format = { type: 'json_object' };
    const res = await fetch(a.url, {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: `Bearer ${a.key}`, 'Content-Type': 'application/json', ...(a.extraHeaders || {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      return { ok: false, status: res.status, detail };
    }
    const d = await res.json();
    const text = String(d?.choices?.[0]?.message?.content ?? '');
    if (!text.trim()) return { ok: false, status: 0, detail: 'empty' };
    return { ok: true, parsed: parseJsonLoose(text) };
  } catch (e) {
    return { ok: false, status: 0, detail: (e as Error).name === 'AbortError' ? 'timeout' : `error:${(e as Error).message.slice(0, 120)}` };
  } finally {
    clearTimeout(timer);
  }
}

// One provider over all images, chunked to its image limit; a chunk failure
// fails the provider so the next one gets a clean go.
async function callProvider(a: Attempt, imgs: Img[], deadline: number, tried: string[]): Promise<unknown[] | null> {
  const chunks: Img[][] = [];
  for (let i = 0; i < imgs.length; i += a.maxImages) chunks.push(imgs.slice(i, i + a.maxImages));
  const parts: unknown[] = [];
  for (const ch of chunks) {
    if (Date.now() > deadline - 5000) { tried.push(`${a.name}:budget`); return null; }
    let r = await callOnce(a, ch, a.jsonMode, deadline);
    if (!r.ok && r.status === 400 && a.jsonMode) r = await callOnce(a, ch, false, deadline); // model rejected json mode
    if (!r.ok) { tried.push(`${a.name}:${r.status || r.detail}`); return null; }
    parts.push(r.parsed);
  }
  return parts;
}

// ── Normalising the model's answer ─────────────────────────────────────────
function stripForbidden(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripForbidden);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (FORBIDDEN.test(k)) continue;
      out[k] = stripForbidden(val);
    }
    return out;
  }
  return v;
}

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
function toISODate(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`;
  return null;
}
const clamp01 = (n: unknown) => { const x = Number(n); return isNaN(x) ? 0.5 : Math.max(0, Math.min(1, x)); };
const str = (v: unknown) => { if (v == null) return null; const s = String(v).trim(); return s && s.toLowerCase() !== 'null' && s.toLowerCase() !== 'n/a' ? s : null; };

function normalise(parts: unknown[], indexOffsets: number[]): Extract {
  const fields = {} as Record<FieldName, string | null>;
  const confidence = {} as Record<FieldName, number>;
  for (const f of FIELDS) { fields[f] = null; confidence[f] = 0; }
  const tickets: Ticket[] = [];
  const warnings: string[] = [];

  parts.forEach((raw, pi) => {
    const p = stripForbidden(raw) as Record<string, unknown>;
    const fl = (p?.fields && typeof p.fields === 'object' ? p.fields : p) as Record<string, unknown>;
    for (const f of FIELDS) {
      const cell = fl?.[f];
      let value: string | null; let conf: number;
      if (cell && typeof cell === 'object' && 'value' in (cell as Record<string, unknown>)) {
        value = str((cell as Record<string, unknown>).value); conf = clamp01((cell as Record<string, unknown>).confidence);
      } else { value = str(cell); conf = value ? 0.6 : 0; }
      if (DATE_FIELDS.includes(f) && value) { const iso = toISODate(value); if (!iso) conf = Math.min(conf, 0.3); value = iso ?? value; }
      if (value && (fields[f] == null || conf > confidence[f])) { fields[f] = value; confidence[f] = conf; }
    }
    const tk = Array.isArray(p?.tickets) ? p.tickets as Record<string, unknown>[] : [];
    for (const t of tk) {
      const name = str(t?.name); if (!name) continue;
      const idx = t?.source_image_index == null ? null : Number(t.source_image_index);
      tickets.push({
        name, number: str(t?.number), issuer: str(t?.issuer), expiry: toISODate(t?.expiry),
        class_or_units: str(t?.class_or_units),
        source_image_index: idx == null || isNaN(idx) ? null : idx + (indexOffsets[pi] || 0),
        confidence: clamp01(t?.confidence ?? 0.6),
      });
    }
    if (Array.isArray(p?.warnings)) for (const w of p.warnings as unknown[]) { const s = str(w); if (s && !FORBIDDEN.test(s)) warnings.push(s.slice(0, 200)); }
  });

  // Same ticket read from two chunks → keep the better read.
  const seen = new Map<string, Ticket>();
  for (const t of tickets) {
    const k = `${t.name.toLowerCase()}|${(t.number || '').toLowerCase()}`;
    const prev = seen.get(k);
    if (!prev || t.confidence > prev.confidence) seen.set(k, t);
  }
  return { fields, confidence, tickets: [...seen.values()], warnings: [...new Set(warnings)] };
}

// ── Server-side warnings ───────────────────────────────────────────────────
function addWarnings(x: Extract) {
  const today = sydneyDate(new Date());
  const daysUntil = (iso: string) => Math.round((new Date(`${iso}T12:00:00+10:00`).getTime() - new Date(`${today}T12:00:00+10:00`).getTime()) / 86400000);
  const w: string[] = [];

  const dob = x.fields.date_of_birth;
  if (dob && /^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    const [y, m, d] = dob.split('-').map(Number);
    const turns18 = `${y + 18}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (turns18 > today) w.push(`Under 18 until ${turns18} — check the client's under-18 policy`);
  }
  const lic = x.fields.drivers_licence_expiry;
  if (lic && /^\d{4}-\d{2}-\d{2}$/.test(lic)) {
    const n = daysUntil(lic);
    if (n < 0) w.push(`Driver licence expired on ${lic}`);
    else if (n <= 60) w.push(`Driver licence expires on ${lic} (in ${n} days)`);
  }
  for (const t of x.tickets) {
    if (!t.expiry || !/^\d{4}-\d{2}-\d{2}$/.test(t.expiry)) continue;
    const n = daysUntil(t.expiry);
    if (n < 0) w.push(`${t.name} expired on ${t.expiry}`);
    else if (n <= 60) w.push(`${t.name} expires on ${t.expiry} (in ${n} days)`);
  }
  const visaish = x.fields.visa_subclass || /visa/i.test(x.fields.citizenship_status || '');
  if (visaish && !x.fields.visa_expiry) w.push('Visa holder with no visa expiry read — run a VEVO check');
  const prov = `${x.fields.licence_conditions || ''} ${x.fields.drivers_licence_class || ''}`;
  if (/\bP[12]\b/i.test(prov) || /provisional/i.test(prov)) w.push('Provisional licence (P1/P2)');

  x.warnings = [...new Set([...w, ...x.warnings])];
}

// ── Image loading ──────────────────────────────────────────────────────────
const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
function b64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)) as unknown as number[]);
  return btoa(s);
}

// ── Housekeeping (2026-11-09): staged photos are deleted after 30 days ──────
// pg_cron (intake-cleanup-daily) posts here with the shared x-digest-secret
// header — same guard as send-timesheet-bundle-daily. Lists every uid folder
// in the bucket and removes the files older than INTAKE_RETENTION_DAYS. The
// ticket photos the form attached were COPIED to cert-photos/<workerId>/ at
// save time, so nothing a worker record points at is touched.
const DIGEST_SECRET          = Deno.env.get('DIGEST_SECRET') || '';
const INTAKE_RETENTION_DAYS  = 30;
async function cleanupStale(): Promise<Response> {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const cutoff = Date.now() - INTAKE_RETENTION_DAYS * 86400000;
  const { data: folders, error: fErr } = await sb.storage.from(BUCKET).list('', { limit: 1000 });
  if (fErr) return json({ ok: false, error: fErr.message }, 500);
  const stale: string[] = [];
  for (const f of folders || []) {
    if (f.id) continue;                      // a file at the root — not ours, leave it
    const { data: files } = await sb.storage.from(BUCKET).list(f.name, { limit: 1000 });
    for (const o of files || []) {
      const t = Date.parse(o.created_at || o.updated_at || '');
      if (o.id && t && t < cutoff) stale.push(`${f.name}/${o.name}`);
    }
  }
  let removed = 0;
  for (let i = 0; i < stale.length; i += 100) {
    const batch = stale.slice(i, i + 100);
    const { error } = await sb.storage.from(BUCKET).remove(batch);
    if (error) return json({ ok: false, error: error.message, removed }, 500);
    removed += batch.length;
  }
  if (removed) {
    await sb.from('activity_events').insert([{
      actor_id: null, actor_name: 'system', verb: 'intake cleanup', object_type: 'storage', object_id: null,
      after: { bucket: BUCKET, removed, older_than_days: INTAKE_RETENTION_DAYS },
    }]).then(({ error }) => { if (error) console.error('activity insert failed:', error.message); });
  }
  return json({ ok: true, removed, kept: stale.length - removed });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);
  const digest = req.headers.get('x-digest-secret');
  if (digest !== null) {
    if (!DIGEST_SECRET || digest !== DIGEST_SECRET) return json({ error: 'unauthorized' }, 401);
    return cleanupStale();
  }
  const started = Date.now();
  const deadline = started + TOTAL_BUDGET_MS;

  try {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!jwt) return json({ error: 'unauthorized' }, 401);
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: userData, error: userErr } = await anon.auth.getUser(jwt);
    const user = userData?.user;
    if (userErr || !user?.id || !user.email) return json({ error: 'unauthorized' }, 401);

    // Same predicate as the portal's RLS, run as the caller.
    const asCaller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const { data: isOffice, error: officeErr } = await asCaller.rpc('is_office_user');
    if (officeErr || isOffice !== true) return json({ error: 'not_office', message: 'Only office users can read worker paperwork.' }, 403);

    let body: { paths?: unknown } = {};
    try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const paths = Array.isArray(body.paths) ? body.paths.filter((p) => typeof p === 'string') as string[] : [];
    if (!paths.length) return json({ error: 'no_paths', message: 'Upload at least one photo first.' }, 400);
    if (paths.length > MAX_IMAGES) return json({ error: 'too_many', message: `Up to ${MAX_IMAGES} photos at a time.` }, 400);

    const prefix = `${user.id}/`;
    for (const p of paths) {
      if (!p.startsWith(prefix) || p.includes('..')) return json({ error: 'forbidden_path', message: 'Those photos are not yours to read.' }, 403);
      const ext = (p.split('.').pop() || '').toLowerCase();
      if (ext === 'heic' || ext === 'heif') return json({ error: 'heic', message: 'HEIC photos cannot be read. On iPhone set Camera → Formats → Most Compatible, or screenshot the photo and upload that.' }, 415);
      if (ext === 'pdf') return json({ error: 'pdf', message: 'PDFs are not read here — take a photo of each page instead.' }, 415);
      if (!MIME[ext]) return json({ error: 'bad_type', message: 'Use JPG, PNG or WEBP photos.' }, 415);
    }

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const imgs: Img[] = [];
    for (let i = 0; i < paths.length; i++) {
      const { data, error } = await sb.storage.from(BUCKET).download(paths[i]);
      if (error || !data) return json({ error: 'download_failed', message: `Photo ${i + 1} could not be read: ${error?.message || 'not found'}` }, 400);
      if (data.size > MAX_BYTES) return json({ error: 'too_large', message: `Photo ${i + 1} is over 8 MB.` }, 413);
      const bytes = new Uint8Array(await data.arrayBuffer());
      const ext = (paths[i].split('.').pop() || 'jpg').toLowerCase();
      imgs.push({ dataUrl: `data:${MIME[ext] || 'image/jpeg'};base64,${b64(bytes)}`, index: i });
    }

    const attempts = providerChain();
    if (!attempts.length) return json({ error: 'no_provider', message: 'No vision model key is configured.' }, 503);
    const tried: string[] = [];
    let result: Extract | null = null;
    let via = 'none';
    for (const a of attempts) {
      if (Date.now() > deadline - 8000) { tried.push(`${a.name}:budget`); continue; }
      const parts = await callProvider(a, imgs, deadline, tried);
      if (!parts) continue;
      const offsets: number[] = [];
      for (let i = 0; i < imgs.length; i += a.maxImages) offsets.push(i);
      try {
        result = normalise(parts, offsets);
        via = a.name;
        break;
      } catch (_e) { tried.push(`${a.name}:bad_json`); }
    }
    if (!result) return json({ error: 'all_providers_failed', message: 'Could not read the photos — add the worker by hand.', tried }, 502);

    addWarnings(result);
    const found = result;
    const fieldsFound = FIELDS.filter((f) => found.fields[f] != null).length;

    // Audit row: counts only, never the content.
    try {
      const { data: me } = await sb.from('workers').select('id, name').eq('email', user.email.toLowerCase()).maybeSingle();
      await sb.from('activity_events').insert([{
        actor_id: me?.id ?? null, actor_name: me?.name ?? user.email,
        verb: 'worker intake read', object_type: 'worker_intake', object_id: null,
        after: { images: imgs.length, fields_found: fieldsFound, tickets: found.tickets.length, via, ms: Date.now() - started },
      }]);
    } catch (e) { console.error('activity_events insert failed:', (e as Error).message); }

    return json({ ok: true, via, tried, images: imgs.length, ...found });
  } catch (e) {
    console.error('worker-intake failed:', (e as Error).message);
    return json({ error: 'server_error', message: (e as Error).message }, 500);
  }
});
