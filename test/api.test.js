import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store/memory.js";
import { loadConfig } from "../src/config.js";

const store = new MemoryStore();
const authenticate = async (req) => ({
  id: String(req.headers["x-user-id"] || "requester-1"),
  email: String(req.headers["x-user-email"] || "person@example.edu"),
  name: String(req.headers["x-user-name"] || "Test Person"),
  role: String(req.headers["x-user-role"] || "requester"),
});
const app = createApp({ store, authenticate });
let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function request(path, { method = "GET", role = "requester", userId = "requester-1", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-user-id": userId,
      "x-user-email": `${userId}@example.edu`,
      "x-user-role": role,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  return { response, json };
}

test("health endpoint is public", async () => {
  const response = await fetch(`${baseUrl}/api/v1/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
});

test("OpenAPI contract is served", async () => {
  const response = await fetch(`${baseUrl}/openapi.yaml`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /^openapi: 3\.1\.0/m);
});

test("demo configuration starts without database or SSO, while OIDC remains explicit", () => {
  assert.equal(loadConfig({ NODE_ENV: "production" }).auth.mode, "demo");
  assert.equal(loadConfig({ POSTGRES_URL: "postgresql://example" }).databaseUrl, "postgresql://example");
  assert.throws(() => loadConfig({ VERCEL: "1" }), /Persistent database is required/);
  assert.throws(() => loadConfig({ AUTH_MODE: "oidc" }), /AUTH_MODE=oidc requires/);
});

test("venue booking, duplicate prevention, approval, privacy, and audit flow", async () => {
  const venueResult = await request("/api/v1/venues", {
    method: "POST",
    role: "admin",
    userId: "admin-1",
    body: { name: "Main Football Ground", category: "ground", location: "Sports Complex", capacity: 80, amenities: ["lights"] },
  });
  assert.equal(venueResult.response.status, 201);
  const venueId = venueResult.json.data.id;

  const flowResult = await request("/api/v1/admin/approval-flows", {
    method: "POST",
    role: "admin",
    userId: "admin-1",
    body: { name: "Ground approvals", resourceType: "venue", resourceId: venueId, steps: [{ label: "Sports secretary", role: "approver" }] },
  });
  assert.equal(flowResult.response.status, 201);

  const bookingInput = {
    resourceType: "venue",
    resourceId: venueId,
    title: "Football practice",
    purpose: "Team training",
    startAt: "2027-01-10T10:00:00.000Z",
    endAt: "2027-01-10T11:00:00.000Z",
  };
  const bookingResult = await request("/api/v1/bookings", { method: "POST", body: bookingInput });
  assert.equal(bookingResult.response.status, 201);
  assert.equal(bookingResult.json.data.status, "pending");
  const bookingId = bookingResult.json.data.id;

  const duplicate = await request("/api/v1/bookings", { method: "POST", userId: "requester-2", body: { ...bookingInput, title: "Conflicting event" } });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.json.error.code, "CONFLICT");

  const availability = await fetch(`${baseUrl}/api/v1/public/availability?resourceType=venue&resourceId=${venueId}&from=2027-01-10T00:00:00.000Z&to=2027-01-11T00:00:00.000Z`);
  const publicBody = await availability.json();
  assert.equal(publicBody.data.length, 1);
  assert.equal("requesterId" in publicBody.data[0], false);
  assert.equal("title" in publicBody.data[0], false);

  const pending = await request("/api/v1/approvals/pending", { role: "approver", userId: "approver-1" });
  assert.equal(pending.response.status, 200);
  assert.equal(pending.json.data[0].id, bookingId);

  const decision = await request(`/api/v1/approvals/${bookingId}/decision`, {
    method: "POST", role: "approver", userId: "approver-1", body: { decision: "approve", comment: "Approved" },
  });
  assert.equal(decision.response.status, 200);
  assert.equal(decision.json.data.booking.status, "approved");

  const audit = await request("/api/v1/admin/audit-log", { role: "admin", userId: "admin-1" });
  assert.equal(audit.response.status, 200);
  assert.ok(audit.json.data.some((entry) => entry.action === "booking.approved"));
});

test("blackout blocks a booking and requesters cannot access admin endpoints", async () => {
  const venue = await request("/api/v1/venues", {
    method: "POST", role: "admin", userId: "admin-1",
    body: { name: "Academic Court", category: "court", capacity: 20, amenities: [] },
  });
  const venueId = venue.json.data.id;
  const blackout = await request("/api/v1/admin/blackouts", {
    method: "POST", role: "admin", userId: "admin-1",
    body: { resourceType: "venue", resourceId: venueId, startAt: "2027-02-01T00:00:00.000Z", endAt: "2027-02-02T00:00:00.000Z", reason: "Exams" },
  });
  assert.equal(blackout.response.status, 201);

  const blocked = await request("/api/v1/bookings", {
    method: "POST",
    body: { resourceType: "venue", resourceId: venueId, title: "Badminton", startAt: "2027-02-01T10:00:00.000Z", endAt: "2027-02-01T11:00:00.000Z" },
  });
  assert.equal(blocked.response.status, 409);

  const forbiddenResult = await request("/api/v1/admin/users");
  assert.equal(forbiddenResult.response.status, 403);
});

test("equipment stock supports concurrent quantities up to inventory", async () => {
  const equipment = await request("/api/v1/equipment", {
    method: "POST", role: "admin", userId: "admin-1",
    body: { name: "Badminton Racquet", category: "racquet", quantity: 3, condition: "good" },
  });
  const equipmentId = equipment.json.data.id;
  const base = { resourceType: "equipment", resourceId: equipmentId, startAt: "2027-03-01T10:00:00.000Z", endAt: "2027-03-01T11:00:00.000Z" };

  const first = await request("/api/v1/bookings", { method: "POST", body: { ...base, title: "Practice A", quantity: 2 } });
  assert.equal(first.response.status, 201);
  const second = await request("/api/v1/bookings", { method: "POST", userId: "requester-2", body: { ...base, title: "Practice B", quantity: 1 } });
  assert.equal(second.response.status, 201);
  const third = await request("/api/v1/bookings", { method: "POST", userId: "requester-3", body: { ...base, title: "Practice C", quantity: 1 } });
  assert.equal(third.response.status, 409);
});
