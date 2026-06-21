# Inbound Applications Pipeline — Operations Guide

**For:** MRA Portal (`portal.miningresourcesaustralia.com`) + CBD Portal (`cbd-portal-gray.vercel.app`).
**Status:** Live as of 2026-06-12.

---

## The problem we just fixed

You're getting applications through the Lovable marketing site (`miningresourcesaustralia.com`) and via the LinkedIn ad, but they weren't appearing in the portal. They were landing in **a separate Supabase project that Lovable owns** (`yqiabdwysevitladphni`) — not in the portal database. Your account doesn't have access to that project, so the data was effectively lost from the portal's point of view.

Last signup in the portal's auth before this fix: **2026-06-02**. We've been blind for 10 days.

---

## The fix

Three pieces, deployed and verified:

### 1. New table: `worker_applications`

Sits in **both** portal Supabase projects. Captures every inbound application with these fields:

| Column | Notes |
|---|---|
| `type` | `'worker'` or `'client'` |
| `full_name`, `email`, `phone`, `message` | What the form submitter typed |
| `source` | Auto-tagged: `linkedin-ad`, `marketing-site`, `portal-apply`, etc. |
| `status` | `new` → `reviewing` → `approved` / `rejected` / `converted` |
| `reviewed_by`, `reviewed_at`, `review_notes` | Admin triage state |
| `converted_worker_id` | If we converted them, points to the new `workers` row |

RLS is locked down — anon callers **cannot** read or write this table directly (PII protection). Only authenticated admins on the portal see it. Public writes go through the edge function below.

### 2. Edge function: `submit-application`

Public-callable. Validates the payload server-side (name 2-200 chars, email regex, length caps to defang spam), then inserts via service_role so it bypasses RLS.

**Endpoints (these are what the marketing site / LinkedIn / portal /apply page hit):**

| Portal | Endpoint |
|---|---|
| MRA | `https://qtefchnpozpqtdpvfeov.supabase.co/functions/v1/submit-application` |
| CBD | `https://tsizneslellcqusjwtub.supabase.co/functions/v1/submit-application` |

**Request body:**
```json
{
  "type": "worker",
  "full_name": "Jane Smith",
  "email": "jane@example.com",
  "phone": "0412 345 678",
  "message": "Heard about you on LinkedIn, can operate 8t excavator",
  "source": "linkedin-ad"
}
```

**Required headers:**
- `apikey`: the project's anon publishable key (already in the marketing site bundle)
- `Authorization: Bearer <same anon key>`
- `Content-Type: application/json`

**Response 200:** `{ "ok": true, "id": "uuid-of-new-row" }`
**Response 4xx:** `{ "error": "invalid_email" | "invalid_name" | …, "message": "..." }`

### 3. Two new portal pages

| Page | Path | Who sees it |
|---|---|---|
| **Applications** (admin triage) | sidebar → 📥 Applications | Authenticated admins. Filter by status (New / Reviewing / Approved / Rejected / Converted) and type (Worker / Client). Buttons: Convert to Worker, Mark Reviewing, Reject, Save Notes, Delete. |
| **Apply** (public form) | `/apply` (or `/apply?type=client`) | Anyone. Same branding as portal. Submits to the edge function. Auto-detects source from `?utm_source=` or HTTP Referer. |

A sidebar badge on Applications shows the count of `status='new'` so you can spot inbound work at a glance.

---

## How to use the new flow

### When a new application lands

1. Sidebar badge on **📥 Applications** lights up orange (count of new submissions).
2. Click into Applications. The "New" tab is selected by default.
3. Read the card. Phone / email links are clickable (they `tel:` / `mailto:`).
4. Three things you can do:
   - **✅ Convert to Worker** — instantly creates a `workers` row with the name, email, phone they submitted. Status = "Profile Incomplete". Then jump to Pending Workers and send the onboarding link (Email / WhatsApp / SMS) like with any new hire.
   - **👀 Reviewing** — moves to the "Reviewing" filter so it stays on your radar but isn't blocking the "New" view.
   - **👎 Reject** — moves to the "Rejected" bucket. Doesn't delete the record.
5. Optional: click **▾ Details** to expand and add review notes (visible to admins only).

### When you want to send people to a portal-hosted form

Instead of going to Lovable: just send them to `portal.miningresourcesaustralia.com/apply` (or `/apply?type=client` for credit applications). The form has the right MRA branding, accepts the same fields, and posts straight to the new pipeline.

---

## Re-point the Lovable marketing site (recommended, 5 minutes)

The Lovable site is currently writing to its own Supabase project that you can't see. Two ways to fix:

### Option A — Quickest. Change ONE call site (recommended).

Open the Lovable editor and find this line (it's in `index-CMIp7Rby.js` once built, but Lovable shows it as source):

```ts
await supabase.from("applications").insert({ ... });
```

Replace with:

```ts
await fetch("https://qtefchnpozpqtdpvfeov.supabase.co/functions/v1/submit-application", {
  method: "POST",
  headers: {
    apikey: <MRA_ANON_KEY>,
    Authorization: `Bearer ${<MRA_ANON_KEY>}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    type: t,             // existing 'worker' | 'client' switch
    full_name: c.data.full_name,
    email: c.data.email,
    phone: c.data.phone || null,
    message: c.data.message || null,
    source: "marketing-site",
  }),
});
```

Get the MRA anon key from: Supabase Dashboard → mra-portal → Project Settings → API Keys → **anon (publishable)** value. It's safe to embed in client JS (that's what publishable means).

### Option B — Even simpler. Re-point the CTA button.

In Lovable, change the "Apply for a Job" button's `href` (currently `#workers`) to:
```
https://portal.miningresourcesaustralia.com/apply
```
And "Apply for Credit" to:
```
https://portal.miningresourcesaustralia.com/apply?type=client
```

Users get bounced over to the portal-hosted form. The marketing site no longer has to know about Supabase at all.

### Re-point the LinkedIn ad

Edit the LinkedIn ad's "Destination URL" in LinkedIn Campaign Manager. Change it from the Lovable site to:
```
https://portal.miningresourcesaustralia.com/apply?utm_source=linkedin-ad&type=worker
```
The portal's Apply page reads `utm_source` and tags every resulting application with `source='linkedin-ad'`, so you'll be able to see exactly which ones came from LinkedIn in the Applications admin view.

---

## Backfill the last 10 days?

The applications submitted between 2026-06-02 and now are sitting in the Lovable Supabase project (`yqiabdwysevitladphni`) and your account can't read them. Two options:

1. **Ask Lovable support** to transfer that project into your Supabase organization, then we can `SELECT` from `applications` and bulk-insert into `worker_applications`.
2. **Ask Lovable support to export the table to CSV** and forward it; we can import via the Supabase Dashboard's table importer. Quicker than a transfer.

If you want me to help once you have the CSV / project access, just say the word.

---

## What this changed in the codebase

Across both repos:

| File | Change |
|---|---|
| `supabase/migrations/20260612_worker_applications_inbound_pipeline.sql` | NEW — table, RLS, indexes, `approve_application_to_worker` RPC |
| `supabase/functions/submit-application/index.ts` | NEW — public intake edge function |
| `src/pages/Applications/ApplicationsPage.jsx` | NEW — admin triage UI |
| `src/pages/Apply/ApplyPage.jsx` | NEW — public application form |
| `src/App.jsx` | Added `/apply` to public route patterns |
| `src/portals/AdminPortal.jsx` | Added Applications to sidebar + badge |
| `APPLICATIONS_PIPELINE.md` | THIS doc |

Migration is idempotent (`IF NOT EXISTS` everywhere) — safe to re-apply.

---

*Document version: 2026-06-12.*
