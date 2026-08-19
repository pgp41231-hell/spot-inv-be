CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_unique ON app_users(lower(email));

UPDATE app_users SET role='requester',updated_at=now()
WHERE role='admin' AND lower(email)<>'sportscomm@iiml.ac.in';
UPDATE app_users SET role='admin',updated_at=now()
WHERE lower(email)='sportscomm@iiml.ac.in';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_email_is_fixed') THEN
    ALTER TABLE app_users ADD CONSTRAINT admin_email_is_fixed
      CHECK (role <> 'admin' OR lower(email) = 'sportscomm@iiml.ac.in');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS user_passwords (
  user_id text PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS auth_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  email_pattern text NOT NULL,
  updated_by text REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO auth_settings(id,email_pattern)
VALUES(true,'^pgp\d{5}@iiml\.ac\.in$')
ON CONFLICT(id) DO NOTHING;
