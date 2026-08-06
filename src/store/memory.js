import { randomUUID } from "node:crypto";
import { conflict, forbidden, notFound } from "../errors.js";
import { holdExpiryFrom, isHoldActive } from "../holds.js";

const now = () => new Date().toISOString();
const clone = (value) => structuredClone(value);

export class MemoryStore {
  constructor(seed = {}) {
    this.users = new Map();
    this.venues = new Map();
    this.equipment = new Map();
    this.bookings = new Map();
    this.blackouts = new Map();
    this.holds = new Map();
    this.approvalFlows = new Map();
    this.decisions = new Map();
    this.committee = new Map();
    this.gallery = new Map();
    this.tournaments = new Map();
    this.matches = new Map();
    this.notifications = new Map();
    this.audit = [];

    for (const venue of seed.venues || []) this.venues.set(venue.id, clone(venue));
    for (const item of seed.equipment || []) this.equipment.set(item.id, clone(item));
    for (const flow of seed.approvalFlows || []) this.approvalFlows.set(flow.id, clone(flow));
  }

  async close() {}

  async ensureUser(user) {
    const existing = this.users.get(user.id);
    const record = { ...existing, ...user, updatedAt: now(), createdAt: existing?.createdAt || now() };
    this.users.set(user.id, record);
    return clone(record);
  }

  async listUsers() {
    return clone([...this.users.values()]);
  }

  async getUser(id) {
    const user = this.users.get(id);
    if (!user) throw notFound("User");
    return clone(user);
  }

  async setUserRole(id, role) {
    const user = this.users.get(id);
    if (!user) throw notFound("User");
    user.role = role;
    user.updatedAt = now();
    return clone(user);
  }

  collection(type) {
    if (type === "venue") return this.venues;
    if (type === "equipment") return this.equipment;
    throw new Error(`Unknown resource type: ${type}`);
  }

  async listResources(type, filters = {}) {
    let values = [...this.collection(type).values()];
    if (filters.active !== undefined) values = values.filter((x) => x.active === filters.active);
    if (filters.category) values = values.filter((x) => x.category === filters.category);
    if (filters.minCapacity) values = values.filter((x) => (x.capacity || x.quantity || 0) >= filters.minCapacity);
    if (filters.q) {
      const q = filters.q.toLowerCase();
      values = values.filter((x) => `${x.name} ${x.location || ""}`.toLowerCase().includes(q));
    }
    return clone(values);
  }

  async getResource(type, id) {
    const item = this.collection(type).get(id);
    if (!item) throw notFound(type === "venue" ? "Venue" : "Equipment item");
    return clone(item);
  }

  async createResource(type, data, actor) {
    const id = randomUUID();
    const record = {
      id,
      ...clone(data),
      active: data.active ?? true,
      createdAt: now(),
      updatedAt: now(),
    };
    this.collection(type).set(id, record);
    await this.appendAudit(actor, `${type}.created`, type, id, null, record);
    return clone(record);
  }

  async updateResource(type, id, data, actor) {
    const before = await this.getResource(type, id);
    const after = { ...before, ...clone(data), id, updatedAt: now() };
    this.collection(type).set(id, after);
    await this.appendAudit(actor, `${type}.updated`, type, id, before, after);
    return clone(after);
  }

  async deleteResource(type, id, actor) {
    const before = await this.getResource(type, id);
    const after = { ...before, active: false, updatedAt: now() };
    this.collection(type).set(id, after);
    await this.appendAudit(actor, `${type}.deactivated`, type, id, before, after);
    return clone(after);
  }

  async listBlackouts(resourceType, resourceId) {
    return clone([...this.blackouts.values()].filter((item) =>
      (!resourceType || item.resourceType === resourceType) &&
      (!resourceId || item.resourceId === resourceId),
    ));
  }

  async createBlackout(data, actor) {
    const record = { id: randomUUID(), ...clone(data), createdAt: now() };
    this.blackouts.set(record.id, record);
    await this.appendAudit(actor, "blackout.created", "blackout", record.id, null, record);
    return clone(record);
  }

  async hasConflict(args) {
    return this.conflictFor(args);
  }

  // Deliberately synchronous. Callers that commit (createBooking, createHold) run
  // this and their write in one uninterrupted block, so two simultaneous requests
  // cannot both pass the check before either writes. Postgres gets the same
  // guarantee from the `no_overlapping_venue_booking` exclusion constraint.
  //
  // `ignoreHoldsBy` lets a requester's own hold pass through: a hold must block
  // everyone else and never the person who took it.
  conflictFor({ resourceType, resourceId, startAt, endAt, excludeBookingId, quantity = 1, ignoreHoldsBy, excludeHoldId }) {
    const overlap = (item) => item.startAt < endAt && item.endAt > startAt;
    const overlappingBookings = [...this.bookings.values()].filter((item) =>
      item.id !== excludeBookingId &&
      item.resourceType === resourceType &&
      item.resourceId === resourceId &&
      !["cancelled", "rejected"].includes(item.status) &&
      overlap(item),
    );
    const overlappingHolds = [...this.holds.values()].filter((item) =>
      item.id !== excludeHoldId &&
      item.resourceType === resourceType &&
      item.resourceId === resourceId &&
      item.heldBy !== ignoreHoldsBy &&
      isHoldActive(item) &&
      overlap(item),
    );
    const blackout = [...this.blackouts.values()].find((item) =>
      item.resourceType === resourceType &&
      (item.resourceId === null || item.resourceId === resourceId) &&
      overlap(item),
    );
    if (blackout) return { ...clone(blackout), conflictType: "blackout" };
    if (resourceType === "venue") {
      if (overlappingBookings[0]) return { ...clone(overlappingBookings[0]), conflictType: "booking" };
      if (overlappingHolds[0]) {
        return { conflictType: "hold", startAt: overlappingHolds[0].startAt, endAt: overlappingHolds[0].endAt, expiresAt: overlappingHolds[0].expiresAt };
      }
      return null;
    }
    const item = this.equipment.get(resourceId);
    if (!item) throw notFound("Equipment item");
    const sumQuantity = (total, entry) => total + Number(entry.quantity || 1);
    const used = overlappingBookings.reduce(sumQuantity, 0) + overlappingHolds.reduce(sumQuantity, 0);
    if (used + Number(quantity) > Number(item.quantity)) {
      return { conflictType: "insufficient_stock", available: Math.max(0, Number(item.quantity) - used) };
    }
    return null;
  }

  // --- EPIC-03 / US-04B: temporary slot holds ---------------------------------

  async createHold(data, actor) {
    const existing = this.conflictFor({ ...data, ignoreHoldsBy: actor.id });
    if (existing) throw conflict("That slot is no longer available to hold", { conflict: existing });
    const record = {
      id: randomUUID(),
      resourceType: data.resourceType,
      resourceId: data.resourceId,
      startAt: data.startAt,
      endAt: data.endAt,
      quantity: Number(data.quantity || 1),
      heldBy: actor.id,
      expiresAt: holdExpiryFrom(),
      releasedAt: null,
      bookingId: null,
      createdAt: now(),
    };
    this.holds.set(record.id, record);
    return clone(record);
  }

  async getHold(id) {
    const hold = this.holds.get(id);
    if (!hold) throw notFound("Hold");
    return clone(hold);
  }

  async releaseHold(id, actor) {
    const hold = this.holds.get(id);
    if (!hold) throw notFound("Hold");
    if (hold.heldBy !== actor.id && actor.role !== "admin") {
      throw forbidden("Only the person holding this slot can release it");
    }
    hold.releasedAt = hold.releasedAt || now();
    return clone(hold);
  }

  async listActiveHolds({ resourceType, resourceId, from, to } = {}) {
    return clone([...this.holds.values()].filter((item) =>
      isHoldActive(item) &&
      (!resourceType || item.resourceType === resourceType) &&
      (!resourceId || item.resourceId === resourceId) &&
      (!from || item.endAt > from) &&
      (!to || item.startAt < to),
    ).sort((a, b) => a.startAt.localeCompare(b.startAt)));
  }

  async listHoldsForUser(userId) {
    return clone([...this.holds.values()]
      .filter((item) => item.heldBy === userId && isHoldActive(item))
      .sort((a, b) => a.startAt.localeCompare(b.startAt)));
  }

  async consumeHold(holdId, bookingId) {
    const hold = this.holds.get(holdId);
    if (!hold) throw notFound("Hold");
    hold.bookingId = bookingId;
    hold.releasedAt = now();
    return clone(hold);
  }

  async listBookings(filters = {}) {
    let values = [...this.bookings.values()];
    for (const key of ["requesterId", "resourceType", "resourceId", "status"]) {
      if (filters[key]) values = values.filter((item) => item[key] === filters[key]);
    }
    if (filters.from) values = values.filter((item) => item.endAt > filters.from);
    if (filters.to) values = values.filter((item) => item.startAt < filters.to);
    return clone(values.sort((a, b) => a.startAt.localeCompare(b.startAt)));
  }

  async getBooking(id) {
    const booking = this.bookings.get(id);
    if (!booking) throw notFound("Booking");
    return clone(booking);
  }

  async createBooking(data, actor) {
    // Resolve approvals first so that the conflict check and the write below are
    // one synchronous, uninterruptible step (US-04C).
    const steps = await this.resolveApprovalSteps(data.resourceType, data.resourceId);
    const existing = this.conflictFor({ ...data, ignoreHoldsBy: actor.id });
    if (existing) throw conflict("The resource is unavailable for that time", { conflict: existing });
    const record = {
      id: randomUUID(),
      ...clone(data),
      requesterId: actor.id,
      status: steps.length ? "pending" : "approved",
      currentApprovalOrder: steps.length ? 1 : null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.bookings.set(record.id, record);
    this.decisions.set(record.id, []);
    await this.appendAudit(actor, "booking.created", "booking", record.id, null, record);
    return clone(record);
  }

  async updateBooking(id, data, actor) {
    const before = await this.getBooking(id);
    const candidate = { ...before, ...clone(data), id, updatedAt: now() };
    const existing = this.conflictFor({ ...candidate, excludeBookingId: id, ignoreHoldsBy: actor.id });
    if (existing) throw conflict("The resource is unavailable for that time", { conflict: existing });
    this.bookings.set(id, candidate);
    await this.appendAudit(actor, "booking.updated", "booking", id, before, candidate);
    return clone(candidate);
  }

  async setBookingStatus(id, status, actor, extra = {}) {
    const before = await this.getBooking(id);
    const after = { ...before, ...extra, status, updatedAt: now() };
    this.bookings.set(id, after);
    await this.appendAudit(actor, `booking.${status}`, "booking", id, before, after);
    return clone(after);
  }

  async listApprovalFlows() {
    return clone([...this.approvalFlows.values()]);
  }

  async createApprovalFlow(data, actor) {
    const record = {
      id: randomUUID(),
      name: data.name,
      resourceType: data.resourceType,
      resourceId: data.resourceId ?? null,
      active: data.active ?? true,
      steps: data.steps.map((step, index) => ({
        id: randomUUID(),
        order: index + 1,
        role: step.role || "approver",
        approverId: step.approverId || null,
        label: step.label || `Approval ${index + 1}`,
      })),
      createdAt: now(),
      updatedAt: now(),
    };
    this.approvalFlows.set(record.id, record);
    await this.appendAudit(actor, "approval_flow.created", "approval_flow", record.id, null, record);
    return clone(record);
  }

  async resolveApprovalSteps(resourceType, resourceId) {
    const candidates = [...this.approvalFlows.values()].filter((flow) =>
      flow.active && flow.resourceType === resourceType &&
      (flow.resourceId === resourceId || flow.resourceId === null),
    );
    const flow = candidates.find((item) => item.resourceId === resourceId) || candidates[0];
    return clone(flow?.steps || []);
  }

  async getApprovalContext(bookingId) {
    const booking = await this.getBooking(bookingId);
    const steps = await this.resolveApprovalSteps(booking.resourceType, booking.resourceId);
    return { booking, steps, decisions: clone(this.decisions.get(bookingId) || []) };
  }

  async listPendingApprovals(user) {
    const pending = [];
    for (const booking of this.bookings.values()) {
      if (booking.status !== "pending") continue;
      const steps = await this.resolveApprovalSteps(booking.resourceType, booking.resourceId);
      const step = steps.find((item) => item.order === booking.currentApprovalOrder);
      if (step && (user.role === "admin" || step.approverId === user.id || (!step.approverId && step.role === user.role))) {
        pending.push({ ...clone(booking), currentStep: clone(step) });
      }
    }
    return pending;
  }

  async addDecision(bookingId, step, decision, comment, actor) {
    const decisions = this.decisions.get(bookingId) || [];
    if (decisions.some((item) => item.stepId === step.id)) {
      throw conflict("This approval step has already been decided");
    }
    const record = {
      id: randomUUID(), bookingId, stepId: step.id, stepOrder: step.order,
      approverId: actor.id, decision, comment: comment || null, decidedAt: now(),
    };
    decisions.push(record);
    this.decisions.set(bookingId, decisions);
    await this.appendAudit(actor, `approval.${decision}`, "booking", bookingId, null, record);
    return clone(record);
  }

  async listContent(type, filters = {}) {
    const map = this[type];
    let values = [...map.values()];
    if (filters.tournamentId) values = values.filter((item) => item.tournamentId === filters.tournamentId);
    return clone(values);
  }

  async getContent(type, id) {
    const record = this[type].get(id);
    if (!record) throw notFound("Content");
    return clone(record);
  }

  async createContent(type, data, actor) {
    const record = { id: randomUUID(), ...clone(data), createdAt: now(), updatedAt: now() };
    this[type].set(record.id, record);
    await this.appendAudit(actor, `${type}.created`, type, record.id, null, record);
    return clone(record);
  }

  async updateContent(type, id, data, actor) {
    const before = await this.getContent(type, id);
    const after = { ...before, ...clone(data), id, updatedAt: now() };
    this[type].set(id, after);
    await this.appendAudit(actor, `${type}.updated`, type, id, before, after);
    return clone(after);
  }

  async utilization(from, to) {
    const bookings = await this.listBookings({ from, to });
    const approved = bookings.filter((item) => ["approved", "completed"].includes(item.status));
    const byResource = {};
    for (const item of approved) {
      const hours = (new Date(item.endAt) - new Date(item.startAt)) / 3_600_000;
      byResource[item.resourceId] = (byResource[item.resourceId] || 0) + hours;
    }
    return { from, to, bookingCount: bookings.length, approvedCount: approved.length, bookedHoursByResource: byResource };
  }

  async appendAudit(actor, action, entityType, entityId, before, after) {
    this.audit.push({
      id: randomUUID(), actorId: actor?.id || null, action, entityType, entityId,
      before: clone(before), after: clone(after), createdAt: now(),
    });
  }

  async listAudit(limit = 100) {
    return clone(this.audit.slice(-limit).reverse());
  }

  async enqueueNotification(data) {
    const record = { id: randomUUID(), status: "pending", attempts: 0, ...clone(data), createdAt: now() };
    this.notifications.set(record.id, record);
    return clone(record);
  }

  async listDueNotifications() {
    return clone([...this.notifications.values()].filter((item) =>
      (item.status === "pending" || (item.status === "failed" && item.attempts < 3)) &&
      (!item.sendAfter || item.sendAfter <= now()),
    ));
  }

  async markNotification(id, status, error = null) {
    const record = this.notifications.get(id);
    if (!record) throw notFound("Notification");
    Object.assign(record, { status, error, attempts: record.attempts + 1, updatedAt: now() });
    return clone(record);
  }
}
