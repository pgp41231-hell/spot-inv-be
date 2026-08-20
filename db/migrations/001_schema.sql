-- Courtyard final-state schema for a fresh Supabase project.
-- This baseline intentionally contains no legacy upgrade or deduplication SQL.

CREATE SCHEMA IF NOT EXISTS public;
GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
GRANT ALL ON SCHEMA public TO postgres,service_role;
SET search_path TO public,extensions;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS private;

-- Authentication profiles and local-development authentication fallback.
CREATE TABLE IF NOT EXISTS app_users (
  id text PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL,
  role text NOT NULL DEFAULT 'requester'
    CHECK (role IN ('requester','approver','scorekeeper','admin','inventory_kiosk')),
  must_change_password boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_email_is_fixed CHECK (role <> 'admin' OR lower(email)='sports@iiml.ac.in')
);

-- This baseline is intentionally rerun on deploy. Correct installations that
-- were previously created with sportscomm@iiml.ac.in as the fixed admin.
ALTER TABLE app_users DROP CONSTRAINT IF EXISTS admin_email_is_fixed;
UPDATE app_users
SET role='requester',must_change_password=false,updated_at=now()
WHERE lower(email)='sportscomm@iiml.ac.in';
UPDATE app_users
SET must_change_password=CASE WHEN role<>'admin' THEN true ELSE must_change_password END,
    role='admin',updated_at=now()
WHERE lower(email)='sports@iiml.ac.in';
ALTER TABLE app_users ADD CONSTRAINT admin_email_is_fixed
CHECK (role <> 'admin' OR lower(email)='sports@iiml.ac.in');

CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_unique ON app_users(lower(email));

CREATE TABLE IF NOT EXISTS role_assignments (
  email text PRIMARY KEY CHECK (email=lower(email)),
  role text NOT NULL CHECK (role IN ('approver','scorekeeper')),
  updated_by text REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

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

-- Sports, teams, venues, and equipment inventory.
CREATE TABLE IF NOT EXISTS sports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by text REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sports_name_unique ON sports(lower(name));

CREATE TABLE IF NOT EXISTS campus_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by text REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS campus_locations_name_unique ON campus_locations(lower(name));

CREATE TABLE IF NOT EXISTS venues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  sport_id uuid REFERENCES sports(id),
  category text NOT NULL DEFAULT 'Sports venue',
  location text,
  location_id uuid REFERENCES campus_locations(id),
  photo_path text,
  capacity integer NOT NULL DEFAULT 1 CHECK (capacity > 0),
  amenities jsonb NOT NULL DEFAULT '[]'::jsonb,
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS venues_sport_id_idx ON venues(sport_id);

CREATE TABLE IF NOT EXISTS equipment_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  sport_id uuid NOT NULL REFERENCES sports(id),
  photo_path text,
  quantity integer NOT NULL CHECK (quantity >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  tracking text NOT NULL DEFAULT 'BULK' CHECK (tracking IN ('ASSET','BULK')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS equipment_items_name_unique ON equipment_items(lower(name));

CREATE TABLE IF NOT EXISTS equipment_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id uuid NOT NULL REFERENCES equipment_items(id) ON DELETE CASCADE,
  asset_tag text NOT NULL UNIQUE,
  serial_number text,
  condition text NOT NULL DEFAULT 'good'
    CHECK (condition IN ('excellent','good','fair','maintenance','retired')),
  state text NOT NULL DEFAULT 'IN_INVENTORY'
    CHECK (state IN ('IN_INVENTORY','CASUAL_POOL','ISSUED_TO_STUDENT','HELD_BY_TEAM','DAMAGED','MISSING')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS equipment_assets_equipment_state_idx ON equipment_assets(equipment_id,state);

CREATE TABLE IF NOT EXISTS equipment_allocations (
  equipment_id uuid PRIMARY KEY REFERENCES equipment_items(id) ON DELETE CASCADE,
  casual_allocated_quantity integer NOT NULL DEFAULT 0 CHECK (casual_allocated_quantity >= 0),
  updated_by text REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sport_pocs (
  sport_id uuid PRIMARY KEY REFERENCES sports(id) ON DELETE CASCADE,
  primary_poc_id text REFERENCES app_users(id),
  secondary_poc_id text REFERENCES app_users(id),
  updated_by text REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (secondary_poc_id IS NULL OR secondary_poc_id IS DISTINCT FROM primary_poc_id)
);

CREATE TABLE IF NOT EXISTS teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  sport_id uuid NOT NULL REFERENCES sports(id),
  captain_id text NOT NULL REFERENCES app_users(id),
  active boolean NOT NULL DEFAULT true,
  created_by text REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(sport_id,name)
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(team_id,user_id)
);

-- Equipment requests, physical custody, QR redemption, and custody audit.
CREATE TABLE IF NOT EXISTS equipment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_type text NOT NULL CHECK (request_type IN ('CASUAL','TEAM','RETURN')),
  requester_id text NOT NULL REFERENCES app_users(id),
  team_id uuid REFERENCES teams(id),
  sport_id uuid REFERENCES sports(id),
  parent_request_id uuid REFERENCES equipment_requests(id),
  expected_return_at timestamptz,
  due_at timestamptz,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','REJECTED','ISSUED','RETURN_PENDING','COMPLETED')),
  decision_note text,
  approved_by text REFERENCES app_users(id),
  approved_at timestamptz,
  administrator_override boolean NOT NULL DEFAULT false,
  allow_concurrent_issue boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (request_type='CASUAL' AND team_id IS NULL AND sport_id IS NULL AND expected_return_at IS NOT NULL AND parent_request_id IS NULL)
    OR (request_type='TEAM' AND team_id IS NOT NULL AND sport_id IS NOT NULL AND expected_return_at IS NULL AND parent_request_id IS NULL)
    OR (request_type='RETURN' AND parent_request_id IS NOT NULL)
  )
);
ALTER TABLE equipment_requests ADD COLUMN IF NOT EXISTS allow_concurrent_issue boolean NOT NULL DEFAULT false;
DROP INDEX IF EXISTS one_active_casual_issue_per_student;
CREATE UNIQUE INDEX one_active_casual_issue_per_student
  ON equipment_requests(requester_id)
  WHERE request_type='CASUAL' AND status IN ('ISSUED','RETURN_PENDING') AND NOT allow_concurrent_issue;
CREATE INDEX IF NOT EXISTS equipment_requests_requester_idx ON equipment_requests(requester_id,created_at DESC);
CREATE INDEX IF NOT EXISTS equipment_requests_sport_status_idx ON equipment_requests(sport_id,status,created_at);

CREATE TABLE IF NOT EXISTS equipment_request_items (
  request_id uuid NOT NULL REFERENCES equipment_requests(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES equipment_items(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY(request_id,equipment_id)
);

CREATE TABLE IF NOT EXISTS equipment_custody (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id uuid NOT NULL REFERENCES equipment_items(id),
  asset_id uuid REFERENCES equipment_assets(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  state text NOT NULL CHECK (state IN ('ISSUED_TO_STUDENT','HELD_BY_TEAM','DAMAGED','MISSING')),
  student_id text REFERENCES app_users(id),
  team_id uuid REFERENCES teams(id),
  source_request_id uuid REFERENCES equipment_requests(id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (state='ISSUED_TO_STUDENT' AND student_id IS NOT NULL AND team_id IS NULL)
    OR (state='HELD_BY_TEAM' AND team_id IS NOT NULL AND student_id IS NULL)
    OR (state IN ('DAMAGED','MISSING') AND NOT (student_id IS NOT NULL AND team_id IS NOT NULL))
  )
);
CREATE INDEX IF NOT EXISTS equipment_custody_equipment_idx ON equipment_custody(equipment_id,state);
CREATE INDEX IF NOT EXISTS equipment_custody_student_idx ON equipment_custody(student_id,state);
CREATE INDEX IF NOT EXISTS equipment_custody_team_idx ON equipment_custody(team_id,state);

CREATE TABLE IF NOT EXISTS equipment_qr_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES equipment_requests(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('ISSUE','RETURN')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by text REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS equipment_qr_request_idx ON equipment_qr_tokens(request_id,created_at DESC);

CREATE TABLE IF NOT EXISTS equipment_state_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id uuid NOT NULL REFERENCES equipment_items(id),
  asset_id uuid REFERENCES equipment_assets(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  from_state text NOT NULL
    CHECK (from_state IN ('IN_INVENTORY','CASUAL_POOL','ISSUED_TO_STUDENT','HELD_BY_TEAM','DAMAGED','MISSING')),
  to_state text NOT NULL
    CHECK (to_state IN ('IN_INVENTORY','CASUAL_POOL','ISSUED_TO_STUDENT','HELD_BY_TEAM','DAMAGED','MISSING')),
  actor_id text NOT NULL REFERENCES app_users(id),
  request_id uuid REFERENCES equipment_requests(id),
  person_id text REFERENCES app_users(id),
  team_id uuid REFERENCES teams(id),
  note text,
  manual_override boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS equipment_state_audit_filters_idx
  ON equipment_state_audit(equipment_id,person_id,created_at DESC);

-- Venue booking, holds, approval compatibility, and general portal content.
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
  ON approval_flows(resource_type,resource_id) WHERE resource_id IS NOT NULL AND active;

CREATE TABLE IF NOT EXISTS approval_flow_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL REFERENCES approval_flows(id) ON DELETE CASCADE,
  step_order integer NOT NULL CHECK (step_order > 0),
  label text NOT NULL,
  required_role text NOT NULL DEFAULT 'approver' CHECK (required_role IN ('approver','admin')),
  approver_id text REFERENCES app_users(id),
  UNIQUE(flow_id,step_order)
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
  status text NOT NULL DEFAULT 'approved'
    CHECK (status IN ('pending','approved','rejected','cancelled','completed')),
  current_approval_order integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_at < end_at),
  CONSTRAINT no_overlapping_venue_booking EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(start_at,end_at,'[)') WITH &&
  ) WHERE (resource_type='venue' AND status NOT IN ('cancelled','rejected')),
  CONSTRAINT no_overlapping_requester_venue_booking EXCLUDE USING gist (
    requester_id WITH =,
    tstzrange(start_at,end_at,'[)') WITH &&
  ) WHERE (resource_type='venue' AND status NOT IN ('cancelled','rejected'))
);
CREATE INDEX IF NOT EXISTS bookings_requester_idx ON bookings(requester_id,start_at DESC);
CREATE INDEX IF NOT EXISTS bookings_resource_idx ON bookings(resource_type,resource_id,start_at);
CREATE INDEX IF NOT EXISTS bookings_pending_idx ON bookings(status,current_approval_order) WHERE status='pending';

CREATE TABLE IF NOT EXISTS booking_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  step_id uuid NOT NULL REFERENCES approval_flow_steps(id),
  step_order integer NOT NULL,
  approver_id text NOT NULL REFERENCES app_users(id),
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  comment text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(booking_id,step_id)
);

CREATE TABLE IF NOT EXISTS slot_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type text NOT NULL CHECK (resource_type IN ('venue','equipment')),
  resource_id uuid NOT NULL,
  held_by text NOT NULL REFERENCES app_users(id),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_at < end_at)
);
CREATE INDEX IF NOT EXISTS slot_holds_active_idx
  ON slot_holds(resource_type,resource_id,expires_at) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS slot_holds_holder_idx
  ON slot_holds(held_by,expires_at) WHERE released_at IS NULL;

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

-- Additive columns for the frontend's Fixtures/Tournaments/Committee module:
-- multi-sport committee tags, a tournament's venue and one-line blurb (for
-- its gallery card), and linking a gallery photo to the tournament it was
-- taken at. ADD COLUMN IF NOT EXISTS keeps this safe to run against an
-- already-deployed database, not just a fresh one — same idempotency
-- guarantee as every other statement in this baseline.
ALTER TABLE committee_members ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS blurb text;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS venue text;
ALTER TABLE gallery_items ADD COLUMN IF NOT EXISTS tournament_id uuid REFERENCES tournaments(id) ON DELETE CASCADE;
-- `venue_id` links to a real bookable venue record; `venue` is a plain-text
-- fallback (e.g. "Indoor Court 2") for grounds/venues that aren't in the
-- venues table (or haven't been matched up yet) but still need a label on
-- the fixture card. `stage` is the round/bracket label (e.g. "Men's Singles
-- - Semifinal"), separate from `notes` (a live-match note or final result).
ALTER TABLE matches ADD COLUMN IF NOT EXISTS venue text;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS stage text;

-- Section-wise points standings per tournament (e.g. Sangram's Section A-I
-- table, one row per section/sport pair). Previously had no backend
-- equivalent at all — the frontend invented the numbers locally.
CREATE TABLE IF NOT EXISTS standings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  section text NOT NULL,
  sport text NOT NULL,
  points integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, section, sport)
);
CREATE INDEX IF NOT EXISTS standings_tournament_idx ON standings(tournament_id);

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

-- Supabase Auth profile synchronization and email eligibility.
CREATE OR REPLACE FUNCTION private.current_app_role()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$ SELECT role FROM public.app_users WHERE id=(SELECT auth.uid())::text $$;

CREATE OR REPLACE FUNCTION private.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$ SELECT EXISTS(
  SELECT 1 FROM public.app_users
  WHERE id=(SELECT auth.uid())::text AND role='admin' AND lower(email)='sports@iiml.ac.in'
) $$;

CREATE OR REPLACE FUNCTION private.owns_equipment_request(target_request uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$ SELECT EXISTS(
  SELECT 1 FROM public.equipment_requests
  WHERE id=target_request AND requester_id=(SELECT auth.uid())::text
) $$;

CREATE OR REPLACE FUNCTION public.handle_sports_user_created()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE assigned_role text;
BEGIN
  SELECT role INTO assigned_role FROM public.role_assignments WHERE email=lower(NEW.email);
  INSERT INTO public.app_users(id,email,name,role,must_change_password)
  VALUES(
    NEW.id::text,
    lower(NEW.email),
    COALESCE(NULLIF(NEW.raw_user_meta_data->>'name',''),split_part(NEW.email,'@',1)),
    CASE WHEN lower(NEW.email)='sports@iiml.ac.in' THEN 'admin' ELSE COALESCE(assigned_role,'requester') END,
    lower(NEW.email)='sports@iiml.ac.in'
  )
  ON CONFLICT(id) DO UPDATE SET
    email=EXCLUDED.email,
    name=EXCLUDED.name,
    role=CASE
      WHEN lower(EXCLUDED.email)='sports@iiml.ac.in' THEN 'admin'
      WHEN app_users.role='admin' THEN 'requester'
      ELSE app_users.role
    END,
    updated_at=now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.enforce_sports_email_rule()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE allowed_pattern text;
BEGIN
  IF lower(NEW.email) IN ('sports@iiml.ac.in','inventory@iiml.ac.in') THEN RETURN NEW; END IF;
  SELECT email_pattern INTO allowed_pattern FROM public.auth_settings WHERE id=true;
  IF NEW.email IS NULL OR lower(NEW.email) !~* COALESCE(allowed_pattern,'^pgp\d{5}@iiml\.ac\.in$') THEN
    RAISE EXCEPTION 'Email is not eligible for this portal';
  END IF;
  RETURN NEW;
END $$;

INSERT INTO app_users(id,email,name,role,must_change_password)
SELECT
  user_record.id::text,
  lower(user_record.email),
  COALESCE(NULLIF(user_record.raw_user_meta_data->>'name',''),split_part(user_record.email,'@',1)),
  CASE WHEN lower(user_record.email)='sports@iiml.ac.in' THEN 'admin' ELSE COALESCE(assignment.role,'requester') END,
  false
FROM auth.users user_record
LEFT JOIN role_assignments assignment ON assignment.email=lower(user_record.email)
WHERE user_record.email IS NOT NULL
ON CONFLICT(id) DO UPDATE SET
  email=EXCLUDED.email,
  name=EXCLUDED.name,
  role=CASE
    WHEN lower(EXCLUDED.email)='sports@iiml.ac.in' THEN 'admin'
    WHEN app_users.role='admin' THEN 'requester'
    ELSE app_users.role
  END,
  updated_at=now();

DROP TRIGGER IF EXISTS sports_user_created ON auth.users;
CREATE TRIGGER sports_user_created
AFTER INSERT OR UPDATE OF email,raw_user_meta_data ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_sports_user_created();

DROP TRIGGER IF EXISTS sports_email_rule ON auth.users;
CREATE TRIGGER sports_email_rule
BEFORE INSERT OR UPDATE OF email ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.enforce_sports_email_rule();

-- Append-only audit protection.
CREATE OR REPLACE FUNCTION public.prevent_audit_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_mutation();

CREATE OR REPLACE FUNCTION public.prevent_equipment_audit_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'equipment_state_audit is append-only'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS equipment_state_audit_no_update ON equipment_state_audit;
CREATE TRIGGER equipment_state_audit_no_update BEFORE UPDATE OR DELETE ON equipment_state_audit
FOR EACH ROW EXECUTE FUNCTION public.prevent_equipment_audit_mutation();

-- Row-level security. The API normally uses the server connection; these rules
-- also protect direct Supabase Data API access.
ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sports ENABLE ROW LEVEL SECURITY;
ALTER TABLE sport_pocs ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE venues ENABLE ROW LEVEL SECURITY;
ALTER TABLE campus_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_request_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_custody ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_qr_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_state_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_self_or_admin ON app_users;
CREATE POLICY profiles_self_or_admin ON app_users FOR SELECT TO authenticated
USING (id=(SELECT auth.uid())::text OR (SELECT private.is_admin()));
DROP POLICY IF EXISTS admin_role_assignments ON role_assignments;
CREATE POLICY admin_role_assignments ON role_assignments FOR ALL TO authenticated
USING ((SELECT private.is_admin())) WITH CHECK ((SELECT private.is_admin()));
DROP POLICY IF EXISTS admin_auth_settings ON auth_settings;
CREATE POLICY admin_auth_settings ON auth_settings FOR ALL TO authenticated
USING ((SELECT private.is_admin())) WITH CHECK ((SELECT private.is_admin()));

DROP POLICY IF EXISTS authenticated_read_sports ON sports;
CREATE POLICY authenticated_read_sports ON sports FOR SELECT TO authenticated
USING (active OR (SELECT private.is_admin()));
DROP POLICY IF EXISTS admin_manage_sports ON sports;
CREATE POLICY admin_manage_sports ON sports FOR ALL TO authenticated
USING ((SELECT private.is_admin())) WITH CHECK ((SELECT private.is_admin()));
DROP POLICY IF EXISTS authenticated_read_pocs ON sport_pocs;
CREATE POLICY authenticated_read_pocs ON sport_pocs FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS admin_manage_pocs ON sport_pocs;
CREATE POLICY admin_manage_pocs ON sport_pocs FOR ALL TO authenticated
USING ((SELECT private.is_admin())) WITH CHECK ((SELECT private.is_admin()));
DROP POLICY IF EXISTS team_visibility ON teams;
CREATE POLICY team_visibility ON teams FOR SELECT TO authenticated
USING (active OR captain_id=(SELECT auth.uid())::text OR (SELECT private.is_admin()));
DROP POLICY IF EXISTS admin_manage_teams ON teams;
CREATE POLICY admin_manage_teams ON teams FOR ALL TO authenticated
USING ((SELECT private.is_admin())) WITH CHECK ((SELECT private.is_admin()));
DROP POLICY IF EXISTS team_member_visibility ON team_members;
CREATE POLICY team_member_visibility ON team_members FOR SELECT TO authenticated
USING (user_id=(SELECT auth.uid())::text OR team_id IN (
  SELECT id FROM teams WHERE captain_id=(SELECT auth.uid())::text
) OR (SELECT private.is_admin()));
DROP POLICY IF EXISTS admin_manage_team_members ON team_members;
CREATE POLICY admin_manage_team_members ON team_members FOR ALL TO authenticated
USING ((SELECT private.is_admin())) WITH CHECK ((SELECT private.is_admin()));

DROP POLICY IF EXISTS authenticated_read_venues ON venues;
CREATE POLICY authenticated_read_venues ON venues FOR SELECT TO authenticated USING (active OR (SELECT private.is_admin()));
DROP POLICY IF EXISTS admin_manage_venues ON venues;
CREATE POLICY admin_manage_venues ON venues FOR ALL TO authenticated
USING ((SELECT private.is_admin())) WITH CHECK ((SELECT private.is_admin()));
DROP POLICY IF EXISTS authenticated_read_locations ON campus_locations;
CREATE POLICY authenticated_read_locations ON campus_locations FOR SELECT TO authenticated
USING (active OR (SELECT private.is_admin()));
DROP POLICY IF EXISTS admin_manage_locations ON campus_locations;
CREATE POLICY admin_manage_locations ON campus_locations FOR ALL TO authenticated
USING ((SELECT private.is_admin())) WITH CHECK ((SELECT private.is_admin()));
DROP POLICY IF EXISTS authenticated_read_equipment ON equipment_items;
CREATE POLICY authenticated_read_equipment ON equipment_items FOR SELECT TO authenticated
USING (active OR (SELECT private.is_admin()));
DROP POLICY IF EXISTS admin_manage_equipment ON equipment_items;
CREATE POLICY admin_manage_equipment ON equipment_items FOR ALL TO authenticated
USING ((SELECT private.is_admin())) WITH CHECK ((SELECT private.is_admin()));
DROP POLICY IF EXISTS equipment_assets_staff_read ON equipment_assets;
CREATE POLICY equipment_assets_staff_read ON equipment_assets FOR SELECT TO authenticated
USING ((SELECT private.current_app_role()) IN ('approver','inventory_kiosk','admin'));
DROP POLICY IF EXISTS equipment_assets_kiosk_update ON equipment_assets;
CREATE POLICY equipment_assets_kiosk_update ON equipment_assets FOR UPDATE TO authenticated
USING ((SELECT private.current_app_role()) IN ('inventory_kiosk','admin'))
WITH CHECK ((SELECT private.current_app_role()) IN ('inventory_kiosk','admin'));
DROP POLICY IF EXISTS equipment_allocation_staff_read ON equipment_allocations;
CREATE POLICY equipment_allocation_staff_read ON equipment_allocations FOR SELECT TO authenticated
USING ((SELECT private.current_app_role()) IN ('approver','admin'));
DROP POLICY IF EXISTS equipment_allocation_admin_manage ON equipment_allocations;
CREATE POLICY equipment_allocation_admin_manage ON equipment_allocations FOR ALL TO authenticated
USING ((SELECT private.is_admin())) WITH CHECK ((SELECT private.is_admin()));

DROP POLICY IF EXISTS request_visibility ON equipment_requests;
CREATE POLICY request_visibility ON equipment_requests FOR SELECT TO authenticated
USING (
  requester_id=(SELECT auth.uid())::text
  OR (SELECT private.current_app_role()) IN ('approver','inventory_kiosk','admin')
);
DROP POLICY IF EXISTS students_create_own_requests ON equipment_requests;
CREATE POLICY students_create_own_requests ON equipment_requests FOR INSERT TO authenticated
WITH CHECK (
  requester_id=(SELECT auth.uid())::text AND (
    request_type='CASUAL'
    OR (request_type='TEAM' AND team_id IN (SELECT id FROM teams WHERE captain_id=(SELECT auth.uid())::text))
    OR (request_type='RETURN' AND (SELECT private.owns_equipment_request(parent_request_id)))
  )
);
DROP POLICY IF EXISTS equipment_request_staff_decision ON equipment_requests;
CREATE POLICY equipment_request_staff_decision ON equipment_requests FOR UPDATE TO authenticated
USING (
  status='PENDING' AND (
    (SELECT private.is_admin())
    OR ((SELECT private.current_app_role())='approver' AND request_type='CASUAL')
    OR ((SELECT private.current_app_role())='approver' AND request_type='TEAM' AND EXISTS (
      SELECT 1 FROM sport_pocs poc
      WHERE poc.sport_id=equipment_requests.sport_id
      AND (poc.primary_poc_id=(SELECT auth.uid())::text OR poc.secondary_poc_id=(SELECT auth.uid())::text)
    ))
  )
) WITH CHECK ((SELECT private.is_admin()) OR (SELECT private.current_app_role())='approver');
DROP POLICY IF EXISTS request_items_visibility ON equipment_request_items;
CREATE POLICY request_items_visibility ON equipment_request_items FOR SELECT TO authenticated
USING (request_id IN (SELECT id FROM equipment_requests));
DROP POLICY IF EXISTS students_create_request_items ON equipment_request_items;
CREATE POLICY students_create_request_items ON equipment_request_items FOR INSERT TO authenticated
WITH CHECK (request_id IN (
  SELECT id FROM equipment_requests
  WHERE requester_id=(SELECT auth.uid())::text
  AND (status='PENDING' OR (status='APPROVED' AND request_type='RETURN'))
));
DROP POLICY IF EXISTS custody_visibility ON equipment_custody;
CREATE POLICY custody_visibility ON equipment_custody FOR SELECT TO authenticated
USING (
  student_id=(SELECT auth.uid())::text
  OR team_id IN (SELECT id FROM teams WHERE captain_id=(SELECT auth.uid())::text)
  OR (SELECT private.current_app_role()) IN ('approver','inventory_kiosk','admin')
);
DROP POLICY IF EXISTS equipment_custody_kiosk_manage ON equipment_custody;
CREATE POLICY equipment_custody_kiosk_manage ON equipment_custody FOR ALL TO authenticated
USING ((SELECT private.current_app_role()) IN ('inventory_kiosk','admin'))
WITH CHECK ((SELECT private.current_app_role()) IN ('inventory_kiosk','admin'));
DROP POLICY IF EXISTS token_visibility ON equipment_qr_tokens;
CREATE POLICY token_visibility ON equipment_qr_tokens FOR SELECT TO authenticated
USING (
  request_id IN (SELECT id FROM equipment_requests WHERE requester_id=(SELECT auth.uid())::text)
  OR (SELECT private.current_app_role()) IN ('inventory_kiosk','admin')
);
DROP POLICY IF EXISTS equipment_audit_staff_visibility ON equipment_state_audit;
CREATE POLICY equipment_audit_staff_visibility ON equipment_state_audit FOR SELECT TO authenticated
USING ((SELECT private.current_app_role()) IN ('approver','admin'));
DROP POLICY IF EXISTS equipment_audit_kiosk_insert ON equipment_state_audit;
CREATE POLICY equipment_audit_kiosk_insert ON equipment_state_audit FOR INSERT TO authenticated
WITH CHECK ((SELECT private.current_app_role()) IN ('inventory_kiosk','admin'));

GRANT USAGE ON SCHEMA public,private TO authenticated;
GRANT EXECUTE ON FUNCTION private.current_app_role(),private.is_admin(),private.owns_equipment_request(uuid) TO authenticated;
GRANT SELECT ON app_users,sports,sport_pocs,teams,team_members,venues,campus_locations,
  equipment_items,equipment_assets,equipment_allocations,equipment_requests,
  equipment_request_items,equipment_custody,equipment_qr_tokens,equipment_state_audit TO authenticated;
GRANT ALL ON role_assignments,auth_settings,sports,sport_pocs,teams,team_members,venues,campus_locations,equipment_items TO authenticated;
GRANT INSERT,UPDATE ON equipment_requests TO authenticated;
GRANT INSERT ON equipment_request_items,equipment_state_audit TO authenticated;
GRANT UPDATE ON equipment_assets TO authenticated;
GRANT INSERT,UPDATE ON equipment_allocations TO authenticated;
GRANT INSERT,UPDATE,DELETE ON equipment_custody TO authenticated;
REVOKE ALL ON user_passwords,auth_sessions FROM anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_sports_user_created() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_sports_email_rule() FROM PUBLIC,anon,authenticated;

-- Public media bucket. Authenticated uploads remain administrator-only.
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('sports-media','sports-media',true,5242880,ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT(id) DO UPDATE SET
  public=true,
  file_size_limit=EXCLUDED.file_size_limit,
  allowed_mime_types=EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS sports_media_admin_insert ON storage.objects;
CREATE POLICY sports_media_admin_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id='sports-media' AND (SELECT private.is_admin()));
DROP POLICY IF EXISTS sports_media_admin_select ON storage.objects;
CREATE POLICY sports_media_admin_select ON storage.objects FOR SELECT TO authenticated
USING (bucket_id='sports-media' AND (SELECT private.is_admin()));
DROP POLICY IF EXISTS sports_media_admin_update ON storage.objects;
CREATE POLICY sports_media_admin_update ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id='sports-media' AND (SELECT private.is_admin()))
WITH CHECK (bucket_id='sports-media' AND (SELECT private.is_admin()));
DROP POLICY IF EXISTS sports_media_admin_delete ON storage.objects;
CREATE POLICY sports_media_admin_delete ON storage.objects FOR DELETE TO authenticated
USING (bucket_id='sports-media' AND (SELECT private.is_admin()));

-- Idempotent default sports, locations, inventory, tracked assets, and venues.
INSERT INTO sports(name,active)
SELECT seed.name,true FROM (VALUES
  ('Cricket'),('Football'),('Basketball'),('Badminton'),('Table Tennis'),
  ('Volleyball'),('Tennis'),('Squash'),('Chess'),('Athletics'),('General')
) AS seed(name)
ON CONFLICT DO NOTHING;

INSERT INTO campus_locations(name,active)
SELECT seed.name,true FROM (VALUES
  ('Sports Complex'),('Main Ground'),('Indoor Hall'),('Equipment Store'),('Gymnasium')
) AS seed(name)
ON CONFLICT DO NOTHING;

WITH equipment_seed(name,quantity,sport,tracking,casual_quantity) AS (VALUES
  ('Badminton racquets',20,'Badminton','BULK',20),
  ('Shuttlecocks',60,'Badminton','BULK',60),
  ('Table tennis bats',12,'Table Tennis','BULK',12),
  ('Table tennis balls',50,'Table Tennis','BULK',50),
  ('Footballs',8,'Football','BULK',8),
  ('Basketballs',8,'Basketball','BULK',8),
  ('Volleyballs',6,'Volleyball','BULK',6),
  ('Tennis racquets',10,'Tennis','BULK',10),
  ('Tennis balls',40,'Tennis','BULK',40),
  ('Chess sets',15,'Chess','BULK',15),
  ('Training cones',30,'General','BULK',30),
  ('Training bibs',25,'General','BULK',25),
  ('Cricket kit bags',4,'Cricket','ASSET',0),
  ('Cricket bats',10,'Cricket','ASSET',0),
  ('Cricket balls',30,'Cricket','BULK',0),
  ('Batting pads (pairs)',8,'Cricket','ASSET',0),
  ('Batting gloves (pairs)',8,'Cricket','BULK',0),
  ('Wicket keeping set',2,'Cricket','ASSET',0),
  ('Match footballs',6,'Football','BULK',0),
  ('Football goal nets',4,'Football','ASSET',0),
  ('Basketball match balls',4,'Basketball','BULK',0),
  ('Volleyball net',2,'Volleyball','ASSET',0),
  ('Badminton match shuttles',40,'Badminton','BULK',0)
), inserted_equipment AS (
  INSERT INTO equipment_items(name,sport_id,quantity,metadata,tracking,active)
  SELECT seed.name,sport.id,seed.quantity,'{}'::jsonb,seed.tracking,true
  FROM equipment_seed seed JOIN sports sport ON lower(sport.name)=lower(seed.sport)
  ON CONFLICT DO NOTHING
  RETURNING id
)
INSERT INTO equipment_allocations(equipment_id,casual_allocated_quantity)
SELECT item.id,seed.casual_quantity
FROM equipment_seed seed JOIN equipment_items item ON lower(item.name)=lower(seed.name)
ON CONFLICT(equipment_id) DO NOTHING;

INSERT INTO equipment_assets(equipment_id,asset_tag,serial_number,condition,state)
SELECT
  item.id,
  upper(regexp_replace(item.name,'[^a-zA-Z0-9]+','-','g')) || '-' || lpad(unit.number::text,3,'0'),
  NULL,
  'good',
  'IN_INVENTORY'
FROM equipment_items item
CROSS JOIN LATERAL generate_series(1,item.quantity) AS unit(number)
WHERE item.tracking='ASSET'
  AND lower(item.name) IN (
    'cricket kit bags','cricket bats','batting pads (pairs)',
    'wicket keeping set','football goal nets','volleyball net'
  )
ON CONFLICT(asset_tag) DO NOTHING;

INSERT INTO venues(name,sport_id,category,location,capacity,amenities,rules,active)
SELECT seed.name,sport.id,seed.sport,seed.location,1,'[]'::jsonb,'{}'::jsonb,true
FROM (VALUES
  ('Volleyball Court','Volleyball','Near H10'),
  ('Volleyball Court 2','Volleyball','Near H10'),
  ('Football Field','Football','In front of Mess')
) AS seed(name,sport,location)
JOIN sports sport ON lower(sport.name)=lower(seed.sport)
WHERE NOT EXISTS (SELECT 1 FROM venues venue WHERE lower(venue.name)=lower(seed.name));

-- Fail the build with a direct message if this baseline ever becomes incomplete.
CREATE TABLE IF NOT EXISTS venue_maintenance_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  reporter_id text NOT NULL REFERENCES app_users(id),
  category text NOT NULL CHECK (category IN ('CLEANING','LIGHTING','PLAYING_SURFACE','NET_OR_POST','SEATING','WATER','ELECTRICAL','SAFETY','OTHER')),
  title text NOT NULL,
  description text NOT NULL,
  exact_area text,
  urgency text NOT NULL DEFAULT 'NORMAL' CHECK (urgency IN ('LOW','NORMAL','URGENT')),
  status text NOT NULL DEFAULT 'REPORTED' CHECK (status IN ('REPORTED','ACKNOWLEDGED','IN_PROGRESS','RESOLVED','REJECTED')),
  review_note text,
  expected_resolution_at timestamptz,
  reviewed_by text REFERENCES app_users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS venue_maintenance_status_idx ON venue_maintenance_requests(status,created_at DESC);
CREATE INDEX IF NOT EXISTS venue_maintenance_reporter_idx ON venue_maintenance_requests(reporter_id,created_at DESC);
CREATE INDEX IF NOT EXISTS venue_maintenance_venue_idx ON venue_maintenance_requests(venue_id,created_at DESC);
ALTER TABLE venue_maintenance_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS maintenance_visibility ON venue_maintenance_requests;
CREATE POLICY maintenance_visibility ON venue_maintenance_requests FOR SELECT TO authenticated
USING (reporter_id=(SELECT auth.uid())::text OR (SELECT private.current_app_role()) IN ('approver','admin'));
DROP POLICY IF EXISTS maintenance_reporter_insert ON venue_maintenance_requests;
CREATE POLICY maintenance_reporter_insert ON venue_maintenance_requests FOR INSERT TO authenticated
WITH CHECK (reporter_id=(SELECT auth.uid())::text AND EXISTS (SELECT 1 FROM venues WHERE id=venue_id AND active));
DROP POLICY IF EXISTS maintenance_staff_update ON venue_maintenance_requests;
CREATE POLICY maintenance_staff_update ON venue_maintenance_requests FOR UPDATE TO authenticated
USING ((SELECT private.current_app_role()) IN ('approver','admin'))
WITH CHECK ((SELECT private.current_app_role()) IN ('approver','admin'));
GRANT SELECT,INSERT,UPDATE ON venue_maintenance_requests TO authenticated;

DO $$
DECLARE missing_tables text;
BEGIN
  SELECT string_agg(required.name,', ' ORDER BY required.name) INTO missing_tables
  FROM (VALUES
    ('app_users'),('venues'),('bookings'),('slot_holds'),('sports'),('teams'),
    ('equipment_items'),('equipment_assets'),('equipment_allocations'),
    ('equipment_requests'),('equipment_custody'),('equipment_qr_tokens'),('equipment_state_audit'),
    ('venue_maintenance_requests')
  ) AS required(name)
  WHERE to_regclass('public.' || required.name) IS NULL;
  IF missing_tables IS NOT NULL THEN RAISE EXCEPTION 'Schema baseline incomplete; missing: %',missing_tables; END IF;
END $$;
