-- 2026-05-15 — Message history (bulk sends) + Gmail OAuth + threaded inbox.

-- ── Bulk message audit log ──────────────────────────────────────────────────
-- One row per recipient per send. The `batch_id` groups recipients sent
-- together so the UI can collapse them into a single "you emailed X people".
CREATE TABLE IF NOT EXISTS message_log (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id     UUID         NOT NULL,
  channel      TEXT         NOT NULL CHECK (channel IN ('email', 'sms', 'gmail')),
  audience     TEXT,                    -- 'workers' | 'clients' | 'mixed' | 'thread'
  recipient_id UUID,                    -- worker or client id (nullable for ad-hoc)
  recipient_name  TEXT,
  recipient_email TEXT,
  subject      TEXT,
  body         TEXT,
  status       TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'queued')),
  error        TEXT,
  sent_by      UUID,                    -- auth.uid() of admin who triggered the send
  sent_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_log_sent_at  ON message_log (sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_log_batch    ON message_log (batch_id);
CREATE INDEX IF NOT EXISTS idx_message_log_recipient ON message_log (recipient_email);

ALTER TABLE message_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth users read message log" ON message_log
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "Auth users insert message log" ON message_log
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- The edge function writes via service role, which bypasses RLS automatically.

-- ── Gmail OAuth tokens (single row, id=1) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS gmail_tokens (
  id            INTEGER PRIMARY KEY DEFAULT 1,
  email_address TEXT,                   -- the connected Gmail account
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  scope         TEXT,
  last_history_id TEXT,                 -- Gmail historyId for incremental sync
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT gmail_single_row CHECK (id = 1)
);

ALTER TABLE gmail_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth users gmail tokens" ON gmail_tokens
  FOR ALL USING (auth.uid() IS NOT NULL);

-- ── Inbox cache: threads + messages ────────────────────────────────────────
-- We mirror Gmail's structure: each "thread" is a conversation; each
-- "message" is one email in it. We cache locally so the UI doesn't pay an
-- API call per render, and so we can attach a worker/client link.
CREATE TABLE IF NOT EXISTS email_threads (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_thread_id TEXT UNIQUE,         -- Gmail's id; null for outgoing-only drafts
  subject        TEXT,
  participants   TEXT[],               -- flat list of emails seen in the thread
  last_message_at TIMESTAMPTZ,
  unread         BOOLEAN DEFAULT FALSE,
  worker_id      UUID REFERENCES workers(id) ON DELETE SET NULL,
  client_id      UUID REFERENCES clients(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_threads_last  ON email_threads (last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_threads_worker ON email_threads (worker_id);
CREATE INDEX IF NOT EXISTS idx_email_threads_client ON email_threads (client_id);

ALTER TABLE email_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Auth users email threads" ON email_threads
  FOR ALL USING (auth.uid() IS NOT NULL);

CREATE TABLE IF NOT EXISTS email_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id     UUID NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
  gmail_message_id TEXT UNIQUE,
  direction     TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_email    TEXT,
  from_name     TEXT,
  to_emails     TEXT[],
  cc_emails     TEXT[],
  subject       TEXT,
  body_text     TEXT,
  body_html     TEXT,
  snippet       TEXT,
  has_attachments BOOLEAN DEFAULT FALSE,
  sent_at       TIMESTAMPTZ,
  received_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_messages_thread ON email_messages (thread_id, sent_at);

ALTER TABLE email_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Auth users email messages" ON email_messages
  FOR ALL USING (auth.uid() IS NOT NULL);
