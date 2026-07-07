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

// ── Admin SMS allowlist (now OFF — texts every eligible admin) ──────────────
// Was temporarily set to only Zeff while the worker-triggered roster lookup was
// broken by the workers RLS lockdown. That is fixed (the roster now comes from
// the get_admin_notification_recipients SECURITY DEFINER RPC, which works for
// worker- and admin-triggered events alike), so the gate is disabled and every
// eligible admin (per-event mode + SMS on) is texted. Set to an array of E.164
// numbers only if you ever need to temporarily restrict outbound admin SMS.
const SMS_ALLOWLIST = null;

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
// (per-event mode + SMS channel on) and the Zeff-only SMS_ALLOWLIST gate above.
// Numbers are E.164-normalised and de-duped. Fire-and-forget; never throws.
export async function broadcastAdminSms(body) {
  try {
    // Roster via SECURITY DEFINER RPC so the worker accept/decline path (which
    // cannot read other workers under the RLS lockdown) still gets the admin list.
    const { data, error } = await supabase.rpc('get_admin_notification_recipients');
    if (error) return { ok: false, sent: 0, error: error.message };

    // Only per-event admins with the SMS channel enabled (digest admins get the
    // once-a-day summary instead). Defaults treat missing prefs as opted-in.
    const eligible = (data || []).filter(w =>
      (w.notify_mode || 'per_event') === 'per_event' && w.notify_sms !== false
    );

    const seen = new Set();
    let targets = [];
    for (const w of eligible) {
      const to = normaliseAUMobile(w.mobile);
      if (!to || seen.has(to)) continue;
      seen.add(to);
      targets.push({ to, name: w.name });
    }

    // Zeff-only gate: when the allowlist is set, override the roster and text
    // exactly those numbers so we never buzz the whole team by accident.
    if (Array.isArray(SMS_ALLOWLIST) && SMS_ALLOWLIST.length) {
      const gate = new Set();
      targets = SMS_ALLOWLIST
        .map(n => normaliseAUMobile(n))
        .filter(n => n && !gate.has(n) && gate.add(n))
        .map(to => ({ to, name: 'Zeff' }));
    }

    if (!targets.length) return { ok: false, sent: 0, error: 'no admin SMS recipients' };

    const results = await Promise.all(
      targets.map(t => sendWorkerSms(t.to, body).then(r => ({ ...r, to: t.to, name: t.name })))
    );
    return { ok: results.some(r => r.ok), sent: results.filter(r => r.ok).length, results };
  } catch (e) {
    return { ok: false, sent: 0, error: e?.message || String(e) };
  }
}

// Email the admins about an allocation event via send-bulk-email. Notification
// emails are GOOGLE (Gmail) ONLY — `gmail_only:true` tells send-bulk-email to
// never fall back to Resend for these. The shared ops mailbox (ADMIN_EMAIL)
// always gets the event as the team record; additionally each per-event admin
// with the Email channel on gets a personal copy. Daily-digest admins are
// skipped here and get the once-a-day summary instead. Fire-and-forget. Never throws.
export async function sendAdminEmail(subject, text) {
  try {
    const recipients = [{ name: 'Admin', email: ADMIN_EMAIL }];
    const seen = new Set([ADMIN_EMAIL.toLowerCase()]);
    try {
      const { data } = await supabase.rpc('get_admin_notification_recipients');
      for (const w of (data || [])) {
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
