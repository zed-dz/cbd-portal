-- Multiple job sites per client, and multiple contacts per site.
--
-- Until now a "client" row WAS a site: to run two jobs for the same company you
-- created the company twice. That is why the allocation picker shows "Matt Civil"
-- three times, and worse, those duplicate rows carry DIFFERENT rates while
-- timesheets store the client as free text — so payroll matches on name, takes
-- the first hit, and can bill the wrong rate for the site actually worked.
--
-- This splits sites out properly. Clients stay one row per company; sites hang
-- off them; contacts hang off sites (a site can have a supervisor, a foreman and
-- an accounts contact, each with their own phone/email).
--
-- Additive only. clients.site is left in place and back-filled into client_sites
-- below, so nothing that reads the old column breaks while the UI moves over.

create table if not exists client_sites (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients(id) on delete cascade,
  name        text not null,
  address     text,
  notes       text,
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists client_sites_client_id_idx on client_sites(client_id);

create table if not exists client_site_contacts (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references client_sites(id) on delete cascade,
  name          text not null,
  role          text,
  email         text,
  phone         text,
  is_primary    boolean not null default false,
  -- Who receives the timesheet approval link for work on this site. Kept separate
  -- from is_primary: the person who signs off hours is often not the main contact.
  approves_timesheets boolean not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists client_site_contacts_site_id_idx on client_site_contacts(site_id);

alter table client_sites          enable row level security;
alter table client_site_contacts  enable row level security;

-- Same policy shape as client_rate_cards: any signed-in user, full access.
drop policy if exists "Auth users full access" on client_sites;
create policy "Auth users full access" on client_sites
  for all using ((select auth.uid()) is not null)
  with check ((select auth.uid()) is not null);

drop policy if exists "Auth users full access" on client_site_contacts;
create policy "Auth users full access" on client_site_contacts
  for all using ((select auth.uid()) is not null)
  with check ((select auth.uid()) is not null);

-- Back-fill: every existing client with a site name gets that site as its first
-- client_sites row, and its existing contact becomes that site's primary contact.
-- Guarded so re-running the migration cannot duplicate them.
insert into client_sites (client_id, name, address)
select c.id, nullif(trim(c.site), ''), null
from clients c
where nullif(trim(c.site), '') is not null
  and not exists (
    select 1 from client_sites s
    where s.client_id = c.id and lower(trim(s.name)) = lower(trim(c.site))
  );

insert into client_site_contacts (site_id, name, email, phone, is_primary, approves_timesheets)
select s.id, nullif(trim(c.contact), ''), c.contact_email, c.contact_phone, true, true
from clients c
join client_sites s
  on s.client_id = c.id and lower(trim(s.name)) = lower(trim(c.site))
where nullif(trim(c.contact), '') is not null
  and not exists (
    select 1 from client_site_contacts k where k.site_id = s.id
  );
