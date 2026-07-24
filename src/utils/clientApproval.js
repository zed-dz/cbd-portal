// Supervisor approval chain: when an admin approves a daily timesheet, the
// site supervisor gets a secure tokenised link (email + SMS when we have their
// contact) to review and accept it. Only client-accepted timesheets count as
// billable in Payroll. All sends are fire-and-forget — they never block the UI.
import { supabase } from '../supabaseClient';
import { PORTAL_URL, normaliseAUMobile, sendWorkerSms, addAdminNotification } from './notify';

// Resolve the best supervisor contact for a header: the project's site contact
// first (client_jobs matched by client + project name), then the client's
// head-office contact as fallback.
async function resolveSupervisorContact(header) {
  const clientName = (header.client || '').trim();
  const projectName = (header.project || '').trim();
  if (!clientName) return null;

  const { data: clients } = await supabase.from('clients')
    .select('id, name, contact, contact_email, contact_phone')
    .ilike('name', clientName).limit(1);
  const client = clients?.[0];

  if (client && projectName) {
    const { data: jobs } = await supabase.from('client_jobs')
      .select('name, site_contact_name, site_contact_email, site_contact_phone')
      .eq('client_id', client.id).ilike('name', projectName).limit(1);
    const job = jobs?.[0];
    if (job && (job.site_contact_email || job.site_contact_phone)) {
      return {
        name: job.site_contact_name || 'Site Supervisor',
        email: (job.site_contact_email || '').trim() || null,
        phone: (job.site_contact_phone || '').trim() || null,
        source: 'project site contact',
      };
    }
  }

  if (client && (client.contact_email || client.contact_phone)) {
    return {
      name: client.contact || 'Site Supervisor',
      email: (client.contact_email || '').trim() || null,
      phone: (client.contact_phone || '').trim() || null,
      source: 'client contact',
    };
  }
  return null;
}

// Send (or resend, with force:true) the approval request for one header.
// Returns { ok, sentTo, error } — callers surface the result in a toast so the
// admin knows whether the supervisor actually got it.
export async function sendTimesheetForClientApproval(headerId, { force = false } = {}) {
  try {
    const { data: h, error } = await supabase.from('timesheet_headers')
      .select('id, client, project, role, status, client_approval_token, client_approved, client_approval_sent_at, total_hours, workers(name)')
      .eq('id', headerId).single();
    if (error || !h) return { ok: false, error: error?.message || 'timesheet not found' };
    if (h.client_approved) return { ok: false, error: 'already accepted by the client' };
    if (h.status === 'rejected') return { ok: false, error: 'timesheet was rejected' };
    if (h.client_approval_sent_at && !force) return { ok: false, error: 'already sent', alreadySent: true };

    const contact = await resolveSupervisorContact(h);
    if (!contact || (!contact.email && !contact.phone)) {
      const err = `no site-supervisor contact on file for ${h.client || 'this client'}${h.project ? ` / ${h.project}` : ''} — add one on the client's project`;
      // Autonomous flow: the worker can't fix this, so light up the admin bell.
      addAdminNotification({
        type: 'timesheet_signoff_blocked',
        title: `Supervisor sign-off NOT sent — ${h.workers?.name || 'worker'} / ${h.client || 'client'}`,
        body: err,
      });
      return { ok: false, error: err };
    }

    const workerName = h.workers?.name || 'our worker';
    const link = `${PORTAL_URL}/approve-ts/${h.client_approval_token}`;
    const label = `${workerName} — ${h.project || h.client}${h.total_hours ? ` (${Number(h.total_hours).toFixed(2)}h)` : ''}`;
    const sentVia = [];

    if (contact.email) {
      const { data, error: e } = await supabase.functions.invoke('send-bulk-email', {
        body: {
          recipients: [{ name: contact.name, email: contact.email }],
          subject: `Timesheet approval requested — ${label}`,
          // NOTE: send-bulk-email already prepends "Hi {name}," to every email —
          // do NOT add a greeting here or the supervisor gets it twice.
          body: `Please review and accept the timesheet for ${label}.\n\nOpen it here (no login needed):\n${link}\n\nOnce you accept, the hours are finalised for invoicing. If we don't hear back within 7 days, the hours are finalised automatically.\n\nThanks!`,
          audience: 'mixed',
          gmail_only: true,
        },
      });
      if (!e && data?.ok !== false && !data?.error) sentVia.push(`email ${contact.email}`);
    }

    if (contact.phone) {
      const to = normaliseAUMobile(contact.phone);
      if (to) {
        const r = await sendWorkerSms(to, `Timesheet approval: ${label}. Review & accept: ${link} (auto-finalises in 7 days)`);
        if (r.ok) sentVia.push(`SMS ${to}`);
      }
    }

    if (!sentVia.length) {
      addAdminNotification({
        type: 'timesheet_signoff_blocked',
        title: `Supervisor sign-off NOT sent — ${h.workers?.name || 'worker'} / ${h.client || 'client'}`,
        body: 'Send failed on every channel (check Gmail/Twilio setup). Resend from Timesheets → View.',
      });
      return { ok: false, error: 'send failed on every channel (check Gmail/Twilio setup)' };
    }

    await supabase.from('timesheet_headers').update({
      client_approval_sent_at: new Date().toISOString(),
      client_approval_sent_to: `${contact.name} (${sentVia.join(', ')})`,
    }).eq('id', h.id);

    return { ok: true, sentTo: `${contact.name} — ${sentVia.join(' + ')}` };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Admin fallback for verbal/phone approvals: same effect as the supervisor
// clicking the link — signs off AND approves, so it lands in Payroll.
export async function markClientApprovedManually(headerId, approverNote) {
  const { error } = await supabase.from('timesheet_headers').update({
    client_approved: true,
    client_approved_at: new Date().toISOString(),
    client_approved_by: approverNote || 'Marked manually by admin',
    status: 'approved',
  }).eq('id', headerId);
  if (error) return { ok: false, error: error.message };
  const { error: e2 } = await supabase.from('timesheets')
    .update({ client_approved: true, status: 'approved' }).eq('header_id', headerId);
  return { ok: !e2, error: e2?.message };
}
