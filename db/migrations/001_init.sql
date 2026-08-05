CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS app_users (
  id text PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL,
  role text NOT NULL DEFAULT 'requester' CHECK (role IN ('requester','approver','scorekeeper','admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS venues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category text NOT NULL,
  location text,
  capacity integer NOT NULL CHECK (capacity > 0),
  amenities jsonb NOT NULL DEFAULT '[]'::jsonb,
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS equipment_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category text NOT NULL,
  location text,
  quantity integer NOT NULL CHECK (quantity > 0),
  condition text NOT NULL DEFAULT 'good' CHECK (condition IN ('excellent','good','fair','maintenance','retired')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approval_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  resource_type text NOT NULL CHECK (resource_type IN ('venue','equipment')),
  resource_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_default_flow
  ON approval_flows(resource_type) WHERE resource_id IS NULL AND active;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_resource_flow
  ON approval_flows(resource_type, resource_id) WHERE resource_id IS NOT NULL AND active;

CREATE TABLE IF NOT EXISTS approval_flow_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL REFERENCES approval_flows(id) ON DELETE CASCADE,
  step_order integer NOT NULL CHECK (step_order > 0),
  label text NOT NULL,
  required_role text NOT NULL DEFAULT 'approver' CHECK (required_role IN ('approver','admin')),
  approver_id text REFERENCES app_users(id),
  UNIQUE(flow_id, step_order)
);

CREATE TABLE IF NOT EXISTS blackouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type text NOT NULL CHECK (resource_type IN ('venue','equipment')),
  resource_id uuid,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  reason text NOT NULL,
  created_by text REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_at < end_at)
);

CREATE TABLE IF NOT EXISTS bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id text NOT NULL REFERENCES app_users(id),
  resource_type text NOT NULL CHECK (resource_type IN ('venue','equipment')),
  resource_id uuid NOT NULL,
  title text NOT NULL,
  purpose text,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled','completed')),
  current_approval_order integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_at < end_at)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'no_overlapping_venue_booking') THEN
    ALTER TABLE bookings ADD CONSTRAINT no_overlapping_venue_booking
      EXCLUDE USING gist (
        resource_id WITH =,
        tstzrange(start_at, end_at, '[)') WITH &&
      ) WHERE (resource_type = 'venue' AND status NOT IN ('cancelled','rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS bookings_requester_idx ON bookings(requester_id, start_at DESC);
CREATE INDEX IF NOT EXISTS bookings_resource_idx ON bookings(resource_type, resource_id, start_at);
CREATE INDEX IF NOT EXISTS bookings_pending_idx ON bookings(status, current_approval_order) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS booking_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  step_id uuid NOT NULL REFERENCES approval_flow_steps(id),
  step_order integer NOT NULL,
  approver_id text NOT NULL REFERENCES app_users(id),
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  comment text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(booking_id, step_id)
);

CREATE TABLE IF NOT EXISTS committee_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  title text NOT NULL,
  email text,
  phone text,
  responsibilities text,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gallery_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  event_name text,
  occurred_on date,
  media_url text NOT NULL,
  thumbnail_url text,
  caption text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tournaments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  starts_on date,
  ends_on date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','live','completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid REFERENCES tournaments(id) ON DELETE CASCADE,
  sport text NOT NULL,
  home_team text NOT NULL,
  away_team text NOT NULL,
  venue_id uuid REFERENCES venues(id),
  starts_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','completed','cancelled')),
  home_score jsonb NOT NULL DEFAULT '{}'::jsonb,
  away_score jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient text NOT NULL,
  template text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts integer NOT NULL DEFAULT 0,
  error text,
  send_after timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
