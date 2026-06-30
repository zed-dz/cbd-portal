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
export const ADMIN_EMAIL = 'admin@cbdplantlabour.com.au';

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
export function allocationSmsBody({ name, client, site, start_date }) {
  const who = name ? `Hi ${name},` : 'Hi,';
  const where = client || site || 'a new job';
  const at = client && site ? `${client} — ${site}` : where;
  const when = start_date ? ` starting ${fmtNiceDate(start_date)}` : '';
  return `${who} you've been allocated to ${at}${when}. Open the portal to accept: ${PORTAL_URL}`;
}

// ── Admin broadcast (SMS + email) ──────────────────────────────────────────
// Every allocation event (create / accept / decline) drops an in-app bell
// notification AND now also texts every admin + emails ADMIN_EMAIL. All paths
// are fire-and-forget: they never throw and never block the UI.

// Short admin SMS bodies. `worker`/`client` already resolved by the caller.
export function adminCreateSmsBody({ worker, client, start_date }) {
  return `New allocation: ${worker || 'Worker'} → ${client || 'client'} (${start_date || 'TBC'}). Sent for acceptance.`;
}
export function adminAcceptSmsBody({ worker, client, start_date }) {
  return `${worker || 'Worker'} ACCEPTED ${client || 'client'} (${start_date || 'TBC'}).`;
}
export function adminDeclineSmsBody({ worker, client, start_date }) {
  return `${worker || 'Worker'} DECLINED ${client || 'client'} (${start_date || 'TBC'}).`;
}

// Text every admin (workers.access_level='admin' with a non-empty mobile).
// Numbers are E.164-normalised and de-duped. Returns a per-number result array
// but callers typically ignore it (fire-and-forget). Never throws.
export async function broadcastAdminSms(body) {
  try {
    const { data, error } = await supabase
      .from('workers')
      .select('name, mobile, access_level')
      .eq('access_level', 'admin');
    if (error || !data?.length) return { ok: false, sent: 0, error: error?.message };

    // Normalise + de-dupe numbers (keep first name seen for logging).
    const seen = new Set();
    const targets = [];
    for (const w of data) {
      const to = normaliseAUMobile(w.mobile);
      if (!to || seen.has(to)) continue;
      seen.add(to);
      targets.push({ to, name: w.name });
    }
    if (!targets.length) return { ok: false, sent: 0, error: 'no admin mobiles' };

    const results = await Promise.all(
      targets.map(t => sendWorkerSms(t.to, body).then(r => ({ ...r, to: t.to, name: t.name })))
    );
    return { ok: results.some(r => r.ok), sent: results.filter(r => r.ok).length, results };
  } catch (e) {
    return { ok: false, sent: 0, error: e?.message || String(e) };
  }
}

// Email ADMIN_EMAIL via the existing send-bulk-email path (Gmail when
// connected, else Resend). Fire-and-forget. Never throws.
export async function sendAdminEmail(subject, text) {
  try {
    const { data, error } = await supabase.functions.invoke('send-bulk-email', {
      body: {
        recipients: [{ name: 'Admin', email: ADMIN_EMAIL }],
        subject,
        body: text,
        audience: 'mixed',
      },
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
