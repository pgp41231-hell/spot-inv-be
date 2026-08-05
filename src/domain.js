import { badRequest, forbidden } from "./errors.js";

export const ROLES = ["requester", "approver", "scorekeeper", "admin"];
export const BOOKING_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "completed",
];

export function parseDate(value, fieldName) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw badRequest(`${fieldName} must be a valid ISO-8601 date-time`);
  }
  return date;
}

export function validateInterval(startValue, endValue) {
  const startAt = parseDate(startValue, "startAt");
  const endAt = parseDate(endValue, "endAt");
  if (startAt >= endAt) throw badRequest("endAt must be after startAt");
  return { startAt: startAt.toISOString(), endAt: endAt.toISOString() };
}

export function assertBookingOwnerOrAdmin(booking, user) {
  if (booking.requesterId !== user.id && user.role !== "admin") {
    throw forbidden("Only the requester or an administrator can change this booking");
  }
}

export function nextApprovalState(booking, steps, decisions, action) {
  if (booking.status !== "pending") {
    throw badRequest("Only pending bookings can be reviewed");
  }
  if (action === "reject") return "rejected";
  const approved = new Set(
    decisions.filter((item) => item.decision === "approved").map((item) => item.stepId),
  );
  return steps.every((step) => approved.has(step.id)) ? "approved" : "pending";
}

export function publicBookingView(booking) {
  return {
    id: booking.id,
    resourceType: booking.resourceType,
    resourceId: booking.resourceId,
    startAt: booking.startAt,
    endAt: booking.endAt,
    status: booking.status,
  };
}
