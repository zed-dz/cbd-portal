// Single source of truth for share links the admin gives to workers (onboarding
// and public profile). We prefer a build-time PORTAL_URL env var over the
// browser's window.location.origin so an admin testing on localhost never
// accidentally hands a worker a link they can't open.
//
// Resolution order:
//   1. REACT_APP_PORTAL_URL (set in Vercel + .env.local)
//   2. window.location.origin (falls back when running on the prod domain)
//   3. Hard-coded production URL (last-resort safety net)
//
// Used by: WorkersPage (Add Worker → Send Invite, Copy Link buttons),
// PendingWorkersPage (Send Reminder, Copy Link, SMS, WhatsApp).

const PROD_FALLBACK = 'https://cbd-portal-gray.vercel.app';

export function portalBaseUrl() {
  const envUrl = process.env.REACT_APP_PORTAL_URL;
  if (envUrl) return envUrl.replace(/\/+$/, '');
  if (typeof window !== 'undefined' && window.location && window.location.origin) {
    const origin = window.location.origin;
    // Defensive: never hand out a localhost/preview URL as a worker invite.
    if (/^https?:\/\/(localhost|127\.0\.0\.1|.*\.local)/i.test(origin)) return PROD_FALLBACK;
    return origin;
  }
  return PROD_FALLBACK;
}

export function onboardLink(profileToken) {
  return `${portalBaseUrl()}/onboard/${profileToken}`;
}

export function publicProfileLink(profileToken) {
  return `${portalBaseUrl()}/p/${profileToken}`;
}

// Build a tel/sms/WhatsApp deep-link suitable for opening a worker's preferred
// messenger pre-populated with their onboarding URL.
//
// `mobile` may be in any common AU format: "0412 345 678", "+61 412 345 678",
// "0412345678". We normalise to E.164 (+614...) for WhatsApp; SMS keeps the
// raw national number since iOS/Android handle either form.
export function normaliseMobileE164AU(mobile) {
  if (!mobile) return '';
  const digits = mobile.toString().replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('614')) return `+${digits}`;
  if (digits.startsWith('04') && digits.length === 10) return `+61${digits.slice(1)}`;
  if (digits.startsWith('4') && digits.length === 9) return `+61${digits}`;
  return digits.startsWith('+') ? digits : `+${digits}`;
}

export function smsLink({ mobile, body }) {
  // sms:?body= works on iOS and most modern Android browsers. Number is
  // optional in the URI; if present we prefix with the comma so SMS apps that
  // require explicit recipient still get one.
  const phone = (mobile || '').toString().replace(/[^\d+]/g, '');
  const enc   = encodeURIComponent(body || '');
  return phone ? `sms:${phone}?body=${enc}` : `sms:?body=${enc}`;
}

export function whatsappLink({ mobile, body }) {
  // wa.me requires E.164 with NO leading + or punctuation. If no mobile we
  // open the universal "send a message" screen and the admin picks the chat.
  const e164 = normaliseMobileE164AU(mobile).replace(/^\+/, '');
  const enc  = encodeURIComponent(body || '');
  return e164 ? `https://wa.me/${e164}?text=${enc}` : `https://wa.me/?text=${enc}`;
}

// Standard message we paste into SMS/WhatsApp. Keep this short — SMS clients
// truncate around 160 chars.
export function inviteMessage({ firstName, link }) {
  const greet = firstName ? `Hey ${firstName},` : 'Hey,';
  return `${greet} you've been added to CBD Plant & Labour's worker portal. Finish your profile here (takes ~1 min): ${link}`;
}
