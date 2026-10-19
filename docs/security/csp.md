# Content-Security-Policy and Permissions-Policy (vercel.json)

Audited 2026-10-19 against every external origin the client actually loads.
The header is ENFORCED (`Content-Security-Policy`), no longer report-only.

## Final header

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' data: https://fonts.gstatic.com;
  img-src 'self' data: blob: https://*.supabase.co;
  media-src 'self' blob:;
  worker-src 'self' blob:;
  connect-src 'self' https://*.supabase.co wss://*.supabase.co https://venture-command.vercel.app https://venturecommand.com.au;
  manifest-src 'self';
  frame-src 'none';
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
  object-src 'none';
  upgrade-insecure-requests

Permissions-Policy: camera=(self), geolocation=(self), microphone=(), payment=()
```

## Why each directive

| Directive | Value | Evidence in `src/` |
|---|---|---|
| `default-src` | `'self'` | Fallback for anything not listed. CRA emits `/static/js/*` and `/static/css/*` from the same origin. |
| `script-src` | `'self' 'unsafe-inline'` | CRA 5 inlines the webpack runtime chunk into `index.html` (`INLINE_RUNTIME_CHUNK` default). The print popups (`TimesheetDetailView.jsx` 297/391, `TimesheetsPage.jsx` 751) are `window.open('')` + `document.write` with an inline `<script>window.onload = … print()`; an `about:blank` popup inherits the opener's CSP. Removing `'unsafe-inline'` needs `INLINE_RUNTIME_CHUNK=false` AND rewriting those popups, so it stays for now. No external scripts exist. |
| `style-src` | `'self' 'unsafe-inline' https://fonts.googleapis.com` | Inline `style={{…}}` everywhere; `GlobalStyles` in `App.jsx` injects a `<style>` tag and a `<link>` to `fonts.googleapis.com/css2`. Print popups use inline `<style>`. |
| `font-src` | `'self' data: https://fonts.gstatic.com` | Google Fonts CSS references `fonts.gstatic.com`. `data:` kept for any inlined font. |
| `img-src` | `'self' data: blob: https://*.supabase.co` | `data:image/…` signature PNGs (`DailyTimesheetForm`, `TimesheetDetailView`, `SignaturePad`); camera capture preview is a `data:` URL and the saved file is a `blob:` (`ScanModal.jsx`); worker photos / certificates / PDFs render from Supabase storage (`*.supabase.co/storage/v1/object/...`). |
| `media-src` | `'self' blob:` | `<video>` in `ScanModal.jsx` gets a `MediaStream` via `srcObject`; `blob:` covers any object-URL playback. |
| `worker-src` | `'self' blob:` | Future barcode / image workers; CRA service worker if ever enabled. Without this directive workers fall back to `child-src` → `default-src`, which would block `blob:` workers. |
| `connect-src` | `'self' https://*.supabase.co wss://*.supabase.co https://venture-command.vercel.app https://venturecommand.com.au` | Supabase REST/auth/storage/functions (`supabaseClient.js`, `XeroSyncPage.jsx`, `PayrollTrackerPage.jsx`), Realtime over `wss:`, and the Omni help bubble (`OmniHelpBubble.jsx` → `/api/ecosystem/*`). If `REACT_APP_VC_URL` is ever set to another host, add it here. |
| `manifest-src` | `'self'` | `public/manifest.json` (PWA). |
| `frame-src` | `'none'` | No `<iframe>` anywhere in `src/`. Signed storage URLs, maps, WhatsApp and Gmail OAuth all open via `window.open(..., '_blank')` = navigations, not framed loads. |
| `frame-ancestors` | `'none'` | Portal must never be embedded (clickjacking). Mirrors `X-Frame-Options: DENY`. |
| `base-uri` | `'self'` | Blocks `<base>` injection rewriting relative URLs. |
| `form-action` | `'self'` | All forms submit via `onSubmit`/JS; no `<form action="https://…">` exists. Stops a form hijack posting credentials elsewhere. |
| `object-src` | `'none'` | No Flash/plugins. |
| `upgrade-insecure-requests` | — | Any accidental `http://` sub-resource is upgraded. |

## Permissions-Policy

* `camera=(self)` — the admin "📷 Scan" button (`ScanModal.jsx`, `getUserMedia`) was dead on the live site because the old value was `camera=()`.
* `geolocation=(self)` — the GPS clock-in being built on another branch.
* `microphone=()` and `payment=()` stay denied; nothing uses them.

## Navigations that are NOT governed by CSP (safe to keep)

`window.open` to Google Maps links, `wa.me`, signed Supabase storage URLs, Xero OAuth, Gmail OAuth (`console.cloud.google.com`), `portal.cbdpnl.com.au` invite links.

## How to re-verify after a deploy

1. Open the live portal with DevTools → Console. Any blocked resource prints `Refused to load … because it violates the following Content Security Policy directive`.
2. Walk: login → admin dashboard (fonts render in Syne / DM Sans) → Timesheets → open one → Print (popup must print) → 📷 Scan (camera prompt must appear) → Workers → open a worker photo / certificate → help bubble question.
3. `curl -sI https://portal.cbdpnl.com.au | grep -i -E "content-security|permissions-policy"` shows the two headers.
