-- Idempotent catalog and equipment seed. All equipment starts in inventory;
-- no custody rows are inserted.

INSERT INTO sports(name,active)
SELECT seed.name,true FROM (VALUES
  ('Cricket'),('Football'),('Basketball'),('Badminton'),('Table Tennis'),
  ('Volleyball'),('Tennis'),('Squash'),('Chess'),('Athletics'),('General')
) AS seed(name)
WHERE NOT EXISTS (SELECT 1 FROM sports s WHERE lower(s.name)=lower(seed.name));

INSERT INTO equipment_categories(name,active)
SELECT seed.name,true FROM (VALUES
  ('Racquets'),('Balls'),('Protective gear'),('Training aids'),('Kit'),('Nets and posts')
) AS seed(name)
WHERE NOT EXISTS (SELECT 1 FROM equipment_categories c WHERE lower(c.name)=lower(seed.name));

INSERT INTO campus_locations(name,active)
SELECT seed.name,true FROM (VALUES
  ('Sports Complex'),('Main Ground'),('Indoor Hall'),('Equipment Store'),('Gymnasium')
) AS seed(name)
WHERE NOT EXISTS (SELECT 1 FROM campus_locations l WHERE lower(l.name)=lower(seed.name));

-- Link legacy records conservatively, retaining their text labels.
UPDATE venues v SET location_id=l.id FROM campus_locations l
WHERE v.location_id IS NULL AND lower(v.location)=lower(l.name);
UPDATE equipment_items e SET sport_id=s.id FROM sports s
WHERE e.sport_id IS NULL AND lower(s.name)='general';
UPDATE equipment_items e SET category_id=c.id FROM equipment_categories c
WHERE e.category_id IS NULL AND lower(c.name)='kit';
UPDATE equipment_items e SET location_id=l.id FROM campus_locations l
WHERE e.location_id IS NULL AND lower(l.name)='equipment store';

WITH equipment_seed(name,quantity,sport,category,pool,tracking) AS (VALUES
  ('Badminton racquets',20,'Badminton','Racquets','CASUAL','BULK'),
  ('Shuttlecocks',60,'Badminton','Balls','CASUAL','BULK'),
  ('Table tennis bats',12,'Table Tennis','Racquets','CASUAL','BULK'),
  ('Table tennis balls',50,'Table Tennis','Balls','CASUAL','BULK'),
  ('Footballs',8,'Football','Balls','CASUAL','BULK'),
  ('Basketballs',8,'Basketball','Balls','CASUAL','BULK'),
  ('Volleyballs',6,'Volleyball','Balls','CASUAL','BULK'),
  ('Tennis racquets',10,'Tennis','Racquets','CASUAL','BULK'),
  ('Tennis balls',40,'Tennis','Balls','CASUAL','BULK'),
  ('Chess sets',15,'Chess','Kit','CASUAL','BULK'),
  ('Training cones',30,'General','Training aids','CASUAL','BULK'),
  ('Training bibs',25,'General','Kit','CASUAL','BULK'),
  ('Cricket kit bags',4,'Cricket','Kit','TEAM','ASSET'),
  ('Cricket bats',10,'Cricket','Kit','TEAM','ASSET'),
  ('Cricket balls',30,'Cricket','Balls','TEAM','BULK'),
  ('Batting pads (pairs)',8,'Cricket','Protective gear','TEAM','ASSET'),
  ('Batting gloves (pairs)',8,'Cricket','Protective gear','TEAM','BULK'),
  ('Wicket keeping set',2,'Cricket','Protective gear','TEAM','ASSET'),
  ('Match footballs',6,'Football','Balls','TEAM','BULK'),
  ('Football goal nets',4,'Football','Nets and posts','TEAM','ASSET'),
  ('Basketball match balls',4,'Basketball','Balls','TEAM','BULK'),
  ('Volleyball net',2,'Volleyball','Nets and posts','TEAM','ASSET'),
  ('Badminton match shuttles',40,'Badminton','Balls','TEAM','BULK')
)
INSERT INTO equipment_items(name,category,location,quantity,condition,metadata,active,pool,tracking,sport_id,category_id,location_id)
SELECT seed.name,seed.category,'Equipment Store',seed.quantity,
  NULL,'{}'::jsonb,true,seed.pool,seed.tracking,
  s.id,c.id,l.id
FROM equipment_seed seed
JOIN sports s ON lower(s.name)=lower(seed.sport)
JOIN equipment_categories c ON lower(c.name)=lower(seed.category)
JOIN campus_locations l ON lower(l.name)='equipment store'
WHERE NOT EXISTS (SELECT 1 FROM equipment_items e WHERE lower(e.name)=lower(seed.name));

-- Asset tags are deterministic and idempotent. Conditions live per unit.
INSERT INTO equipment_assets(equipment_id,asset_tag,serial_number,state,condition)
SELECT e.id,
  upper(regexp_replace(e.name,'[^a-zA-Z0-9]+','-','g')) || '-' || lpad(series.unit::text,3,'0'),
  NULL,'IN_INVENTORY','good'
FROM equipment_items e
CROSS JOIN LATERAL generate_series(1,e.quantity) AS series(unit)
WHERE e.tracking='ASSET'
  AND lower(e.name) IN ('cricket kit bags','cricket bats','batting pads (pairs)','wicket keeping set','football goal nets','volleyball net')
  AND NOT EXISTS (
    SELECT 1 FROM equipment_assets a
    WHERE a.asset_tag=upper(regexp_replace(e.name,'[^a-zA-Z0-9]+','-','g')) || '-' || lpad(series.unit::text,3,'0')
  );

ALTER TABLE equipment_items ALTER COLUMN sport_id SET NOT NULL;
ALTER TABLE equipment_items ALTER COLUMN category_id SET NOT NULL;
ALTER TABLE equipment_items ALTER COLUMN location_id SET NOT NULL;
