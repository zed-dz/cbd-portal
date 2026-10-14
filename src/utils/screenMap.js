// What is on the user's screen RIGHT NOW, for the Portal Assistant.
//
// The assistant used to answer "where is X?" from a prompt written once by
// hand, so it told a user Sign out was top-right after the button had moved to
// the bottom of the sidebar. This reads the live page instead: every visible
// control, its label, and which part of the screen it sits in. It is rebuilt on
// every question, so it always matches the version of the portal being used.
//
// Data only — the server treats it as untrusted text and it grants nothing:
// the assistant's data access still comes from the caller's login.

const SELECTOR = 'button, a[href], [role="button"], [role="tab"], select, input[type="checkbox"], h1, h2, h3, label';
const MAX_ITEMS = 160;
const MAX_TEXT = 60;

function labelOf(el) {
  const t = (el.getAttribute('aria-label') || el.innerText || el.title || el.getAttribute('placeholder') || '')
    .replace(/\s+/g, ' ').trim();
  if (el.tagName === 'SELECT') {
    const opt = el.options?.[el.selectedIndex]?.text;
    return `dropdown${opt ? ` (showing "${opt.trim().slice(0, 30)}")` : ''}`;
  }
  return t.slice(0, MAX_TEXT);
}

function regionOf(rect, vw, vh) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const v = cy < vh / 3 ? 'top' : cy > (2 * vh) / 3 ? 'bottom' : 'middle';
  const h = cx < vw / 3 ? 'left' : cx > (2 * vw) / 3 ? 'right' : 'centre';
  return `${v}-${h}`;
}

function areaOf(el) {
  const tagged = el.closest('[data-area]');
  if (tagged) return tagged.getAttribute('data-area');
  if (el.closest('nav')) return 'left sidebar menu';
  if (el.closest('[role="dialog"], [data-modal]')) return 'open pop-up window';
  if (el.closest('header')) return 'top bar';
  return '';
}

export function buildScreenMap() {
  if (typeof document === 'undefined') return [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const seen = new Set();
  const out = [];
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (out.length >= MAX_ITEMS) break;
    if (el.closest('[data-assistant-root]')) continue;           // never describe the chat itself
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;              // hidden / collapsed
    if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue; // off-screen
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    const text = labelOf(el);
    if (!text) continue;
    const kind = /^H[1-3]$/.test(el.tagName) ? 'heading'
      : el.tagName === 'SELECT' ? 'dropdown'
      : el.tagName === 'LABEL' ? 'label'
      : el.getAttribute('role') === 'tab' ? 'tab'
      : el.tagName === 'A' ? 'link' : 'button';
    const region = regionOf(rect, vw, vh);
    const key = `${kind}|${text}|${region}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const area = areaOf(el);
    out.push(area ? { kind, text, where: region, area } : { kind, text, where: region });
  }
  return out;
}
