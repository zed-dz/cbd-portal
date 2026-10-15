// One place for "a new allocation exists → tell the worker and the office".
// Used by the Calendar quick form and its copy-to-tomorrow (audit P2: those
// paths created allocations silently, so workers never knew). The Allocations
// page keeps its own richer version with per-step toasts.

import { normaliseAUMobile, sendWorkerSms, addAdminNotification, allocationSmsBody, broadcastAdminSms, adminCreateSmsBody, sendAdminEmail, sendWorkerAllocationEmail } from './notify';
import { logActivity } from './activity';

export function notifyAllocationCreated(row, worker, { showToast, adminQuiet = false } = {}) {
  const name = worker?.name || 'Worker';
  const client = row?.client || '';
  const site = row?.site || '';
  const startDate = row?.start_date || null;
  const role = row?.role || '';

  const to = normaliseAUMobile(worker?.mobile);
  if (to) {
    sendWorkerSms(to, allocationSmsBody({ name, client, site, start_date: startDate, role }))
      .then(r => { if (!r?.ok) showToast?.(`SMS to ${name} failed: ${r?.error || 'unknown error'}`, 'error'); })
      .catch(() => {});
  } else {
    showToast?.(`${name} has no mobile on file — SMS skipped.`, 'info');
  }
  if (worker?.email) {
    Promise.resolve(sendWorkerAllocationEmail(worker, { client, site, role, start_date: startDate })).catch(() => {});
  }
  logActivity({
    verb: 'created', object_type: 'allocation', object_id: row?.id || null,
    after: { worker: name, client, site, role, start_date: startDate },
  });
  if (adminQuiet) return;

  const where = client || site || 'a new job';
  addAdminNotification({
    type: 'allocation_sent',
    title: `Allocation sent to ${name}`,
    body: `${where}${role ? ` · ${role}` : ''}${startDate ? ` — starts ${startDate}` : ''}`,
    allocation_id: row?.id || null,
    worker_id: worker?.id || null,
  }).then(() => window.dispatchEvent(new CustomEvent('cbd:notify'))).catch(() => {});
  broadcastAdminSms(adminCreateSmsBody({ worker: name, client: where, start_date: startDate, role }));
  sendAdminEmail(
    `Admin update — ${name} allocated to ${where}`,
    `FYI for the admin team (no action needed): ${name} has been allocated to ${where}${role ? ` as ${role}` : ''}${startDate ? ` starting ${startDate}` : ''}. The worker has been notified by SMS and email to accept it in the portal.`
  );
}
