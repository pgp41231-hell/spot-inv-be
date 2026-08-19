-- Legacy deployments allowed multiple user rows with the same email. Merge
-- them before enforcing case-insensitive uniqueness. Historical audit rows are
-- deliberately left untouched because audit_log is append-only and actor_id is
-- not a foreign key.
DO $$
DECLARE
  duplicate_user record;
BEGIN
  FOR duplicate_user IN
    WITH ranked_users AS (
      SELECT
        id,
        first_value(id) OVER (
          PARTITION BY lower(trim(email))
          ORDER BY
            CASE WHEN id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN 0 ELSE 1 END,
            created_at,
            id
        ) AS keeper_id,
        row_number() OVER (
          PARTITION BY lower(trim(email))
          ORDER BY
            CASE WHEN id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN 0 ELSE 1 END,
            created_at,
            id
        ) AS position
      FROM app_users
    )
    SELECT id AS duplicate_id, keeper_id
    FROM ranked_users
    WHERE position > 1
  LOOP
    UPDATE approval_flow_steps SET approver_id=duplicate_user.keeper_id WHERE approver_id=duplicate_user.duplicate_id;
    UPDATE blackouts SET created_by=duplicate_user.keeper_id WHERE created_by=duplicate_user.duplicate_id;
    UPDATE bookings SET requester_id=duplicate_user.keeper_id WHERE requester_id=duplicate_user.duplicate_id;
    UPDATE booking_approvals SET approver_id=duplicate_user.keeper_id WHERE approver_id=duplicate_user.duplicate_id;
    UPDATE slot_holds SET held_by=duplicate_user.keeper_id WHERE held_by=duplicate_user.duplicate_id;
    DELETE FROM app_users WHERE id=duplicate_user.duplicate_id;
  END LOOP;

  UPDATE app_users SET email=lower(trim(email)) WHERE email IS DISTINCT FROM lower(trim(email));
END $$;

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
