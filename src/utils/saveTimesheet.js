// The ONE network path that saves a daily timesheet: the save_daily_timesheet
// RPC plus the post-save header/line patch (master-data ids, name snapshots,
// finished-early answer, fatigue flags). The form calls it directly; the
// offline queue replays the exact same payload through it later, so a sheet
// sent from the queue lands identically to one sent live.
import { supabase } from '../supabaseClient';
import { isNetworkError } from './offlineQueue';
import { uploadTimesheetPhotos } from './timesheetPhotos';
import { sendTimesheetForClientApproval, markClientApprovedManually } from './clientApproval';
import { logActivity } from './activity';

// payload: { rpcArgs, headerPatch, linePatch }
export async function persistTimesheet(payload) {
  let data, error;
  try {
    ({ data, error } = await supabase.rpc('save_daily_timesheet', payload.rpcArgs));
  } catch (e) { error = e; }
  if (error) return { ok: false, error, network: isNetworkError(error) };

  const headerId = payload.rpcArgs?.p_header_id || data;
  const warnings = [];
  if (headerId) {
    // AWAITED: the approval paths can lock the header, and these columns are
    // not in the lock's allowed set (review #10 race).
    if (payload.headerPatch && Object.keys(payload.headerPatch).length) {
      const { error: e1 } = await supabase.from('timesheet_headers').update(payload.headerPatch).eq('id', headerId);
      if (e1) warnings.push(`client/site link failed: ${e1.message}`);
    }
    if (payload.linePatch && (payload.linePatch.client_id || payload.linePatch.site_id)) {
      const { error: e2 } = await supabase.from('timesheets').update(payload.linePatch).eq('header_id', headerId);
      if (e2) warnings.push(`line client/site link failed: ${e2.message}`);
    }
  }
  return { ok: true, headerId, data, warnings };
}

// Replay of one queued item (see offlineQueue.js for the shape): save, then
// photos, then the supervisor sign-off step the live submit would have run.
export async function replayQueuedTimesheet(item) {
  const r = await persistTimesheet(item.payload);
  if (!r.ok) return r;
  const headerId = r.headerId;
  const workerId = item.payload?.rpcArgs?.p_worker_id;
  let photoErrors = 0;
  if (headerId && workerId && item.photos?.length) {
    const up = await uploadTimesheetPhotos({ workerId, headerId, photos: item.photos });
    photoErrors = up.errors.length;
  }
  if (headerId) {
    try {
      if (item.followUp?.signedOnSite) await markClientApprovedManually(headerId, item.followUp.who || 'signed on site');
      else if (item.followUp?.supervisor !== false) await sendTimesheetForClientApproval(headerId);
    } catch { /* sign-off is best effort; the office can resend */ }
    logActivity({
      verb: 'submitted', object_type: 'timesheet_header', object_id: headerId,
      after: { client: item.payload?.rpcArgs?.p_client, project: item.payload?.rpcArgs?.p_project, queued_offline: true, queued_at: item.queuedAt },
    });
  }
  return { ...r, photoErrors };
}
