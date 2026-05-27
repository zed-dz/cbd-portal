-- Expanded worker onboarding (SiteMate-equivalent).
--
-- Non-sensitive data lives on `workers`. Sensitive data (TFN, bank, super,
-- medical) lives in separate tables with admin-only RLS — workers themselves
-- never get to read these back, and only users whose worker row has
-- access_level='admin' (and isn't archived) can SELECT/UPDATE them. The
-- onboarding RPC writes via SECURITY DEFINER so a worker can submit during
-- onboarding without ever being granted permanent read access.

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS date_of_birth date,
  ADD COLUMN IF NOT EXISTS gender text,
  ADD COLUMN IF NOT EXISTS alternate_phone text,
  ADD COLUMN IF NOT EXISTS postal_address text,
  ADD COLUMN IF NOT EXISTS drivers_licence_number text,
  ADD COLUMN IF NOT EXISTS drivers_licence_expiry date,
  ADD COLUMN IF NOT EXISTS citizenship_status text,
  ADD COLUMN IF NOT EXISTS visa_subclass text,
  ADD COLUMN IF NOT EXISTS visa_expiry date,
  ADD COLUMN IF NOT EXISTS claim_tax_free_threshold boolean,
  ADD COLUMN IF NOT EXISTS has_hecs_debt boolean,
  ADD COLUMN IF NOT EXISTS emergency_name text,
  ADD COLUMN IF NOT EXISTS emergency_relationship text,
  ADD COLUMN IF NOT EXISTS emergency_phone text,
  ADD COLUMN IF NOT EXISTS emergency_phone_alt text,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;

ALTER TABLE workers
  DROP CONSTRAINT IF EXISTS workers_citizenship_status_check;
ALTER TABLE workers
  ADD CONSTRAINT workers_citizenship_status_check
  CHECK (citizenship_status IS NULL OR citizenship_status IN ('citizen','permanent_resident','visa','other'));

-- Sensitive payroll details (TFN, bank, super) — separate table so RLS can
-- restrict reads independently of the workers row.
CREATE TABLE IF NOT EXISTS worker_payroll_details (
  worker_id            uuid PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
  tfn                  text,
  bank_account_name    text,
  bank_bsb             text,
  bank_account_number  text,
  super_fund_name      text,
  super_fund_usi       text,
  super_member_number  text,
  use_default_super    boolean DEFAULT false,
  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS worker_medical_details (
  worker_id        uuid PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
  blood_type       text,
  allergies        text,
  conditions       text,
  medications      text,
  gp_name          text,
  gp_phone         text,
  medicare_number  text,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

ALTER TABLE worker_payroll_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_medical_details ENABLE ROW LEVEL SECURITY;

-- Admin gate: user must have a non-archived worker row with access_level='admin'
-- matching their auth.jwt email.
DROP POLICY IF EXISTS payroll_admin_all ON worker_payroll_details;
CREATE POLICY payroll_admin_all ON worker_payroll_details
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM workers w
      WHERE lower(w.email) = lower(auth.jwt() ->> 'email')
        AND w.access_level = 'admin'
        AND w.archived_at IS NULL
    )
  )
  WITH CHECK (true);

DROP POLICY IF EXISTS medical_admin_all ON worker_medical_details;
CREATE POLICY medical_admin_all ON worker_medical_details
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM workers w
      WHERE lower(w.email) = lower(auth.jwt() ->> 'email')
        AND w.access_level = 'admin'
        AND w.archived_at IS NULL
    )
  )
  WITH CHECK (true);

-- Replace the old 4-arg RPC. SECURITY DEFINER lets the anon caller write to
-- workers + worker_payroll_details + worker_medical_details despite RLS.
DROP FUNCTION IF EXISTS update_worker_via_token(uuid, text, text, text);

CREATE OR REPLACE FUNCTION update_worker_via_token(
  token uuid,
  p_mobile                    text DEFAULT NULL,
  p_alternate_phone           text DEFAULT NULL,
  p_address                   text DEFAULT NULL,
  p_postal_address            text DEFAULT NULL,
  p_date_of_birth             date DEFAULT NULL,
  p_gender                    text DEFAULT NULL,
  p_drivers_licence_number    text DEFAULT NULL,
  p_drivers_licence_expiry    date DEFAULT NULL,
  p_citizenship_status        text DEFAULT NULL,
  p_visa_subclass             text DEFAULT NULL,
  p_visa_expiry               date DEFAULT NULL,
  p_claim_tax_free_threshold  boolean DEFAULT NULL,
  p_has_hecs_debt             boolean DEFAULT NULL,
  p_emergency_name            text DEFAULT NULL,
  p_emergency_relationship    text DEFAULT NULL,
  p_emergency_phone           text DEFAULT NULL,
  p_emergency_phone_alt       text DEFAULT NULL,
  p_licences                  text DEFAULT NULL,
  p_tfn                       text DEFAULT NULL,
  p_bank_account_name         text DEFAULT NULL,
  p_bank_bsb                  text DEFAULT NULL,
  p_bank_account_number       text DEFAULT NULL,
  p_super_fund_name           text DEFAULT NULL,
  p_super_fund_usi            text DEFAULT NULL,
  p_super_member_number       text DEFAULT NULL,
  p_use_default_super         boolean DEFAULT NULL,
  p_blood_type                text DEFAULT NULL,
  p_allergies                 text DEFAULT NULL,
  p_conditions                text DEFAULT NULL,
  p_medications               text DEFAULT NULL,
  p_gp_name                   text DEFAULT NULL,
  p_gp_phone                  text DEFAULT NULL,
  p_medicare_number           text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  w_id uuid;
BEGIN
  SELECT id INTO w_id FROM workers
  WHERE profile_token = token AND archived_at IS NULL
  LIMIT 1;

  IF w_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE workers SET
    mobile                    = COALESCE(p_mobile,                    mobile),
    alternate_phone           = COALESCE(p_alternate_phone,           alternate_phone),
    address                   = COALESCE(p_address,                   address),
    postal_address            = COALESCE(p_postal_address,            postal_address),
    date_of_birth             = COALESCE(p_date_of_birth,             date_of_birth),
    gender                    = COALESCE(p_gender,                    gender),
    drivers_licence_number    = COALESCE(p_drivers_licence_number,    drivers_licence_number),
    drivers_licence_expiry    = COALESCE(p_drivers_licence_expiry,    drivers_licence_expiry),
    citizenship_status        = COALESCE(p_citizenship_status,        citizenship_status),
    visa_subclass             = COALESCE(p_visa_subclass,             visa_subclass),
    visa_expiry               = COALESCE(p_visa_expiry,               visa_expiry),
    claim_tax_free_threshold  = COALESCE(p_claim_tax_free_threshold,  claim_tax_free_threshold),
    has_hecs_debt             = COALESCE(p_has_hecs_debt,             has_hecs_debt),
    emergency_name            = COALESCE(p_emergency_name,            emergency_name),
    emergency_relationship    = COALESCE(p_emergency_relationship,    emergency_relationship),
    emergency_phone           = COALESCE(p_emergency_phone,           emergency_phone),
    emergency_phone_alt       = COALESCE(p_emergency_phone_alt,       emergency_phone_alt),
    licences                  = COALESCE(p_licences,                  licences),
    app_status                = 'Completing Profile',
    onboarding_completed_at   = NOW()
  WHERE id = w_id;

  INSERT INTO worker_payroll_details AS pd (
    worker_id, tfn, bank_account_name, bank_bsb, bank_account_number,
    super_fund_name, super_fund_usi, super_member_number, use_default_super
  ) VALUES (
    w_id, p_tfn, p_bank_account_name, p_bank_bsb, p_bank_account_number,
    p_super_fund_name, p_super_fund_usi, p_super_member_number,
    COALESCE(p_use_default_super, false)
  )
  ON CONFLICT (worker_id) DO UPDATE SET
    tfn                  = COALESCE(EXCLUDED.tfn,                  pd.tfn),
    bank_account_name    = COALESCE(EXCLUDED.bank_account_name,    pd.bank_account_name),
    bank_bsb             = COALESCE(EXCLUDED.bank_bsb,             pd.bank_bsb),
    bank_account_number  = COALESCE(EXCLUDED.bank_account_number,  pd.bank_account_number),
    super_fund_name      = COALESCE(EXCLUDED.super_fund_name,      pd.super_fund_name),
    super_fund_usi       = COALESCE(EXCLUDED.super_fund_usi,       pd.super_fund_usi),
    super_member_number  = COALESCE(EXCLUDED.super_member_number,  pd.super_member_number),
    use_default_super    = COALESCE(EXCLUDED.use_default_super,    pd.use_default_super),
    updated_at           = NOW();

  INSERT INTO worker_medical_details AS md (
    worker_id, blood_type, allergies, conditions, medications,
    gp_name, gp_phone, medicare_number
  ) VALUES (
    w_id, p_blood_type, p_allergies, p_conditions, p_medications,
    p_gp_name, p_gp_phone, p_medicare_number
  )
  ON CONFLICT (worker_id) DO UPDATE SET
    blood_type       = COALESCE(EXCLUDED.blood_type,       md.blood_type),
    allergies        = COALESCE(EXCLUDED.allergies,        md.allergies),
    conditions       = COALESCE(EXCLUDED.conditions,       md.conditions),
    medications      = COALESCE(EXCLUDED.medications,      md.medications),
    gp_name          = COALESCE(EXCLUDED.gp_name,          md.gp_name),
    gp_phone         = COALESCE(EXCLUDED.gp_phone,         md.gp_phone),
    medicare_number  = COALESCE(EXCLUDED.medicare_number,  md.medicare_number),
    updated_at       = NOW();

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION update_worker_via_token(
  uuid, text, text, text, text, date, text, text, date,
  text, text, date, boolean, boolean,
  text, text, text, text,
  text,
  text, text, text, text, text, text, text, boolean,
  text, text, text, text, text, text, text
) TO anon, authenticated;
