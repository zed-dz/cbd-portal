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
  // Approve = state change + LOCK (same as the supervisor link path), so a
  // verbally-accepted sheet cannot drift afterwards without Reset workflow.
  const { error } = await supabase.from('timesheet_headers').update({
    client_approved: true,
    client_approved_at: new Date().toISOString(),
    client_approved_by: approverNote || 'Marked manually by admin',
    status: 'approved',
    locked: true,
    approved_at: new Date().toISOString(),
  }).eq('id', headerId);
  if (error) return { ok: false, error: error.message };
  const { error: e2 } = await supabase.from('timesheets')
    .update({ client_approved: true, status: 'approved' }).eq('header_id', headerId);
  // A verbal acceptance still gets the client their PDF record automatically.
  supabase.functions.invoke('send-timesheet-pdf', { body: { header_id: headerId, reason: 'admin' } }).catch(() => {});
  return { ok: !e2, error: e2?.message };
}
