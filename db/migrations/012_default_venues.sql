-- Default campus venues. The name checks keep this seed idempotent even when
-- an administrator already created a matching venue manually.
INSERT INTO venues(name, sport_id, category, location, capacity, amenities, rules, active)
SELECT 'Volleyball Court', s.id, 'Volleyball', 'Near H10', 1, '[]'::jsonb, '{}'::jsonb, true
FROM sports s
WHERE lower(s.name) = 'volleyball'
  AND NOT EXISTS (SELECT 1 FROM venues v WHERE lower(v.name) = 'volleyball court');

INSERT INTO venues(name, sport_id, category, location, capacity, amenities, rules, active)
SELECT 'Volleyball Court 2', s.id, 'Volleyball', 'Near H10', 1, '[]'::jsonb, '{}'::jsonb, true
FROM sports s
WHERE lower(s.name) = 'volleyball'
  AND NOT EXISTS (SELECT 1 FROM venues v WHERE lower(v.name) = 'volleyball court 2');

INSERT INTO venues(name, sport_id, category, location, capacity, amenities, rules, active)
SELECT 'Football Field', s.id, 'Football', 'In front of Mess', 1, '[]'::jsonb, '{}'::jsonb, true
FROM sports s
WHERE lower(s.name) = 'football'
  AND NOT EXISTS (SELECT 1 FROM venues v WHERE lower(v.name) = 'football field');
