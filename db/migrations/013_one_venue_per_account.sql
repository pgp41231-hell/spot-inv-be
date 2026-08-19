-- An account may book only one venue at any instant. The half-open [) range
-- permits adjacent reservations: a booking ending at 10:00 does not conflict
-- with another beginning at 10:00.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'no_overlapping_requester_venue_booking'
  ) THEN
    ALTER TABLE bookings ADD CONSTRAINT no_overlapping_requester_venue_booking
      EXCLUDE USING gist (
        requester_id WITH =,
        tstzrange(start_at, end_at, '[)') WITH &&
      ) WHERE (resource_type = 'venue' AND status NOT IN ('cancelled','rejected'));
  END IF;
END $$;
