// Allocation notification helpers — shared by the admin allocation flow and the
// worker accept/decline flow.
//
//   • normaliseAUMobile  — AU mobile → E.164 ("+61…") for Twilio
//   • sendWorkerSms      — fire the `send-sms` edge function ({ to, body })
//   • addAdminNotification — append a row to `notifications` (staff read it in the bell)
//
// The `send-sms` function expects { to, body } and returns { sid, status } or
// { error, code }. verify_jwt is on, so only authenticated portal users can send.

import { supabase } from '../supabaseClient';

// Public portal URL workers open to accept an allocation.
export const PORTAL_URL = 'https://cbd-portal-gray.vercel.app';

// Single address that mirrors every admin allocation notification by email.
// This is the real, monitored team inbox (also the connected Gmail sender).
export const ADMIN_EMAIL = 'theteamcbd@gmail.com';

// ── Allocation recipients = the ALLOCATORS (owner decision 2026-08-04) ──────
// Allocation events (create / accept / decline) go to whoever is flagged as an
// allocator on the Workers page (`workers.is_allocator`) — SMS *and* email —
// not to every admin. This replaced the hard-coded SMS allowlist: the old gate
// only covered SMS, so Nick and Val kept receiving the emails. The office can
// now name two or three allocators themselves without a code change.
//
// Fail-safe: if NOBODY is flagged, we send no personal alerts at all rather
// than falling back to the whole team (the old behaviour is exactly what the
// owner asked us to stop). The shared team inbox still gets the email, so the
// event is never lost — see sendAdminEmail below.
function pickAllocators(roster) {
  return (roster || []).filter(w => w.is_allocator === true);
}

// Normalise an Australian mobile to E.164 ("+61…").
// Accepts "0447 532 346", "0447  532 346", "+61 447 532 346",
// "0447532346", "61447532346", "447532346". Already-"+"-prefixed values pass
// through (after stripping spaces). Returns '' when nothing usable is left.
export function normaliseAUMobile(mobile) {
  if (!mobile) return '';
  let d = String(mobile).trim();
  // Keep a single leading + then digits only.
  const hasPlus = d.startsWith('+');
  d = d.replace(/[^\d]/g, '');
  if (!d) return '';
  if (hasPlus) return `+${d}`;
  if (d.startsWith('61')) return `+${d}`;          // 61447532346 → +61447532346
  if (d.startsWith('0')) return `+61${d.slice(1)}`; // 0447532346  → +61447532346
  if (d.startsWith('4') && d.length === 9) return `+61${d}`; // 447532346 → +61447532346
  // Fall back: assume it's a local AU number missing the trunk 0.
  return `+61${d}`;
}

// Fire the SMS. Resolves to { ok, sid, status, error, code }. Never throws — the
// caller treats SMS as fire-and-forget so it can't block the UI.
export async function sendWorkerSms(to, body) {
  if (!to) return { ok: false, error: 'no mobile' };
  try {
    const { data, error } = await supabase.functions.invoke('send-sms', {
      body: { to, body },
    });
    if (error) return { ok: false, error: error.message };
    if (data?.error) return { ok: false, error: data.error, code: data.code };
    return { ok: true, sid: data?.sid, status: data?.status };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Insert an in-app admin notification. Never throws.
export async function addAdminNotification({ type, title, body, allocation_id, worker_id }) {
  try {
    const { error } = await supabase.from('notifications').insert([{
      type: type || 'allocation',
      title: title || null,
      body: body || null,
      allocation_id: allocation_id || null,
      worker_id: worker_id || null,
    }]);
    return { ok: !error, error: error?.message };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Email the allocated worker their new job (alongside the SMS) so a stale
// mobile number can never silently hide an allocation. send-bulk-email
// prepends its own "Hi {name}," greeting. Fire-and-forget, never throws.
export async function sendWorkerAllocationEmail(worker, { client, site, role, start_date }) {
  try {
    const email = (worker?.email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'no email' };
    const where = client && site ? `${client} — ${site}` : (client || site || 'a new job');
    const { data, error } = await supabase.functions.invoke('send-bulk-email', {
      body: {
        recipients: [{ name: worker.name || 'there', email }],
        subject: `New allocation — ${where}`,
        body: `You've been allocated to ${where}${role ? ` as ${role}` : ''}${start_date ? ` starting ${fmtNiceDate(start_date)}` : ''}.\n\nOpen the portal to accept: ${PORTAL_URL}`,
        audience: 'mixed',
        gmail_only: true,
      },
    });
    if (error) return { ok: false, error: error.message };
    return { ok: !!data?.ok, via: data?.via };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Build the worker SMS body for a new allocation.
export function allocationSmsBody({ name, client, site, start_date, role }) {
  const who = name ? `Hi ${name},` : 'Hi,';
  const where = client || site || 'a new job';
  const at = client && site ? `${client} — ${site}` : where;
  const as = role ? ` as ${role}` : '';
  const when = start_date ? ` starting ${fmtNiceDate(start_date)}` : '';
  return `${who} you've been allocated to ${at}${as}${when}. Open the portal to accept: ${PORTAL_URL}`;
}

// ── Admin broadcast (SMS + email) ──────────────────────────────────────────
// Every allocation event (create / accept / decline) drops an in-app bell
// notification AND now also texts every admin + emails ADMIN_EMAIL. All paths
// are fire-and-forget: they never throw and never block the UI.

// Short admin SMS bodies. `worker`/`client` already resolved by the caller.
export function adminCreateSmsBody({ worker, client, start_date, role }) {
  const as = role ? ` as ${role}` : '';
  return `New allocation: ${worker || 'Worker'} → ${client || 'client'}${as} (${start_date || 'TBC'}). Sent for acceptance.`;
}
export function adminAcceptSmsBody({ worker, client, start_date, role }) {
  const as = role ? ` as ${role}` : '';
  return `${worker || 'Worker'} ACCEPTED ${client || 'client'}${as} (${start_date || 'TBC'}).`;
}
export function adminDeclineSmsBody({ worker, client, start_date, role }) {
  const as = role ? ` as ${role}` : '';
  return `${worker || 'Worker'} DECLINED ${client || 'client'}${as} (${start_date || 'TBC'}).`;
}

// Text the admins who should get an immediate SMS. Honors per-admin prefs
// (per-event mode + SMS channel on) and the SMS_ALLOWLIST gate above when set.
// Numbers are E.164-normalised and de-duped. Fire-and-forget; never throws.
export async function broadcastAdminSms(body) {
  try {
    // Roster via SECURITY DEFINER RPC so the worker accept/decline path (which
    // cannot read other workers under the RLS lockdown) still gets the admin list.
    const { data, error } = await supabase.rpc('get_admin_notification_recipients');
    if (error) return { ok: false, sent: 0, error: error.message };

    // Allocators only, and only those on per-event mode with the SMS channel
    // enabled (digest admins get the once-a-day summary instead). Defaults
    // treat missing prefs as opted-in.
    const eligible = pickAllocators(data).filter(w =>
      (w.notify_mode || 'per_event') === 'per_event' && w.notify_sms !== false
    );

    const seen = new Set();
    const targets = [];
    for (const w of eligible) {
      const to = normaliseAUMobile(w.mobile);
      if (!to || seen.has(to)) continue;
      seen.add(to);
      targets.push({ to, name: w.name });
    }

    if (!targets.length) return { ok: false, sent: 0, error: 'no allocator SMS recipients' };

    const results = await Promise.all(
      targets.map(t => sendWorkerSms(t.to, body).then(r => ({ ...r, to: t.to, name: t.name })))
    );
    return { ok: results.some(r => r.ok), sent: results.filter(r => r.ok).length, results };
  } catch (e) {
    return { ok: false, sent: 0, error: e?.message || String(e) };
  }
}

// Email the allocators about an allocation event via send-bulk-email.
// Notification emails are GOOGLE (Gmail) ONLY — `gmail_only:true` tells
// send-bulk-email to never fall back to Resend for these. The shared ops
// mailbox (ADMIN_EMAIL) always gets the event as the team record; on top of
// that, each ALLOCATOR on per-event mode with the Email channel on gets a
// personal copy. Non-allocator admins get nothing personally — that is the
// 2026-08-04 fix for "Nick and Val are still receiving these". Daily-digest
// admins are skipped here and get the once-a-day summary instead.
// Fire-and-forget. Never throws.
export async function sendAdminEmail(subject, text) {
  try {
    const recipients = [{ name: 'Admin', email: ADMIN_EMAIL }];
    const seen = new Set([ADMIN_EMAIL.toLowerCase()]);
    try {
      const { data } = await supabase.rpc('get_admin_notification_recipients');
      for (const w of pickAllocators(data)) {
        const email = (w.email || '').trim();
        if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue;
        if ((w.notify_mode || 'per_event') !== 'per_event') continue;
        if (w.notify_email === false) continue;
        const key = email.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        recipients.push({ name: w.name || 'Admin', email });
      }
    } catch { /* fall back to the shared ops mailbox only */ }

    const { data, error } = await supabase.functions.invoke('send-bulk-email', {
      body: { recipients, subject, body: text, audience: 'mixed', gmail_only: true },
    });
    if (error) return { ok: false, error: error.message };
    if (data?.error) return { ok: false, error: data.error };
    return { ok: !!data?.ok, via: data?.via, sent: data?.sent };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function fmtNiceDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return iso;
  }
}
