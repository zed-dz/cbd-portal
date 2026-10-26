-- 20261026_po_number.sql
-- Purchase order number per site and per project (site supervisor feedback, Paul,
-- 2026-10-26): the client's PO goes on every timesheet email and PDF so their
-- accounts can match it. Additive only.
alter table public.client_sites add column if not exists po_number text check (po_number is null or char_length(po_number) <= 60);
alter table public.client_jobs  add column if not exists po_number text check (po_number is null or char_length(po_number) <= 60);
comment on column public.client_sites.po_number is 'Client purchase order for work at this site; printed on timesheet emails and PDFs.';
comment on column public.client_jobs.po_number  is 'Client purchase order for this project; printed on timesheet emails and PDFs.';
