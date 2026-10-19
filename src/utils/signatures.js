// Drawn-signature helpers for site inductions and company documents
// (2026-10-20). Pure functions, no React, no Supabase: the size/format check
// the sign buttons run, a short device label from a user agent, and the HTML
// of a "signed copy" print (the caller hands it to openPrintWindow).

// Same cap as the CHECK constraint in 20261020_signatures_and_grants.sql.
export const SIGNATURE_MAX_BYTES = 200 * 1024;
// Same floor as require_drawn_signature() in 20261020_audit_fixes.sql: below
// every genuine mark measured in Chromium and WebKit (smallest: a 4 px tick at
// 1,226 chars), above an empty / 1x1 / tightly compressed blank. A full-size
// blank from the pad is never sent: SignaturePad emits '' until ink is drawn.
export const SIGNATURE_MIN_CHARS = 1100;
const PNG_PREFIX = 'data:image/png;base64,';

// null when the drawn signature can be stored, else a message for the toast.
export function signatureProblem(dataUrl) {
  const s = String(dataUrl || '');
  if (!s) return 'Sign with your finger in the box first.';
  if (!s.startsWith(PNG_PREFIX)) return 'The signature could not be read — tap Clear and sign again.';
  if (s.length > SIGNATURE_MAX_BYTES) return 'The signature is too large — tap Clear and sign again with a simpler mark.';
  if (s.length < SIGNATURE_MIN_CHARS) return 'The signature is too small — sign your name in the box.';
  return null;
}

// "iPhone · Safari", "Android · Chrome", "Windows · Edge" … from a user agent.
export function shortDevice(ua) {
  const s = String(ua || '');
  if (!s.trim()) return '—';
  let device = 'Other';
  if (/iPhone/i.test(s)) device = 'iPhone';
  else if (/iPad/i.test(s)) device = 'iPad';
  else if (/Android/i.test(s)) device = /Mobile/i.test(s) ? 'Android phone' : 'Android tablet';
  else if (/Windows/i.test(s)) device = 'Windows';
  else if (/Macintosh|Mac OS X/i.test(s)) device = 'Mac';
  else if (/CrOS/i.test(s)) device = 'Chromebook';
  else if (/Linux/i.test(s)) device = 'Linux';

  let browser = 'browser';
  if (/EdgA?\/|EdgiOS\//i.test(s)) browser = 'Edge';
  else if (/SamsungBrowser\//i.test(s)) browser = 'Samsung Internet';
  else if (/OPR\/|Opera/i.test(s)) browser = 'Opera';
  else if (/FxiOS\/|Firefox\//i.test(s)) browser = 'Firefox';
  else if (/CriOS\/|Chrome\//i.test(s)) browser = 'Chrome';
  else if (/Safari\//i.test(s)) browser = 'Safari';
  return `${device} · ${browser}`;
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// One signature as a printable page: the text that was signed, the typed name,
// the drawn signature, time, IP, device and version. No <script>, no inline
// handlers (strict CSP); the opener triggers print via openPrintWindow.
// kind: 'Site induction' | 'Document'.
// snapshot / snapshotSha256: the exact wording stored by the server when the
// person signed (content_snapshot / content_sha256, 2026-10-20). When present
// it is printed instead of today's text, with its SHA-256 fingerprint.
// Rows signed before snapshots existed fall back to `text` (today's wording,
// currentVersion) with a note when the versions differ.
export function buildSignedCopyHtml({
  kind = 'Document', title = '', context = '', text = '', currentVersion = null,
  signedVersion = null, workerName = '', signedName = '', signedAt = '',
  ip = '', userAgent = '', signaturePng = '', brand = '', printedAt = '',
  snapshot = '', snapshotSha256 = '',
}) {
  const png = String(signaturePng || '').startsWith(PNG_PREFIX) ? signaturePng : '';
  const hasSnap = !!String(snapshot || '').trim();
  const versionNote = hasSnap
    ? '<div class="note ok">The text below is the exact wording this person signed, stored by the server at the moment of signing.</div>'
    : currentVersion != null && signedVersion != null && Number(currentVersion) !== Number(signedVersion)
      ? `<div class="note">This person signed version ${esc(signedVersion)}. The text below is the current version ${esc(currentVersion)} — the earlier wording is not kept.</div>`
      : '<div class="note">Signed before the portal kept a copy of the wording: the text below is the current version.</div>';
  const shownText = hasSnap ? snapshot : text;
  const row = (k, v) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Signed copy — ${esc(title)} — ${esc(signedName || workerName)}</title>
<style>body{font-family:-apple-system,Segoe UI,sans-serif;color:#111;padding:28px;max-width:800px;margin:0 auto}
h1{font-size:21px;margin:0 0 4px}.sub{color:#666;font-size:12px;margin-bottom:16px}
.text{white-space:pre-wrap;font-size:13.5px;line-height:1.6;border:1px solid #ddd;border-radius:6px;padding:14px;margin-bottom:18px}
.note{background:#fff7e6;border:1px solid #f5c26b;border-radius:6px;padding:8px 12px;font-size:12px;margin-bottom:12px}.note.ok{background:#eefaf1;border-color:#8fd19e}
.mono{font-family:Consolas,Menlo,monospace;font-size:11px;word-break:break-all}
table{border-collapse:collapse;width:100%;margin-bottom:14px}th{text-align:left;width:150px;color:#555;font-size:11.5px;text-transform:uppercase;letter-spacing:.5px;padding:7px 8px;border-bottom:1px solid #ddd;vertical-align:top}
td{padding:7px 8px;border-bottom:1px solid #ddd;font-size:13.5px;word-break:break-word}
.sig{border:1px solid #ccc;border-radius:6px;padding:6px;background:#fff;display:inline-block}.sig img{display:block;max-width:420px;max-height:160px}
.footer{color:#888;font-size:11px;margin-top:18px}</style></head><body>
<h1>${esc(kind)} — signed copy</h1>
<div class="sub">${esc(title)}${context ? ` · ${esc(context)}` : ''}${!hasSnap && currentVersion != null ? ` · current version ${esc(currentVersion)}` : ''}</div>
${versionNote}
<div class="text">${esc(shownText || '(no text — the PDF attached to the document is the full wording)')}</div>
<table>
${row('Worker', esc(workerName || '—'))}
${row('Signed as (typed)', esc(signedName || '—'))}
${row('Drawn signature', png ? `<div class="sig"><img src="${esc(png)}" alt="Drawn signature"></div>` : 'none recorded (signed before drawn signatures)')}
${row('Signed at', esc(signedAt || '—'))}
${row('Version signed', signedVersion != null ? `v${esc(signedVersion)}` : '—')}
${hasSnap ? row('Wording fingerprint', `<span class="mono">SHA-256 ${esc(snapshotSha256 || '—')}</span>`) : ''}
${row('IP address', esc(ip || '—'))}
${row('Device', esc(shortDevice(userAgent)))}
${row('Full user agent', `<span style="font-size:11px;color:#555">${esc(userAgent || '—')}</span>`)}
</table>
<div class="footer">Printed${brand ? ` from the ${esc(brand)} portal` : ''}${printedAt ? ` on ${esc(printedAt)}` : ''}. IP and device were recorded by the server when the signature was saved.</div>
</body></html>`;
}
