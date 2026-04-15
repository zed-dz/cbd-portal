# CBD Plant & Labour Operations Portal
## Complete Build Plan for Cursor IDE

---

## HOW TO USE THIS GUIDE

Each step below is a **prompt you paste into Cursor's AI chat** (Composer or inline chat). Complete them in order. After each step, **review the output, test it**, and only move on when it works.

Golden rules:
- One prompt = one job. Don't combine steps.
- Always paste error messages back into Cursor if something breaks.
- Commit to Git after every successful step.

---

## PHASE 1 — SUPABASE SETUP (Do this manually, ~15 min)

### Step 1.1 — Create the Supabase Project
1. Go to **supabase.com** → sign in → "New Project"
2. Pick a name like `cbd-portal`, set a strong DB password, choose the closest region
3. Wait for it to spin up (~2 min)

### Step 1.2 — Copy Your Credentials
1. Go to **Settings → API**
2. Copy and save these two values somewhere safe:
   - `Project URL` (looks like `https://xxxxx.supabase.co`)
   - `anon public` key (long string starting with `eyJ...`)

### Step 1.3 — Create the Database Tables
1. Go to **SQL Editor** in Supabase
2. Click **"New Query"**
3. Paste this entire block and click **Run**:

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Workers table
CREATE TABLE workers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  mobile TEXT,
  role TEXT NOT NULL DEFAULT 'worker',
  status TEXT DEFAULT 'available',
  app_status TEXT DEFAULT 'Active',
  site TEXT,
  client TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Allocations table
CREATE TABLE allocations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  worker_id UUID REFERENCES workers(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending',
  site TEXT,
  client TEXT,
  start_time TIMESTAMP WITH TIME ZONE,
  end_time TIMESTAMP WITH TIME ZONE,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Timesheets table
CREATE TABLE timesheets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  worker_id UUID REFERENCES workers(id) ON DELETE CASCADE,
  client TEXT,
  site TEXT,
  date DATE,
  start_time TIMESTAMP WITH TIME ZONE,
  end_time TIMESTAMP WITH TIME ZONE,
  hours NUMERIC,
  status TEXT DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Certifications table
CREATE TABLE certifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  worker_id UUID REFERENCES workers(id) ON DELETE CASCADE,
  cert_name TEXT NOT NULL,
  issuer TEXT,
  expiry DATE,
  doc_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Row Level Security
ALTER TABLE workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE certifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth users full access" ON workers
  FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Auth users full access" ON allocations
  FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Auth users full access" ON timesheets
  FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Auth users full access" ON certifications
  FOR ALL USING (auth.role() = 'authenticated');
```

### Step 1.4 — Create Test Users in Supabase Auth
1. Go to **Authentication → Users** in Supabase
2. Click **"Add User"** → **"Create New User"**
3. Create these two users:

| Email | Password | Note |
|---|---|---|
| `admin@cbdplantlabour.com.au` | `Admin123!` | This is the admin |
| `james@email.com` | `Worker123!` | This is a test worker |

### Step 1.5 — Seed Worker Records
1. Go back to **SQL Editor**, new query, paste and run:

```sql
INSERT INTO workers (name, email, role, status, app_status)
VALUES ('Matt', 'admin@cbdplantlabour.com.au', 'admin', 'available', 'Active');

INSERT INTO workers (name, email, role, status, app_status)
VALUES ('James Holloway', 'james@email.com', 'worker', 'available', 'Active');
```

> ✅ **Checkpoint:** You should now see 2 users in Auth AND 2 rows in the workers table.

---

## PHASE 2 — PROJECT SCAFFOLDING (Cursor prompts)

### Step 2.1 — Create the React Project

**Run in your terminal (not Cursor):**
```bash
npx create-react-app cbd-portal
cd cbd-portal
npm install @supabase/supabase-js
```

Then open the `cbd-portal` folder in Cursor.

### Step 2.2 — Clean Up Boilerplate

**Paste this prompt into Cursor Composer:**

> Delete all files inside `src/` except `index.js`. Then create a clean `src/App.jsx` that just renders a `<div>Hello World</div>`. Update `src/index.js` to import and render `App` from `./App`. Remove any references to deleted files like App.css, logo.svg, reportWebVitals, etc.

### Step 2.3 — Create the Supabase Client

**Paste this prompt into Cursor Composer:**

> Create a file `src/supabaseClient.js` that initialises and exports a Supabase client. Use these credentials:
>
> - URL: `YOUR_SUPABASE_URL_HERE`
> - Anon Key: `YOUR_ANON_KEY_HERE`
>
> Use `createClient` from `@supabase/supabase-js`.

⚠️ **Replace the placeholder values with your real credentials from Step 1.2.**

> ✅ **Checkpoint:** Run `npm start`. You should see "Hello World" in your browser with zero console errors.

---

## PHASE 3 — AUTHENTICATION (Cursor prompts)

### Step 3.1 — Build the Login Page

**Paste into Cursor Composer:**

> In `src/App.jsx`, build a login screen with these requirements:
>
> - Dark theme (background `#0f172a`, cards `#1e293b`, text white, accent `#3b82f6`)
> - Email and password fields
> - "Sign In" button that calls `supabase.auth.signInWithPassword()`
> - Show loading spinner while authenticating
> - Show error messages inline (red text below the form)
> - Company logo placeholder text "CBD Plant & Labour" at the top
> - All styling must be inline CSS (no external CSS files)
> - Import supabase from `./supabaseClient`
> - On successful login, store the session in React state

### Step 3.2 — Add Auth State Management

**Paste into Cursor Composer:**

> Update `src/App.jsx` to:
>
> 1. On mount, check for an existing session with `supabase.auth.getSession()`
> 2. Listen for auth changes with `supabase.auth.onAuthStateChange()`
> 3. When a user is logged in, query the `workers` table to find their record by email and store it in state as `currentWorker`
> 4. If `currentWorker.role === 'admin'`, show the Admin Portal
> 5. If `currentWorker.role === 'worker'`, show the Worker Portal
> 6. For now, just render placeholder text: "Admin Portal" or "Worker Portal"
> 7. Add a "Sign Out" button that calls `supabase.auth.signOut()`

> ✅ **Checkpoint:** Log in as `admin@cbdplantlabour.com.au` → see "Admin Portal". Log in as `james@email.com` → see "Worker Portal". Sign out works.

---

## PHASE 4 — ADMIN PORTAL LAYOUT (Cursor prompts)

### Step 4.1 — Sidebar Navigation

**Paste into Cursor Composer:**

> In `src/App.jsx`, when the admin is logged in, render a layout with:
>
> - A fixed left sidebar (240px wide, background `#1e293b`)
> - Sidebar has the company name "CBD Plant & Labour" at top
> - Navigation links (just text buttons) for these pages:
>   - Dashboard
>   - Workers
>   - Allocations
>   - Timesheets
>   - Certifications
>   - Reports
> - Clicking a nav link sets an `activePage` state variable
> - The main content area fills the remaining width (to the right of sidebar)
> - A top bar showing the logged-in user's name and a Sign Out button
> - The active nav item should be highlighted with the accent colour `#3b82f6`
> - All inline CSS, dark theme consistent with login page
> - For now, the main content area just shows the page name as a heading

### Step 4.2 — Dashboard Page

**Paste into Cursor Composer:**

> Build the Dashboard page component (can be a function inside `App.jsx`). It should:
>
> 1. Fetch counts from Supabase: total workers, active allocations, pending timesheets, expiring certifications (within 30 days)
> 2. Display 4 stat cards in a row (grid layout)
>    - Each card: dark card `#1e293b`, rounded corners, count in large bold text, label below
>    - Cards: "Total Workers", "Active Allocations", "Pending Timesheets", "Expiring Certs"
> 3. Below the cards, show a "Recent Activity" section — just the 5 most recent timesheets with worker name, date, hours, status
> 4. Loading skeleton/spinner while data loads
> 5. All inline CSS, dark theme

> ✅ **Checkpoint:** Dashboard shows correct counts from your seeded data.

---

## PHASE 5 — CRUD PAGES (Cursor prompts)

### Step 5.1 — Workers Management Page

**Paste into Cursor Composer:**

> Build the Workers page inside `App.jsx`. Requirements:
>
> 1. Fetch all workers from Supabase and display in a table
> 2. Table columns: Name, Email, Mobile, Role, Status, App Status, Site, Client, Actions
> 3. "Add Worker" button at top-right that opens a modal
> 4. The modal is a dark overlay with a centred form card (`#1e293b`)
> 5. Modal form fields: Name, Email, Mobile, Role (dropdown: admin/worker), Status (dropdown: available/on-site/unavailable), App Status, Site, Client
> 6. Save button calls `supabase.from('workers').insert()`
> 7. Each table row has Edit and Delete buttons
> 8. Edit opens the same modal pre-filled with data, saves with `.update()`
> 9. Delete shows a confirm dialog, then calls `.delete()`
> 10. After any CRUD operation, refresh the table data
> 11. Show a green success toast/banner briefly after operations
> 12. Search/filter bar at top to filter workers by name
> 13. All inline CSS, dark theme, consistent styling

### Step 5.2 — Allocations Page

**Paste into Cursor Composer:**

> Build the Allocations page inside `App.jsx`. Requirements:
>
> 1. Fetch all allocations joined with worker names: `supabase.from('allocations').select('*, workers(name)')`
> 2. Table columns: Worker Name, Site, Client, Status, Start Time, Actions
> 3. "Create Allocation" button → modal with fields:
>    - Worker (dropdown populated from workers table)
>    - Site (text input)
>    - Client (text input)
>    - Status (dropdown: pending/confirmed/completed/cancelled)
>    - Start Time (datetime input)
>    - Notes (textarea)
> 4. Full CRUD (create, edit, delete) with modals
> 5. Status badges with colour coding:
>    - pending = yellow
>    - confirmed = blue
>    - completed = green
>    - cancelled = red
> 6. Filter by status dropdown
> 7. All inline CSS, dark theme

### Step 5.3 — Timesheets Page

**Paste into Cursor Composer:**

> Build the Timesheets page inside `App.jsx`. Requirements:
>
> 1. Fetch all timesheets joined with worker names
> 2. Table columns: Worker Name, Client, Site, Date, Hours, Status, Actions
> 3. "Add Timesheet" button → modal with fields:
>    - Worker (dropdown from workers table)
>    - Client, Site (text inputs)
>    - Date (date input)
>    - Hours (number input)
>    - Status (dropdown: pending/approved/rejected)
>    - Notes (textarea)
> 4. Full CRUD with modals
> 5. "Approve" and "Reject" quick-action buttons on each pending row
>    - Approve sets status to 'approved'
>    - Reject sets status to 'rejected'
> 6. Status badges with colour coding (pending=yellow, approved=green, rejected=red)
> 7. Filter by status
> 8. All inline CSS, dark theme

### Step 5.4 — Certifications Page

**Paste into Cursor Composer:**

> Build the Certifications page inside `App.jsx`. Requirements:
>
> 1. Fetch all certifications joined with worker names
> 2. Table columns: Worker Name, Certification, Issuer, Expiry Date, Status, Actions
> 3. "Add Certification" button → modal with fields:
>    - Worker (dropdown from workers table)
>    - Certification Name
>    - Issuer
>    - Expiry Date (date input)
> 4. Full CRUD with modals
> 5. Expiry status logic (calculated, not stored):
>    - Expired (past date) = red badge
>    - Expiring within 30 days = yellow badge
>    - Valid = green badge
> 6. Sort by expiry date (soonest first)
> 7. All inline CSS, dark theme

> ✅ **Checkpoint:** All 4 CRUD pages work. You can add, edit, delete records in each. Tables show correct data.

---

## PHASE 6 — WORKER PORTAL (Cursor prompts)

### Step 6.1 — Worker Portal Layout & Tabs

**Paste into Cursor Composer:**

> Build the Worker Portal view in `App.jsx` (shown when `currentWorker.role === 'worker'`). Requirements:
>
> 1. Top bar with worker's name, "CBD Plant & Labour" branding, and Sign Out button
> 2. Tab navigation below the top bar with 4 tabs:
>    - My Allocations
>    - My Timesheets
>    - My Certifications
>    - Clock In/Out
> 3. Active tab highlighted with accent colour
> 4. Content area below tabs changes based on selected tab
> 5. All inline CSS, dark theme matching admin portal

### Step 6.2 — Worker: My Allocations Tab

**Paste into Cursor Composer:**

> Build the "My Allocations" tab for the worker portal. Requirements:
>
> 1. Fetch allocations where `worker_id` matches `currentWorker.id`
> 2. Display as cards (not a table) — each card shows: Site, Client, Status badge, Start Time
> 3. Cards in a responsive grid (1 column mobile, 2 columns desktop)
> 4. Read-only — workers cannot edit allocations
> 5. Show "No allocations found" message if empty
> 6. All inline CSS, dark theme

### Step 6.3 — Worker: My Timesheets Tab

**Paste into Cursor Composer:**

> Build the "My Timesheets" tab for the worker portal. Requirements:
>
> 1. Fetch timesheets where `worker_id` matches `currentWorker.id`
> 2. Display in a simple table: Date, Client, Site, Hours, Status badge
> 3. "Submit Timesheet" button → modal with fields: Client, Site, Date, Hours, Notes
> 4. On submit, insert to Supabase with `worker_id` set to `currentWorker.id` and status `'pending'`
> 5. Workers can only create, not edit or delete
> 6. All inline CSS, dark theme

### Step 6.4 — Worker: My Certifications Tab

**Paste into Cursor Composer:**

> Build the "My Certifications" tab for the worker portal. Requirements:
>
> 1. Fetch certifications where `worker_id` matches `currentWorker.id`
> 2. Display as cards: Cert Name, Issuer, Expiry Date, Status badge (expired/expiring/valid)
> 3. Read-only for workers
> 4. All inline CSS, dark theme

### Step 6.5 — Worker: Clock In/Out Tab

**Paste into Cursor Composer:**

> Build the "Clock In/Out" tab for the worker portal. Requirements:
>
> 1. Large centered card with current date and time (updating every second)
> 2. "Clock In" button (green) — when clicked:
>    - Save the current time to React state as `clockInTime`
>    - Disable the Clock In button
>    - Show the Clock Out button
> 3. "Clock Out" button (red) — when clicked:
>    - Calculate hours worked (difference between clock in and now)
>    - Insert a timesheet record to Supabase with the date, hours (rounded to 2 decimal), status 'pending'
>    - Show a success message with hours worked
>    - Reset the UI back to showing the Clock In button
> 4. Show today's clock-in history below the buttons (list of today's timesheet entries)
> 5. All inline CSS, dark theme

> ✅ **Checkpoint:** Log in as James. All 4 tabs work. Clock in/out creates timesheet records. Switch to admin — those timesheets appear for approval.

---

## PHASE 7 — REPORTS & CSV EXPORT (Cursor prompts)

### Step 7.1 — Reports Page with CSV Export

**Paste into Cursor Composer:**

> Build the Reports page for the admin portal. Requirements:
>
> 1. Four export sections, each with a heading and an "Export CSV" button:
>    - **Workers Export**: downloads all workers as CSV
>    - **Allocations Export**: downloads all allocations (with worker names) as CSV
>    - **Timesheets Export**: downloads all timesheets (with worker names) as CSV
>    - **Certifications Export**: downloads all certifications (with worker names) as CSV
> 2. CSV export logic (pure JavaScript, no libraries):
>    - Fetch data from Supabase
>    - Convert to CSV string (headers + rows)
>    - Create a Blob, generate a download URL, trigger download
>    - File name format: `workers_export_2026-04-14.csv`
> 3. Date range filter (optional): two date inputs that filter timesheets and allocations by date range before export
> 4. Show record count next to each export button (e.g. "Export 24 records")
> 5. All inline CSS, dark theme

> ✅ **Checkpoint:** Each CSV button downloads a valid CSV file that opens correctly in Excel.

---

## PHASE 8 — POLISH & NOTIFICATIONS (Cursor prompts)

### Step 8.1 — Toast Notification System

**Paste into Cursor Composer:**

> Add a reusable toast notification system to `App.jsx`. Requirements:
>
> 1. A `showToast(message, type)` function where type is 'success', 'error', or 'info'
> 2. Toast appears in the top-right corner, slides in from the right
> 3. Auto-dismisses after 3 seconds
> 4. Colour coding: success=green, error=red, info=blue
> 5. Stack multiple toasts if triggered in quick succession
> 6. Go through ALL existing CRUD operations in the file and add toast calls:
>    - After successful create: "Record created successfully"
>    - After successful update: "Record updated successfully"
>    - After successful delete: "Record deleted"
>    - After any Supabase error: show the error message
>    - After clock in/out: "Clocked in at [time]" / "Clocked out — [X] hours logged"
> 7. All inline CSS, dark theme

### Step 8.2 — Loading States & Empty States

**Paste into Cursor Composer:**

> Go through every page/tab in `App.jsx` and ensure:
>
> 1. Every data fetch shows a loading spinner (a simple CSS spinner) while loading
> 2. Every table/card list shows a friendly empty state message when there are no records (e.g. "No timesheets found. Create one to get started.")
> 3. All buttons show a loading/disabled state while an operation is in progress to prevent double-clicks
> 4. All modals have proper close behaviour (close button + clicking overlay)
> 5. All inline CSS, dark theme

### Step 8.3 — Responsive Design Pass

**Paste into Cursor Composer:**

> Make the entire app responsive. Requirements:
>
> 1. On screens narrower than 768px:
>    - Admin sidebar collapses to a hamburger menu icon
>    - Clicking the hamburger slides the sidebar in as an overlay
>    - Tables become horizontally scrollable
>    - Stat cards on dashboard stack vertically
>    - Modals take full screen width with padding
> 2. On screens narrower than 480px:
>    - Further reduce font sizes and padding
>    - Clock In/Out buttons are full width
> 3. Use inline styles with a simple check: `const isMobile = window.innerWidth < 768` (update on resize)
> 4. Test that nothing breaks or overflows

> ✅ **Checkpoint:** App looks good on desktop AND mobile. All features still work.

---

## PHASE 9 — BUG SWEEP (Cursor prompts)

### Step 9.1 — Full Code Review

**Paste into Cursor Composer:**

> Review the entire `src/App.jsx` file for bugs and issues. Specifically check for:
>
> 1. **Missing error handling**: Every Supabase call should have `.catch()` or check for `error` in the response and show a toast
> 2. **Memory leaks**: All `useEffect` hooks that set up subscriptions or intervals must return cleanup functions
> 3. **Stale state**: After any CRUD operation, the relevant data should be re-fetched
> 4. **Missing keys**: All `.map()` rendered lists must have unique `key` props
> 5. **Uncontrolled inputs**: All form inputs should be controlled (value + onChange)
> 6. **Modal state reset**: Form fields should clear when modal closes
> 7. **Date/timezone issues**: All dates should display correctly in the user's local timezone
> 8. **Empty field validation**: Required fields (name, email) should show validation before submitting
> 9. **SQL injection**: Confirm Supabase client handles parameterized queries (it does by default)
> 10. Fix ALL issues found. List every fix you made.

### Step 9.2 — Console Error Sweep

**Run in your terminal:**
```
npm start
```

Then test every single flow below. If any console errors appear, paste them into Cursor with:

> Fix this console error: [paste error here]

**Test checklist:**
```
[ ] Login as admin — no errors
[ ] Dashboard loads with correct counts
[ ] Workers: view list, add new, edit, delete
[ ] Allocations: view list, add new, edit, delete, filter by status
[ ] Timesheets: view list, add new, edit, delete, approve, reject
[ ] Certifications: view list, add new, edit, delete, expiry badges correct
[ ] Reports: export each CSV, open in Excel
[ ] Sign out
[ ] Login as worker — no errors
[ ] My Allocations tab loads
[ ] My Timesheets: view and submit new
[ ] My Certifications tab loads
[ ] Clock In → wait 10 seconds → Clock Out → timesheet created
[ ] Sign out
[ ] Login as admin → new timesheet from James visible → approve it
[ ] Resize browser to mobile — layout works
[ ] All toasts appear correctly
[ ] All modals open and close properly
[ ] No console errors during any of the above
```

---

## PHASE 10 — DEPLOY TO VERCEL (Manual steps)

### Step 10.1 — Push to GitHub
```bash
cd cbd-portal
git init
git add .
git commit -m "CBD Portal v1.0"
```
Create a new repo on GitHub, then:
```bash
git remote add origin https://github.com/YOUR_USERNAME/cbd-portal.git
git branch -M main
git push -u origin main
```

### Step 10.2 — Deploy on Vercel
1. Go to **vercel.com** → sign in → "Add New Project"
2. Import your GitHub repo
3. Framework preset: **Create React App**
4. No environment variables needed (credentials are in the code — see note below)
5. Click **Deploy**
6. Wait for build to complete → visit your live URL

### Step 10.3 — (Recommended) Move Credentials to Env Variables

**Paste into Cursor Composer:**

> Refactor `src/supabaseClient.js` to read credentials from environment variables:
>
> - `REACT_APP_SUPABASE_URL`
> - `REACT_APP_SUPABASE_ANON_KEY`
>
> Create a `.env` file in the project root with these values. Add `.env` to `.gitignore`.

Then in Vercel → Settings → Environment Variables, add both values.

---

## QUICK REFERENCE — CURSOR TIPS

| Situation | What to do in Cursor |
|---|---|
| Code doesn't work | Select the broken code → Cmd+K → "Fix this error: [error message]" |
| Need to change something | Select the code → Cmd+K → describe the change |
| Big new feature | Use Composer (Cmd+I) with the full prompt |
| Supabase error | Paste the exact error into Composer and ask it to fix |
| Whole file review | Open App.jsx → Cmd+I → "Review this file for bugs" |
| Console error | Copy the error → Cmd+I → "Fix this console error: [paste]" |

---

## FILE STRUCTURE (Final)

```
cbd-portal/
├── public/
│   └── index.html
├── src/
│   ├── App.jsx          ← All portal code lives here
│   ├── supabaseClient.js ← Supabase connection
│   └── index.js          ← Entry point
├── .env                  ← Supabase credentials
├── .gitignore
└── package.json
```

---

## ESTIMATED TIME

| Phase | Time |
|---|---|
| Phase 1: Supabase Setup | 15 min |
| Phase 2: Scaffolding | 10 min |
| Phase 3: Auth | 20 min |
| Phase 4: Admin Layout + Dashboard | 30 min |
| Phase 5: CRUD Pages (4 pages) | 90 min |
| Phase 6: Worker Portal (5 tabs) | 60 min |
| Phase 7: Reports & CSV | 20 min |
| Phase 8: Polish | 30 min |
| Phase 9: Bug Sweep | 30 min |
| Phase 10: Deploy | 15 min |
| **Total** | **~5 hours** |
