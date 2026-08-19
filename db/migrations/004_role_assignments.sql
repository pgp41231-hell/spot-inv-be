CREATE TABLE IF NOT EXISTS role_assignments (
  email text PRIMARY KEY CHECK (email = lower(email)),
  role text NOT NULL CHECK (role IN ('approver','scorekeeper')),
  updated_by text REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO role_assignments(email,role)
SELECT lower(email),role FROM app_users
WHERE role IN ('approver','scorekeeper')
ON CONFLICT(email) DO NOTHING;
