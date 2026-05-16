-- 2026-05-16 — Inbox upgrades: client email domains, templates, thread state.
-- Adds:
--   * clients.email_domains TEXT[]  — so anything @sydneywater.com.au matches Sydney Water
--   * email_threads.starred / archived  — local mirror of Gmail's STARRED / INBOX labels
--   * email_threads.matched_by_domain   — audit trail when domain match was used
--   * email_templates                   — reusable canned messages with {{placeholders}}

ALTER TABLE clients ADD COLUMN IF NOT EXISTS email_domains TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Seed email_domains from the existing contact_email so clients work today
-- without the user having to fill in domains by hand. Skip personal/consumer
-- domains so a stray gmail.com contact doesn't claim every consumer email.
UPDATE clients
SET email_domains = ARRAY[lower(split_part(contact_email, '@', 2))]
WHERE contact_email IS NOT NULL
  AND COALESCE(array_length(email_domains, 1), 0) = 0
  AND lower(split_part(contact_email, '@', 2)) NOT IN (
    'gmail.com','yahoo.com','yahoo.com.au','hotmail.com','hotmail.com.au',
    'outlook.com','outlook.com.au','icloud.com','live.com','protonmail.com',
    'me.com','aol.com','bigpond.com','bigpond.net.au','optusnet.com.au',
    'tpg.com.au','iinet.net.au'
  );

CREATE INDEX IF NOT EXISTS idx_clients_email_domains ON clients USING GIN (email_domains);

ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS starred  BOOLEAN DEFAULT FALSE;
ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE;
ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS matched_by_domain TEXT;

CREATE INDEX IF NOT EXISTS idx_email_threads_starred  ON email_threads (starred)  WHERE starred = TRUE;
CREATE INDEX IF NOT EXISTS idx_email_threads_archived ON email_threads (archived) WHERE archived = FALSE;

-- ── Email templates ─────────────────────────────────────────────────────────
-- Snippets with {{placeholder}} interpolation done client-side at compose time.
-- Body is plain text; we don't store rich HTML to keep the editor honest.
CREATE TABLE IF NOT EXISTS email_templates (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT         NOT NULL,
  subject     TEXT         NOT NULL,
  body        TEXT         NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE email_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth users email templates"
  ON email_templates FOR ALL
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

-- Seed a handful of common templates so the dropdown isn't empty on first run.
INSERT INTO email_templates (name, subject, body) VALUES
  (
    'Timesheet approved',
    'Your timesheet for week ending {{week_ending}} is approved',
    'Hi {{worker_name}},

Your timesheet for the week ending {{week_ending}} has been approved and is in for payroll.

If anything looks off, reply to this email and we''ll sort it.

Thanks,
CBD Plant & Labour'
  ),
  (
    'Allocation confirmed',
    'Allocation confirmed — {{job}} on {{date}}',
    'Hi {{worker_name}},

You''re confirmed for {{job}} on {{date}}.

Site:  {{site}}
Start: {{start_time}}

Reply here if anything changes — please give us as much notice as you can.

CBD Plant & Labour'
  ),
  (
    'Onboarding link',
    'Welcome to CBD Plant & Labour — complete your profile',
    'Hi {{worker_name}},

Welcome aboard. Please complete your onboarding profile here:

{{onboard_link}}

It''s about 5 minutes — mobile number, address, current tickets/licences. Once that''s in we can start putting you on shifts.

Any questions, just reply.

CBD Plant & Labour'
  ),
  (
    'Payslip ready',
    'Payslip ready — week ending {{week_ending}}',
    'Hi {{worker_name}},

Your payslip for week ending {{week_ending}} has been processed and the funds are on their way.

If you don''t see it in your account by end of business tomorrow, reply here.

CBD Plant & Labour'
  )
ON CONFLICT DO NOTHING;
