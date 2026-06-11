-- Projects (formerly "client_jobs") now carry their own site contact, so a
-- client with 5 active projects can have 5 different on-site contacts.
ALTER TABLE client_jobs
  ADD COLUMN IF NOT EXISTS site_contact_name  TEXT,
  ADD COLUMN IF NOT EXISTS site_contact_email TEXT,
  ADD COLUMN IF NOT EXISTS site_contact_phone TEXT;

-- Rate cards become full Schedule-of-Rates line items, matching CBD's printed
-- SOR layout: every row has a Unit of Measure (Hour / Shift / Day / Ton /
-- Unit), an optional Category for grouping (Labour / Plant / Materials /
-- Attachments / Other), and A/B/C bands (B and C remain nullable so single-
-- rate items like Materials + Tipping work cleanly).
ALTER TABLE client_rate_cards
  ADD COLUMN IF NOT EXISTS uom       TEXT NOT NULL DEFAULT 'hour'
    CHECK (uom IN ('hour','shift','day','ton','unit','km','m3','m2','lm','each')),
  ADD COLUMN IF NOT EXISTS category  TEXT
    CHECK (category IS NULL OR category IN ('labour','plant','materials','attachments','allowances','other')),
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

-- Faster sort/filter when rendering the list grouped by category.
CREATE INDEX IF NOT EXISTS client_rate_cards_category_idx
  ON client_rate_cards (client_id, category, sort_order);
