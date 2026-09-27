// Map-link sanity check for the pin-drop fields (Dashpivot parity 1.2).
// Accepts the link shapes clients actually text through. Anything else STILL
// SAVES — the warning is a hint, not a gate, because some clients send
// what3words / Mapbox / council-portal links that open fine on a phone.
export function isLikelyMapLink(url) {
  if (!url || !String(url).trim()) return true;
  let u;
  try { u = new URL(String(url).trim()); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  if (host === 'maps.app.goo.gl' || host === 'maps.apple.com') return true;
  if (host === 'goo.gl' && path.startsWith('/maps')) return true;
  if (host === 'maps.google.com' || host.startsWith('maps.google.')) return true;
  // google.<tld>/maps and www.google.<tld>/maps
  if (/(^|\.)google\.[a-z.]+$/.test(host) && path.startsWith('/maps')) return true;
  return false;
}
