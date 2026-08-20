import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import { loadConfig } from "./config.js";
import { createAuthenticator, requireRoles } from "./auth.js";
import { AppError, badRequest, forbidden } from "./errors.js";
import { assertBookingOwnerOrAdmin, publicBookingView, ROLES, validateInterval } from "./domain.js";
import { assertHoldMatchesBooking, HOLD_TTL_MINUTES, holdPublicView, isHoldActive } from "./holds.js";
import { describeRecommendations, DEFAULT_LIMIT, DEFAULT_WINDOW_DAYS, isPeak, recommendSlots } from "./recommendations.js";
import { MemoryStore, MEMORY_EQUIPMENT_SEED, MEMORY_VENUE_SEED } from "./store/memory.js";
import { PostgresStore } from "./store/postgres.js";
import {
  BOOTSTRAP_ADMIN_EMAIL, compileEmailPattern, loginWithPassword, sessionTokenHash, signupWithPassword,
} from "./password-auth.js";
import { createEquipmentToken, equipmentTokenHash, verifyEquipmentToken } from "./equipment-tokens.js";

const config = loadConfig();

function defaultStore() {
  if (config.databaseUrl) return new PostgresStore(config.databaseUrl);
  return new MemoryStore({ venues: MEMORY_VENUE_SEED, equipment: MEMORY_EQUIPMENT_SEED });
}

const id = z.string().min(1);
const iso = z.string().datetime({ offset: true });
const resourceType = z.enum(["venue", "equipment"]);
const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
});
const signupSchema = credentialsSchema.extend({ name: z.string().trim().min(2).max(120) });
const emailRuleSchema = z.object({ emailPattern: z.string().min(3).max(500) });
const roleAssignmentSchema = z.object({
  email: z.string().email(),
  role: z.enum(["requester", "approver", "scorekeeper"]),
});

const venueSchema = z.object({
  name: z.string().min(2),
  sportId: id.optional().nullable(),
  category: z.string().min(2).default("Sports venue"),
  location: z.string().optional().nullable(),
  locationId: id.optional().nullable(),
  photoPath: z.string().max(500).optional().nullable(),
  capacity: z.number().int().positive().default(1),
  amenities: z.array(z.string()).default([]),
  rules: z.record(z.string(), z.unknown()).default({}),
  active: z.boolean().optional(),
});

const equipmentSchema = z.object({
  name: z.string().min(2),
  sportId: id,
  photoPath: z.string().max(500).optional().nullable(),
  quantity: z.number().int().positive(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  tracking: z.enum(["ASSET", "BULK"]).default("BULK"),
  active: z.boolean().optional(),
});

const sportSchema = z.object({ name: z.string().trim().min(2).max(100), active: z.boolean().optional() });
const pocsSchema = z.object({ primaryPocId: id.optional().nullable(), secondaryPocId: id.optional().nullable() });
const teamSchema = z.object({
  name: z.string().trim().min(2).max(120), sportId: id, captainId: id,
  memberIds: z.array(id).default([]), active: z.boolean().optional(),
});
const equipmentRequestSchema = z.object({
  requestType: z.enum(["CASUAL", "TEAM", "RETURN"]),
  teamId: id.optional().nullable(), parentRequestId: id.optional().nullable(),
  expectedReturnAt: iso.optional().nullable(),
  items: z.array(z.object({ equipmentId: id, quantity: z.number().int().positive() })).min(1),
});
const equipmentDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(1000).optional().nullable(),
  confirmConcurrentIssue: z.boolean().optional().default(false),
});
const returnOutcomeSchema = z.object({ equipmentId: id, damaged: z.number().int().min(0).default(0), missing: z.number().int().min(0).default(0), note: z.string().max(1000).optional().nullable() });
const assetScanSchema = z.object({
  equipmentId: id, assetTag: z.string().trim().min(1).max(200),
  outcome: z.enum(["RETURNED", "DAMAGED", "MISSING"]).optional(),
  note: z.string().trim().max(1000).optional().nullable(),
});
const equipmentTransferSchema = z.object({
  fromState: z.enum(["IN_INVENTORY", "CASUAL_POOL", "HELD_BY_TEAM", "ISSUED_TO_STUDENT", "DAMAGED", "MISSING"]),
  toState: z.enum(["IN_INVENTORY", "CASUAL_POOL", "HELD_BY_TEAM", "ISSUED_TO_STUDENT", "DAMAGED", "MISSING"]),
  quantity: z.number().int().positive(),
  assetIds: z.array(id).default([]), custodyIds: z.array(id).default([]),
  teamId: id.optional().nullable(), studentId: id.optional().nullable(),
  reason: z.string().trim().max(1000).optional().nullable(),
});

const bookingSchema = z.object({
  resourceType,
  resourceId: id,
  title: z.string().min(2).max(160),
  purpose: z.string().max(2000).optional().nullable(),
  quantity: z.number().int().positive().default(1),
  startAt: iso,
  endAt: iso,
  metadata: z.record(z.string(), z.unknown()).default({}),
  // EPIC-03 / US-04B: optional, so a client without slot-lock support still books normally.
  holdId: id.optional(),
});

const holdSchema = z.object({
  resourceType,
  resourceId: id,
  startAt: iso,
  endAt: iso,
  quantity: z.number().int().positive().default(1),
});

const bookingUpdateSchema = bookingSchema.pick({
  title: true, purpose: true, quantity: true, startAt: true, endAt: true, metadata: true,
}).partial();

const blackoutSchema = z.object({
  resourceType,
  resourceId: id.optional().nullable(),
  startAt: iso,
  endAt: iso,
  reason: z.string().min(2).max(500),
});

const approvalFlowSchema = z.object({
  name: z.string().min(2),
  resourceType,
  resourceId: id.optional().nullable(),
  active: z.boolean().optional(),
  steps: z.array(z.object({
    label: z.string().min(2),
    role: z.enum(["approver", "admin"]).default("approver"),
    approverId: id.optional().nullable(),
  })).min(1),
});

const contentSchemas = {
  committee: z.object({
    name: z.string().min(2), title: z.string().min(2), email: z.string().email().optional().nullable(),
    phone: z.string().optional().nullable(), responsibilities: z.string().optional().nullable(),
    // Every sport this member is involved in, e.g. ["Cricket", "Badminton"] —
    // not just one. Rendered as one pill per tag on the frontend.
    tags: z.array(z.string().min(1)).default([]),
    displayOrder: z.number().int().default(0),
  }),
  gallery: z.object({
    title: z.string().min(2), eventName: z.string().optional().nullable(), occurredOn: z.string().date().optional().nullable(),
    mediaUrl: z.string().url(), thumbnailUrl: z.string().url().optional().nullable(), caption: z.string().optional().nullable(),
    // Which tournament this photo belongs to, if any — lets a tournament's
    // detail page query its own photos directly instead of matching on
    // eventName text.
    tournamentId: id.optional().nullable(),
  }),
  tournaments: z.object({
    name: z.string().min(2), description: z.string().optional().nullable(), startsOn: z.string().date().optional().nullable(),
    endsOn: z.string().date().optional().nullable(), status: z.enum(["draft", "published", "live", "completed"]).default("draft"),
    // blurb is the short one-liner a gallery card shows under the name;
    // description is the longer paragraph on the tournament's own page.
    blurb: z.string().optional().nullable(), venue: z.string().optional().nullable(),
  }),
  matches: z.object({
    tournamentId: id.optional().nullable(), sport: z.string().min(2), homeTeam: z.string().min(1), awayTeam: z.string().min(1),
    venueId: id.optional().nullable(), startsAt: iso, status: z.enum(["scheduled", "live", "completed", "cancelled"]).default("scheduled"),
    homeScore: z.record(z.string(), z.unknown()).default({}), awayScore: z.record(z.string(), z.unknown()).default({}),
    notes: z.string().optional().nullable(),
    // Plain-text venue label, independent of venueId (a real venues-table
    // link) -- lets a fixture show a ground/court name even when it isn't
    // matched to a bookable venue record. stage is the round/bracket label,
    // e.g. "Men's Singles - Semifinal", kept separate from notes.
    venue: z.string().optional().nullable(), stage: z.string().optional().nullable(),
  }),
  // Section-wise standings for a tournament (e.g. Sangram's Section A-I
  // points table) — one row per section/sport pair, unique per tournament.
  // Same write access as matches: this is scorekeeper territory, same as
  // updating a live score is.
  standings: z.object({
    tournamentId: id, section: z.string().min(1), sport: z.string().min(1), points: z.number().int().min(0).default(0),
  }),
};

const parse = (schema, input) => schema.parse(input);

async function enqueueApprovalMessages(store, booking, step) {
  if (!step) return;
  const recipients = step.approverId
    ? [await store.getUser(step.approverId)]
    : (await store.listUsers()).filter((user) => user.role === step.role || user.role === "admin");
  const unique = [...new Map(recipients.filter((user) => user.email).map((user) => [user.email, user])).values()];
  for (const recipient of unique) {
    const payload = { bookingId: booking.id, title: booking.title, approvalStep: step.label };
    await store.enqueueNotification({ recipient: recipient.email, template: "approval-pending", payload });
    await store.enqueueNotification({
      recipient: recipient.email,
      template: "approval-reminder",
      payload,
      sendAfter: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

// listBlackouts(type, id) returns only blackouts pinned to that exact resource,
// so fetch them all for the type and keep the institute-wide ones too.
async function blackoutsFor(store, { resourceType, resourceId, from, to }) {
  const all = await store.listBlackouts(resourceType, null);
  return all.filter((item) =>
    (!resourceId || item.resourceId === null || item.resourceId === resourceId) &&
    (!from || item.endAt > from) &&
    (!to || item.startAt < to));
}

// EPIC-04 / US-05B: gather everything that occupies the search window, then hand
// it to the pure heuristic. Kept here so the booking 409 path and the
// recommendations endpoint always answer with exactly the same logic.
async function alternativesFor(store, { resourceType, resourceId, startAt, endAt, limit, windowDays }) {
  const from = new Date(new Date(startAt).getTime() - DAY_MS).toISOString();
  const to = new Date(new Date(startAt).getTime() + (windowDays + 2) * DAY_MS).toISOString();
  const [bookings, blackouts, holds] = await Promise.all([
    store.listBookings({ resourceType, resourceId, from, to }),
    blackoutsFor(store, { resourceType, resourceId, from, to }),
    store.listActiveHolds({ resourceType, resourceId, from, to }),
  ]);
  return recommendSlots({
    startAt,
    endAt,
    occupied: bookings.filter((item) => !["cancelled", "rejected"].includes(item.status)),
    blackouts,
    holds,
    limit,
    windowDays,
  });
}

export function createApp(options = {}) {
  const store = options.store || defaultStore();
  const authConfig = options.auth || config.auth;
  const authenticate = options.authenticate || createAuthenticator(authConfig, store);
  const app = express();
  app.locals.store = store;

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.allowedOrigins.length === 0 || config.allowedOrigins.includes(origin)) return callback(null, true);
      callback(forbidden("Origin is not allowed"));
    },
  }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static("public"));
  app.use((req, res, next) => {
    req.requestId = req.headers["x-request-id"] || randomUUID();
    res.setHeader("x-request-id", req.requestId);
    next();
  });

  app.get("/", (_req, res) => res.json({ service: "IIM Lucknow Sports Operations API", docs: "/api/docs", health: "/api/v1/health" }));
  app.get("/api/docs", (_req, res) => res.redirect("/openapi.yaml"));
  app.get("/api/v1/health", (_req, res) => res.json({
    status: "ok",
    storage: config.databaseUrl ? "postgres" : "memory",
    timestamp: new Date().toISOString(),
  }));

  app.get("/api/v1/auth/config", async (_req, res) => {
    const settings = await store.getAuthSettings();
    res.json({ data: { emailPattern: settings.emailPattern, bootstrapAdminEmail: BOOTSTRAP_ADMIN_EMAIL } });
  });
  app.post("/api/v1/auth/signup", async (req, res) => {
    const data = await signupWithPassword(store, parse(signupSchema, req.body));
    res.status(201).json({ data });
  });
  app.post("/api/v1/auth/login", async (req, res) => {
    const data = await loginWithPassword(store, parse(credentialsSchema, req.body));
    res.json({ data });
  });

  app.get("/api/v1/public/venues", async (req, res) => {
    const data = await store.listResources("venue", { active: true, category: req.query.category, q: req.query.q });
    res.json({ data });
  });
  app.get("/api/v1/public/equipment", async (req, res) => {
    const data = await store.listResources("equipment", { active: true, category: req.query.category, q: req.query.q });
    res.json({ data });
  });
  app.get("/api/v1/public/equipment-catalog", async (_req, res) => {
    res.json({ data: await store.listEquipmentCatalog() });
  });
  app.get("/api/v1/public/availability", async (req, res) => {
    const filters = {
      resourceType: req.query.resourceType,
      resourceId: req.query.resourceId,
      from: req.query.from,
      to: req.query.to,
    };
    if (!filters.resourceType || !filters.from || !filters.to) {
      throw badRequest("resourceType, from, and to are required");
    }
    const data = (await store.listBookings(filters))
      .filter((item) => !["cancelled", "rejected"].includes(item.status))
      .map(publicBookingView);

    // EPIC-03 / US-04A: the calendar has to grey out blackouts and live holds too.
    // These are additive keys — `data` keeps its existing shape and meaning.
    const [blackouts, holds] = await Promise.all([
      blackoutsFor(store, filters),
      store.listActiveHolds(filters),
    ]);
    res.json({
      data,
      blackouts: blackouts.map(({ id, resourceType: type, resourceId, startAt, endAt, reason }) =>
        ({ id, resourceType: type, resourceId, startAt, endAt, reason })),
      holds: holds.map(holdPublicView),
    });
  });

  // EPIC-03 / US-04B: anonymised live holds, so a second student sees a slot is
  // taken without learning who is taking it.
  app.get("/api/v1/public/holds", async (req, res) => {
    if (!req.query.resourceType) throw badRequest("resourceType is required");
    const holds = await store.listActiveHolds({
      resourceType: req.query.resourceType,
      resourceId: req.query.resourceId,
      from: req.query.from,
      to: req.query.to,
    });
    res.json({ data: holds.map(holdPublicView), meta: { ttlMinutes: HOLD_TTL_MINUTES } });
  });

  // EPIC-04 / US-05B: alternatives for a slot that is (or might be) unavailable.
  app.get("/api/v1/public/recommendations", async (req, res) => {
    const { resourceType: type, resourceId, startAt, endAt } = req.query;
    if (!type || !resourceId || !startAt || !endAt) {
      throw badRequest("resourceType, resourceId, startAt, and endAt are required");
    }
    const { startAt: from, endAt: to } = validateInterval(startAt, endAt);
    const limit = Math.min(Number(req.query.limit || DEFAULT_LIMIT), 10);
    const windowDays = Math.min(Number(req.query.windowDays || DEFAULT_WINDOW_DAYS), 30);
    const data = await alternativesFor(store, { resourceType: type, resourceId, startAt: from, endAt: to, limit, windowDays });
    res.json({
      data,
      meta: {
        requestedPeak: isPeak(from),
        windowDays,
        reason: describeRecommendations(data, { requestedPeak: isPeak(from) }),
      },
    });
  });
  for (const type of ["committee", "gallery", "tournaments", "matches", "standings"]) {
    app.get(`/api/v1/public/${type}`, async (req, res) => {
      const data = await store.listContent(type, { tournamentId: req.query.tournamentId });
      const publicData = type === "tournaments" ? data.filter((item) => item.status !== "draft") : data;
      res.json({ data: publicData });
    });
  }

  app.use("/api/v1", async (req, _res, next) => {
    try {
      if (req.path.startsWith("/jobs/")) return next();
      req.authIdentity = await authenticate(req);
      req.user = await store.ensureUser(req.authIdentity);
      if (authConfig.mode === "supabase") {
        const authSettings = await store.getAuthSettings();
        const privilegedServiceEmail = [BOOTSTRAP_ADMIN_EMAIL, "inventory@iiml.ac.in"].includes(req.user.email);
        if (!privilegedServiceEmail && !compileEmailPattern(authSettings.emailPattern).test(req.user.email)) {
          throw forbidden("This email is no longer eligible to sign in");
        }
      }
      if (req.user.mustChangePassword && !["/me", "/account/password-changed", "/auth/logout"].includes(req.path)) {
        throw new AppError(403, "MUST_CHANGE_PASSWORD", "Password change required before continuing");
      }
      next();
    } catch (error) { next(error); }
  });

  app.get("/api/v1/me", (req, res) => res.json({ data: req.user }));
  app.post("/api/v1/account/password-changed", async (req, res) => {
    if (authConfig.mode === "supabase" && req.user.mustChangePassword) {
      const authUpdatedAt = new Date(req.authIdentity.authUpdatedAt || 0).getTime();
      const profileCreatedAt = new Date(req.user.createdAt || Date.now()).getTime();
      if (authUpdatedAt <= profileCreatedAt) throw conflict("Update the password with Supabase Auth before clearing the first-login requirement");
    }
    res.json({ data: await store.clearMustChangePassword(req.user.id) });
  });

  // Equipment requests deliberately use their own workflow and never enter the
  // venue reservation approval queue.
  app.get("/api/v1/equipment-module/sports", async (_req, res) => res.json({ data: await store.listSports() }));
  app.get("/api/v1/equipment-module/teams", async (_req, res) => res.json({ data: await store.listTeams() }));
  app.get("/api/v1/equipment-module/requests", async (req, res) => res.json({ data: await store.listEquipmentRequests(req.user) }));
  app.post("/api/v1/equipment-module/requests", async (req, res) => {
    if (req.user.role === "inventory_kiosk") throw forbidden();
    const input = parse(equipmentRequestSchema, req.body);
    if (input.requestType === "CASUAL" && !input.expectedReturnAt) throw badRequest("Casual requests require an expected return time");
    if (input.requestType === "TEAM" && !input.teamId) throw badRequest("Team requests require a team");
    if (input.requestType === "RETURN" && !input.parentRequestId) throw badRequest("Return requests require the original request");
    res.status(201).json({ data: await store.createEquipmentRequest(input, req.user) });
  });
  app.post("/api/v1/equipment-module/requests/:id/decision", requireRoles("approver", "admin"), async (req, res) => {
    const input = parse(equipmentDecisionSchema, req.body);
    res.json({ data: await store.decideEquipmentRequest(req.params.id, input.decision, input.note, req.user, input.confirmConcurrentIssue) });
  });
  app.post("/api/v1/equipment-module/requests/:id/qr", async (req, res) => {
    const request = await store.getEquipmentRequest(req.params.id);
    if (request.requesterId !== req.user.id && req.user.role !== "admin") throw forbidden();
    if (request.status !== "APPROVED") throw conflict("A QR token requires a currently approved request");
    const purpose = request.requestType === "RETURN" ? "RETURN" : "ISSUE";
    const token = createEquipmentToken(config.qr.secret);
    const expiresAt = new Date(Date.now() + config.qr.ttlHours * 60 * 60 * 1000).toISOString();
    await store.createEquipmentQr({ requestId: request.id, purpose, tokenHash: equipmentTokenHash(token), expiresAt });
    res.status(201).json({ data: { token, purpose, expiresAt } });
  });
  app.post("/api/v1/equipment-module/kiosk/inspect", requireRoles("inventory_kiosk", "admin"), async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(20) }), req.body);
    verifyEquipmentToken(token, config.qr.secret);
    res.json({ data: await store.inspectEquipmentQr(equipmentTokenHash(token)) });
  });
  app.post("/api/v1/equipment-module/kiosk/confirm", requireRoles("inventory_kiosk", "admin"), async (req, res) => {
    const input = parse(z.object({ token: z.string().min(20), outcomes: z.array(returnOutcomeSchema).default([]), assetScans: z.array(assetScanSchema).default([]), confirmConcurrentIssue: z.boolean().optional().default(false) }), req.body);
    verifyEquipmentToken(input.token, config.qr.secret);
    res.json({ data: await store.redeemEquipmentQr(equipmentTokenHash(input.token), input.outcomes, input.assetScans, req.user, input.confirmConcurrentIssue) });
  });
  app.get("/api/v1/equipment-module/audit", requireRoles("approver", "admin"), async (req, res) => {
    res.json({ data: await store.listEquipmentAudit(req.query) });
  });
  app.get("/api/v1/equipment-module/inventory", requireRoles("approver", "admin"), async (req, res) => {
    res.json({ data: await store.listEquipmentInventory(req.query) });
  });
  app.post("/api/v1/equipment-module/inventory/:id/transfer", requireRoles("admin"), async (req, res) => {
    const input = parse(equipmentTransferSchema, req.body);
    const isAllocation = [input.fromState, input.toState].every((state) => ["IN_INVENTORY", "CASUAL_POOL"].includes(state));
    if (!isAllocation && !input.reason) throw badRequest("Manual custody corrections require a reason");
    res.json({ data: await store.transferEquipmentState(req.params.id, input, req.user) });
  });
  app.post("/api/v1/equipment-module/inventory/:id/resolve", requireRoles("admin"), async (req, res) => {
    const { action } = parse(z.object({ action: z.enum(["restore", "writeoff"]) }), req.body);
    res.json({ data: await store.resolveEquipmentException(req.params.id, action, req.user) });
  });
  app.post("/api/v1/auth/logout", async (req, res) => {
    const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "")?.[1];
    if (token) await store.deleteAuthSession(sessionTokenHash(token));
    res.status(204).end();
  });

  for (const [path, type, schema] of [["venues", "venue", venueSchema], ["equipment", "equipment", equipmentSchema]]) {
    app.get(`/api/v1/${path}`, async (req, res) => {
      const data = await store.listResources(type, {
        active: req.query.active === undefined ? undefined : req.query.active === "true",
        category: req.query.category,
        q: req.query.q,
        minCapacity: req.query.minCapacity ? Number(req.query.minCapacity) : undefined,
      });
      res.json({ data });
    });
    app.get(`/api/v1/${path}/:id`, async (req, res) => res.json({ data: await store.getResource(type, req.params.id) }));
    app.post(`/api/v1/${path}`, requireRoles("admin"), async (req, res) => {
      const input = parse(schema, req.body);
      const data = await store.createResource(type, input, req.user);
      res.status(201).json({ data });
    });
    app.patch(`/api/v1/${path}/:id`, requireRoles("admin"), async (req, res) => {
      const input = parse(schema.partial(), req.body);
      const data = await store.updateResource(type, req.params.id, input, req.user);
      res.json({ data });
    });
    app.delete(`/api/v1/${path}/:id`, requireRoles("admin"), async (req, res) => {
      const data = await store.deleteResource(type, req.params.id, req.user);
      res.json({ data });
    });
  }

  // --- EPIC-03 / US-04B: slot holds -----------------------------------------
  // A hold is advisory and short-lived. It stops a race during form-filling; the
  // booking, and its database exclusion constraint, remain the source of truth.

  app.get("/api/v1/holds/mine", async (req, res) => {
    res.json({ data: await store.listHoldsForUser(req.user.id), meta: { ttlMinutes: HOLD_TTL_MINUTES } });
  });

  app.post("/api/v1/holds", async (req, res) => {
    const input = parse(holdSchema, req.body);
    Object.assign(input, validateInterval(input.startAt, input.endAt));
    const resource = await store.getResource(input.resourceType, input.resourceId);
    if (!resource.active) throw badRequest("The selected resource is inactive");
    const data = await store.createHold(input, req.user);
    res.status(201).json({ data, meta: { ttlMinutes: HOLD_TTL_MINUTES } });
  });

  app.delete("/api/v1/holds/:id", async (req, res) => {
    res.json({ data: await store.releaseHold(req.params.id, req.user) });
  });

  app.get("/api/v1/bookings", async (req, res) => {
    const filters = { ...req.query };
    if (req.user.role !== "admin") filters.requesterId = req.user.id;
    res.json({ data: await store.listBookings(filters) });
  });
  app.get("/api/v1/bookings/:id", async (req, res) => {
    const booking = await store.getBooking(req.params.id);
    if (booking.requesterId !== req.user.id && !["approver", "admin"].includes(req.user.role)) throw forbidden();
    res.json({ data: booking });
  });
  app.post("/api/v1/bookings", async (req, res) => {
    const { holdId, ...input } = parse(bookingSchema, req.body);
    Object.assign(input, validateInterval(input.startAt, input.endAt));
    const resource = await store.getResource(input.resourceType, input.resourceId);
    if (!resource.active) throw badRequest("The selected resource is inactive");

    // US-04B: a hold only counts if it is yours, still live, and on this exact slot.
    if (holdId) {
      const hold = await store.getHold(holdId);
      if (hold.heldBy !== req.user.id) throw forbidden("That hold belongs to someone else");
      if (!isHoldActive(hold)) throw badRequest("Your hold on this slot has expired");
      assertHoldMatchesBooking(hold, input);
    }

    let data;
    try {
      data = await store.createBooking(input, req.user);
    } catch (error) {
      // US-05C: answer the clash and the way out in one response, so the frontend
      // can offer alternatives without a second round-trip.
      if (error.status === 409) {
        error.details = {
          ...error.details,
          alternatives: await alternativesFor(store, {
            resourceType: input.resourceType,
            resourceId: input.resourceId,
            startAt: input.startAt,
            endAt: input.endAt,
            limit: DEFAULT_LIMIT,
            windowDays: DEFAULT_WINDOW_DAYS,
          }),
        };
      }
      throw error;
    }
    if (holdId) await store.consumeHold(holdId, data.id);
    await store.enqueueNotification({
      recipient: req.user.email,
      template: data.status === "approved" ? "booking-approved" : "booking-received",
      payload: { bookingId: data.id, title: data.title },
    });
    if (data.status === "pending") {
      const steps = await store.resolveApprovalSteps(data.resourceType, data.resourceId);
      await enqueueApprovalMessages(store, data, steps.find((step) => step.order === data.currentApprovalOrder));
    }
    res.status(201).json({ data });
  });
  app.patch("/api/v1/bookings/:id", async (req, res) => {
    const booking = await store.getBooking(req.params.id);
    assertBookingOwnerOrAdmin(booking, req.user);
    if (booking.status !== "pending" && req.user.role !== "admin") throw badRequest("Only pending bookings can be edited");
    const input = parse(bookingUpdateSchema, req.body);
    if (input.startAt || input.endAt) {
      Object.assign(input, validateInterval(input.startAt || booking.startAt, input.endAt || booking.endAt));
    }
    res.json({ data: await store.updateBooking(booking.id, input, req.user) });
  });
  app.post("/api/v1/bookings/:id/cancel", async (req, res) => {
    const booking = await store.getBooking(req.params.id);
    assertBookingOwnerOrAdmin(booking, req.user);
    if (["cancelled", "completed"].includes(booking.status)) throw badRequest("Booking cannot be cancelled");
    res.json({ data: await store.setBookingStatus(booking.id, "cancelled", req.user) });
  });

  app.get("/api/v1/approvals/pending", requireRoles("approver", "admin"), async (req, res) => {
    res.json({ data: await store.listPendingApprovals(req.user) });
  });
  app.post("/api/v1/approvals/:bookingId/decision", requireRoles("approver", "admin"), async (req, res) => {
    const input = parse(z.object({ decision: z.enum(["approve", "reject"]), comment: z.string().max(2000).optional() }), req.body);
    const { booking, steps, decisions } = await store.getApprovalContext(req.params.bookingId);
    if (booking.status !== "pending") throw badRequest("Booking is not pending approval");
    const step = steps.find((item) => item.order === booking.currentApprovalOrder);
    if (!step) throw badRequest("No active approval step is configured");
    if (req.user.role !== "admin" && step.approverId !== req.user.id && (step.approverId || step.role !== req.user.role)) throw forbidden();
    const decision = input.decision === "approve" ? "approved" : "rejected";
    await store.addDecision(booking.id, step, decision, input.comment, req.user);
    const nextStep = decision === "approved" ? steps.find((item) => item.order === step.order + 1) : null;
    const status = decision === "rejected" ? "rejected" : nextStep ? "pending" : "approved";
    const data = await store.setBookingStatus(booking.id, status, req.user, { currentApprovalOrder: nextStep?.order ?? null });
    const requester = await store.getUser(booking.requesterId);
    await store.enqueueNotification({
      recipient: requester.email,
      template: `booking-${status}`,
      payload: { bookingId: booking.id, title: booking.title, comment: input.comment || null },
    });
    if (nextStep) await enqueueApprovalMessages(store, data, nextStep);
    res.json({ data: { booking: data, decisions: [...decisions, { stepId: step.id, decision }] } });
  });

  const requireBootstrapAdmin = (req, _res, next) => {
    if (req.user.role !== "admin" || req.user.email !== BOOTSTRAP_ADMIN_EMAIL) return next(forbidden("Only the Sports Committee administrator can access this area"));
    next();
  };
  app.post("/api/v1/admin/sports", requireBootstrapAdmin, async (req, res) => {
    res.status(201).json({ data: await store.createSport(parse(sportSchema, req.body), req.user) });
  });
  app.post("/api/v1/admin/campus-locations", requireBootstrapAdmin, async (req, res) => {
    res.status(201).json({ data: await store.createCatalogEntry("location", parse(sportSchema, req.body), req.user) });
  });
  app.patch("/api/v1/admin/campus-locations/:id", requireBootstrapAdmin, async (req, res) => {
    res.json({ data: await store.updateCatalogEntry("location", req.params.id, parse(sportSchema.partial(), req.body), req.user) });
  });
  app.post("/api/v1/admin/inventory-kiosk", requireBootstrapAdmin, async (req, res) => {
    const { password } = parse(z.object({ password: z.string().min(8).max(200) }), req.body);
    if (!config.auth.supabaseUrl || !config.auth.supabaseServiceRoleKey) throw badRequest("Supabase service credentials are not configured");
    const headers = { apikey: config.auth.supabaseServiceRoleKey, Authorization: `Bearer ${config.auth.supabaseServiceRoleKey}`, "Content-Type": "application/json" };
    const list = await fetch(`${config.auth.supabaseUrl}/auth/v1/admin/users?page=1&per_page=1000`, { headers });
    if (!list.ok) throw new AppError(502, "SUPABASE_AUTH_ERROR", "Could not inspect Supabase Auth users");
    const payload = await list.json();
    const users = Array.isArray(payload) ? payload : (payload.users || []);
    if (users.some((item) => String(item.email).toLowerCase() === "inventory@iiml.ac.in")) throw conflict("The inventory kiosk account already exists; it was not reset or overwritten");
    const created = await fetch(`${config.auth.supabaseUrl}/auth/v1/admin/users`, { method: "POST", headers, body: JSON.stringify({ email: "inventory@iiml.ac.in", password, email_confirm: true, user_metadata: { name: "Inventory Kiosk" } }) });
    if (!created.ok) throw new AppError(502, "SUPABASE_AUTH_ERROR", "Could not create the inventory kiosk account");
    res.status(201).json({ data: await store.markInventoryKiosk("inventory@iiml.ac.in") });
  });
  app.patch("/api/v1/admin/sports/:id", requireBootstrapAdmin, async (req, res) => {
    res.json({ data: await store.updateSport(req.params.id, parse(sportSchema.partial(), req.body), req.user) });
  });
  app.put("/api/v1/admin/sports/:id/pocs", requireBootstrapAdmin, async (req, res) => {
    res.json({ data: await store.setSportPocs(req.params.id, parse(pocsSchema, req.body), req.user) });
  });
  app.put("/api/v1/admin/sports/:id/captain", requireBootstrapAdmin, async (req, res) => {
    const { email } = parse(z.object({ email: z.string().trim().email().transform((value) => value.toLowerCase()) }), req.body);
    res.json({ data: await store.assignSportCaptain(req.params.id, email, req.user) });
  });
  app.post("/api/v1/admin/teams", requireBootstrapAdmin, async (req, res) => {
    res.status(201).json({ data: await store.createTeam(parse(teamSchema, req.body), req.user) });
  });
  app.post("/api/v1/admin/equipment/:id/assets", requireBootstrapAdmin, async (req, res) => {
    const input = parse(z.object({ assets: z.array(z.object({ assetTag: z.string().trim().min(1).max(100), serialNumber: z.string().trim().max(200).optional().nullable(), condition: z.enum(["excellent", "good", "fair", "maintenance", "retired"]).optional() })).min(1) }), req.body);
    res.status(201).json({ data: await store.createEquipmentAssets(req.params.id, input.assets, req.user) });
  });
  app.patch("/api/v1/admin/teams/:id", requireBootstrapAdmin, async (req, res) => {
    res.json({ data: await store.updateTeam(req.params.id, parse(teamSchema.partial(), req.body), req.user) });
  });
  app.get("/api/v1/admin/users", requireBootstrapAdmin, async (_req, res) => res.json({ data: await store.listUsers() }));
  app.patch("/api/v1/admin/users/:id/role", requireBootstrapAdmin, async (req, res) => {
    const { role } = parse(z.object({ role: z.enum(["requester", "approver", "scorekeeper"]) }), req.body);
    res.json({ data: await store.setUserRole(req.params.id, role) });
  });
  app.get("/api/v1/admin/role-assignments", requireBootstrapAdmin, async (_req, res) => {
    res.json({ data: await store.listRoleAssignments() });
  });
  app.post("/api/v1/admin/role-assignments", requireBootstrapAdmin, async (req, res) => {
    const { email, role } = parse(roleAssignmentSchema, req.body);
    const data = await store.setRoleAssignment(email, role, req.user);
    res.status(role === "requester" ? 200 : 201).json({ data });
  });
  app.delete("/api/v1/admin/role-assignments/:email", requireBootstrapAdmin, async (req, res) => {
    await store.deleteRoleAssignment(req.params.email, req.user);
    res.status(204).end();
  });
  app.get("/api/v1/admin/auth-settings", requireBootstrapAdmin, async (_req, res) => {
    res.json({ data: await store.getAuthSettings() });
  });
  app.put("/api/v1/admin/auth-settings", requireBootstrapAdmin, async (req, res) => {
    const { emailPattern } = parse(emailRuleSchema, req.body);
    compileEmailPattern(emailPattern);
    res.json({ data: await store.setEmailPattern(emailPattern, req.user) });
  });
  app.get("/api/v1/admin/approval-flows", requireRoles("admin"), async (_req, res) => res.json({ data: await store.listApprovalFlows() }));
  app.post("/api/v1/admin/approval-flows", requireRoles("admin"), async (req, res) => {
    res.status(201).json({ data: await store.createApprovalFlow(parse(approvalFlowSchema, req.body), req.user) });
  });
  app.get("/api/v1/admin/blackouts", requireRoles("admin"), async (req, res) => {
    res.json({ data: await store.listBlackouts(req.query.resourceType, req.query.resourceId) });
  });
  app.post("/api/v1/admin/blackouts", requireRoles("admin"), async (req, res) => {
    const input = parse(blackoutSchema, req.body);
    Object.assign(input, validateInterval(input.startAt, input.endAt));
    res.status(201).json({ data: await store.createBlackout(input, req.user) });
  });
  app.get("/api/v1/admin/reports/utilization", requireRoles("admin"), async (req, res) => {
    if (!req.query.from || !req.query.to) throw badRequest("from and to are required");
    res.json({ data: await store.utilization(req.query.from, req.query.to) });
  });
  app.get("/api/v1/admin/audit-log", requireRoles("admin"), async (req, res) => {
    res.json({ data: await store.listAudit(Math.min(Number(req.query.limit || 100), 500)) });
  });

  for (const type of ["committee", "gallery", "tournaments", "matches", "standings"]) {
    // Standings get the same write access as matches: editing a live score
    // and editing that score's effect on the table are the same job.
    const roles = ["matches", "standings"].includes(type) ? ["scorekeeper", "admin"] : ["admin"];
    app.get(`/api/v1/${type}`, async (req, res) => res.json({ data: await store.listContent(type, { tournamentId: req.query.tournamentId }) }));
    app.post(`/api/v1/${type}`, requireRoles(...roles), async (req, res) => {
      res.status(201).json({ data: await store.createContent(type, parse(contentSchemas[type], req.body), req.user) });
    });
    app.patch(`/api/v1/${type}/:id`, requireRoles(...roles), async (req, res) => {
      res.json({ data: await store.updateContent(type, req.params.id, parse(contentSchemas[type].partial(), req.body), req.user) });
    });
    app.delete(`/api/v1/${type}/:id`, requireRoles(...roles), async (req, res) => {
      await store.deleteContent(type, req.params.id, req.user);
      res.json({ data: { id: req.params.id } });
    });
  }

  app.get("/api/v1/jobs/reminders", async (req, res) => {
    const auth = String(req.headers.authorization || "");
    if (!config.cronSecret || auth !== `Bearer ${config.cronSecret}`) throw forbidden("Invalid cron secret");
    const due = await store.listDueNotifications();
    const results = [];
    for (const notification of due) {
      try {
        if (!config.email.webhookUrl) throw new Error("EMAIL_WEBHOOK_URL is not configured");
        const response = await fetch(config.email.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${config.email.webhookToken}` },
          body: JSON.stringify(notification),
        });
        if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
        await store.markNotification(notification.id, "sent");
        results.push({ id: notification.id, status: "sent" });
      } catch (error) {
        await store.markNotification(notification.id, "failed", error.message);
        results.push({ id: notification.id, status: "failed", error: error.message });
      }
    }
    res.json({ processed: results.length, results });
  });

  app.use((req, _res, next) => next(new AppError(404, "NOT_FOUND", `Route ${req.method} ${req.path} not found`)));
  app.use((error, req, res, _next) => {
    const normalized = error instanceof ZodError
      ? new AppError(400, "VALIDATION_ERROR", "Request validation failed", error.issues)
      : error;
    const status = normalized.status || 500;
    if (status >= 500) console.error({ requestId: req.requestId, error: normalized });
    res.status(status).json({
      error: {
        code: normalized.code || "INTERNAL_ERROR",
        message: status >= 500 ? "An unexpected error occurred" : normalized.message,
        details: normalized.details,
        requestId: req.requestId,
      },
    });
  });

  return app;
}

const app = createApp();
export default app;
