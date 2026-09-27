import { supabase } from '../supabaseClient';

// The ONE admin approve path (review finding: two divergent paths existed).
// The server recomputes the hours split under the client's rules, refuses on
// drift, locks the sheet, logs the event and emails the client PDF.
export async function approveTimesheet(headerId) {
  const { data, error } = await supabase.functions.invoke('approve-timesheet', { body: { header_id: headerId } });
  if (!error && !data?.error) return { ok: true, data };
  let msg = data?.error || error?.message || 'Approval failed';
  if (error?.context) {
    try { const j = await error.context.json(); msg = j.error || msg; } catch { /* keep msg */ }
  }
  return { ok: false, error: msg };
}
