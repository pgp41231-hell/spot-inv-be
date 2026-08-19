-- Equipment catalogs, per-unit condition, and public venue/equipment photos.
-- Booking, fixture, tournament, event, and approval logic are unchanged.

CREATE TABLE IF NOT EXISTS equipment_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by text REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS equipment_categories_name_unique ON equipment_categories(lower(name));

CREATE TABLE IF NOT EXISTS campus_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by text REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS campus_locations_name_unique ON campus_locations(lower(name));

ALTER TABLE venues ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES campus_locations(id);
ALTER TABLE venues ADD COLUMN IF NOT EXISTS photo_path text;

ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS sport_id uuid REFERENCES sports(id);
ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES equipment_categories(id);
ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES campus_locations(id);
ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS photo_path text;
ALTER TABLE equipment_items DROP CONSTRAINT IF EXISTS equipment_items_quantity_check;
ALTER TABLE equipment_items ADD CONSTRAINT equipment_items_quantity_check CHECK (quantity >= 0);

ALTER TABLE equipment_assets ADD COLUMN IF NOT EXISTS condition text NOT NULL DEFAULT 'good';
ALTER TABLE equipment_assets DROP CONSTRAINT IF EXISTS equipment_assets_condition_check;
ALTER TABLE equipment_assets ADD CONSTRAINT equipment_assets_condition_check
  CHECK (condition IN ('excellent','good','fair','maintenance','retired'));

-- Bulk condition is represented by custody quantities in DAMAGED/MISSING, not
-- by one misleading condition on the whole equipment row.
ALTER TABLE equipment_items ALTER COLUMN condition DROP NOT NULL;
UPDATE equipment_items SET condition=NULL;
ALTER TABLE equipment_items DROP CONSTRAINT IF EXISTS equipment_tracking_condition_check;
ALTER TABLE equipment_items ADD CONSTRAINT equipment_tracking_condition_check
  CHECK (condition IS NULL);

ALTER TABLE equipment_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE campus_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS authenticated_read_equipment_categories ON equipment_categories;
CREATE POLICY authenticated_read_equipment_categories ON equipment_categories FOR SELECT TO authenticated
USING (active OR (SELECT private.is_admin()));
DROP POLICY IF EXISTS admin_manage_equipment_categories ON equipment_categories;
CREATE POLICY admin_manage_equipment_categories ON equipment_categories FOR ALL TO authenticated
USING ((SELECT private.is_admin())) WITH CHECK ((SELECT private.is_admin()));

DROP POLICY IF EXISTS authenticated_read_campus_locations ON campus_locations;
CREATE POLICY authenticated_read_campus_locations ON campus_locations FOR SELECT TO authenticated
USING (active OR (SELECT private.is_admin()));
DROP POLICY IF EXISTS admin_manage_campus_locations ON campus_locations;
CREATE POLICY admin_manage_campus_locations ON campus_locations FOR ALL TO authenticated
USING ((SELECT private.is_admin())) WITH CHECK ((SELECT private.is_admin()));

GRANT SELECT ON equipment_categories,campus_locations TO authenticated;
GRANT ALL ON equipment_categories,campus_locations TO authenticated;

-- Public images; only the fixed administrator can create, replace, or remove.
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('sports-media','sports-media',true,5242880,ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT(id) DO UPDATE SET public=true,file_size_limit=EXCLUDED.file_size_limit,allowed_mime_types=EXCLUDED.allowed_mime_types;

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
