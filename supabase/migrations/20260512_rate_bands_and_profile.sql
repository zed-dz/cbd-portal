-- ============================================================================
-- 20260512: A/B/C rate bands + per-client per-role rate cards + shareable
--           worker profile tokens.
-- ============================================================================
-- Rate band model:
--   A = Normal time (Mon–Fri under 8h)
--   B = OT 1.5x — also covers Night-shift M–F <8h and Saturday day <8h
--   C = OT 2x   — Sat >8h, Sat night, all Sunday, all Public Holidays
-- ============================================================================

-- ── Workers: pay-rate bands ─────────────────────────────────────────────────
ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS pay_rate_a NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS pay_rate_b NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS pay_rate_c NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS profile_token UUID UNIQUE DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS profile_invite_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qualified BOOLEAN DEFAULT FALSE;

-- Backfill: copy old pay_rate_regular -> A, pay_rate_overtime -> B,
-- and derive C as 2x A when not yet set. (Idempotent: only fills NULLs.)
UPDATE workers
SET pay_rate_a = COALESCE(pay_rate_a, pay_rate_regular),
    pay_rate_b = COALESCE(pay_rate_b, pay_rate_overtime, pay_rate_regular * 1.5),
    pay_rate_c = COALESCE(pay_rate_c, pay_rate_regular * 2)
WHERE pay_rate_a IS NULL OR pay_rate_b IS NULL OR pay_rate_c IS NULL;

-- Ensure every existing worker has a profile token
UPDATE workers SET profile_token = gen_random_uuid() WHERE profile_token IS NULL;

CREATE INDEX IF NOT EXISTS workers_profile_token_idx ON workers(profile_token);

-- ── Clients: A/B/C bands (kept alongside old columns for backward compat) ──
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS rate_a NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS rate_b NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS rate_c NUMERIC(8,2);

UPDATE clients
SET rate_a = COALESCE(rate_a, rate_regular),
    rate_b = COALESCE(rate_b, rate_overtime, rate_night),
    rate_c = COALESCE(rate_c, rate_weekend, rate_overtime)
WHERE rate_a IS NULL OR rate_b IS NULL OR rate_c IS NULL;

-- ── Per-client per-role rate cards ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_rate_cards (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  role_name   TEXT NOT NULL,
  rate_a      NUMERIC(8,2),
  rate_b      NUMERIC(8,2),
  rate_c      NUMERIC(8,2),
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id, role_name)
);
ALTER TABLE client_rate_cards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Auth users full access" ON client_rate_cards;
CREATE POLICY "Auth users full access" ON client_rate_cards
  FOR ALL USING (auth.uid() IS NOT NULL);

CREATE INDEX IF NOT EXISTS client_rate_cards_client_idx ON client_rate_cards(client_id);

-- ── Public read-only profile RPC ────────────────────────────────────────────
-- Returns a safe subset of worker fields for a given profile_token. Anyone
-- holding the token (unguessable UUID) can view the public profile — but
-- pay rates, email, address, bank/super, ABN are deliberately excluded.
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
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION get_public_worker_profile(UUID) TO anon, authenticated;

-- ── Onboarding RPC: worker can self-update via their token ──────────────────
CREATE OR REPLACE FUNCTION update_worker_via_token(
  token       UUID,
  p_mobile    TEXT,
  p_address   TEXT,
  p_licences  TEXT
) RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER
AS $$
  UPDATE workers
  SET mobile   = COALESCE(p_mobile,   mobile),
      address  = COALESCE(p_address,  address),
      licences = COALESCE(p_licences, licences),
      app_status = CASE
        WHEN app_status IN ('Invite Sent','Profile Incomplete') THEN 'Completing Profile'
        ELSE app_status
      END
  WHERE profile_token = token
  RETURNING TRUE;
$$;

GRANT EXECUTE ON FUNCTION update_worker_via_token(UUID, TEXT, TEXT, TEXT) TO anon, authenticated;

-- Pin search_path on SECURITY DEFINER functions (prevents search-path hijacks).
ALTER FUNCTION get_public_worker_profile(UUID) SET search_path = public, pg_temp;
ALTER FUNCTION update_worker_via_token(UUID, TEXT, TEXT, TEXT) SET search_path = public, pg_temp;
