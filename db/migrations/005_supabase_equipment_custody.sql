-- Supabase-backed equipment request, custody, and authorization model.
-- This migration does not alter venue bookings, fixtures, scores, tournaments,
-- events, or committee content.

CREATE SCHEMA IF NOT EXISTS private;

ALTER TABLE app_users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_role_check;
ALTER TABLE app_users ADD CONSTRAINT app_users_role_check
  CHECK (role IN ('requester','approver','scorekeeper','admin','inventory_kiosk'));

ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS pool text NOT NULL DEFAULT 'CASUAL'
  CHECK (pool IN ('CASUAL','TEAM'));
ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS tracking text NOT NULL DEFAULT 'BULK'
  CHECK (tracking IN ('ASSET','BULK'));

CREATE TABLE IF NOT EXISTS sports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_by text REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
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

CREATE TABLE IF NOT EXISTS equipment_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id uuid NOT NULL REFERENCES equipment_items(id),
  asset_tag text NOT NULL UNIQUE,
  serial_number text,
  state text NOT NULL DEFAULT 'IN_INVENTORY'
    CHECK (state IN ('IN_INVENTORY','ISSUED_TO_STUDENT','HELD_BY_TEAM','DAMAGED','MISSING')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

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
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (request_type='CASUAL' AND team_id IS NULL AND sport_id IS NULL AND expected_return_at IS NOT NULL AND parent_request_id IS NULL)
    OR (request_type='TEAM' AND team_id IS NOT NULL AND sport_id IS NOT NULL AND expected_return_at IS NULL AND parent_request_id IS NULL)
    OR (request_type='RETURN' AND parent_request_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_casual_issue_per_student
  ON equipment_requests(requester_id)
  WHERE request_type='CASUAL' AND status IN ('APPROVED','ISSUED','RETURN_PENDING');
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
  source_request_id uuid NOT NULL REFERENCES equipment_requests(id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((student_id IS NOT NULL)::int + (team_id IS NOT NULL)::int = 1)
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
  from_state text NOT NULL CHECK (from_state IN ('IN_INVENTORY','ISSUED_TO_STUDENT','HELD_BY_TEAM','DAMAGED','MISSING')),
  to_state text NOT NULL CHECK (to_state IN ('IN_INVENTORY','ISSUED_TO_STUDENT','HELD_BY_TEAM','DAMAGED','MISSING')),
  actor_id text NOT NULL REFERENCES app_users(id),
  request_id uuid NOT NULL REFERENCES equipment_requests(id),
  person_id text REFERENCES app_users(id),
  team_id uuid REFERENCES teams(id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS equipment_state_audit_filters_idx
  ON equipment_state_audit(equipment_id,person_id,created_at DESC);

CREATE OR REPLACE FUNCTION private.current_app_role()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$ SELECT role FROM public.app_users WHERE id=(SELECT auth.uid())::text $$;

CREATE OR REPLACE FUNCTION private.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$ SELECT EXISTS(SELECT 1 FROM public.app_users WHERE id=(SELECT auth.uid())::text AND role='admin' AND lower(email)='sportscomm@iiml.ac.in') $$;

CREATE OR REPLACE FUNCTION private.is_sport_poc(target_sport uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$ SELECT EXISTS(SELECT 1 FROM public.sport_pocs WHERE sport_id=target_sport AND (primary_poc_id=(SELECT auth.uid())::text OR secondary_poc_id=(SELECT auth.uid())::text)) $$;

CREATE OR REPLACE FUNCTION private.owns_equipment_request(target_request uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$ SELECT EXISTS(SELECT 1 FROM public.equipment_requests WHERE id=target_request AND requester_id=(SELECT auth.uid())::text) $$;

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
    CASE WHEN lower(NEW.email)='sportscomm@iiml.ac.in' THEN 'admin' ELSE COALESCE(assigned_role,'requester') END,
    lower(NEW.email)='sportscomm@iiml.ac.in'
  )
  ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email,name=EXCLUDED.name,updated_at=now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.enforce_sports_email_rule()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE allowed_pattern text;
BEGIN
  IF lower(NEW.email) IN ('sportscomm@iiml.ac.in','inventory@iiml.ac.in') THEN
    RETURN NEW;
  END IF;
  SELECT email_pattern INTO allowed_pattern FROM public.auth_settings WHERE id=true;
  IF NEW.email IS NULL OR lower(NEW.email) !~* COALESCE(allowed_pattern,'^pgp\d{5}@iiml\.ac\.in$') THEN
    RAISE EXCEPTION 'Email is not eligible for this portal';
  END IF;
  RETURN NEW;
END $$;

-- Backfill pre-existing Supabase Auth accounts without resetting passwords or
-- forcing the first-login flag. Newly seeded accounts pass through the trigger
-- below and receive must_change_password=true.
INSERT INTO public.app_users(id,email,name,role,must_change_password)
SELECT u.id::text,lower(u.email),COALESCE(NULLIF(u.raw_user_meta_data->>'name',''),split_part(u.email,'@',1)),
  CASE WHEN lower(u.email)='sportscomm@iiml.ac.in' THEN 'admin' ELSE COALESCE(r.role,'requester') END,false
FROM auth.users u LEFT JOIN public.role_assignments r ON r.email=lower(u.email)
WHERE u.email IS NOT NULL
ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email,name=EXCLUDED.name,
  role=CASE WHEN lower(EXCLUDED.email)='sportscomm@iiml.ac.in' THEN 'admin' ELSE app_users.role END,updated_at=now();

DROP TRIGGER IF EXISTS sports_user_created ON auth.users;
CREATE TRIGGER sports_user_created AFTER INSERT OR UPDATE OF email,raw_user_meta_data ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_sports_user_created();
DROP TRIGGER IF EXISTS sports_email_rule ON auth.users;
CREATE TRIGGER sports_email_rule BEFORE INSERT OR UPDATE OF email ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.enforce_sports_email_rule();

-- Authentication is now owned by Supabase Auth. Keep legacy tables inaccessible
-- for rollback/migration analysis, but remove Data API access.
REVOKE ALL ON user_passwords,auth_sessions FROM anon,authenticated;

ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sports ENABLE ROW LEVEL SECURITY;
ALTER TABLE sport_pocs ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_assets ENABLE ROW LEVEL SECURITY;
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

DROP POLICY IF EXISTS authenticated_read_active_sports ON sports;
CREATE POLICY authenticated_read_active_sports ON sports FOR SELECT TO authenticated
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
USING (user_id=(SELECT auth.uid())::text OR team_id IN (SELECT id FROM teams WHERE captain_id=(SELECT auth.uid())::text) OR (SELECT private.is_admin()));
DROP POLICY IF EXISTS admin_manage_team_members ON team_members;
CREATE POLICY admin_manage_team_members ON team_members FOR ALL TO authenticated
USING ((SELECT private.is_admin())) WITH CHECK ((SELECT private.is_admin()));

DROP POLICY IF EXISTS authenticated_read_equipment ON equipment_items;
CREATE POLICY authenticated_read_equipment ON equipment_items FOR SELECT TO authenticated USING (active OR (SELECT private.is_admin()));
DROP POLICY IF EXISTS admin_manage_equipment ON equipment_items;
CREATE POLICY admin_manage_equipment ON equipment_items FOR ALL TO authenticated
USING ((SELECT private.is_admin())) WITH CHECK ((SELECT private.is_admin()));
DROP POLICY IF EXISTS equipment_assets_staff_only ON equipment_assets;
CREATE POLICY equipment_assets_staff_only ON equipment_assets FOR SELECT TO authenticated
USING ((SELECT private.current_app_role()) IN ('approver','inventory_kiosk','admin'));

DROP POLICY IF EXISTS request_visibility ON equipment_requests;
CREATE POLICY request_visibility ON equipment_requests FOR SELECT TO authenticated
USING (
  requester_id=(SELECT auth.uid())::text
  OR (SELECT private.is_admin())
  OR (SELECT private.current_app_role())='inventory_kiosk'
  OR (SELECT private.current_app_role())='approver'
);
DROP POLICY IF EXISTS students_create_own_requests ON equipment_requests;
CREATE POLICY students_create_own_requests ON equipment_requests FOR INSERT TO authenticated
WITH CHECK (
  requester_id=(SELECT auth.uid())::text
  AND (
    request_type='CASUAL'
    OR (request_type='TEAM' AND team_id IN (SELECT id FROM teams WHERE captain_id=(SELECT auth.uid())::text))
    OR (request_type='RETURN' AND (SELECT private.owns_equipment_request(parent_request_id)))
  )
);
DROP POLICY IF EXISTS request_items_visibility ON equipment_request_items;
CREATE POLICY request_items_visibility ON equipment_request_items FOR SELECT TO authenticated
USING (request_id IN (SELECT id FROM equipment_requests));
DROP POLICY IF EXISTS students_create_request_items ON equipment_request_items;
CREATE POLICY students_create_request_items ON equipment_request_items FOR INSERT TO authenticated
WITH CHECK (request_id IN (SELECT id FROM equipment_requests WHERE requester_id=(SELECT auth.uid())::text AND (status='PENDING' OR (status='APPROVED' AND request_type='RETURN'))));

DROP POLICY IF EXISTS custody_visibility ON equipment_custody;
CREATE POLICY custody_visibility ON equipment_custody FOR SELECT TO authenticated
USING (student_id=(SELECT auth.uid())::text OR team_id IN (SELECT id FROM teams WHERE captain_id=(SELECT auth.uid())::text) OR (SELECT private.current_app_role()) IN ('approver','inventory_kiosk','admin'));
DROP POLICY IF EXISTS token_visibility ON equipment_qr_tokens;
CREATE POLICY token_visibility ON equipment_qr_tokens FOR SELECT TO authenticated
USING (request_id IN (SELECT id FROM equipment_requests WHERE requester_id=(SELECT auth.uid())::text) OR (SELECT private.current_app_role()) IN ('inventory_kiosk','admin'));
DROP POLICY IF EXISTS equipment_audit_staff_visibility ON equipment_state_audit;
CREATE POLICY equipment_audit_staff_visibility ON equipment_state_audit FOR SELECT TO authenticated
USING ((SELECT private.current_app_role()) IN ('approver','admin'));

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT ON sports,sport_pocs,teams,team_members,equipment_items,equipment_assets,equipment_requests,equipment_request_items,equipment_custody,equipment_qr_tokens,equipment_state_audit TO authenticated;
GRANT INSERT ON equipment_requests,equipment_request_items TO authenticated;
GRANT ALL ON sports,sport_pocs,teams,team_members,equipment_items,role_assignments,auth_settings TO authenticated;

-- Append-only custody audit, consistent with the existing audit log.
CREATE OR REPLACE FUNCTION prevent_equipment_audit_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'equipment_state_audit is append-only'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS equipment_state_audit_no_update ON equipment_state_audit;
CREATE TRIGGER equipment_state_audit_no_update BEFORE UPDATE OR DELETE ON equipment_state_audit
FOR EACH ROW EXECUTE FUNCTION prevent_equipment_audit_mutation();

REVOKE EXECUTE ON FUNCTION public.handle_sports_user_created() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_sports_email_rule() FROM PUBLIC,anon,authenticated;
