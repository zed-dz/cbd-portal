# Dashpivot → CBD Portal build pack

## What is in here
| File | Use it for |
|---|---|
| `01-DASHPIVOT-TEARDOWN.md` | Every layer of Dashpivot: nav, folders, lists, templates, field types, workflow, register, PDF, email, users, settings. Ends with the 12 patterns that make it feel smooth. |
| `02-TEMPLATE-SCHEMAS.md` | Exact fields + formulas of Timesheet A/B/C, FT invoice, Weekly timesheet, Weekly allocation, Employment form. |
| `03-TIMESHEET-LOGIC.md` | Hour rules in plain English (normal / 1.5x / 2.0x / allowances) + Dashpivot bugs + portal mismatch. |
| `code/hoursCalc.ts` | The hour rules as one TypeScript function. |
| `code/hoursCalc.test.ts` | 12 checks. All pass. One is a real submitted Dashpivot form. |
| `04-DATA-MODEL.sql` | Target Supabase changes (additive). Training trigger, lock trigger, send log, rate sets, RLS. |
| `05-CLAUDE-CODE-PROMPTS.md` | Copy-paste prompts: 0 recon → Phase 1 (7) → Phase 2 (3) → Phase 3 (2) → 5 extras. |
| `CLAUDE.md.snippet` | Rules to paste into the repo's CLAUDE.md. |
| `screenshots/` | 25 Dashpivot + 6 portal screenshots. See `screenshots/INDEX.md`. |

## How to use it
1. Put this folder in the portal repo as `docs/dashpivot/`.
2. Paste `CLAUDE.md.snippet` into `CLAUDE.md`.
3. Run test: `node --experimental-strip-types docs/dashpivot/code/hoursCalc.test.ts`
4. In Claude Code, paste prompt **0** (recon). Then Phase 1 prompts one by one.

## Decide before prompt 2.1
**Which hour rules are the truth?** They do not match today.
Same shift (Tue night 22:00–08:00, 0.75 break):
- Portal now: Normal 7.60 · OT 1.65
- Dashpivot: 1.5x 8.00 · 2.0x 1.25

Options:
1. **Per-client setting, default = Dashpivot rules.** Clients already signed ~4,700 timesheets on these rules. (My pick. Check with your bookkeeper first.)
2. Keep the portal's 7.6 h / RDO rules for everyone.

## Watch out
- "A · B · C" means two different things. In Dashpivot = 3 timesheet templates. In the portal = 3 charge rates (normal / 1.5x / 2.0x). Do not mix them.
- Screenshots show real worker names and signatures. Keep this pack private.
- Not scanned: the Sitemate phone app (workers submit there). Scan it on a phone if you want the mobile screens too.
