-- Advisor remediation (security + performance lints), 2026-05-28.
--
-- Addresses:
--  • rls_policy_always_true  — payroll/medical policies had WITH CHECK (true),
--    letting any authenticated user INSERT rows. Tighten to the same admin
--    gate as USING.
--  • public_bucket_allows_listing — drop the broad SELECT policy on the
--    public worker-photos bucket (public buckets serve object URLs without
--    a listing policy; the policy only enabled enumerate-all-files).
--  • auth_rls_initplan — every RLS policy called auth.<fn>() per-row. Wrap in
--    (select auth.<fn>()) so Postgres evaluates it once per query.
--  • unindexed_foreign_keys — add covering indexes on the worker_id / client_id
--    FKs that drive the hottest joins.
--
-- NOT changed (intentional / environmental):
--  • anon/authenticated can execute get_public_worker_profile and
--    update_worker_via_token — REQUIRED for the public onboarding magic-link
--    flow. Revoking would break onboarding. search_path is pinned on both.
--  • Leaked-password protection — Auth setting, toggle in Dashboard → Auth.
--  • "Unused index" INFO lints — those indexes are new and simply haven't been
--    hit yet; they back queries that run in production. Keep them.

-- ── Security + perf: payroll / medical admin policies ──────────────────────
-- USING and WITH CHECK both gated to admin/manager; auth.jwt() wrapped once.
DROP POLICY IF EXISTS payroll_admin_all ON worker_payroll_details;
CREATE POLICY payroll_admin_all ON worker_payroll_details
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM workers w
      WHERE lower(w.email) = lower((select auth.jwt()) ->> 'email')
        AND w.access_level IN ('admin', 'manager')
        AND w.archived_at IS NULL
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM workers w
      WHERE lower(w.email) = lower((select auth.jwt()) ->> 'email')
        AND w.access_level IN ('admin', 'manager')
        AND w.archived_at IS NULL
    )
  );

DROP POLICY IF EXISTS medical_admin_all ON worker_medical_details;
CREATE POLICY medical_admin_all ON worker_medical_details
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM workers w
      WHERE lower(w.email) = lower((select auth.jwt()) ->> 'email')
        AND w.access_level IN ('admin', 'manager')
        AND w.archived_at IS NULL
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM workers w
      WHERE lower(w.email) = lower((select auth.jwt()) ->> 'email')
        AND w.access_level IN ('admin', 'manager')
        AND w.archived_at IS NULL
    )
  );

-- ── Security: stop the public photo bucket from being listable ─────────────
DROP POLICY IF EXISTS worker_photos_read ON storage.objects;
-- (No replacement: public buckets still serve direct object URLs without a
-- SELECT policy. Removing it just blocks "list every file" enumeration.)

-- ── Performance: wrap auth.uid() in (select ...) across all base policies ──
DROP POLICY IF EXISTS "Auth users full access" ON workers;
CREATE POLICY "Auth users full access" ON workers
  FOR ALL USING ((select auth.uid()) IS NOT NULL) WITH CHECK ((select auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "Auth users full access" ON allocations;
CREATE POLICY "Auth users full access" ON allocations
  FOR ALL USING ((select auth.uid()) IS NOT NULL) WITH CHECK ((select auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "Auth users full access" ON timesheets;
CREATE POLICY "Auth users full access" ON timesheets
  FOR ALL USING ((select auth.uid()) IS NOT NULL) WITH CHECK ((select auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "Auth users full access" ON certifications;
CREATE POLICY "Auth users full access" ON certifications
  FOR ALL USING ((select auth.uid()) IS NOT NULL) WITH CHECK ((select auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "Auth users full access" ON clients;
CREATE POLICY "Auth users full access" ON clients
  FOR ALL USING ((select auth.uid()) IS NOT NULL) WITH CHECK ((select auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "Auth users full access" ON payroll_config;
CREATE POLICY "Auth users full access" ON payroll_config
  FOR ALL USING ((select auth.uid()) IS NOT NULL) WITH CHECK ((select auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "Auth users full access" ON xero_tokens;
CREATE POLICY "Auth users full access" ON xero_tokens
  FOR ALL USING ((select auth.uid()) IS NOT NULL) WITH CHECK ((select auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "Auth users full access" ON job_roles;
CREATE POLICY "Auth users full access" ON job_roles
  FOR ALL USING ((select auth.uid()) IS NOT NULL) WITH CHECK ((select auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "Auth users full access" ON client_jobs;
CREATE POLICY "Auth users full access" ON client_jobs
  FOR ALL USING ((select auth.uid()) IS NOT NULL) WITH CHECK ((select auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "Auth users full access" ON client_rate_cards;
CREATE POLICY "Auth users full access" ON client_rate_cards
  FOR ALL USING ((select auth.uid()) IS NOT NULL) WITH CHECK ((select auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "Auth users read message log" ON message_log;
CREATE POLICY "Auth users read message log" ON message_log
  FOR SELECT USING ((select auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "Auth users insert message log" ON message_log;
CREATE POLICY "Auth users insert message log" ON message_log
  FOR INSERT WITH CHECK ((select auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "Auth users gmail tokens" ON gmail_tokens;
CREATE POLICY "Auth users gmail tokens" ON gmail_tokens
  FOR ALL USING ((select auth.uid()) IS NOT NULL) WITH CHECK ((select auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "Auth users email threads" ON email_threads;
CREATE POLICY "Auth users email threads" ON email_threads
  FOR ALL USING ((select auth.uid()) IS NOT NULL) WITH CHECK ((select auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "Auth users email messages" ON email_messages;
CREATE POLICY "Auth users email messages" ON email_messages
  FOR ALL USING ((select auth.uid()) IS NOT NULL) WITH CHECK ((select auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "Auth users email templates" ON email_templates;
CREATE POLICY "Auth users email templates" ON email_templates
  FOR ALL USING ((select auth.uid()) IS NOT NULL) WITH CHECK ((select auth.uid()) IS NOT NULL);

-- ── Performance: covering indexes for foreign keys ─────────────────────────
CREATE INDEX IF NOT EXISTS allocations_worker_id_idx   ON allocations(worker_id);
CREATE INDEX IF NOT EXISTS certifications_worker_id_idx ON certifications(worker_id);
CREATE INDEX IF NOT EXISTS client_jobs_client_id_idx    ON client_jobs(client_id);
CREATE INDEX IF NOT EXISTS timesheets_worker_id_idx      ON timesheets(worker_id);
