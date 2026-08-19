-- Older deployments could create more than one app_users row for the same
-- email because authentication identities were accepted before email
-- uniqueness was enforced. Preserve the canonical user and its history before
-- adding the case-insensitive unique index. UUID-shaped IDs are preferred
-- because they normally correspond to the Supabase Auth identity; role and
-- creation time are deterministic fallbacks for legacy/demo users.
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
            CASE role WHEN 'admin' THEN 0 WHEN 'approver' THEN 1 WHEN 'scorekeeper' THEN 2 ELSE 3 END,
            created_at,
            id
        ) AS keeper_id,
        row_number() OVER (
          PARTITION BY lower(trim(email))
          ORDER BY
            CASE WHEN id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN 0 ELSE 1 END,
            CASE role WHEN 'admin' THEN 0 WHEN 'approver' THEN 1 WHEN 'scorekeeper' THEN 2 ELSE 3 END,
            created_at,
            id
        ) AS position
      FROM app_users
    )
    SELECT id AS duplicate_id, keeper_id
    FROM ranked_users
    WHERE position > 1
  LOOP
    UPDATE app_users keeper
    SET
      role = merged.role,
      name = CASE WHEN trim(keeper.name) = '' THEN merged.name ELSE keeper.name END,
      updated_at = greatest(keeper.updated_at, merged.updated_at)
    FROM (
      SELECT role, name, updated_at
      FROM app_users
      WHERE id IN (duplicate_user.keeper_id, duplicate_user.duplicate_id)
      ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'approver' THEN 1 WHEN 'scorekeeper' THEN 2 ELSE 3 END
      LIMIT 1
    ) merged
    WHERE keeper.id=duplicate_user.keeper_id;

    UPDATE approval_flow_steps SET approver_id=duplicate_user.keeper_id WHERE approver_id=duplicate_user.duplicate_id;
    UPDATE blackouts SET created_by=duplicate_user.keeper_id WHERE created_by=duplicate_user.duplicate_id;
    UPDATE bookings SET requester_id=duplicate_user.keeper_id WHERE requester_id=duplicate_user.duplicate_id;
    UPDATE booking_approvals SET approver_id=duplicate_user.keeper_id WHERE approver_id=duplicate_user.duplicate_id;
    UPDATE slot_holds SET held_by=duplicate_user.keeper_id WHERE held_by=duplicate_user.duplicate_id;
    UPDATE audit_log SET actor_id=duplicate_user.keeper_id WHERE actor_id=duplicate_user.duplicate_id;
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
