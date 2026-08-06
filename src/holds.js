import { badRequest } from "./errors.js";

// EPIC-03 / US-04B: a hold is a short advisory claim on a slot, taken while the
// requester fills in the booking form. It is not a booking and never becomes one;
// the booking is still the only durable record.
export const HOLD_TTL_MINUTES = 5;

export function holdExpiryFrom(at = new Date()) {
  return new Date(new Date(at).getTime() + HOLD_TTL_MINUTES * 60_000).toISOString();
}

export function isHoldActive(hold, at = new Date()) {
  if (!hold || hold.releasedAt) return false;
  return new Date(hold.expiresAt) > new Date(at);
}

// Mirrors publicBookingView in domain.js: the calendar needs to know a slot is
// spoken for, but not who is holding it.
export function holdPublicView(hold) {
  return {
    id: hold.id,
    resourceType: hold.resourceType,
    resourceId: hold.resourceId,
    startAt: hold.startAt,
    endAt: hold.endAt,
    expiresAt: hold.expiresAt,
  };
}

// A hold only authorises the exact slot it was taken on. Anything else and the
// requester has edited the times since, so the hold no longer means what it said.
export function assertHoldMatchesBooking(hold, booking) {
  if (hold.resourceType !== booking.resourceType || hold.resourceId !== booking.resourceId) {
    throw badRequest("This hold was taken on a different resource");
  }
  if (new Date(hold.startAt).getTime() !== new Date(booking.startAt).getTime()
    || new Date(hold.endAt).getTime() !== new Date(booking.endAt).getTime()) {
    throw badRequest("This hold was taken on a different time slot");
  }
}
