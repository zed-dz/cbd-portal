do $$
declare src text;
begin
  select pg_get_functiondef(p.oid) into src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='save_daily_timesheet';

  if src is null then raise exception 'save_daily_timesheet not found'; end if;

  if position('from public.workers w where w.id = auth.uid()' in src) = 0 then
    raise notice 'admin lookup already patched or shaped differently - no change';
    return;
  end if;

  src := replace(src,
    'from public.workers w where w.id = auth.uid()',
    'from public.workers w where lower(w.email) = lower((select u.email from auth.users u where u.id = auth.uid())) and w.archived_at is null');

  execute src;
  raise notice 'save_daily_timesheet admin lookup patched to match on email';
end $$;