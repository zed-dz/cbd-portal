# CBD Plant & Labour — Operations Portal

Worker-and-client operations portal for **CBD Plant & Labour** (NSW, AU
construction labour-hire — road / rail / water).

- **Live URL:** https://cbd-portal-gray.vercel.app
- **Stack:** React 19 (CRA) · Supabase · Vercel · Resend + Gmail · Xero
- **Supabase project:** `tsizneslellcqusjwtub` (region ap-southeast-2)

## Where to read first

| File | What it tells you |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Current state, architecture, conventions. **Start here.** |
| [DOCS.md](DOCS.md) | End-user team guide (inbox, templates, bulk messages, etc.) |
| [src/theme.js](src/theme.js) | Design tokens — accent color, palette, radius scale |

## Layout

```
src/
├── App.jsx                ← Route detection, global styles, auth bootstrap
├── theme.js               ← Design tokens
├── supabaseClient.js      ← Reads REACT_APP_SUPABASE_* env vars
│
├── components/
│   ├── index.js           ← Barrel re-exporter (back-compat for old imports)
│   ├── ui/                ← Design-system primitives, one per file
│   │   ├── Badge.jsx · EmptyState.jsx · Field.jsx · Modal.jsx
│   │   └── Spinner.jsx · Table.jsx · Toast.jsx
│   ├── blast/             ← Top-bar Send-Blast modal
│   ├── inbox/             ← EmailHistoryPanel embed for worker/client cards
│   └── scan/              ← Camera + QR detect modal
│
├── portals/               ← Top-level layouts (one per role)
│   ├── AdminPortal.jsx
│   └── WorkerPortal.jsx
│
├── pages/                 ← One folder per route
│   ├── Allocations/ · AppViews/ · BulkMessages/ · Calendar/
│   ├── ClientApprovals/ · Clients/ · Dashboard/
│   ├── Inbox/             ← Gmail-OAuth-driven team inbox
│   ├── LicenceAgent/ · Login/
│   ├── OnboardProfile/    ← /onboard/<token> public route
│   ├── Payroll/ · PendingWorkers/
│   ├── PublicProfile/     ← /p/<token> public route
│   ├── Reports/ · Templates/ · Timesheets/ · Workers/
│   └── XeroSync/
│
├── utils/
│   ├── csv.js · dates.js
│   ├── payroll.js         ← Pure pay/charge calculations
│   └── useDraft.js        ← Form auto-save hook
│
└── constants/
    ├── jobTitles.js · scenarios.js

supabase/
├── migrations/            ← SQL files matching applied migration history
└── functions/             ← Deno edge functions (xero-*, gmail-*, send-*)
```

## Sibling project

[`zed-dz/mra-portal`](https://github.com/zed-dz/mra-portal) — same codebase
ancestor, separate Supabase, separate Vercel. When fixing a bug that applies
to both, port the change across.

## Run locally

```bash
npm install
npm start                  # http://localhost:3000
```

You'll need `REACT_APP_SUPABASE_URL` and `REACT_APP_SUPABASE_ANON_KEY` set
in `.env.local` (get them from the Supabase dashboard).
