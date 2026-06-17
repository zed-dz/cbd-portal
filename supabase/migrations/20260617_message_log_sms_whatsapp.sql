-- Extend message_log to cover SMS + WhatsApp (Twilio) blasts alongside the
-- existing email channels. Adds the channel enum value and a column for the
-- recipient's phone, mirroring recipient_email.

ALTER TABLE message_log DROP CONSTRAINT IF EXISTS message_log_channel_check;
ALTER TABLE message_log
  ADD CONSTRAINT message_log_channel_check
  CHECK (channel IN ('email','sms','gmail','whatsapp'));

ALTER TABLE message_log
  ADD COLUMN IF NOT EXISTS recipient_mobile text;

CREATE INDEX IF NOT EXISTS idx_message_log_recipient_mobile
  ON message_log (recipient_mobile);
