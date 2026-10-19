-- OAuth token tables are server-only (2026-10-20).
-- Edge functions use the service role. The only browser read is the Payroll
-- page asking "is Xero connected and until when?" (xero_tokens.id, expires_at).
-- Before this, any signed-in admin could read access/refresh tokens via the API.

revoke all on public.xero_tokens  from anon, authenticated;
revoke all on public.myob_tokens  from anon, authenticated;
revoke all on public.gmail_tokens from anon, authenticated;

grant select (id, expires_at) on public.xero_tokens to authenticated;
