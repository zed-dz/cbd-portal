-- 20261027_clients_timesheet_emails_grant.sql
-- clients hides money with COLUMN-level select grants. The 2026-10-26 column
-- timesheet_emails got no grant, so every office select of the clients list failed with
-- "permission denied for table clients". Non-money column: readable like contact_email.
grant select (timesheet_emails) on public.clients to authenticated;
