// myob-status — tells the portal whether MYOB is connected (and which company
// files the connection can see) WITHOUT exposing any token. Called with the
// user's JWT (verify_jwt on).
//
// GATE: OFFICE (hardening 2026-10-15) — company-file names are office data.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;
const MYOB_CLIENT_ID       = Deno.env.get('MYOB_CLIENT_ID') || '';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

// ── Caller gate (hardening 2026-10-15) ──────────────────────────────────────
// OFFICE = anyone who uses the office portal (workers.role = 'admin', or an
// access_level of admin/accounts); MONEY = access_level admin/accounts only.
// Internal callers (other edge functions, cron) pass the service-role key as
// the bearer and skip the worker lookup. Email match is exact (lower-cased):
// `ilike` would treat `_` and `%` as wildcards.
type GateLevel = 'office' | 'money';
type GateResult =
  | { ok: true; via: 'service' | 'user'; email: string | null; worker: { id: string; name: string | null; role: string | null; access_level: string | null } | null }
  | { ok: false; status: number; error: string };
async function gateCaller(req: Request, level: GateLevel): Promise<GateResult> {
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return { ok: false, status: 401, error: 'Unauthorized' };
  if (bearer === SUPABASE_SERVICE_KEY) return { ok: true, via: 'service', email: null, worker: null };
  const { data: { user }, error } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY).auth.getUser(bearer);
  if (error || !user?.email) return { ok: false, status: 401, error: 'Unauthorized' };
  const { data: w } = await createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY).from('workers')
    .select('id, name, role, access_level, is_allocator')
    .eq('email', user.email.toLowerCase())
    .is('archived_at', null)
    .maybeSingle();
  const money  = !!w && ['admin', 'accounts'].includes(w.access_level || '') && !w.is_allocator  /* allocators never see pay */;
  const office = money || (!!w && w.role === 'admin');
  if (level === 'money' ? !money : !office) {
    return { ok: false, status: 403, error: level === 'money' ? 'Admin or accounts only' : 'Office staff only' };
  }
  return { ok: true, via: 'user', email: user.email, worker: w };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const gate = await gateCaller(req, 'office');
  if (!gate.ok) return json({ error: gate.error }, gate.status);

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data } = await sb.from('myob_tokens')
    .select('connected_at, expires_at, company_files, company_file_id, company_file_name')
    .eq('id', 1).maybeSingle();
  const files = (data?.company_files as Array<{ Id?: string; Name?: string }> | null) || null;
  return json({
    configured: !!MYOB_CLIENT_ID,
    connected: !!data?.connected_at,
    connected_at: data?.connected_at || null,
    company_files: Array.isArray(files) ? files.map(f => ({ id: f.Id, name: f.Name })) : null,
    selected_file: data?.company_file_name || null,
  });
});
