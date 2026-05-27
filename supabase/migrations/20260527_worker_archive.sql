-- Soft-archive for workers. Instead of hard-deleting a worker (which would
-- orphan historical allocations/timesheets/payroll), the row is kept and
-- marked archived with a reason category + free-text notes. Archived workers
-- are hidden from selection UIs (allocation create, timesheet entry, etc.)
-- but their history stays intact and they can be un-archived later — useful
-- when a former worker returns.

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS archived_at      timestamptz,
  ADD COLUMN IF NOT EXISTS archived_reason  text,   -- short category, see CHECK below
  ADD COLUMN IF NOT EXISTS archived_notes   text,   -- free-text rationale / handover context
  ADD COLUMN IF NOT EXISTS archived_by      text;   -- email/name of who archived them

ALTER TABLE workers
  DROP CONSTRAINT IF EXISTS workers_archived_reason_check;

ALTER TABLE workers
  ADD CONSTRAINT workers_archived_reason_check
  CHECK (
    archived_reason IS NULL OR archived_reason IN (
      'resigned', 'let_go', 'end_of_contract',
      'medical', 'retired', 'no_show', 'other'
    )
  );

-- Partial index — almost every active query filters archived rows out; a
-- partial index on the small archived subset keeps active-worker queries
-- from paying a B-tree-walk cost for a column that's NULL on most rows.
CREATE INDEX IF NOT EXISTS workers_archived_at_idx
  ON workers (archived_at)
  WHERE archived_at IS NOT NULL;

-- Public profile RPC: don't leak archived workers via the magic-link token.
CREATE OR REPLACE FUNCTION get_public_worker_profile(token UUID)
RETURNS TABLE (
  id            UUID,
  name          TEXT,
  job_title     TEXT,
  licences      TEXT,
  mobile        TEXT,
  site          TEXT,
  client        TEXT,
  worker_type   TEXT,
  status        TEXT,
  qualified     BOOLEAN,
  certifications JSONB,
  generated_at  TIMESTAMPTZ
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    w.id, w.name, w.job_title, w.licences, w.mobile,
    w.site, w.client, w.worker_type, w.status, w.qualified,
    COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'cert_name', c.cert_name, 'issuer', c.issuer, 'expiry', c.expiry
      ) ORDER BY c.expiry NULLS LAST)
        FROM certifications c WHERE c.worker_id = w.id),
      '[]'::jsonb
    ) AS certifications,
    NOW() AS generated_at
  FROM workers w
  WHERE w.profile_token = token
    AND w.archived_at IS NULL
  LIMIT 1;
$$;

-- Same defensive guard on the onboarding update RPC: an archived worker
-- shouldn't be able to keep submitting through their old magic link.
CREATE OR REPLACE FUNCTION update_worker_via_token(
  token       UUID,
  p_mobile    TEXT,
  p_address   TEXT,
  p_licences  TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  updated INT;
BEGIN
  UPDATE workers
  SET mobile     = COALESCE(p_mobile,   mobile),
      address    = COALESCE(p_address,  address),
      licences   = COALESCE(p_licences, licences),
      app_status = 'Completing Profile'
  WHERE profile_token = token
    AND archived_at IS NULL;
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION update_worker_via_token(UUID, TEXT, TEXT, TEXT) TO anon, authenticated;
