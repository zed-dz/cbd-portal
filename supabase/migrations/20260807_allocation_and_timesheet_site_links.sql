-- Real client/site links on allocations and timesheets, alongside the names.
--
-- Allocations and timesheets record the client and site as FREE TEXT. Payroll then
-- resolves the client with `clients.find(c => c.name === ts.client)` — first match
-- wins. Because the same company exists several times (one row per site) and those
-- rows carry DIFFERENT rate cards, the rate used to bill a job depends on row
-- order rather than on the site actually worked. A "Matt Civil" job can bill at
-- $50/hr or $100/hr essentially at random.
--
-- We keep the text columns (nothing that reads them breaks, and they stay the
-- human-readable record of what was typed at the time) and add proper foreign
-- keys beside them. New rows get both; the lookup prefers the id.
--
-- ON DELETE SET NULL, never CASCADE: deleting a site must never delete timesheets.

alter table allocations add column if not exists client_id uuid references clients(id)      on delete set null;
alter table allocations add column if not exists site_id   uuid references client_sites(id) on delete set null;
alter table timesheets  add column if not exists client_id uuid references clients(id)      on delete set null;
alter table timesheets  add column if not exists site_id   uuid references client_sites(id) on delete set null;

create index if not exists allocations_client_id_idx on allocations(client_id);
create index if not exists allocations_site_id_idx   on allocations(site_id);
create index if not exists timesheets_client_id_idx  on timesheets(client_id);
create index if not exists timesheets_site_id_idx    on timesheets(site_id);

-- Back-fill, deliberately conservative.
--
-- Match on client name AND site name together, and only where that pair resolves
-- to exactly ONE site. Where a client name is ambiguous and the site does not
-- disambiguate it, we leave the ids NULL rather than guess — a guess here would
-- silently lock in the very wrong-rate bug this is meant to fix. Those rows keep
-- working through the existing name lookup and can be corrected by hand.

with resolved as (
  select a.id as alloc_id, s.id as site_id, s.client_id
  from allocations a
  join client_sites s
    on lower(trim(s.name)) = lower(trim(a.site))
  join clients c
    on c.id = s.client_id
   and lower(trim(c.name)) = lower(trim(a.client))
  where nullif(trim(a.site), '') is not null
    and nullif(trim(a.client), '') is not null
  group by a.id, s.id, s.client_id
  having count(*) = 1
)
update allocations a
   set site_id = r.site_id, client_id = r.client_id
  from resolved r
 where a.id = r.alloc_id
   and a.site_id is null;

with resolved as (
  select t.id as ts_id, s.id as site_id, s.client_id
  from timesheets t
  join client_sites s
    on lower(trim(s.name)) = lower(trim(t.site))
  join clients c
    on c.id = s.client_id
   and lower(trim(c.name)) = lower(trim(t.client))
  where nullif(trim(t.site), '') is not null
    and nullif(trim(t.client), '') is not null
  group by t.id, s.id, s.client_id
  having count(*) = 1
)
update timesheets t
   set site_id = r.site_id, client_id = r.client_id
  from resolved r
 where t.id = r.ts_id
   and t.site_id is null;

-- Where the site did not resolve but the CLIENT NAME is unique on its own, we can
-- still safely set client_id — that alone is enough to bill the right rate card.
update allocations a
   set client_id = c.id
  from clients c
 where a.client_id is null
   and nullif(trim(a.client), '') is not null
   and lower(trim(c.name)) = lower(trim(a.client))
   and (select count(*) from clients c2 where lower(trim(c2.name)) = lower(trim(a.client))) = 1;

update timesheets t
   set client_id = c.id
  from clients c
 where t.client_id is null
   and nullif(trim(t.client), '') is not null
   and lower(trim(c.name)) = lower(trim(t.client))
   and (select count(*) from clients c2 where lower(trim(c2.name)) = lower(trim(t.client))) = 1;
