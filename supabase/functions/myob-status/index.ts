// myob-status — tells the portal whether MYOB is connected (and which company
// files the connection can see) WITHOUT exposing any token. Called with the
// user's JWT (verify_jwt on).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const MYOB_CLIENT_ID       = Deno.env.get('MYOB_CLIENT_ID') || '';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data } = await sb.from('myob_tokens')
    .select('connected_at, expires_at, company_files, company_file_id, company_file_name')
    .eq('id', 1).maybeSingle();
  const files = (data?.company_files as Array<{ Id?: string; Name?: string }> | null) || null;
  return new Response(JSON.stringify({
    configured: !!MYOB_CLIENT_ID,
    connected: !!data?.connected_at,
    connected_at: data?.connected_at || null,
    company_files: Array.isArray(files) ? files.map(f => ({ id: f.Id, name: f.Name })) : null,
    selected_file: data?.company_file_name || null,
  }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
});
