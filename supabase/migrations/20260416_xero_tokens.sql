-- Xero OAuth token storage (single row, id=1)
CREATE TABLE IF NOT EXISTS xero_tokens (
  id            INTEGER PRIMARY KEY DEFAULT 1,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  tenant_id     TEXT,
  scope         TEXT,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT single_row CHECK (id = 1)
);

ALTER TABLE xero_tokens ENABLE ROW LEVEL SECURITY;

-- Only authenticated admin users can read/write tokens
CREATE POLICY "Auth users full access" ON xero_tokens
  FOR ALL USING (auth.uid() IS NOT NULL);
