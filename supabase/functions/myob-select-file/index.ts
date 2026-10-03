// myob-select-file — the admin picks WHICH MYOB company file pushes target
// (two-entity structure incoming; and the 2-week test must hit the test file,
// never the live books). The chosen id must be one of the files the stored
// connection can actually see. Admin-gated; myob_tokens stays service-role only.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  let body: { id?: string; name?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  if (!body.id) return json({ error: 'id required' }, 400);

  const sbUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get('Authorization') || '' } },
  });
  const { data: isAdmin, error: adminErr } = await sbUser.rpc('is_portal_admin');
  if (adminErr || !isAdmin) return json({ error: 'admin only' }, 403);

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: row } = await sb.from('myob_tokens')
    .select('company_files').eq('id', 1).maybeSingle();
  if (!row?.company_files) return json({ error: 'MYOB is not connected yet' }, 409);

  const files = row.company_files as Array<{ Id?: string; Name?: string }>;
  const match = Array.isArray(files) ? files.find(f => f.Id === body.id) : null;
  if (!match) return json({ error: 'that company file is not visible to this connection' }, 422);

  const { error } = await sb.from('myob_tokens').update({
    company_file_id: match.Id,
    company_file_name: match.Name || body.name || null,
  }).eq('id', 1);
  if (error) return json({ error: error.message }, 500);

  await sb.from('activity_events').insert([{
    actor_name: 'portal', verb: 'selected', object_type: 'myob_company_file', object_id: null,
    after: { id: match.Id, name: match.Name },
  }]);

  return json({ ok: true, selected: match.Name });
});
