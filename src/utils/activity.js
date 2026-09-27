// Activity log (Dashpivot parity X1) — one row in activity_events per
// meaningful write. Fire-and-forget by design: logging must never block or
// fail the save it describes, so every path here swallows its own errors.
//
// Call sites live in the page that owns the write (Clients / Rate Sets for
// now). Timesheet, allocation and send events are logged by their own owners.

import { supabase } from '../supabaseClient';

// Resolved once per session; a wrong-but-cached name is better than a workers
// lookup on every save.
let cachedActor = null;

async function resolveActor() {
  if (cachedActor) return cachedActor;
  try {
    const { data } = await supabase.auth.getUser();
    const user = data?.user;
    if (!user) return { id: null, name: 'System' };
    let name = user.email || 'Unknown';
    // Own row is readable under the workers self-or-staff RLS policy.
    const { data: w } = await supabase.from('workers').select('name').ilike('email', user.email || '').limit(1);
    if (w?.[0]?.name) name = w[0].name;
    cachedActor = { id: user.id, name };
    return cachedActor;
  } catch {
    return { id: null, name: 'Unknown' };
  }
}

// logActivity({ verb: 'created', object_type: 'client', object_id, client_id,
//               site_id, actor_name, before, after })
// Verbs read as plain English in the feed: "<actor> <verb> <object_type>".
// `after` (jsonb) should carry at least { name } so the feed can show WHICH
// client / rate set the row is about.
export async function logActivity({ verb, object_type, object_id = null, client_id = null, site_id = null, actor_name = null, before = null, after = null }) {
  try {
    const actor = await resolveActor();
    await supabase.from('activity_events').insert([{
      actor_id: actor.id,
      actor_name: actor_name || actor.name,
      verb: verb || 'updated',
      object_type: object_type || 'record',
      object_id,
      client_id,
      site_id,
      before,
      after,
    }]);
  } catch {
    // fire-and-forget — never surface logging failures to the user
  }
}
