# CBD Portal — June 2026 Updates: Team How-To Guide

This guide covers everything that changed on the **Clients** page in the June 2026 release. It's written so you can hand it straight to a new team member and they can start using the system the same day.

Live portal: **https://cbd-portal-gray.vercel.app**

---

## TL;DR — what's new

| Old | New |
|---|---|
| "Jobs" tab | **"Projects"** tab |
| "Charge bands" | **"Default client rates"** (A / B / C only) |
| "Roles & Rates" tab | **"Schedule of Rates"** tab |
| "Job Roles" library tab | **"Common Roles"** tab |
| One contact per client | **One contact per project** (site contact: name, email, phone) |
| Charge bands only — Normal, OT, Night, Weekend, Public Holiday | **A / B / C bands** — A = Normal Mon–Fri, B = OT 1.5×, C = OT 2× (matches the printed SOR PDF) |
| Single flat list of role rates | **Schedule of Rates line items** — every PDF row is its own product, with UOM (Hour / Shift / Day / Ton / m³ / m² / lm / each / km / Unit) and an optional Category (Labour / Plant / Attachments / Materials / Allowances / Other) |
| Manual one-row-at-a-time entry | **3 ways to add rates**: single, bulk (3+ rows), or paste/upload a whole SOR |

---

## 1. The Clients page at a glance

Each client now has **three tabs** in their detail view:

1. **Projects** — every active job site for that client. Each project has its own site contact + required roles.
2. **Schedule of Rates** — every billable line item for that client (Labourer, Confined Space, 8t Excavator, Tipping Fee per ton, etc.) with A / B / C rates.
3. **Default client rates** — fallback A / B / C rates used when a timesheet doesn't match a specific SOR line item.

Plus the **"Common Roles"** tab at the top (next to the Clients tab) — a global library of role names used for description autocomplete.

---

## 2. Adding a new client

**Clients → + Add Client**

Fill in:
- **Name** (required)
- **Billing contact** — name, phone, email (the person you send invoices to)
- **Default client rates** — A (Normal), B (OT 1.5×), C (OT 2×) in $/hour
- **Allowances** — Travel, Meal (per shift)

Click **Save**. The client appears in the list.

---

## 3. Adding projects (job sites) under a client

A single client (e.g. JK Williams) can have 3–4 active job sites. Each one is a **project** with its own on-site contact, separate from the billing contact.

**Click the client → Projects tab → + Add Project**

For each project:
- **Name** — e.g. "Rail Corridor — Eastern Line"
- **Site** — e.g. "Truganina Yard"
- **Address**
- **Site contact** — name, email, phone (this person is who the worker calls on the day, not the client's office)
- **Start date / End date / Status** (active / paused / done)
- **Required Roles** — toggle which roles are needed on this site (Excavator Operator, Dogman, etc.)
- **Notes**

Click **Save**. The project now shows up as a row under the client.

> 💡 **When to use site contact vs billing contact?** Billing contact = invoices, account changes, contract questions. Site contact = "what time should we arrive tomorrow?", "where's the gate code?", "we're running late."

---

## 4. Adding line items to a Schedule of Rates

**Click the client → Schedule of Rates tab**

You'll see line items grouped by category (Labour, Plant, Attachments, Materials, Allowances, Other, Uncategorised). Each row shows the description, UOM badge, and A / B / C rates.

You have **three ways** to add rates, in increasing order of speed:

### 4a. Single item — `+ Add line item`

Use this when adding ONE new item to an existing SOR.

Fields:
- **Description** — e.g. "General Labour" (autocomplete from Common Roles library)
- **UOM** — pick from dropdown (Hour, Shift, Day, Ton, Unit, km, m³, m², lm, Each)
- **Category** — pick from dropdown or leave Uncategorised
- **A — Normal** ($/UOM) — **required**
- **B — OT 1.5×** — leave blank if single-rate (Materials, Tipping, etc.)
- **C — OT 2×** — leave blank if single-rate
- **Notes** — optional

Click **Save**.

### 4b. Tabular bulk add — `+ Add many`

Use this when adding 3–10 rows by hand (e.g. you just got a phone confirmation for half a dozen new items).

Opens a small spreadsheet-style form with Category / Description / UOM / A / B / C / Remove columns. Starts with 3 blank rows; click **+ Add row** for more. Empty rows are auto-skipped on save. Click **Save all** when done.

### 4c. Upload from PDF / Excel / CSV — `📤 Upload rates` ⭐

This is the **headline new feature**. It lets you paste in (or upload) an entire SOR in one operation.

**Three input modes:**

1. **Paste from PDF** — open the SOR PDF, select a whole table, Ctrl+C, paste into the textarea.
2. **Paste from Excel** — select rows in Excel, Ctrl+C, paste. Tab-separated cells just work.
3. **Upload a file** — click "📁 Choose CSV file" and pick a .csv / .tsv / .txt file.

**What the parser does automatically:**

- **Detects the delimiter** (tab > pipe > comma) so you don't have to convert anything.
- **Recognises headers** — case-insensitive matching for common synonyms:
  - `Description`, `Desc`, `Name`, `Role`, `Line Item` → description
  - `UOM`, `Unit`, `Units`, `U/M` → UOM
  - `A`, `Rate A`, `Normal`, `Mon-Fri` → A band
  - `B`, `Rate B`, `OT`, `Overtime`, `Sat` → B band
  - `C`, `Rate C`, `OT 2`, `Sun`, `PH` → C band
  - `Category`, `Section`, `Group`, `Type` → category
  - `Notes`, `Comment`, `Basis`, `Remark` → notes
  - `Item`, `#`, `No`, `Row` → ignored (it's just a row-number column)
- **Normalises UOMs** — `Hour` / `Hr` / `H` → `hour`; `Tonne` → `ton`; `m²` → `m2`; `m³` → `m3`; `Lineal m` → `lm`; etc.
- **Maps category section names** — `LABOUR` / `Labour` → `labour`; `Plant Hire` → `plant`; `Materials & Tipping` → `materials`; `Hammer` / `Auger` → `attachments`; `Travel` / `LAFHA` / `Meal` → `allowances`; etc.
- **Handles edge cases** — `POR`, `POA`, `TBA`, `N/A`, and blank cells are all treated as null (no rate). Rows where ALL three rates are null get skipped (with a reason shown).
- **Strips leading row numbers** — if every row starts with "1", "2", "3"... it drops that column.
- **Strips `$` and `,`** from rates — `$1,200.00` → `1200`.
- **Respects quoted fields** — `"General Labour, all-round",Hour,60.15` parses correctly.

**Workflow:**

1. Open the SOR PDF (or your Excel sheet).
2. Select the rate table and copy it.
3. In the portal: Clients → click the client → Schedule of Rates tab → **📤 Upload rates**.
4. Paste into the textarea (or click 📁 Choose CSV file).
5. The preview table fills in live, showing every parsed row + any skipped rows (with reasons). The button at the bottom shows "Save N line items".
6. (Optional) Tick **"Replace this client's existing line items first"** if you want to wipe the current SOR and start fresh. A confirmation prompt will appear before anything is deleted, and the new items get inserted first — so if the upload fails, your existing data is still there.
7. Click **Save N line items**. Toast confirms success.

**Format example (paste-friendly):**

```
Description       UOM    A         B         C
General Labour    Hour   60.15     85.05     103.50
Confined Space    Hour   75.00     100.00    125.00
Foreman           Hour   85.00     110.50    136.00
Excavator 5t      Hour   220.00    275.00    330.00
Hammer Attach.    Hour   85.00
Tipping Fee       Ton    220.00
Crushed Rock 20mm m3     78.00
```

(Tabs between columns. Materials/Attachments only need column A.)

**With a category column:**

```
Category,Description,UOM,A,B,C,Notes
Labour,General Labour,hour,60.15,85.05,103.50,
Labour,Confined Space,hour,75,100,125,
Plant,Excavator 5t,hour,220,275,330,
Attachments,Hammer,hour,85,,,
Materials,Tipping Fee,ton,220,,,T&D rates
Allowances,Travel,km,1.85,,,
```

---

## 5. Editing / removing existing line items

In the Schedule of Rates list, each row has **Edit** and **Delete** buttons.

- **Edit** — opens the inline form with the current values filled in. Change what you need and Save.
- **Delete** — asks to confirm, then removes the row.

There's no soft-delete / undo, so be deliberate with Delete. If you want to bulk-replace, use the Upload rates flow with the "Replace existing items" checkbox — it's safer because it inserts first and only deletes the old rows if the new insert succeeds.

---

## 6. Common Roles library

**Clients page → Common Roles tab** (top-level tab)

This is just a list of role names — General Labour, Skilled Labourer, Foreman, Excavator Operator, etc. It's used **only** for autocomplete suggestions when you're typing a description on a rate card.

Adding/removing here doesn't affect any client's actual rates — those are stored per-client on the SOR tab.

---

## 7. FAQ

**Q: What happened to Night and Weekend rate bands?**
A: They've been consolidated into the A / B / C structure to match CBD's printed Schedule of Rates PDF. A = Normal Mon–Fri, B = OT 1.5× (typically Sat / >8h / nights), C = OT 2× (typically Sun / PH). If you need finer granularity per item, set it on the line item — the per-item rate beats the client default.

**Q: A client has both labour and materials on their SOR. How do I record items that don't have all three rates?**
A: Just leave B and C blank on the form. The preview will show "—" for those bands, and on a timesheet the system uses A only.

**Q: I pasted from a PDF and a few rows show as "skipped". Why?**
A: The skipped list (click to expand under the preview) tells you the reason — either "no description" (the row was blank or had only numbers) or "no rates" (all of A/B/C were POR/POA/TBA/blank). Fix the source rows or add them manually with `+ Add line item`.

**Q: The parser put the description in the wrong column.**
A: Add a header row to the top of your paste. The parser is much more accurate with headers (Description, UOM, A, B, C). Without headers it assumes positional order: Category, Description, UOM, A, B, C, Notes.

**Q: Can I download the current SOR for a client?**
A: Not yet — that's a future enhancement. For now use the database export from Supabase if needed, or copy from the on-screen list.

**Q: What if a client has the same line item twice (e.g. "General Labour" duplicated)?**
A: The database doesn't prevent duplicates — both rows will save and both will appear in the list. Delete the duplicate manually with the row's Delete button.

**Q: I clicked "Upload rates" and the preview shows zero rows. What's wrong?**
A: Most common causes:
  1. The pasted text has no recognisable delimiter (no tabs, no pipes, no commas).
  2. The first row of data was treated as a header but didn't match any synonyms — so the parser fell back to positional mode and the columns lined up wrong. Add a clear header row.
  3. All your rates show as POR / POA / TBA — those parse to null, and rows with no rates get skipped.

---

## 8. What's NOT changed (just to clarify)

- **Timesheets, allocations, payroll, Xero sync** — all unchanged. They still read from `client_rate_cards` so they'll pick up the new line items automatically.
- **Worker side** — workers don't see any of this directly. They just submit timesheets as before.
- **Existing clients' default rates** — untouched. The A/B/C "Default client rates" section is the same data that used to be called "charge bands", just renamed.
- **Login / signup** — unchanged.

---

## 9. Where to report problems

If something on the new Schedule of Rates flow is unclear, broken, or missing:

1. Try again with a clear header row at the top of your paste (avoids 80% of parse issues).
2. Take a screenshot of the **Upload rates preview** with the skipped rows expanded.
3. Send to whoever runs the portal admin (with the screenshot + the source PDF / Excel you were pasting from).

---

*Document version: 2026-06-11 · Covers cbd-portal commit history through the SOR v2 release.*
