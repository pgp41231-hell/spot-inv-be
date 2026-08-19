-- Venues now belong to a sport. Legacy category/capacity/amenities columns are
-- retained so existing booking data and older clients continue to work.
ALTER TABLE venues
  ADD COLUMN IF NOT EXISTS sport_id uuid REFERENCES sports(id);

UPDATE venues AS venue
SET sport_id = matched_sport.id
FROM sports AS matched_sport
WHERE venue.sport_id IS NULL
  AND lower(matched_sport.name) = lower(venue.category);

CREATE INDEX IF NOT EXISTS venues_sport_id_idx ON venues(sport_id);
