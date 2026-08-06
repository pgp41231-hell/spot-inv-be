// EPIC-04 — Lightweight AI Recommendation Feature.
// Covers US-05A (peak/off-peak rules), US-05B (rules engine) and US-05D (graceful
// "nothing available" fallback).
//
// Most of these test the pure heuristic directly, which is the point of keeping it
// in src/recommendations.js rather than inside a route handler.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store/memory.js";
import { fromIstParts, isPeak, istDayIndex, recommendSlots } from "../src/recommendations.js";

// 2030-04-01, expressed as an IST day index so every fixture below is unambiguous.
const DAY = istDayIndex("2030-04-01T12:00:00.000Z");
const at = (dayOffset, hour, minute = 0) =>
  fromIstParts(DAY + dayOffset, hour * 60 + minute).toISOString();

const span = (dayOffset, fromHour, toHour) => ({
  startAt: at(dayOffset, fromHour),
  endAt: at(dayOffset, toHour),
});

// Well before every fixture, so "must be in the future" never silently does the work.
const NOW = at(0, 5, 0);

const durationMinutes = (item) => (new Date(item.endAt) - new Date(item.startAt)) / 60_000;
const overlapsAny = (item, blockers) => blockers.some((blocker) =>
  new Date(item.startAt) < new Date(blocker.endAt) && new Date(item.endAt) > new Date(blocker.startAt));

test("US-05B: at most `limit` alternatives are returned, best first", async () => {
  const results = recommendSlots({ ...span(0, 10, 11), now: NOW });
  assert.ok(results.length > 0);
  assert.ok(results.length <= 3, `default limit is 3, got ${results.length}`);

  const scores = results.map((item) => item.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "results must be ranked");

  assert.equal(recommendSlots({ ...span(0, 10, 11), limit: 1, now: NOW }).length, 1);
});

test("US-05B: every alternative keeps the requested duration exactly", async () => {
  const ninetyMinutes = { startAt: at(0, 10), endAt: at(0, 11, 30) };
  const results = recommendSlots({ ...ninetyMinutes, now: NOW });
  assert.ok(results.length > 0);
  for (const item of results) assert.equal(durationMinutes(item), 90);
});

test("US-05B: alternatives never overlap a booking, blackout, or live hold", async () => {
  const occupied = [span(0, 10, 12), span(0, 14, 16)];
  const blackouts = [span(0, 12, 14)];
  const holds = [{ ...span(0, 16, 18), expiresAt: at(7, 12) }];

  const results = recommendSlots({
    ...span(0, 10, 11), occupied, blackouts, holds, now: NOW, limit: 10,
  });

  assert.ok(results.length > 0);
  for (const item of results) {
    assert.equal(overlapsAny(item, [...occupied, ...blackouts, ...holds]), false,
      `${item.startAt} collides with something already on the calendar`);
  }
});

test("US-05A: a peak-hour request is answered with off-peak alternatives first", async () => {
  // 18:00 IST sits inside the evening peak window.
  const request = span(0, 18, 19);
  assert.equal(isPeak(request.startAt), true, "fixture must actually be a peak slot");

  const results = recommendSlots({ ...request, now: NOW });

  assert.ok(results.length > 0);
  assert.equal(results[0].peak, false, "the top suggestion should move the user out of the rush");
  assert.ok(results[0].reasons.some((reason) => /off-peak/i.test(reason)),
    "the user should be told why it was suggested");
});

test("US-05A: an off-peak request is not pushed into peak hours", async () => {
  const request = span(0, 11, 12);
  assert.equal(isPeak(request.startAt), false);

  const results = recommendSlots({ ...request, now: NOW });
  assert.equal(results[0].peak, false);
});

test("US-05B: same-day alternatives outrank later days", async () => {
  const results = recommendSlots({ ...span(0, 10, 11), now: NOW });
  assert.equal(istDayIndex(results[0].startAt), DAY, "there is room today, so today should win");
});

test("US-05B: when today is full, the next day is offered", async () => {
  // Block the whole of the requested day, but nothing after it.
  const blackouts = [{ startAt: at(0, 0), endAt: at(1, 0) }];
  const results = recommendSlots({ ...span(0, 10, 11), blackouts, now: NOW });

  assert.ok(results.length > 0);
  assert.equal(istDayIndex(results[0].startAt), DAY + 1);
  assert.ok(results[0].reasons.includes("Next day"));
});

test("US-05D: a saturated search window returns an empty list, not an error", async () => {
  const blackouts = [{ startAt: at(0, 0), endAt: at(30, 0) }];
  const results = recommendSlots({ ...span(0, 10, 11), blackouts, now: NOW });
  assert.deepEqual(results, [], "no alternatives is a valid answer the UI must handle");
});

test("US-05B: slots in the past are never suggested", async () => {
  const midday = at(0, 12);
  const results = recommendSlots({ ...span(0, 10, 11), now: midday, limit: 10 });

  assert.ok(results.length > 0);
  for (const item of results) {
    assert.ok(new Date(item.startAt) > new Date(midday), `${item.startAt} is in the past`);
  }
});

test("US-05B: the originally requested slot is never suggested back to the user", async () => {
  const request = span(0, 10, 11);
  const results = recommendSlots({ ...request, now: NOW, limit: 10 });
  assert.equal(results.some((item) => item.startAt === request.startAt), false);
});

test("US-05B: a nonsensical interval yields no suggestions rather than throwing", async () => {
  assert.deepEqual(recommendSlots({ startAt: at(0, 11), endAt: at(0, 10), now: NOW }), []);
  assert.deepEqual(recommendSlots({ startAt: "not-a-date", endAt: at(0, 10), now: NOW }), []);
  assert.deepEqual(recommendSlots(), []);
});

// --- HTTP surface -----------------------------------------------------------

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

test("US-05B: GET /public/recommendations answers with alternatives and an explanation", async () => {
  const venue = await request("/api/v1/venues", {
    method: "POST", role: "admin", userId: "admin-1",
    body: { name: "Recommendation Court", category: "court", capacity: 20, amenities: [] },
  });
  const venueId = venue.json.data.id;
  const busy = span(0, 18, 19);
  await request("/api/v1/bookings", {
    method: "POST", body: { resourceType: "venue", resourceId: venueId, title: "Peak-hour match", ...busy },
  });

  const query = new URLSearchParams({
    resourceType: "venue", resourceId: venueId, startAt: busy.startAt, endAt: busy.endAt,
  });
  const response = await fetch(`${baseUrl}/api/v1/public/recommendations?${query}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(body.data.length > 0 && body.data.length <= 3);
  assert.equal(body.meta.requestedPeak, true);
  assert.match(body.meta.reason, /peak/i);
  assert.equal(body.data.some((item) => item.startAt === busy.startAt), false);
});

test("US-05D: a fully blacked-out venue returns an empty list with a plain-English reason", async () => {
  const venue = await request("/api/v1/venues", {
    method: "POST", role: "admin", userId: "admin-1",
    body: { name: "Closed Court", category: "court", capacity: 20, amenities: [] },
  });
  const venueId = venue.json.data.id;
  await request("/api/v1/admin/blackouts", {
    method: "POST", role: "admin", userId: "admin-1",
    body: { resourceType: "venue", resourceId: venueId, reason: "Resurfacing", startAt: at(0, 0), endAt: at(30, 0) },
  });

  const query = new URLSearchParams({
    resourceType: "venue", resourceId: venueId, startAt: at(0, 10), endAt: at(0, 11),
  });
  const response = await fetch(`${baseUrl}/api/v1/public/recommendations?${query}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data, []);
  assert.match(body.meta.reason, /No alternative slots/i);
});

test("US-05B: missing query parameters are rejected with 400, not a silent empty list", async () => {
  const response = await fetch(`${baseUrl}/api/v1/public/recommendations?resourceType=venue`);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "BAD_REQUEST");
});
