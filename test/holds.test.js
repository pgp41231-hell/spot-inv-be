// EPIC-03 — Timeboxed Venue Booking Engine.
// Covers US-04B (temporary slot lock) and US-04C (safe commit, no conflicts).
//
// Runs against MemoryStore, so no database is needed: `npm test`.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store/memory.js";
import { HOLD_TTL_MINUTES } from "../src/holds.js";

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
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });

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
  return { response, json: await response.json() };
}

async function makeVenue(name) {
  const result = await request("/api/v1/venues", {
    method: "POST", role: "admin", userId: "admin-1",
    body: { name, category: "court", location: "Sports Complex", capacity: 20, amenities: [] },
  });
  assert.equal(result.response.status, 201);
  return result.json.data.id;
}

async function makeEquipment(name, quantity) {
  const result = await request("/api/v1/equipment", {
    method: "POST", role: "admin", userId: "admin-1",
    body: { name, category: "racquet", quantity, condition: "good" },
  });
  assert.equal(result.response.status, 201);
  return result.json.data.id;
}

// Far-future dates so "must be in the future" logic is never the reason a test passes.
const slot = (day, fromHour, toHour) => ({
  startAt: `2030-04-${String(day).padStart(2, "0")}T${String(fromHour).padStart(2, "0")}:00:00.000Z`,
  endAt: `2030-04-${String(day).padStart(2, "0")}T${String(toHour).padStart(2, "0")}:00:00.000Z`,
});

test("US-04B: holding a free slot returns a hold that expires in five minutes", async () => {
  const venueId = await makeVenue("Hold Court A");
  const times = slot(1, 10, 11);
  const held = await request("/api/v1/holds", {
    method: "POST", body: { resourceType: "venue", resourceId: venueId, ...times },
  });

  assert.equal(held.response.status, 201);
  assert.equal(held.json.meta.ttlMinutes, HOLD_TTL_MINUTES);
  const lifetimeMinutes = (new Date(held.json.data.expiresAt) - Date.now()) / 60_000;
  assert.ok(lifetimeMinutes > 4.5 && lifetimeMinutes <= 5.01, `expected ~5 minutes, got ${lifetimeMinutes}`);
});

test("US-04B: another person's live hold blocks a booking with conflictType 'hold'", async () => {
  const venueId = await makeVenue("Hold Court B");
  const times = slot(2, 10, 11);
  const held = await request("/api/v1/holds", {
    method: "POST", userId: "requester-1", body: { resourceType: "venue", resourceId: venueId, ...times },
  });
  assert.equal(held.response.status, 201);

  const blocked = await request("/api/v1/bookings", {
    method: "POST", userId: "requester-2",
    body: { resourceType: "venue", resourceId: venueId, title: "Gate crash", ...times },
  });

  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.json.error.details.conflict.conflictType, "hold");
  assert.ok(blocked.json.error.details.conflict.expiresAt, "the clash should say when the hold lapses");
});

test("US-04B: the holder can book their own held slot, and the hold is consumed", async () => {
  const venueId = await makeVenue("Hold Court C");
  const times = slot(3, 10, 11);
  const held = await request("/api/v1/holds", {
    method: "POST", body: { resourceType: "venue", resourceId: venueId, ...times },
  });
  const holdId = held.json.data.id;

  const booked = await request("/api/v1/bookings", {
    method: "POST",
    body: { resourceType: "venue", resourceId: venueId, title: "Confirmed practice", holdId, ...times },
  });

  assert.equal(booked.response.status, 201);
  assert.equal(store.holds.get(holdId).bookingId, booked.json.data.id);
  assert.ok(store.holds.get(holdId).releasedAt, "a consumed hold must not keep blocking the slot");
  // The booking record itself must not carry the transient holdId.
  assert.equal("holdId" in booked.json.data, false);
});

test("US-04B: an expired hold blocks nobody, with no sweeper job involved", async () => {
  const venueId = await makeVenue("Hold Court D");
  const times = slot(4, 10, 11);
  const held = await request("/api/v1/holds", {
    method: "POST", userId: "requester-1", body: { resourceType: "venue", resourceId: venueId, ...times },
  });

  // Wind the clock forward by editing the record rather than sleeping, so the
  // test stays fast and deterministic.
  store.holds.get(held.json.data.id).expiresAt = new Date(Date.now() - 1_000).toISOString();

  const booked = await request("/api/v1/bookings", {
    method: "POST", userId: "requester-2",
    body: { resourceType: "venue", resourceId: venueId, title: "Late but legal", ...times },
  });
  assert.equal(booked.response.status, 201);
});

test("US-04B: the holder can release early; a stranger cannot", async () => {
  const venueId = await makeVenue("Hold Court E");
  const times = slot(5, 10, 11);
  const held = await request("/api/v1/holds", {
    method: "POST", userId: "requester-1", body: { resourceType: "venue", resourceId: venueId, ...times },
  });
  const holdId = held.json.data.id;

  const stranger = await request(`/api/v1/holds/${holdId}`, { method: "DELETE", userId: "requester-9" });
  assert.equal(stranger.response.status, 403);

  const owner = await request(`/api/v1/holds/${holdId}`, { method: "DELETE", userId: "requester-1" });
  assert.equal(owner.response.status, 200);

  const booked = await request("/api/v1/bookings", {
    method: "POST", userId: "requester-2",
    body: { resourceType: "venue", resourceId: venueId, title: "Took the freed slot", ...times },
  });
  assert.equal(booked.response.status, 201);
});

test("US-04B: a slot cannot be held over an existing booking or a blackout", async () => {
  const venueId = await makeVenue("Hold Court F");
  const bookedTimes = slot(6, 10, 11);
  const blackoutTimes = slot(7, 0, 23);

  await request("/api/v1/bookings", {
    method: "POST", body: { resourceType: "venue", resourceId: venueId, title: "Existing", ...bookedTimes },
  });
  await request("/api/v1/admin/blackouts", {
    method: "POST", role: "admin", userId: "admin-1",
    body: { resourceType: "venue", resourceId: venueId, reason: "Maintenance", ...blackoutTimes },
  });

  const overBooking = await request("/api/v1/holds", {
    method: "POST", userId: "requester-2", body: { resourceType: "venue", resourceId: venueId, ...bookedTimes },
  });
  assert.equal(overBooking.response.status, 409);
  assert.equal(overBooking.json.error.details.conflict.conflictType, "booking");

  const overBlackout = await request("/api/v1/holds", {
    method: "POST", userId: "requester-2",
    body: { resourceType: "venue", resourceId: venueId, ...slot(7, 10, 11) },
  });
  assert.equal(overBlackout.response.status, 409);
  assert.equal(overBlackout.json.error.details.conflict.conflictType, "blackout");
});

test("US-04A: public holds are visible but anonymous", async () => {
  const venueId = await makeVenue("Hold Court G");
  const times = slot(8, 10, 11);
  await request("/api/v1/holds", {
    method: "POST", userId: "requester-1", body: { resourceType: "venue", resourceId: venueId, ...times },
  });

  const response = await fetch(`${baseUrl}/api/v1/public/holds?resourceType=venue&resourceId=${venueId}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].startAt, times.startAt);
  assert.equal("heldBy" in body.data[0], false, "the calendar must not leak who holds a slot");
});

test("US-04C: two simultaneous bookings for one slot produce exactly one winner", async () => {
  const venueId = await makeVenue("Race Court");
  const times = slot(9, 10, 11);
  const body = { resourceType: "venue", resourceId: venueId, ...times };

  const results = await Promise.all([
    request("/api/v1/bookings", { method: "POST", userId: "racer-1", body: { ...body, title: "Racer one" } }),
    request("/api/v1/bookings", { method: "POST", userId: "racer-2", body: { ...body, title: "Racer two" } }),
  ]);

  const statuses = results.map((item) => item.response.status).sort();
  assert.deepEqual(statuses, [201, 409], "one booking must win and one must be told why it lost");
});

test("US-04C: a conflict names the clash and offers alternatives in the same response", async () => {
  const venueId = await makeVenue("Alternatives Court");
  const times = slot(10, 10, 11);
  await request("/api/v1/bookings", {
    method: "POST", body: { resourceType: "venue", resourceId: venueId, title: "Existing", ...times },
  });

  const clash = await request("/api/v1/bookings", {
    method: "POST", userId: "requester-2",
    body: { resourceType: "venue", resourceId: venueId, title: "Clashing", ...times },
  });

  assert.equal(clash.response.status, 409);
  assert.equal(clash.json.error.details.conflict.conflictType, "booking");
  assert.ok(Array.isArray(clash.json.error.details.alternatives), "US-05C needs alternatives without a second request");
  assert.ok(clash.json.error.details.alternatives.length > 0);
});

test("US-04A: availability now carries blackouts and holds, and `data` is unchanged", async () => {
  const venueId = await makeVenue("Layered Court");
  const bookedTimes = slot(11, 10, 11);
  await request("/api/v1/bookings", {
    method: "POST", body: { resourceType: "venue", resourceId: venueId, title: "Booked", ...bookedTimes },
  });
  await request("/api/v1/admin/blackouts", {
    method: "POST", role: "admin", userId: "admin-1",
    body: { resourceType: "venue", resourceId: venueId, reason: "Exams", ...slot(11, 14, 16) },
  });
  await request("/api/v1/holds", {
    method: "POST", body: { resourceType: "venue", resourceId: venueId, ...slot(11, 18, 19) },
  });

  const response = await fetch(`${baseUrl}/api/v1/public/availability?resourceType=venue&resourceId=${venueId}`
    + "&from=2030-04-11T00:00:00.000Z&to=2030-04-12T00:00:00.000Z");
  const body = await response.json();

  assert.equal(body.data.length, 1);
  assert.equal("requesterId" in body.data[0], false, "the existing privacy guarantee must survive");
  assert.equal(body.blackouts.length, 1);
  assert.equal(body.blackouts[0].reason, "Exams");
  assert.equal(body.holds.length, 1);
  assert.equal("heldBy" in body.holds[0], false);
});

test("US-04B: equipment holds reserve stock the same way bookings do", async () => {
  const equipmentId = await makeEquipment("Shared Racquet", 3);
  const times = slot(12, 10, 11);
  const base = { resourceType: "equipment", resourceId: equipmentId, ...times };

  const held = await request("/api/v1/holds", { method: "POST", userId: "requester-1", body: { ...base, quantity: 2 } });
  assert.equal(held.response.status, 201);

  const withinStock = await request("/api/v1/bookings", {
    method: "POST", userId: "requester-2", body: { ...base, title: "Takes the last one", quantity: 1 },
  });
  assert.equal(withinStock.response.status, 201);

  const overStock = await request("/api/v1/bookings", {
    method: "POST", userId: "requester-3", body: { ...base, title: "Nothing left", quantity: 1 },
  });
  assert.equal(overStock.response.status, 409);
  assert.equal(overStock.json.error.details.conflict.conflictType, "insufficient_stock");
});

test("US-04B: my holds are listed, and an expired one drops out", async () => {
  const venueId = await makeVenue("Recovery Court");
  const live = await request("/api/v1/holds", {
    method: "POST", userId: "recovery-user", body: { resourceType: "venue", resourceId: venueId, ...slot(13, 10, 11) },
  });
  const stale = await request("/api/v1/holds", {
    method: "POST", userId: "recovery-user", body: { resourceType: "venue", resourceId: venueId, ...slot(13, 12, 13) },
  });
  store.holds.get(stale.json.data.id).expiresAt = new Date(Date.now() - 1_000).toISOString();

  const mine = await request("/api/v1/holds/mine", { userId: "recovery-user" });
  assert.equal(mine.response.status, 200);
  assert.deepEqual(mine.json.data.map((item) => item.id), [live.json.data.id]);
});

test("US-04B: booking with someone else's or an expired hold is refused clearly", async () => {
  const venueId = await makeVenue("Guard Court");
  const times = slot(14, 10, 11);
  const held = await request("/api/v1/holds", {
    method: "POST", userId: "requester-1", body: { resourceType: "venue", resourceId: venueId, ...times },
  });
  const holdId = held.json.data.id;

  const stolen = await request("/api/v1/bookings", {
    method: "POST", userId: "requester-2",
    body: { resourceType: "venue", resourceId: venueId, title: "Borrowed hold", holdId, ...times },
  });
  assert.equal(stolen.response.status, 403);

  const mismatched = await request("/api/v1/bookings", {
    method: "POST", userId: "requester-1",
    body: { resourceType: "venue", resourceId: venueId, title: "Moved the goalposts", holdId, ...slot(14, 15, 16) },
  });
  assert.equal(mismatched.response.status, 400);
  assert.match(mismatched.json.error.message, /different time slot/);

  store.holds.get(holdId).expiresAt = new Date(Date.now() - 1_000).toISOString();
  const expired = await request("/api/v1/bookings", {
    method: "POST", userId: "requester-1",
    body: { resourceType: "venue", resourceId: venueId, title: "Too slow", holdId, ...times },
  });
  assert.equal(expired.response.status, 400);
  assert.match(expired.json.error.message, /expired/);
});
