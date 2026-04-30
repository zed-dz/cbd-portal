-- Job Roles: global reusable pool of role types
CREATE TABLE IF NOT EXISTS job_roles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE job_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Auth users full access" ON job_roles FOR ALL USING (auth.uid() IS NOT NULL);

-- Client Jobs: individual jobs/projects linked to a client
CREATE TABLE IF NOT EXISTS client_jobs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID REFERENCES clients(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT,
  site           TEXT,
  address        TEXT,
  start_date     DATE,
  end_date       DATE,
  status         TEXT DEFAULT 'active'
    CHECK (status IN ('active','on_hold','completed','cancelled')),
  required_roles TEXT[],
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE client_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Auth users full access" ON client_jobs FOR ALL USING (auth.uid() IS NOT NULL);

-- Seed common construction job roles
INSERT INTO job_roles (name) VALUES
  ('Excavator Operator'),('Dogman'),('Skilled Labourer'),('Leading Hand'),
  ('Foreman'),('Traffic Controller'),('Concretor'),('Rigger'),
  ('Crane Operator'),('Scaffolder'),('Plumber'),('Electrician'),
  ('Site Manager'),('Plant Operator'),('Truck Driver'),('Labourer')
ON CONFLICT (name) DO NOTHING;
