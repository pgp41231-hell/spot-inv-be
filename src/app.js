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
import { MemoryStore } from "./store/memory.js";
import { PostgresStore } from "./store/postgres.js";

const config = loadConfig();

function defaultStore() {
  if (config.databaseUrl) return new PostgresStore(config.databaseUrl);
  return new MemoryStore();
}

const id = z.string().min(1);
const iso = z.string().datetime({ offset: true });
const resourceType = z.enum(["venue", "equipment"]);

const venueSchema = z.object({
  name: z.string().min(2),
  category: z.string().min(2),
  location: z.string().optional().nullable(),
  capacity: z.number().int().positive(),
  amenities: z.array(z.string()).default([]),
  rules: z.record(z.string(), z.unknown()).default({}),
  active: z.boolean().optional(),
});

const equipmentSchema = z.object({
  name: z.string().min(2),
  category: z.string().min(2),
  location: z.string().optional().nullable(),
  quantity: z.number().int().positive(),
  condition: z.enum(["excellent", "good", "fair", "maintenance", "retired"]).default("good"),
  metadata: z.record(z.string(), z.unknown()).default({}),
  active: z.boolean().optional(),
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
    displayOrder: z.number().int().default(0),
  }),
  gallery: z.object({
    title: z.string().min(2), eventName: z.string().optional().nullable(), occurredOn: z.string().date().optional().nullable(),
    mediaUrl: z.string().url(), thumbnailUrl: z.string().url().optional().nullable(), caption: z.string().optional().nullable(),
  }),
  tournaments: z.object({
    name: z.string().min(2), description: z.string().optional().nullable(), startsOn: z.string().date().optional().nullable(),
    endsOn: z.string().date().optional().nullable(), status: z.enum(["draft", "published", "live", "completed"]).default("draft"),
  }),
  matches: z.object({
    tournamentId: id.optional().nullable(), sport: z.string().min(2), homeTeam: z.string().min(1), awayTeam: z.string().min(1),
    venueId: id.optional().nullable(), startsAt: iso, status: z.enum(["scheduled", "live", "completed", "cancelled"]).default("scheduled"),
    homeScore: z.record(z.string(), z.unknown()).default({}), awayScore: z.record(z.string(), z.unknown()).default({}),
    notes: z.string().optional().nullable(),
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

export function createApp(options = {}) {
  const store = options.store || defaultStore();
  const authenticate = options.authenticate || createAuthenticator(config.auth);
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
  app.get("/api/v1/health", (_req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

  app.get("/api/v1/public/venues", async (req, res) => {
    const data = await store.listResources("venue", { active: true, category: req.query.category, q: req.query.q });
    res.json({ data });
  });
  app.get("/api/v1/public/equipment", async (req, res) => {
    const data = await store.listResources("equipment", { active: true, category: req.query.category, q: req.query.q });
    res.json({ data });
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
    res.json({ data });
  });
  for (const type of ["committee", "gallery", "tournaments", "matches"]) {
    app.get(`/api/v1/public/${type}`, async (req, res) => {
      const data = await store.listContent(type, { tournamentId: req.query.tournamentId });
      const publicData = type === "tournaments" ? data.filter((item) => item.status !== "draft") : data;
      res.json({ data: publicData });
    });
  }

  app.use("/api/v1", async (req, _res, next) => {
    try {
      if (req.path.startsWith("/jobs/")) return next();
      req.user = await authenticate(req);
      req.user = await store.ensureUser(req.user);
      next();
    } catch (error) { next(error); }
  });

  app.get("/api/v1/me", (req, res) => res.json({ data: req.user }));

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
      const data = await store.createResource(type, parse(schema, req.body), req.user);
      res.status(201).json({ data });
    });
    app.patch(`/api/v1/${path}/:id`, requireRoles("admin"), async (req, res) => {
      const data = await store.updateResource(type, req.params.id, parse(schema.partial(), req.body), req.user);
      res.json({ data });
    });
    app.delete(`/api/v1/${path}/:id`, requireRoles("admin"), async (req, res) => {
      const data = await store.deleteResource(type, req.params.id, req.user);
      res.json({ data });
    });
  }

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
    const input = parse(bookingSchema, req.body);
    Object.assign(input, validateInterval(input.startAt, input.endAt));
    const resource = await store.getResource(input.resourceType, input.resourceId);
    if (!resource.active) throw badRequest("The selected resource is inactive");
    const data = await store.createBooking(input, req.user);
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

  app.get("/api/v1/admin/users", requireRoles("admin"), async (_req, res) => res.json({ data: await store.listUsers() }));
  app.patch("/api/v1/admin/users/:id/role", requireRoles("admin"), async (req, res) => {
    const { role } = parse(z.object({ role: z.enum(ROLES) }), req.body);
    res.json({ data: await store.setUserRole(req.params.id, role) });
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

  for (const type of ["committee", "gallery", "tournaments", "matches"]) {
    const roles = type === "matches" ? ["scorekeeper", "admin"] : ["admin"];
    app.get(`/api/v1/${type}`, async (req, res) => res.json({ data: await store.listContent(type, { tournamentId: req.query.tournamentId }) }));
    app.post(`/api/v1/${type}`, requireRoles(...roles), async (req, res) => {
      res.status(201).json({ data: await store.createContent(type, parse(contentSchemas[type], req.body), req.user) });
    });
    app.patch(`/api/v1/${type}/:id`, requireRoles(...roles), async (req, res) => {
      res.json({ data: await store.updateContent(type, req.params.id, parse(contentSchemas[type].partial(), req.body), req.user) });
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
