-- EPIC-03 / US-04B: temporary slot holds.
--
-- A hold is an advisory, short-lived claim on a slot. It stops a second person
-- from booking the slot while the first person is still filling in the booking
-- form, without ever becoming a booking itself.
--
-- Holds expire passively: every read filters on `released_at IS NULL AND
-- expires_at > now()`. There is deliberately no sweeper job, so an expired hold
-- stops blocking the moment it lapses even if nothing else runs.

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

-- Serves the "is this slot held right now?" lookup that runs on every calendar
-- render and every booking attempt.
CREATE INDEX IF NOT EXISTS slot_holds_active_idx
  ON slot_holds(resource_type, resource_id, expires_at)
  WHERE released_at IS NULL;

-- Serves GET /api/v1/holds/mine.
CREATE INDEX IF NOT EXISTS slot_holds_holder_idx
  ON slot_holds(held_by, expires_at)
  WHERE released_at IS NULL;
