-- 2026-08-04 team feedback F5 + F6
--
-- F5 "Save as Default Client Rates" — the catch-all A/B/C hourly rates a new
--    client starts with, held once for the company instead of retyped per
--    client. Stored in the existing payroll_config key/value table.
--
-- F6 "We want each line item attached to the new clients" — a company-level
--    DEFAULT SCHEDULE OF RATES. Every line item on it is copied onto each new
--    client automatically, so a new client arrives with the full rate card
--    already populated and the office only edits the exceptions.
--
-- Existing clients are untouched; use apply_default_rate_card_to_client() to
-- push the defaults onto one deliberately.

-- ── The default schedule of rates (same shape as client_rate_cards) ─────────
create table if not exists public.default_rate_card (
  id          uuid primary key default gen_random_uuid(),
  role_name   text        not null,
  rate_a      numeric,
  rate_b      numeric,
  rate_c      numeric,
  notes       text,
  uom         text        not null default 'hour',
  category    text,
  sort_order  integer     not null default 0,
  created_at  timestamptz default now()
);

comment on table public.default_rate_card is
  'Company default Schedule of Rates. Copied onto every new client via the trg_clients_apply_default_rates trigger (F6, 2026-08-04).';

alter table public.default_rate_card enable row level security;

drop policy if exists "Auth users full access" on public.default_rate_card;
create policy "Auth users full access" on public.default_rate_card
  for all to authenticated using (true) with check (true);

-- ── F5: the catch-all default A/B/C a new client starts on ─────────────────
insert into public.payroll_config (config_key, config_value, description)
values
  ('default_client_rate_a', '', 'Default client charge rate — A / normal (Mon–Fri ≤8h). Applied to new clients.'),
  ('default_client_rate_b', '', 'Default client charge rate — B / OT 1.5× (night, Sat day).'),
  ('default_client_rate_c', '', 'Default client charge rate — C / OT 2× (Sun, PH, Sat >8h).')
on conflict (config_key) do nothing;

-- ── Copy the defaults onto a client ────────────────────────────────────────
-- replace=false (the default) only fills gaps: line items whose role_name the
-- client already has are left alone, so running it twice is safe and never
-- clobbers a negotiated rate.
create or replace function public.apply_default_rate_card_to_client(
  p_client_id uuid,
  p_replace   boolean default false
)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_inserted integer := 0;
begin
  if p_client_id is null then return 0; end if;

  if p_replace then
    delete from client_rate_cards where client_id = p_client_id;
  end if;

  insert into client_rate_cards (client_id, role_name, rate_a, rate_b, rate_c, notes, uom, category, sort_order)
  select p_client_id, d.role_name, d.rate_a, d.rate_b, d.rate_c, d.notes, d.uom, d.category, d.sort_order
  from default_rate_card d
  where not exists (
    select 1 from client_rate_cards c
    where c.client_id = p_client_id
      and lower(c.role_name) = lower(d.role_name)
  );

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

grant execute on function public.apply_default_rate_card_to_client(uuid, boolean) to authenticated;

-- ── Auto-attach on client creation ─────────────────────────────────────────
create or replace function public.clients_apply_default_rates()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_a numeric;
  v_b numeric;
  v_c numeric;
begin
  -- Catch-all A/B/C: only fill what the office left blank on the new client.
  if new.rate_a is null or new.rate_b is null or new.rate_c is null then
    select nullif(max(case when config_key = 'default_client_rate_a' then config_value end), '')::numeric,
           nullif(max(case when config_key = 'default_client_rate_b' then config_value end), '')::numeric,
           nullif(max(case when config_key = 'default_client_rate_c' then config_value end), '')::numeric
      into v_a, v_b, v_c
      from payroll_config
     where config_key in ('default_client_rate_a', 'default_client_rate_b', 'default_client_rate_c');

    update clients
       set rate_a = coalesce(new.rate_a, v_a),
           rate_b = coalesce(new.rate_b, v_b),
           rate_c = coalesce(new.rate_c, v_c)
     where id = new.id;
  end if;

  -- Every line item on the default schedule of rates.
  perform apply_default_rate_card_to_client(new.id, false);
  return null;
end;
$$;

drop trigger if exists trg_clients_apply_default_rates on public.clients;
create trigger trg_clients_apply_default_rates
  after insert on public.clients
  for each row execute function public.clients_apply_default_rates();
