# Fix Report — Inbound Applications Pipeline

**Incident:** Worker and client applications submitted through the marketing site (`miningresourcesaustralia.com`) and the LinkedIn ad were not appearing in the portal.

**Status:** RESOLVED — 2026-06-12.

**Resolution scope:** Both MRA Portal and CBD Portal.

---

## Root cause

The Lovable marketing site at `miningresourcesaustralia.com` posts form submissions to its **own** Supabase project (`yqiabdwysevitladphni`) — a project created and owned by Lovable's infrastructure, not by the user's Supabase organization. Your Personal Access Token does not grant access to it. The portal database (project ref `qtefchnpozpqtdpvfeov`) is a separate database that has never been wired up to receive that traffic.

Result: every applicant who filled the form on the marketing site or from the LinkedIn ad landed in a database the portal can't see. From the portal's perspective, no one had signed up since 2026-06-02 (10 days of complete blindness).

Diagnosed by:
1. Counting `auth.users` and `workers` rows on mra-portal (only 2, last on 2026-06-02).
2. Surveying the other Supabase projects in the org (`venture-command` had 8 unrelated B2B sales leads).
3. Inspecting the live marketing site's compiled JS bundle (`/assets/index-CMIp7Rby.js`) to extract the Supabase URL it talks to (`yqiabdwysevitladphni.supabase.co`).
4. Verifying via the Supabase Management API that the user's PAT cannot access that project (HTTP 403).

---

## What we shipped

A new inbound-applications pipeline that the marketing site, the LinkedIn ad, and a portal-hosted public form all feed into. Live on **both** Supabase projects so the same flow works for CBD too.

| Piece | Purpose |
|---|---|
| `worker_applications` table | Single source of truth for inbound applicants. Captures name / email / phone / message / source + triage status (new / reviewing / approved / rejected / converted). |
| `submit-application` edge function | Public-callable endpoint. Validates the payload server-side (length, regex), inserts via service_role so RLS on the table can stay admin-only (protects past applicants' PII). |
| `worker_applications` RLS | Anon callers can NOT read or write directly. Only authenticated admins can `SELECT`/`UPDATE`/`DELETE`. |
| `approve_application_to_worker` RPC | One-call "Convert to Worker" — materialises a `workers` row (or reuses one matching by email), marks the application as `converted`, links them. |
| Admin **Applications** page | Triage UI in the portal: filter by status / type, search, expand for review notes, one-click convert / reject / save. Sidebar badge shows count of new submissions. |
| Public **/apply** route | Portal-hosted form at `portal.miningresourcesaustralia.com/apply` (and `cbd-portal-gray.vercel.app/apply`). LinkedIn ad and marketing site CTAs can repoint here directly — same branding as portal, zero Lovable dependency. |

---

## Verification

| Check | Result |
|---|---|
| Edge function deployed (mra) | ✓ `submit-application v1`, ACTIVE |
| Edge function deployed (cbd) | ✓ `submit-application v1`, ACTIVE |
| Anon POST → edge function → row in DB | ✓ Sarah Test Applicant landed with status `new`, source `linkedin-ad` |
| Bad payloads rejected | ✓ Missing `full_name` → 400 `invalid_name`. Bad email → 400 `invalid_email`. |
| RLS protects against direct anon SELECT | ✓ `permission denied for table worker_applications` |
| RLS protects against direct anon INSERT | ✓ Blocked — must go through edge function |
| Admin SELECT works (authenticated context) | ✓ Visible in Applications page |
| Convert-to-Worker RPC | ✓ Creates a `workers` row, status `Profile Incomplete`, links via `converted_worker_id` |

---

## Outstanding action items for you

Two ~5-minute tasks to fully cut over:

### 1. Re-point the LinkedIn ad

LinkedIn Campaign Manager → edit the ad → "Destination URL" → set to:
```
https://portal.miningresourcesaustralia.com/apply?utm_source=linkedin-ad&type=worker
```

After this change, every click on the ad lands on a portal-hosted form and every submission shows up in the Applications page tagged `source=linkedin-ad`.

### 2. Re-point the Lovable marketing-site form (pick ONE option)

**Option A (simplest):** Change the "Apply for a Job" / "Apply for Credit" buttons on the Lovable site to link to `portal.miningresourcesaustralia.com/apply` and `portal.miningresourcesaustralia.com/apply?type=client`. The portal handles everything from there.

**Option B (keep the form on the marketing site):** Open the Lovable editor and change the `supabase.from("applications").insert(...)` call to a `fetch()` against the new edge function. Step-by-step instructions and full code snippet are in `APPLICATIONS_PIPELINE.md`.

### 3. (Optional) Backfill the last 10 days

10 days of submissions (2026-06-02 to today) are still trapped in Lovable's Supabase project. To recover them:
- Ask Lovable support to either transfer that project into your Supabase org, OR export the `applications` table to CSV.
- Once you have the CSV, the Supabase Dashboard table importer drops them straight into `worker_applications` and they'll all show up in the portal.

---

## Code that changed (both repos)

```
supabase/migrations/20260612_worker_applications_inbound_pipeline.sql    NEW
supabase/functions/submit-application/index.ts                            NEW
src/pages/Applications/ApplicationsPage.jsx                               NEW
src/pages/Apply/ApplyPage.jsx                                             NEW
src/App.jsx                                                               +/apply route
src/portals/AdminPortal.jsx                                               +Applications nav + badge
APPLICATIONS_PIPELINE.md                                                  NEW (team operations guide)
```

---

*Report generated 2026-06-12.*
