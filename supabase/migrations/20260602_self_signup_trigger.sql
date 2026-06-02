-- Self-signup trigger: when a new auth.users row is created, automatically
-- create a matching workers row. First signup ever → admin; everyone else
-- → employee. Admin can promote/demote later via the Workers page.

CREATE OR REPLACE FUNCTION handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  is_first_user BOOLEAN;
  display_name  TEXT;
BEGIN
  SELECT NOT EXISTS (SELECT 1 FROM workers) INTO is_first_user;

  display_name := COALESCE(
    NEW.raw_user_meta_data->>'name',
    NEW.raw_user_meta_data->>'full_name',
    split_part(NEW.email, '@', 1)
  );

  -- If admin pre-created a workers row by email, don't override it.
  IF EXISTS (SELECT 1 FROM workers WHERE lower(email) = lower(NEW.email)) THEN
    RETURN NEW;
  END IF;

  INSERT INTO workers (
    name, email, role, access_level, app_status, worker_type
  ) VALUES (
    display_name,
    NEW.email,
    'worker',
    CASE WHEN is_first_user THEN 'admin' ELSE 'employee' END,
    'Active',
    'casual'
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block auth signup on a workers-row insert failure.
  RAISE WARNING 'handle_new_auth_user failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_auth_user();
