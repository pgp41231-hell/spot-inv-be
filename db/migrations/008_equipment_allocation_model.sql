-- Replace the creation-time pool flag with live allocation/custody state.
-- campus_locations remains because venues use it; equipment no longer does.

CREATE TABLE IF NOT EXISTS equipment_allocations (
  equipment_id uuid PRIMARY KEY REFERENCES equipment_items(id) ON DELETE CASCADE,
  casual_allocated_quantity integer NOT NULL DEFAULT 0 CHECK (casual_allocated_quantity >= 0),
  updated_by text REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Existing CASUAL equipment becomes allocated to casual use. Student issues
-- remain part of that allocation; damaged/missing quantities are excluded.
INSERT INTO equipment_allocations(equipment_id,casual_allocated_quantity)
SELECT e.id,
  GREATEST(0,e.quantity-COALESCE((SELECT sum(c.quantity) FROM equipment_custody c WHERE c.equipment_id=e.id AND c.state IN ('DAMAGED','MISSING')),0))::int
FROM equipment_items e WHERE e.pool='CASUAL' AND e.tracking='BULK'
ON CONFLICT(equipment_id) DO NOTHING;

ALTER TABLE equipment_assets DROP CONSTRAINT IF EXISTS equipment_assets_state_check;
ALTER TABLE equipment_assets ADD CONSTRAINT equipment_assets_state_check
  CHECK (state IN ('IN_INVENTORY','CASUAL_POOL','ISSUED_TO_STUDENT','HELD_BY_TEAM','DAMAGED','MISSING'));
UPDATE equipment_assets a SET state='CASUAL_POOL',updated_at=now()
FROM equipment_items e
WHERE a.equipment_id=e.id AND e.pool='CASUAL' AND a.state='IN_INVENTORY';

ALTER TABLE equipment_state_audit DROP CONSTRAINT IF EXISTS equipment_state_audit_from_state_check;
ALTER TABLE equipment_state_audit DROP CONSTRAINT IF EXISTS equipment_state_audit_to_state_check;
ALTER TABLE equipment_state_audit ADD CONSTRAINT equipment_state_audit_from_state_check
  CHECK (from_state IN ('IN_INVENTORY','CASUAL_POOL','ISSUED_TO_STUDENT','HELD_BY_TEAM','DAMAGED','MISSING'));
ALTER TABLE equipment_state_audit ADD CONSTRAINT equipment_state_audit_to_state_check
  CHECK (to_state IN ('IN_INVENTORY','CASUAL_POOL','ISSUED_TO_STUDENT','HELD_BY_TEAM','DAMAGED','MISSING'));
ALTER TABLE equipment_state_audit ALTER COLUMN request_id DROP NOT NULL;
ALTER TABLE equipment_state_audit ADD COLUMN IF NOT EXISTS manual_override boolean NOT NULL DEFAULT false;

-- Manual correction transfers have no originating request. Damage and loss can
-- also be recorded against unassigned stock, so a holder is optional there.
ALTER TABLE equipment_custody ALTER COLUMN source_request_id DROP NOT NULL;
ALTER TABLE equipment_custody DROP CONSTRAINT IF EXISTS equipment_custody_check;
ALTER TABLE equipment_custody ADD CONSTRAINT equipment_custody_check CHECK (
  (state='ISSUED_TO_STUDENT' AND student_id IS NOT NULL AND team_id IS NULL) OR
  (state='HELD_BY_TEAM' AND team_id IS NOT NULL AND student_id IS NULL) OR
  (state IN ('DAMAGED','MISSING') AND NOT (student_id IS NOT NULL AND team_id IS NOT NULL))
);

-- Equipment is now classified only by sport. These legacy creation-time
-- descriptors are deliberately removed after allocation data is preserved.
ALTER TABLE equipment_items DROP CONSTRAINT IF EXISTS equipment_items_category_id_fkey;
ALTER TABLE equipment_items DROP CONSTRAINT IF EXISTS equipment_items_location_id_fkey;
ALTER TABLE equipment_items DROP CONSTRAINT IF EXISTS equipment_items_pool_check;
ALTER TABLE equipment_items DROP CONSTRAINT IF EXISTS equipment_tracking_condition_check;
ALTER TABLE equipment_items DROP CONSTRAINT IF EXISTS equipment_items_condition_check;
ALTER TABLE equipment_items DROP COLUMN IF EXISTS category_id;
ALTER TABLE equipment_items DROP COLUMN IF EXISTS category;
ALTER TABLE equipment_items DROP COLUMN IF EXISTS location_id;
ALTER TABLE equipment_items DROP COLUMN IF EXISTS location;
ALTER TABLE equipment_items DROP COLUMN IF EXISTS pool;
ALTER TABLE equipment_items DROP COLUMN IF EXISTS condition;
DROP TABLE IF EXISTS equipment_categories;

ALTER TABLE equipment_allocations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS equipment_allocation_staff_read ON equipment_allocations;
CREATE POLICY equipment_allocation_staff_read ON equipment_allocations FOR SELECT TO authenticated
USING ((SELECT private.current_app_role()) IN ('approver','admin'));
DROP POLICY IF EXISTS equipment_allocation_admin_manage ON equipment_allocations;
CREATE POLICY equipment_allocation_admin_manage ON equipment_allocations FOR ALL TO authenticated
USING ((SELECT private.is_admin())) WITH CHECK ((SELECT private.is_admin()));
GRANT SELECT,INSERT,UPDATE ON equipment_allocations TO authenticated;

-- Approval remains separate from physical custody. Any SportComm member may
-- decide casual requests; team requests are limited to that sport's POCs (or
-- the fixed administrator). Only the kiosk/admin may perform custody writes.
DROP POLICY IF EXISTS equipment_request_staff_decision ON equipment_requests;
CREATE POLICY equipment_request_staff_decision ON equipment_requests FOR UPDATE TO authenticated
USING (
  status='PENDING' AND (
    (SELECT private.is_admin()) OR
    ((SELECT private.current_app_role())='approver' AND request_type='CASUAL') OR
    ((SELECT private.current_app_role())='approver' AND request_type='TEAM' AND EXISTS (
      SELECT 1 FROM sport_pocs p WHERE p.sport_id=equipment_requests.sport_id
      AND (p.primary_poc_id=(SELECT auth.uid())::text OR p.secondary_poc_id=(SELECT auth.uid())::text)
    ))
  )
) WITH CHECK (
  (SELECT private.is_admin()) OR (SELECT private.current_app_role())='approver'
);
DROP POLICY IF EXISTS equipment_custody_kiosk_manage ON equipment_custody;
CREATE POLICY equipment_custody_kiosk_manage ON equipment_custody FOR ALL TO authenticated
USING ((SELECT private.current_app_role()) IN ('inventory_kiosk','admin'))
WITH CHECK ((SELECT private.current_app_role()) IN ('inventory_kiosk','admin'));
DROP POLICY IF EXISTS equipment_assets_kiosk_update ON equipment_assets;
CREATE POLICY equipment_assets_kiosk_update ON equipment_assets FOR UPDATE TO authenticated
USING ((SELECT private.current_app_role()) IN ('inventory_kiosk','admin'))
WITH CHECK ((SELECT private.current_app_role()) IN ('inventory_kiosk','admin'));
DROP POLICY IF EXISTS equipment_audit_kiosk_insert ON equipment_state_audit;
CREATE POLICY equipment_audit_kiosk_insert ON equipment_state_audit FOR INSERT TO authenticated
WITH CHECK ((SELECT private.current_app_role()) IN ('inventory_kiosk','admin'));
GRANT UPDATE ON equipment_requests,equipment_assets TO authenticated;
GRANT INSERT,UPDATE,DELETE ON equipment_custody TO authenticated;
GRANT INSERT ON equipment_state_audit TO authenticated;
