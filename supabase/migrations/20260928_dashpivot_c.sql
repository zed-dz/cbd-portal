-- 20260928_dashpivot_c.sql — Dashpivot parity, pack C (prompts 3.1, 3.2, X1, X5)
-- Clients folder view · rate-set pay columns · activity feed · cert reminders.
--
-- SECTION 1 was already RUN on tsizneslellcqusjwtub (2026-09-27) via the
-- Management API — purely additive, verified present. Recorded here so other
-- environments replay identically.
-- SECTION 2 (cron.schedule) has NOT been run: central substitutes __ANON__
-- with the project anon key and runs it after deploying the cert-reminders
-- edge function (deploy with --no-verify-jwt).

-- ── Section 1 · additive columns + indexes (ALREADY APPLIED LIVE) ───────────

-- 3.1 — clients gain the archive-never-delete pattern workers already have.
alter table public.clients add column if not exists archived_at timestamptz;

-- 3.2 — rate sets archive + per-line PAY columns. Pay is REFERENCE-ONLY for
-- now: applying a set to a client still copies only the CHARGE columns
-- (rate_a/b/c) into client_rate_cards, which is what billing reads.
alter table public.rate_sets add column if not exists archived_at timestamptz;
alter table public.rate_set_items add column if not exists pay_a numeric;
alter table public.rate_set_items add column if not exists pay_b numeric;
alter table public.rate_set_items add column if not exists pay_c numeric;

-- X5 — idempotence for cert-expiry reminders: a stage ('30'|'14'|'7'|'0')
-- already recorded on the row is never sent twice.
alter table public.certifications add column if not exists last_reminded_at timestamptz;
alter table public.certifications add column if not exists last_reminded_stage text;

-- X1 — feed queries: site-wide newest-first and per-client newest-first.
create index if not exists idx_activity_events_client_created on public.activity_events (client_id, created_at desc);
create index if not exists idx_activity_events_created on public.activity_events (created_at desc);
-- X5 — the daily reminder scan filters on exact expiry dates.
create index if not exists idx_certifications_expiry on public.certifications (expiry);

-- ── Section 2 · pg_cron schedule (NOT RUN — central applies) ────────────────
-- Daily cert-expiry reminders at 21:00 UTC = 7am Sydney in AEST (8am in AEDT —
-- accepted drift; the function computes Sydney dates itself so the stage math
-- is right either way). Substitute __ANON__ with the project anon key BEFORE
-- running this section — run as-is it would schedule a job whose bearer token
-- is the literal placeholder, and every daily call would 401.

select cron.schedule(
  'cert-reminders-daily',
  '0 21 * * *',
  $$
  select net.http_post(
    url     := 'https://tsizneslellcqusjwtub.supabase.co/functions/v1/cert-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer __ANON__'
    ),
    body    := '{}'::jsonb
  );
  $$
);
