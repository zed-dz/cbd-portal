-- 2026-10-15 — API roles never need TRUNCATE / REFERENCES / TRIGGER (PostgREST
-- cannot use them); remove them everywhere, now and for future tables.
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('revoke truncate, references, trigger on public.%I from anon, authenticated', r.tablename);
  end loop;
end $$;
revoke delete on public.payroll_config from authenticated;
alter default privileges for role postgres in schema public revoke truncate, references, trigger on tables from anon, authenticated;
