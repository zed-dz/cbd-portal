-- Inbound applicant pipeline. The marketing site / LinkedIn ad / portal /apply
-- page POST to the `submit-application` edge function, which uses service_role
-- to insert here. The table itself stays admin-read-only — anon callers never
-- touch it directly, so we don't leak past applicants' PII to the public.

CREATE TABLE IF NOT EXISTS worker_applications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT NOT NULL DEFAULT 'worker' CHECK (type IN ('worker','client')),
  full_name       TEXT NOT NULL,
  email           TEXT NOT NULL,
  phone           TEXT,
  message         TEXT,
  source          TEXT,
  status          TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','reviewing','approved','rejected','converted')),
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     TEXT,
  review_notes    TEXT,
  converted_worker_id UUID REFERENCES workers(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS worker_applications_status_idx ON worker_applications (status, created_at DESC);
CREATE INDEX IF NOT EXISTS worker_applications_email_idx  ON worker_applications (LOWER(email));

ALTER TABLE worker_applications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON worker_applications FROM anon;

DROP POLICY IF EXISTS "Auth users full access" ON worker_applications;
CREATE POLICY "Auth users full access"
  ON worker_applications FOR ALL
  TO authenticated
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE OR REPLACE FUNCTION touch_worker_applications_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS worker_applications_touch_updated_at ON worker_applications;
CREATE TRIGGER worker_applications_touch_updated_at
  BEFORE UPDATE ON worker_applications
  FOR EACH ROW EXECUTE FUNCTION touch_worker_applications_updated_at();

-- Idempotent convert: takes an application id, materialises a workers row
-- (or reuses an existing one matched by email), marks the application as
-- converted. Called by the "Convert to Worker" button on the admin page.
CREATE OR REPLACE FUNCTION approve_application_to_worker(p_application_id UUID, p_reviewer TEXT DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_app    worker_applications%ROWTYPE;
  v_worker_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Must be signed in to approve applications'; END IF;
  SELECT * INTO v_app FROM worker_applications WHERE id = p_application_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Application % not found', p_application_id; END IF;
  IF v_app.status = 'converted' THEN RETURN v_app.converted_worker_id; END IF;
  IF v_app.type <> 'worker' THEN
    RAISE EXCEPTION 'Only worker-type applications can be converted to workers (got %)', v_app.type;
  END IF;
  SELECT id INTO v_worker_id FROM workers WHERE LOWER(email) = LOWER(v_app.email) LIMIT 1;
  IF v_worker_id IS NULL THEN
    INSERT INTO workers (name, email, mobile, app_status, status)
    VALUES (v_app.full_name, v_app.email, v_app.phone, 'Profile Incomplete', 'available')
    RETURNING id INTO v_worker_id;
  END IF;
  UPDATE worker_applications
  SET status = 'converted', reviewed_at = NOW(),
      reviewed_by = COALESCE(p_reviewer, reviewed_by), converted_worker_id = v_worker_id
  WHERE id = p_application_id;
  RETURN v_worker_id;
END $$;
GRANT EXECUTE ON FUNCTION approve_application_to_worker(UUID, TEXT) TO authenticated;
