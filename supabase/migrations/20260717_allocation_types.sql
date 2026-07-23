-- Calendar entry types (feedback 4): allocations can now be RDO days,
-- personal/sick leave or annual leave, shown in their own colours.
alter table public.allocations
  add column if not exists allocation_type text not null default 'work';
