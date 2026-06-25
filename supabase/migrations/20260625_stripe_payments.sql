-- 20260625_stripe_payments.sql
-- Feature 3: Stripe payment workflow (invoice the client + pay the worker).
--
-- Secrets: the LIVE Stripe secret key lives ONLY in integration_secrets
-- (key = 'stripe_secret_key'). That table has RLS enabled and NO policies, so it
-- is reachable by the service_role only (edge functions). It is NEVER read by the
-- browser client and the key is NEVER committed. (CBD already had this table; the
-- block below is idempotent and just guarantees the lockdown.)

create table if not exists public.integration_secrets (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table public.integration_secrets enable row level security;
-- intentionally NO policies => only service_role bypasses RLS.
revoke all on public.integration_secrets from anon, authenticated;

-- workers: Stripe Connect account id (present => can receive auto transfers).
alter table public.workers
  add column if not exists stripe_account_id text;

-- Client invoices created via Stripe Invoicing.
create table if not exists public.client_invoices (
  id                 uuid primary key default gen_random_uuid(),
  client             text not null,
  period_from        date,
  period_to          date,
  amount_cents       bigint not null default 0,
  currency           text not null default 'aud',
  line_items         jsonb,                 -- breakdown used to build the invoice
  stripe_customer_id text,
  stripe_invoice_id  text,
  stripe_status      text,                  -- draft|open|paid|void|uncollectible
  hosted_invoice_url text,
  status             text not null default 'pending', -- pending|created|error|dry_run
  error              text,
  created_by         uuid references public.workers(id),
  created_at         timestamptz not null default now()
);
create index if not exists client_invoices_client_idx on public.client_invoices (client);

-- A worker payment run for a pay period.
create table if not exists public.payment_runs (
  id          uuid primary key default gen_random_uuid(),
  period_from date,
  period_to   date,
  status      text not null default 'draft', -- draft|completed|partial|error|dry_run
  total_cents bigint not null default 0,
  currency    text not null default 'aud',
  notes       text,
  created_by  uuid references public.workers(id),
  created_at  timestamptz not null default now()
);

-- Individual worker payments inside a run.
create table if not exists public.worker_payments (
  id                 uuid primary key default gen_random_uuid(),
  run_id             uuid references public.payment_runs(id) on delete cascade,
  worker_id          uuid references public.workers(id),
  amount_cents       bigint not null default 0,
  currency           text not null default 'aud',
  method             text not null default 'manual_recorded', -- stripe_transfer|manual_recorded
  stripe_transfer_id text,
  status             text not null default 'pending',         -- pending|paid|recorded|error|dry_run
  error              text,
  created_at         timestamptz not null default now()
);
create index if not exists worker_payments_run_idx on public.worker_payments (run_id);

-- RLS: these payment records are admin/manager-only (staff). Edge functions use
-- the service_role and bypass RLS; the admin UI reads them as a logged-in admin.
alter table public.client_invoices enable row level security;
alter table public.payment_runs    enable row level security;
alter table public.worker_payments enable row level security;

drop policy if exists client_invoices_staff on public.client_invoices;
create policy client_invoices_staff on public.client_invoices
  for all to authenticated using ( public.is_cbd_staff() ) with check ( public.is_cbd_staff() );

drop policy if exists payment_runs_staff on public.payment_runs;
create policy payment_runs_staff on public.payment_runs
  for all to authenticated using ( public.is_cbd_staff() ) with check ( public.is_cbd_staff() );

drop policy if exists worker_payments_staff on public.worker_payments;
create policy worker_payments_staff on public.worker_payments
  for all to authenticated using ( public.is_cbd_staff() ) with check ( public.is_cbd_staff() );
