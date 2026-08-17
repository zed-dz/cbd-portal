# CBD Plant & Labour — Operations Portal

This file is automatically read by Claude Code at the start of every session.
It captures the **current state**, **architecture**, and **conventions** so any
future session can resume work without re-deriving context.

---

## Verification discipline (always)

Before starting any task, state in one line **how it will be verified** (the command, endpoint, query, or screen that proves it works). After finishing, **run that verification and report the actual result** — real output, not a claim. If a check failed or a step was skipped, say so.

## What this app is

A React 19 + Supabase + Vercel ops portal for **CBD Plant & Labour** (NSW, AU
construction labour-hire — road / rail / water). It runs the entire workflow:

| Stage | What it does |
|---|---|
| Workers     | Roster: full-time / casual / subcontractor. A/B/C pay rate bands. Profile tokens for shareable / onboarding links. |
| Allocations | Day/week allocation of workers to client sites (table + calendar). |
| Timesheets  | Worker self-submit + admin approve. Computed pay/charge hours, OT, allowances, scenarios (rain-off, leave, etc.). |
| Clients     | Per-client A/B/C charge rates, with per-role overrides (`client_rate_cards`). Jobs per client. |
| Payroll     | Computes pay + charge per timesheet. Push to Xero. CSV export. |
| Xero Sync   | OAuth flow to Xero, push approved timesheets as payslip entries. |
| Licence Agent | Worker certifications + expiry tracking. |
| Pending Workers | Workers not yet active — send invites via Resend. |
| Bulk Messages | Email blasts via Gmail (with Resend fallback). Sent History tab. SMS stubbed. |

**Live URL:** https://cbd-portal-gray.vercel.app (NOT `zeta` — common confusion)

---

## Stack at a glance

- **Frontend:** React 19, CRA (`react-scripts` 5), inline styles using theme tokens (no Tailwind, no CSS framework).
- **Auth/DB:** Supabase project `tsizneslellcqusjwtub` (region: ap-southeast-2).
  - Anon JWT and RLS policies (`auth.uid() IS NOT NULL` on most tables).
  - Two SECURITY DEFINER RPCs exposed to anon for the onboarding magic-link flow.
- **Edge functions (Deno):**
  - `xero-callback` — Xero OAuth handler
  - `xero-push` — push approved timesheets to Xero
  - `xero-data` — read Xero org data
  - `send-invite` — single worker invite email. **Routes through Gmail when `gmail_tokens` row exists** by forwarding the caller's JWT to `gmail-send`; falls back to Resend if Gmail fails or isn't connected.
  - `send-bulk-email` — bulk email blast. **Same Gmail-first / Resend-fallback routing** as send-invite. Sends one email per recipient via `gmail-send` (4-way concurrency) when on Gmail; uses Resend's batch endpoint (100/call) on fallback. Logs every send to `message_log`.
  - `gmail-start` / `gmail-callback` — Google OAuth flow for the in-app Inbox
  - `gmail-send` — send via the connected Gmail account, mirror into `email_threads`/`email_messages`
  - `gmail-sync` — pull recent threads from Gmail, match participants to workers/clients (exact email OR `clients.email_domains` match); skips threads with no match so personal mail never enters Supabase
  - `gmail-modify` — toggle read/unread, star/unstar, archive/unarchive on a thread; mirrors to Gmail labels and updates `email_threads`
  - `gmail-status` / `gmail-disconnect` — connection state + revoke
- **Email:** **Gmail-first, Resend-fallback**. The connected Gmail account
  (`theteamcbd@gmail.com`) is the primary sender for invites and blasts —
  reaches any recipient and lets replies land in the in-app Inbox. Resend
  (free 3k/month, `onboarding@resend.dev`) is the fallback path used only
  when Gmail is disconnected; on the Resend free tier emails are restricted
  to your Resend account email (`fsociety.2017@protonmail.com`) until a
  domain is verified.
- **SMS:** wired via **Twilio** (`send-sms` edge function; creds in `integration_secrets`).
  The roster is every worker with `access_level='admin'` + per-event + SMS on (via the
  `get_admin_notification_recipients` RPC), but **`SMS_ALLOWLIST` in `utils/notify.js`
  gates actual texts to Zeff only — the owner's standing decision (re-confirmed
  2026-07-11 after a brief same-day trial of all-admins)**. Bell + email still reach
  all admins. Don't remove the gate without an explicit owner ask.
- **Deploy:** Vercel auto-deploys `main` branch. `vercel.json` rewrites all routes
  to `index.html` (SPA fallback).

---

## Routing model

No router library. `App.jsx` does pathname pattern matching for two public routes
before the auth gate:

- `/p/<uuid>`        → [PublicProfilePage](src/pages/PublicProfile/PublicProfilePage.jsx) — read-only worker card for clients
- `/onboard/<uuid>`  → [OnboardProfilePage](src/pages/OnboardProfile/OnboardProfilePage.jsx) — worker self-completes profile

Anything else → `AppShell` which renders `LoginPage` / `AdminPortal` / `WorkerPortal`
based on session + `currentWorker.role`.

---

## Pay/charge rate model (important)

**Pay and charge are two different rule sets — read the right table.** They used
to be documented here as one shared A/B/C table, which was wrong: the thresholds
genuinely differ (Saturday day *pay* splits at **2h**; Saturday day *charge* has
no split at all).

`A/B/C` name the **client rate-card columns** (1× / 1.5× / 2× tiers). **Don't add
back the old `regular / overtime / night / weekend` labels** in the UI.

### Pay — what the worker is paid

Authoritative source is the DB function `split_shift_hours()` (migration
`20260806_penalty_rates_and_approver.sql`). It writes `ordinary / rdo_hours /
ot15_hours / ot2x_hours` onto each timesheet at save time, and payroll pays
straight from those stored buckets — so the payslip can never disagree with the
hours printed on the timesheet.

| Shift | Split |
|---|---|
| Sunday · Public Holiday · **Saturday night** | **all hours 2×** |
| **Saturday day** | first **2h** at 1.5×, everything after at 2× |
| Weekday night | first **8h** at 1.5×, everything after at 2× |
| Weekday day — full-time | 7.6h ordinary + 0.4h banked to RDO, then 1.5× to the 10th hour, then 2× |
| Weekday day — casual / subcontractor | 8h ordinary, then 1.5× to the 10th hour, then 2× |
| Any non-worked scenario (leave, rain-off, LWOP, training…) | **all ordinary** — penalties never apply |

`computePayrollRow` in [payroll.js](src/utils/payroll.js) reproduces these shapes
as a **fallback** for pre-2026-08-06 rows carrying no stored split, and always for
subcontractors (flat rate + flat `subcontractor_night_loading`, default $10).
Thresholds are overridable in `payroll_config`: `saturday_threshold_hours` (2),
`night_threshold_hours` (8), `ot_threshold_daily` (7.6), `rdo_daily_accrual` (0.4).

Payroll reads `workers.pay_rate_regular` / `pay_rate_overtime` — **not** the worker
A/B/C columns — and derives penalty rates as multiples of `pay_rate_regular`. That
is why the legacy mirror writes in
[WorkersPage.jsx](src/pages/Workers/WorkersPage.jsx) must stay alive.

### Charge — what the client is billed

Single source: `computeChargeAmount` in [payroll.js](src/utils/payroll.js). Bands
come from the matched `client_rate_cards` line, else the client's own A/B/C, else
the legacy `rate_regular / rate_overtime / rate_weekend` columns — so keep the
mirror writes in [ClientsPage.jsx](src/pages/Clients/ClientsPage.jsx) alive too.

| Shift | Billed |
|---|---|
| Sunday · Public Holiday (day or night) | all hours **C** |
| Saturday night | all hours **C** |
| **Saturday day** | all hours **B** — no threshold |
| Weekday night | all hours **B** |
| Weekday day | first **8h** at **A**, everything after at **B** |

⚠️ **Known margin asymmetry — NOT owner-confirmed.** Pay reaches 2× in places
charge never does: a Saturday day shift is *paid* 2× from hour 3 but *billed* at B
for its whole length, and weekday overtime bills at B however long it runs, never
reaching C. Public holidays are billed as Sunday (C) by assumption. See the
comment block above `CHARGE_DAY_THRESHOLD` in payroll.js before "fixing" either.

Per-client per-role overrides live in `client_rate_cards`. Role matching is fuzzy
on purpose (`findRateLine`) and reports which tier matched, so a row that never
found a priced line is flagged rather than silently billed the catch-all.

---

## Design system

All inline-style based. Tokens in [theme.js](src/theme.js):

- `C` — color palette (cool dark, single orange accent `#f97316`)
- `R` — radius scale (sm:6, md:8, lg:11, xl:14, pill:999)
- `SHADOW`, `T` — elevation, timings
- `MONO` — monospace font stack
- `inputStyle`, `btnPrimary`, `btnSecondary`, `btnDanger`, `btnSmall`

Shared components in [src/components/index.js](src/components/index.js):
`ToastContainer`, `Spinner`, `Badge`, `Modal` (with backdrop blur + Escape close),
`Field` (with `hint` + `error`), `EmptyState`, `TableWrap`/`Th`/`Td`,
`allocationBadge`, `timesheetBadge`, `certBadge`.

Global styles injected from `App.jsx` `<GlobalStyles>`: scrollbar theming, focus
rings (orange glow), button active-press, autofill fix, table row hover.

**Convention:** prefer the design system over custom CSS. If a new pattern is
needed twice, factor it into `components/index.js`.

---

## Key files / where to look

```
src/
├── App.jsx                          ← Route detection, global styles, auth bootstrap
├── theme.js                         ← Design tokens
├── components/
│   ├── index.js                     ← Modal, Badge, Field, Toast, Table primitives
│   ├── blast/SendBlastModal.jsx     ← Top-bar bulk email blast
│   ├── inbox/EmailHistoryPanel.jsx  ← Recent-emails strip embedded in Worker/Client modals; dispatches `cbd:navigate` to jump to Inbox
│   └── scan/ScanModal.jsx           ← Top-bar camera + QR detect
├── portals/
│   ├── AdminPortal.jsx              ← Sidebar nav + top bar + page router
│   └── WorkerPortal.jsx             ← Worker-facing tabbed view
├── pages/                           ← One folder per admin page
│   ├── Workers/                     ← A/B/C bands, invite flow, share links, inline email history
│   ├── Clients/                     ← A/B/C bands, role rate cards, jobs, email_domains chips, inline email history
│   ├── Timesheets/                  ← Scenario-driven hours computation
│   ├── Payroll/                     ← Compute pay/charge, push to Xero
│   ├── Inbox/                       ← Team-email inbox; star/archive/mark-unread; templates; add-unknown-sender
│   │   └── inboxApi.js              ← Shared helpers: modifyThread, loadTemplates, interpolate, buildTemplateContext
│   ├── Templates/                   ← CRUD for email_templates (canned messages with {{placeholders}})
│   ├── PublicProfile/               ← /p/<token>  (client-facing)
│   └── OnboardProfile/              ← /onboard/<token>  (worker self-onboard)
├── utils/
│   ├── payroll.js                   ← Pure pay/charge calc fns (no React, no Supabase)
│   ├── useDraft.js                  ← Form auto-save hook
│   ├── csv.js                       ← UTF-8 BOM-prefixed CSV download
│   └── dates.js                     ← fmtDate, todayISO
└── constants/
    ├── scenarios.js
    └── jobTitles.js

supabase/
├── migrations/
│   ├── 20260416_xero_tokens.sql
│   ├── 20260430_job_roles_and_client_jobs.sql
│   └── 20260512_rate_bands_and_profile.sql  ← A/B/C + profile_token + RPCs
└── functions/
    ├── xero-callback/
    ├── xero-data/
    ├── xero-push/
    ├── send-invite/
    └── send-bulk-email/
```

---

## Database — non-obvious bits

- `workers.profile_token` (UUID, unique, auto-generated) — opaque key for the
  shareable profile + onboarding magic links. **Don't ever expose it in URLs
  beyond `/p/<token>` and `/onboard/<token>`** — that's the trust boundary.
- `get_public_worker_profile(token)` RPC (SECURITY DEFINER, search_path pinned) —
  returns a **safe column subset** for the public profile. No pay rates, email,
  address, ABN. Anon can call.
- `update_worker_via_token(token, mobile, address, licences)` RPC — lets a
  worker self-update during onboarding without auth. Sets `app_status` to
  `Completing Profile`.
- `client_rate_cards (client_id, role_name, rate_a, rate_b, rate_c)` — per-role
  override of the client default A/B/C. Look here first before falling back to
  `clients.rate_a/b/c`.
- `message_log` — audit log of every bulk-email + gmail send. Used by the
  "Sent History" tab in Bulk Messages and by the green "✓ recently emailed"
  pill next to recipients.
- `gmail_tokens` (single row, id=1) — OAuth tokens for the connected **team
  email** account. `email_address` is the from address. Whoever connects
  becomes "the company inbox" — the whole team sees the same threads and sends
  from this address. `last_history_id` is reserved for future incremental sync
  via Gmail's history API.
- `email_threads` + `email_messages` — local cache of Gmail conversations so
  the Inbox UI doesn't pay an API call per render. Threads carry optional
  `worker_id` / `client_id` foreign keys, populated by `gmail-sync` when a
  participant's email matches `workers.email`, `clients.contact_email`, or a
  domain in `clients.email_domains[]`. `matched_by_domain` records which
  domain was used. `starred` / `archived` mirror Gmail's STARRED / INBOX
  labels. Threads with no match are never stored (privacy guarantee).
- `clients.email_domains TEXT[]` — list of company domains for the client
  (e.g. `['sydneywater.com.au']`). Anything from those domains is auto-tagged
  to this client in the Inbox. Consumer domains (gmail.com, yahoo.com…) are
  ignored even if entered, so personal mail can't be claimed. Seeded from
  `contact_email` on first migration.
- `email_templates` — reusable canned messages with `{{placeholder}}` support.
  Used by Inbox compose / reply dropdowns. Available placeholders are listed
  in [src/pages/Inbox/inboxApi.js](src/pages/Inbox/inboxApi.js) `placeholderHints()`.

Supabase advisor flagged these RPCs as "anon can execute SECURITY DEFINER" —
**that is intentional** (it's the magic-link contract). Don't "fix" it by
revoking grants. Do keep `search_path` pinned to `public, pg_temp`.

---

## Build / dev / common commands

```bash
# Local dev
npm start          # CRA dev server on :3000

# Production build
npm run build      # outputs to build/, Vercel picks up on push
```

Vercel auto-deploys on push to `main`. Path-with-spaces gotcha: from the parent
folder, `npm run build` fails because the path has spaces. Run from inside
`cbd-portal/` or invoke node directly:

```bash
node ./node_modules/react-scripts/bin/react-scripts.js build
```

C: drive has historically been **full** on the user's Windows machine (causing
pandoc/npm cache failures). Use `Z:\tmp` as a scratch area if needed.

---

## Recent additions (2026-07-12 — AUTONOMOUS supervisor sign-off chain)

- **Fully autonomous timesheet chain** (owner request, two iterations same day):
  worker SUBMITS a daily timesheet → `sendTimesheetForClientApproval`
  (utils/clientApproval.js) immediately emails and texts the **site supervisor**
  (project `site_contact_*`, fallback client contact) a tokenised link
  `/approve-ts/<uuid>` → `ClientApprovePage` (public, anon RPCs
  `get_timesheet_for_client_approval` / `approve_timesheet_via_token`) → the
  supervisor's acceptance **auto-approves the timesheet AND makes it billable**
  — no admin step. Admins can still adjust/reject anytime; failures to send
  (no site contact / channel down) light up the admin bell
  (`timesheet_signoff_blocked`). **Payroll billable = status approved AND
  (`client_approved` OR legacy `header_id is null`).** Admin fallbacks in the
  Timesheets View modal: Send/Resend to supervisor / Mark accepted (verbal —
  also auto-approves). Pre-existing approved rows were grandfathered.
  **The in-form "Client Manual Signature" pad was REMOVED** (the tokenised
  sign-off replaces it; old signatures still render on old sheets).
  **7-day auto-approval:** if the supervisor doesn't respond (and the office
  doesn't reject) within 7 days of the link being sent — or of submission when
  no link could be sent — `auto_approve_stale_timesheets()` approves it
  automatically (hourly pg_cron `auto-approve-stale-timesheets`, bell
  notification `timesheet_auto_approved`; the View panel shows the exact
  auto-approve date, and the email/SMS/supervisor page state the 7-day rule).
  Migrations `20260712_client_approval_chain.sql` +
  `20260712_autonomous_supervisor_signoff.sql` +
  `20260712_auto_approve_after_7_days.sql`. Extracted to Reusable Assets
  as **timesheet-suite** together with the whole daily-timesheet stack.

## Recent additions (July 2026 — team feedback round, 2026-07-11)

- **OT payroll bug FIXED** — `save_daily_timesheet` was writing
  `pay_hours = regular_hours` (7.6-capped) and never setting `overtime_hours`,
  so daily-flow submissions silently dropped OT from pay while charging the
  client full hours. Now `pay_hours = total_hours` and
  `overtime_hours = total − regular`. Existing non-exported rows were repaired
  in the DB. See migration `20260711_ot_fix_adjustments_take5_task.sql`.
- **Adjustment audit trail** — `timesheets` carries
  `original_start_time/original_end_time/original_break_minutes` +
  `adjusted_by/adjusted_at`. The RPC snapshots originals across its
  delete+reinsert edit model; an admin changing times stamps the adjustment, a
  worker resubmitting their own pending sheet does not. Adjustments are shown
  in the edit form, the detail view, and the printed timesheet.
- **Full timesheet view + Print/Save-PDF** —
  `components/timesheet/TimesheetDetailView.jsx` (also exported `printTimesheet`).
  Admin: Timesheets → Daily → View. Worker: My Timesheets → View. Hours only —
  no pay/charge rates — so it's safe to hand to a client.
- **Timesheets tables** — Daily tab now shows Date / Start / Finish / Normal /
  OT per row (header query embeds `timesheets(*)` line rows); Line tab gained
  Start/Finish columns.
- **Full-time minimum day** — `applyFullTimeMinDay` in `utils/payroll.js`
  (used by Payroll page): full-timer on a short standard weekday is topped up
  to 8h pay per DAY (client still charged actual). Config override:
  `payroll_config.min_day_hours_fulltime`. Weekend/PH/non-standard scenarios
  and sub-0.5h days excluded.
- **Take 5 v2** — worker states the task, then 2–3 task-specific hazards each
  with a control measure (`take5.task` + `take5.task_hazards` jsonb; legacy
  `hazards`/`controls` text still written for compat).
- **Client Approvals page removed** (nav + route + page) per team feedback —
  the `client_approved` column remains in the DB, unused.
- **PWA / app-shell** — portal is installable (manifest + branded icons +
  `public/sw.js`; registered in `src/index.js`, production only). Static
  assets cache-first, navigations network-first, Supabase never cached.

## Recent additions (June 2026)

- **Schedule of Rates v2** — `client_rate_cards` is now a full SOR line-item
  model matching the printed PDF. Each row carries `uom` (hour/shift/day/
  ton/unit/km/m³/m²/lm/each), an optional `category` (labour/plant/
  attachments/materials/allowances/other), `sort_order`, and A/B/C bands
  (B & C nullable so single-rate items like Materials use only A).
  UI groups items by category, shows UOM next to description, includes an
  "+ Add many" bulk-entry table. See migration
  `20260603_projects_site_contact_and_rate_line_items`.
- **📤 Upload rates** — paste-or-upload a whole SOR from PDF/Excel/CSV in one
  shot. `UploadRatesModal` in `src/pages/Clients/ClientsPage.jsx` auto-detects
  tab / pipe / comma delimiters, fuzzy-matches headers (Description, UOM,
  A/B/C, Category, Notes — plus the synthetic `row_number` canonical so a
  leading "Item" or "#" column gets ignored), normalises UOM/category, and
  treats POR/POA/TBA/blank as null. Includes a live preview table and an
  optional "replace existing items" toggle that inserts BEFORE deleting old
  rows (so a failed insert never strands the user with an empty list).
  See `TEAM_GUIDE.md` for the team-facing how-to.
- **Projects per client** (formerly "Jobs"). `client_jobs` got
  `site_contact_name` / `site_contact_email` / `site_contact_phone` so a
  single client with multiple active projects can carry a different on-site
  contact per project. Top-level client `contact` stays for billing/admin.
- **UI terminology** — "charge bands" → "client rates", "Jobs" → "Projects",
  "Roles & Rates" tab → "Schedule of Rates", "Job Roles" library tab →
  "Common Roles" (still used for description autocomplete).


- **Self-signup live** — Postgres trigger `handle_new_auth_user` on
  `auth.users` auto-creates a matching `workers` row on signup. First user
  ever becomes admin; everyone after lands as `employee`. Admin promotes via
  the Workers page. **No more manual `INSERT INTO workers` SQL** to onboard
  team members. See migration `self_signup_trigger`.
- **LoginPage has tabs** — `Sign in` / `Create account`. Signup calls
  `supabase.auth.signUp()` directly; the trigger handles the workers-row
  side. See [src/pages/Login/LoginPage.jsx](src/pages/Login/LoginPage.jsx).
- **Components reorganized** — the giant `src/components/index.js` was
  split into one-component-per-file under `src/components/ui/` (Modal,
  Badge, Toast, Spinner, Field, EmptyState, Table). `index.js` is now a
  thin barrel re-exporter, so all existing imports keep working.
- **Repo cleanup** — removed the 4 MB `CBD-Portal-Guidebook.pdf` + `.docx`
  binaries from tracking (re-buildable from DOCS.md). Added `*.pdf` / `*.docx`
  to `.gitignore` so they don't sneak back in. README at the root now
  orients new readers without them having to dig into CLAUDE.md first.

## Recent fixes worth knowing (May 2026)

- **Allocation conflict detection** — both [AllocationsPage](src/pages/Allocations/AllocationsPage.jsx) and [Calendar](src/pages/Calendar/AllocationsCalendarPage.jsx) check for overlapping `pending`/`confirmed` allocations on the same worker before save. Inline yellow banner inside the modal + `window.confirm` override if you proceed. Calendar does a just-in-time DB query at save time because its in-memory `allocations` is range-filtered.
- **`useDraft` form-reset bug** — when modal opens for an existing record, the hook used to reset the form to defaults right after `openEdit` populated it. Fix: only restore from localStorage when a draft *actually* exists. See [useDraft.js](src/utils/useDraft.js).
- **Worker "Quick Licences" vs "Certifications"** — both intentionally exist. Quick Licences is free-text for fast capture + table search/filter; Certifications is the compliance source-of-truth with expiry tracking. The Field hint in the worker modal explains this — don't remove either.
- **Email routing (the big one)** — `send-invite` and `send-bulk-email` were silently failing because they used Resend with the sandbox sender. Now both forward the **caller's Authorization header** to `gmail-send` so the function-to-function call passes `verify_jwt`. Don't try to use `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` from env for this — neither is auto-provided to edge functions in a way that satisfies verify_jwt. Forward the caller's JWT.

## Conventions established this session

- **Inline styles only** — no CSS files, no Tailwind. Use theme tokens.
- **Edit existing files** — only create new files when a clear new module is
  warranted. Pages are organized one-folder-per-page.
- **Don't add comments explaining what code does.** Only add a comment for
  *why* — a hidden constraint, workaround for a bug, or surprising invariant.
- **A/B/C bands replace regular/overtime/night/weekend** in the UI. Legacy
  columns are still written on save for now; don't introduce them back into
  forms.
- **The accent orange `#f97316` is reserved for primary CTAs and brand**
  (logo, primary buttons, stat callouts). Stat cards use cooler colors so
  accent CTAs stay loud.
- **Numeric / status text uses the `MONO` font stack** for tabular feel.
- **Drafts auto-save** to localStorage via `useDraft(key, initial)` — keyed
  per-record so switching between Edit Worker modals doesn't bleed state.

---

## Gmail Inbox setup (one-time)

The `/inbox` page in the portal lets you send and receive emails through
your real Gmail / Google Workspace account — replies thread back in
automatically. Everything is deployed; it just needs OAuth credentials.

1. **Google Cloud Console** → create or pick a project.
2. **APIs & Services → Library** → enable **Gmail API**.
3. **APIs & Services → OAuth consent screen** → External, add scopes
   `gmail.modify` and `userinfo.email`. Add your Gmail address to test users
   while in Testing mode.
4. **APIs & Services → Credentials → Create OAuth client ID** → Web
   application. Authorized redirect URI:
   `https://tsizneslellcqusjwtub.supabase.co/functions/v1/gmail-callback`
5. Copy the Client ID + Client Secret. In Supabase → Project Settings →
   Edge Functions → Secrets:
   ```
   GMAIL_CLIENT_ID = …
   GMAIL_CLIENT_SECRET = …
   ```
6. Open the portal → Inbox → click **Connect Gmail**, approve the consent.
   First sync runs automatically; the green dot in the sidebar shows
   incoming-mail state.

## Pending follow-ups (your call)

1. **Verify a Resend domain** so blast emails go to anyone (not just your
   Resend account email). 10 min once you pick a domain — add SPF/DKIM/DMARC
   records, then set `INVITE_FROM` secret in Supabase to your real sender.
   *Note:* once Gmail Inbox is connected, the Inbox page is the better path
   for client conversations because replies thread back in. Keep Resend for
   one-way blasts.
2. **SMS provider** — Twilio (~$0.01/AU SMS) when you're ready. The UI button
   is wired in but disabled with a "SOON" pill.
3. **Photo upload from Scan modal → attach to worker cert** — currently the
   Scan modal downloads photos locally. Hooking Supabase Storage + attaching
   to a `certifications` row is a natural next step.
4. **Onboarding flow doesn't create an auth user** — workers submit details
   via RPC but can't yet log in to the worker portal. Admin would need to
   create the Supabase auth user manually. Consider:
   `supabase.auth.admin.inviteUserByEmail()` from an edge function.

---

## Saved user-specific context

- Live portal URL is **cbd-portal-gray.vercel.app** (the user has been
  bitten by `zeta` autocomplete before — double-check before typing).
- Resend account email: `fsociety.2017@protonmail.com` — the only address
  that can currently receive emails (until a domain is verified).
- User's primary email on file: `zed.dz1998@gmail.com`.
- GitHub: `zed-dz/cbd-portal`, branch `main`.
- Supabase project ref: `tsizneslellcqusjwtub`.
