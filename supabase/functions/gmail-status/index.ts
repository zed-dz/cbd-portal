// Returns connection status so the frontend can show "Connect Gmail" vs the
// connected inbox UI. Cheap — single DB lookup, no Google calls.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GMAIL_CLIENT_ID      = Deno.env.get('GMAIL_CLIENT_ID')  || '';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data } = await supa.from('gmail_tokens').select('email_address, expires_at, updated_at').eq('id', 1).maybeSingle();

  return new Response(JSON.stringify({
    configured: !!GMAIL_CLIENT_ID,
    connected:  !!data,
    email:      data?.email_address || null,
    expires_at: data?.expires_at || null,
    updated_at: data?.updated_at || null,
  }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
});
