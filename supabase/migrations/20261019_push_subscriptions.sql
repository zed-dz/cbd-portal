-- Web push subscriptions (one row per browser/device that opted in).
-- Additive only. Workers manage their own rows; office users may read the roster.
-- The p256dh/auth values are the browser's keys for THIS subscription only —
-- they let the server encrypt a payload that only that browser can read.

create table if not exists public.push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  worker_id     uuid not null references public.workers(id) on delete cascade,
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index if not exists push_subscriptions_worker_idx on public.push_subscriptions(worker_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists push_subs_worker_select on public.push_subscriptions;
create policy push_subs_worker_select on public.push_subscriptions
  for select to authenticated using (worker_id = public.current_worker_id());

drop policy if exists push_subs_worker_insert on public.push_subscriptions;
create policy push_subs_worker_insert on public.push_subscriptions
  for insert to authenticated with check (worker_id = public.current_worker_id());

drop policy if exists push_subs_worker_update on public.push_subscriptions;
create policy push_subs_worker_update on public.push_subscriptions
  for update to authenticated
  using (worker_id = public.current_worker_id())
  with check (worker_id = public.current_worker_id());

drop policy if exists push_subs_worker_delete on public.push_subscriptions;
create policy push_subs_worker_delete on public.push_subscriptions
  for delete to authenticated using (worker_id = public.current_worker_id());

drop policy if exists push_subs_office_select on public.push_subscriptions;
create policy push_subs_office_select on public.push_subscriptions
  for select to authenticated using (public.is_office_user());

revoke all on public.push_subscriptions from anon;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
