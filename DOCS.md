# CBD Plant & Labour — Operations Portal Guide

A full guide for how the system works, who does what, and how everything links together.

---

## 1. Overview

The portal is the central system for running labour-hire operations. It replaces the old paper / spreadsheet flow with a single live database for:

- **Workers** — your full-time, casual, and subcontractor pool
- **Clients & Jobs** — who you supply labour to, and which projects they have running
- **Allocations** — which worker is sent to which job on which day
- **Timesheets** — actual hours worked, who pays what, what the client gets charged
- **Payroll** — wage calculation + Xero export
- **Licences / Tickets** — every worker's certifications and expiry dates
- **App Views** — what each worker sees on their phone

The portal has **two faces**:
- **Admin Portal** — for office staff (Matt, ops team)
- **Worker Portal** — what each worker sees once invited

You toggle between them with the **👁 Worker View** button in the top bar of the admin portal — useful for previewing exactly what workers see before sending anything out.

---

## 2. Roles & Access

| Role | Access |
|---|---|
| **Admin** (`role = admin`) | Full portal access — workers, allocations, timesheets, payroll, clients, all settings |
| **Manager** (`access_level = manager`) | Admin-level access for senior office staff |
| **Worker** (`role = worker`) | Mobile portal only — sees their own allocations, submits timesheets, clocks in/out, views their tickets |

Each user logs in with their email — the role is set on their worker record.

---

## 3. Onboarding Flow

### 3.1 Adding a Client

**Clients & Rates → + Add Client**

Fill in:
- **Name** (required)
- **Contact details** — person, phone, email
- **Charge rates** — Regular, OT, Night, Weekend ($/hr you bill the client)
- **Allowance charges** — Travel, Meal (what you bill on top per shift)

These rates feed the payroll calculator: when a timesheet is approved, the system uses the client's rates to compute `charge_amount` (what to invoice).

### 3.2 Adding Jobs Under a Client

**Clients & Rates → click "Jobs" button on a client row**

Each client can have unlimited jobs/projects. For each job:
- Name (e.g. "Rail Corridor Maintenance – Eastern Line")
- Site, address, start/end date, status
- **Required Roles** — toggle which roles are needed (Excavator Operator, Dogman, etc.)
- Notes

This gives you a clean record of every active project per client.

### 3.3 Managing Job Roles

**Clients & Rates → Job Roles tab**

This is the global pool of role types — Excavator Operator, Dogman, Skilled Labourer, Foreman, etc. Add or remove any role here and it instantly becomes available when creating jobs.

### 3.4 Adding a Worker

**Workers → + Add Worker**

Required:
- Full name, email
- Worker Type (Casual / Full-Time / Subcontractor)
- Pay Rate Regular ($/hr)

Optional but recommended:
- Mobile, address, job title, licences/tickets list, OT pay rate
- Subcontractor ABN (only shown when type = Subcontractor)

After saving, the worker is in the database. To give them app access, they need an "Invite Sent" status — handled in **Pending Workers**.

### 3.5 Adding Tickets / Licences for a Worker

**Licence Agent → + Add Licence**

For each ticket:
- Worker, licence name, issuer, expiry date

Tickets show up:
- In the **Licence Agent** page (full list with expiry alerts)
- In the worker's **Edit modal** (bottom section)
- In the **Dashboard** (Licence Alerts card if any expire within 30 days)

You can also filter the workers list by licence keyword (e.g. "EWP") using the **🪪 All Licences** dropdown on the Workers page.

---

## 4. Allocations (Scheduling)

**Allocations → + Create Allocation**

An allocation is "Worker X is going to Client Y's site Z from date A to date B".

Fields:
- **Worker** — dropdown
- **Client / Project / Site / Address**
- **Site Supervisor + phone** — who the worker reports to onsite
- **Start Date / End Date** — multi-day allocations supported
- **Arrival Time / End Time** — time-only (date is taken from Start Date)
- **Status** — Pending → Confirmed → Completed (or Cancelled)
- **Notes**

The **Role column** in the allocations table shows the worker's job title automatically.

### Calendar View

**Calendar** — week-grid view of all allocations. Click an empty cell to create, click a bar to edit.

---

## 5. Timesheets

### Worker submission

In the worker portal, the worker:
1. Goes to **My Timesheets** → **+ Submit Timesheet**
2. Picks **Shift Type**: Standard Shift or Rain Day (only 2 options for workers)
3. Enters date, hours, optional client/site/notes
4. Submits — status = `pending`

### Admin approval / entry

In **Timesheets** (admin):
1. Filter to `pending`
2. Open a timesheet → review details
3. Set **Scenario** if needed (admin sees the full list — Late Start, Rain-Off Partial, Public Holiday, Annual Leave, etc.)
4. Approve or reject

### Pay vs Charge logic

Different scenarios result in different pay/charge values. Examples:

| Scenario | Pay Hours | Charge Hours |
|---|---|---|
| Standard | actual | actual |
| Rain-Off Partial | 8.00 | 4.00 |
| Rain-Off Cancelled | 8.00 | 0.00 |
| Late Start (Admin Fault) | 8.00 | actual |
| Annual Leave | 8.00 | 0.00 |
| Public Holiday (Full-Time only) | 8.00 | 0.00 |
| LWOP | 0.00 | 0.00 |

This means **what the worker is paid is independent of what the client is charged** — important for rain days and admin-caused delays.

### Penalty rates (auto-applied)

Based on the date and the Night Shift checkbox:

| Day | Rate |
|---|---|
| Weekday standard | Normal pay rate (+ OT 1.5x past 7.6h) |
| Weekday night shift | First 8h × 1.5x, rest × 2x |
| Saturday | First 2h × 1.5x, rest × 2x |
| Sunday / Public Holiday | All hours × 2x |
| Saturday/Sunday/PH night | All hours × 2x |

All thresholds and multipliers are configurable in **Payroll Config**.

### Allowances (auto-computed)

- **Travel allowance** ($15) — paid to casual workers per shift
- **Meal allowance** ($18.70) — auto-applied when shift hours ≥ 9.5h
- **Geographic loading** (+10%) — manual checkbox

---

## 6. Payroll

**Payroll** — runs the wage calculation across approved timesheets.

Workflow:
1. Pick a pay period (date range)
2. Filter rows you want to include
3. Click **Select All Unexported** — picks every approved timesheet not yet sent to Xero
4. Review the summary bar (total hours, total pay, period)
5. Either:
   - **Push to Xero** — creates a draft pay run in Xero with all selected timesheets
   - **Export Xero CSV** — downloads a CSV you can import manually

After a successful push, each timesheet is stamped `xero_exported = true` so it won't be sent twice.

### Xero Connection

**Payroll** page → **Connect Xero** button. One-time OAuth — after that the portal stores refresh tokens and reconnects automatically.

Required Xero scopes:
- `payroll.employees`
- `payroll.payruns`
- `payroll.payslip`
- `accounting.contacts.read`

### Xero Data Sync

**Xero Data** in the sidebar — read-only view of everything in your Xero account:
- Employees (with pay rates from their Pay Template)
- Pay run history with payslip drill-down
- Contacts (clients/suppliers)
- Leave applications
- Pay setup (calendars, earnings rates, leave types, deductions)

The **💸 Sync Pay Rates → Workers** button on the Employees tab pulls each Xero employee's hourly rate and updates the matching portal worker (matched by full name).

---

## 7. Dashboard

The dashboard shows live operational stats:

| Card | Click action |
|---|---|
| On Site Today | → Workers |
| Available Pool | → Workers |
| Awaiting Approval | → Timesheets |
| Licence Alerts | → Licence Agent |
| Week Billing | → Payroll |
| Ready for Payroll | → Payroll |

Plus pinned panels:
- **Urgent Alerts** — expired licences (dismissable)
- **Pending Timesheets** — last 5
- **Today's Allocations** — full table with CSV export

---

## 8. Team Inbox, Templates & Bulk Messages

The portal has its own **shared team inbox** wired to a Gmail / Google Workspace
account. Every reply from a worker or client lands here, threaded against
their profile. Bulk messages and templates go through this too.

### 8.1 First-time setup (one person does this once)

1. Decide on a **shared ops mailbox** — e.g. `ops@cbdplant.com.au` or
   `theteamcbd@gmail.com`. **Don't use a personal account** — whoever connects,
   the whole team will see every email in that inbox.
2. Sidebar → **Inbox** → click **Connect team email** → sign in to Google →
   approve permissions (read, send, modify labels).
3. The Inbox page now shows that account in the top-left under "Team Email".
   Everyone using the portal sees and replies from the same address.

> Switching accounts later: Inbox sidebar → **↔ Switch** button. The cached
> conversations from the previous account are wiped automatically so they
> don't pollute the new view.

### 8.2 What gets pulled in (and what doesn't)

The Inbox **only stores emails that involve a known worker or a known client**.
Personal mail, newsletters, and notifications stay in Gmail and never reach
the portal. A thread matches if:

- A participant's email matches a `workers.email` exactly, **or**
- A participant's email matches a `clients.contact_email` exactly, **or**
- A participant's email *domain* matches one listed in
  `clients.email_domains` (e.g. anything `@sydneywater.com.au`)

If you want a client's whole team auto-tagged, open **Clients & Rates**
→ edit the client → add the company domain in **Email Domains**. From then
on, any new contact at that client lands under their card automatically.
Consumer domains (gmail.com, yahoo.com, hotmail.com, …) are ignored even if
typed in — otherwise the first gmail.com client would claim every personal
newsletter.

### 8.3 Reading & triaging

Top of the left pane:

| Control | What it does |
|---|---|
| **✎ Compose** | Start a new email |
| **↻ Sync** | Pull recent threads from Gmail (default last 30 days, 60 threads) |
| **↔** | Switch the connected team email account |
| **⛔** | Disconnect the team email entirely |
| Search box | Filter threads by subject / participant / worker / client name |
| Filter chips | Inbox · Unread · Starred · Workers · Clients · Archived |

Default view is **Inbox** (non-archived). Counts on each chip show how many
threads are in that state.

On the right pane (when a thread is open):

| Button | Action |
|---|---|
| ★ / ☆ | Star or un-star the thread (mirrors to Gmail's STARRED label) |
| ● | Mark thread as unread again |
| 🗄 | Archive (removes from Inbox view; thread stays searchable under "Archived") |
| ↺ | Un-archive (only visible on archived threads) |
| ↻ | Re-sync this one thread |

Opening an unread thread auto-marks it read in Gmail.

### 8.4 Replying

Type in the reply box at the bottom of a thread → **Send Reply →**. The
reply goes out **from the team email address**, not whoever is logged into
the portal — so to the worker / client it looks like one continuous
conversation with ops, no matter which staff member typed it.

To insert a saved template into your reply: **📝 Templates** button above
the reply box → pick one → the body is inserted with placeholders filled
in from the thread context.

### 8.5 Composing a new email

**✎ Compose** in the left pane.

- The **To** field has autocomplete from your workers + clients. Pick from
  the list and the email gets tagged to that person automatically when it
  threads back.
- **📝 Insert a template** dropdown lets you pick a saved template. Subject
  and body are filled in; placeholders like `{{worker_name}}`,
  `{{week_ending}}`, `{{onboard_link}}` get substituted using whoever
  you picked in **To**.
- **Send →**. The thread will appear in the inbox after the next sync.

### 8.6 Email Templates (manage canned messages)

Sidebar → Tools → **📝 Email Templates**.

Each template has a **Name** (what shows in the dropdown), a **Subject**, and
a **Body**. Use `{{placeholder}}` syntax to personalise — supported keys:

| Placeholder | Filled with |
|---|---|
| `{{worker_name}}` | The recipient worker's name (if matched) |
| `{{worker_email}}` | The recipient worker's email |
| `{{client_name}}` | The recipient client's company name |
| `{{client_contact}}` | The recipient client's contact person |
| `{{week_ending}}` | Week-ending date (from the linked timesheet, if any) |
| `{{date}}` | Allocation work date (if any) |
| `{{job}}` | Job / project name |
| `{{site}}` | Site name |
| `{{start_time}}` | Allocation start time |
| `{{onboard_link}}` | The worker's onboarding magic link |

Anything inside `{{ }}` that doesn't match a known placeholder is left as-is.

> Seeded with 4 starter templates: Timesheet Approved, Allocation Confirmed,
> Onboarding Link, Payslip Ready. Edit / delete / add as you like — changes
> are immediate, no deploy.

### 8.7 Unknown senders → add as worker / client

When an email comes in from someone **not yet in your system**, the thread
banner shows:

> `someone@newcompany.com.au` isn't linked to a worker or client.
> **[+ Add as worker]  [+ Add as client]**

Click one, fill in the name (+ optional details), Save. The contact is
created and the thread is linked to them. The Inbox re-syncs so all future
replies stay threaded against that record.

If you add them as a **client**, their email domain (if it's a company
domain, not a consumer one) is auto-added to the client's `email_domains`,
so any *other* people from that company will tag automatically going
forward.

### 8.8 Inline email history on Worker / Client modals

Open any worker or client → in the edit modal you'll see a **Recent emails**
panel listing the last 6 threads with that contact. Click any row to jump
straight into the Inbox at that thread. Quick way to check "what did we
last say to them?" without leaving the worker view.

### 8.9 Bulk Messages (one-way blasts)

Sidebar → Tools → **📢 Bulk Messages**. Used for one-way announcements
(rate-rise notice, holiday closure, induction reminder). Goes through
Resend — **separate** from the team inbox. **Use the Inbox** for any
conversation that needs replies (since Resend replies won't thread back).

Each blast logs to `message_log` so you have a record of who got what
and when — and recipient rows in Workers / Clients show a green
"✓ recently emailed" pill so you can see at a glance who's been contacted.

---

## 9. Common Tasks (Cheat Sheet)

**"Send a worker to a job tomorrow"**
1. Workers → confirm worker exists & is Available
2. Allocations → Create Allocation → fill in worker, client, site, supervisor, dates, arrival time
3. Status: Confirmed
4. Bulk Messages (optional) → notify worker

**"Approve a worker's timesheet for a rain day"**
1. Timesheets → filter to Pending
2. Open the row → set Scenario = "Rain-Off Cancelled" (or "Rain-Off Partial" if 4h work was done)
3. The pay/charge auto-fills (8h pay / 0h or 4h charge)
4. Status: Approved → Save

**"Run payroll for last week"**
1. Payroll → set date range to the period
2. Select All Unexported
3. Push to Xero (or Export CSV)

**"Add a new licence type for a worker"**
1. Licence Agent → + Add Licence
2. Pick worker, type the licence name, set expiry
3. Save — appears in their profile and on the dashboard alerts

**"See who has an EWP ticket"**
1. Workers → 🪪 Licence dropdown → "ewp"
2. List filters to only those workers

**"Preview what a worker sees in their app"**
1. Top bar → 👁 Worker View
2. You're now in the worker portal as yourself
3. ✕ Exit Preview to come back

---

## 10. Database Tables (for reference)

| Table | Purpose |
|---|---|
| `workers` | Worker profiles + pay rates + worker_type + licences string |
| `clients` | Client records + charge rates |
| `client_jobs` | Jobs/projects under each client |
| `job_roles` | Global pool of role types |
| `allocations` | Worker assignments to jobs |
| `timesheets` | All shifts worked, with scenario / pay / charge / approval status |
| `certifications` | Tickets / licences with expiry dates |
| `payroll_config` | Configurable rate multipliers, thresholds, allowances |
| `xero_tokens` | OAuth tokens for Xero connection |

---

## 11. Support / Common Issues

**"Xero connection lost"** → Payroll page → Reconnect Xero (re-runs OAuth)

**"Worker can't log in"** → Pending Workers page → check their app_status; resend invite if needed

**"Pay rate is wrong on a payroll row"** → Check the worker's `pay_rate_regular` in Workers, AND the date — rates differ for weekdays/Saturdays/Sundays/PH and night shifts

**"Timesheet approved but not in payroll"** → Check `xero_exported` status — if false, it's still pickable; if true it's already been sent

**"Need to change overtime threshold"** → Payroll Config page, edit `ot_threshold_daily`

**"New emails aren't appearing in the Inbox"** → Make sure the sender's address (or domain) is registered against a worker/client. The Inbox only stores threads with a match. Click ↻ Sync after adding them. The toast now reports how many threads were fetched vs skipped, so you can tell the difference between "Gmail returned nothing" and "Gmail returned threads but none matched".

**"All threads in the Inbox have the wrong person's name"** → Someone added the team email address itself (e.g. `theteamcbd@gmail.com`) as a worker. Remove that worker row, disconnect + reconnect the team email — the cache is wiped on reconnect and the next sync will match correctly.

**"I want to switch to a different team email account"** → Inbox → ↔ Switch button. Confirm. Sign in with the new Google account. Cached threads from the old account are wiped automatically.
