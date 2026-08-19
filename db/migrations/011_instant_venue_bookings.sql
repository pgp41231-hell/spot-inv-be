-- Venue reservations no longer require committee approval. Existing pending
-- venue reservations are safe to confirm because the exclusion constraint has
-- already guaranteed that they do not overlap another live reservation.
UPDATE bookings
SET status = 'approved',
    current_approval_order = NULL,
    updated_at = now()
WHERE resource_type = 'venue'
  AND status = 'pending';
