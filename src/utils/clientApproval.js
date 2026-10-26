// Supervisor approval chain: when a worker submits a daily timesheet (or an
// admin resends), the site supervisor gets a secure tokenised link (email +
// SMS when we have their contact) to review and accept it. Only
// client-accepted timesheets count as billable in Payroll.
//
// The sending now happens SERVER-SIDE in the `send-signoff-request` edge
// function (2026-10-17). It finds the supervisor in this order: the site's
// contacts (approves_timesheets first), the worker's allocation supervisor,
// the project contact, then the client's head office — and it runs with
// server rights, so a worker's phone no longer needs the office-only SMS /
// email functions. Fire-and-forget — never blocks the UI.
import { supabase } from '../supabaseClient';

// Returns { ok, sentTo, error, alreadySent } — callers surface the result in a
// toast so the admin knows whether the supervisor actually got it.
export async function sendTimesheetForClientApproval(headerId, { force = false } = {}) {
  try {
    const { data, error } = await supabase.functions.invoke('send-signoff-request', {
      body: { header_id: headerId, force },
    });
    if (error) return { ok: false, error: error.message || 'send failed' };
    if (!data) return { ok: false, error: 'no response from the server' };
    if (data.error && data.ok === undefined) return { ok: false, error: data.error };
    return data;
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Admin fallback for verbal/phone approvals: same effect as the supervisor
// clicking the link — signs off AND approves, so it lands in Payroll.
export async function markClientApprovedManually(headerId, approverNote) {
  // Approve = state change + LOCK, done on the server: a worker's phone may not flip its
  // own sheet (RLS), so approve_timesheet_on_site checks the supervisor signature + name
  // and does it for the sheet's own worker, or for the office. It also bells the office.
  const { data, error } = await supabase.rpc('approve_timesheet_on_site', { p_header_id: headerId, p_signer: approverNote || 'Marked manually by admin' });
  if (error) return { ok: false, error: error.message };
  if (!data?.ok) return { ok: false, error: data?.error || 'could not approve' };
  // The signed PDF goes to the supervisor and the client's timesheet inbox automatically.
  supabase.functions.invoke('send-timesheet-pdf', { body: { header_id: headerId, reason: 'admin' } }).catch(() => {});
  return { ok: true };
}
