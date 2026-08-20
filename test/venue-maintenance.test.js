import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store/memory.js";

const store = new MemoryStore();
const app = createApp({ store, authenticate: async (req) => ({
  id: String(req.headers["x-user-id"] || "student-1"),
  email: `${String(req.headers["x-user-id"] || "student-1")}@example.edu`,
  name: String(req.headers["x-user-name"] || "Test User"),
  role: String(req.headers["x-user-role"] || "requester"),
}) });
let server;
let baseUrl;
before(async () => { await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); }); baseUrl = `http://127.0.0.1:${server.address().port}`; });
after(async () => { await new Promise((resolve) => server.close(resolve)); });
const request = async (path, { method = "GET", userId = "student-1", role = "requester", body } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { "content-type": "application/json", "x-user-id": userId, "x-user-role": role, "x-user-name": userId }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { response, json: await response.json() };
};

test("students report their own venue issues while SportComm can review them", async () => {
  const venue = await request("/api/v1/venues", { method: "POST", role: "admin", userId: "admin-venue-maintenance", body: { name: "Maintenance Test Court", category: "Court", capacity: 1, amenities: [] } });
  assert.equal(venue.response.status, 201);
  const created = await request("/api/v1/venue-maintenance", { method: "POST", body: { venueId: venue.json.data.id, category: "LIGHTING", title: "Floodlight failure", description: "The north floodlight is not working", exactArea: "North side", urgency: "URGENT" } });
  assert.equal(created.response.status, 201);
  assert.equal(created.json.data.status, "REPORTED");

  const otherStudent = await request("/api/v1/venue-maintenance", { userId: "student-2" });
  assert.equal(otherStudent.json.data.length, 0);
  const committee = await request("/api/v1/venue-maintenance", { userId: "sportcomm-1", role: "approver" });
  assert.ok(committee.json.data.some((item) => item.id === created.json.data.id));

  const forbidden = await request(`/api/v1/venue-maintenance/${created.json.data.id}`, { method: "PATCH", body: { status: "IN_PROGRESS", reviewNote: "Electrician contacted" } });
  assert.equal(forbidden.response.status, 403);
  const updated = await request(`/api/v1/venue-maintenance/${created.json.data.id}`, { method: "PATCH", userId: "sportcomm-1", role: "approver", body: { status: "IN_PROGRESS", reviewNote: "Electrician contacted" } });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.json.data.status, "IN_PROGRESS");
});
