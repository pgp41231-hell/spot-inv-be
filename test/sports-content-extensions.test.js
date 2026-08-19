import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store/memory.js";

// Covers what's new in the Fixtures/Tournaments/Committee frontend module:
// multi-sport committee tags, a tournament's venue/blurb, linking a gallery
// photo to its tournament, the standings content type, and delete support
// for every sports-content type. Same harness shape as test/api.test.js —
// its own store/app/server, so this file runs independently of it.

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

test("committee members carry multiple sport tags, not just one", async () => {
  const created = await request("/api/v1/committee", {
    method: "POST", role: "admin", userId: "admin-1",
    body: { name: "Nirav Mithari", title: "Secretary", tags: ["Cricket", "Football"] },
  });
  assert.equal(created.response.status, 201);
  assert.deepEqual(created.json.data.tags, ["Cricket", "Football"]);

  const listed = await request("/api/v1/public/committee");
  assert.ok(listed.json.data.some((member) => member.name === "Nirav Mithari" && member.tags.includes("Football")));
});

test("tournaments carry a venue and a short blurb alongside the full description", async () => {
  const created = await request("/api/v1/tournaments", {
    method: "POST", role: "admin", userId: "admin-1",
    body: {
      name: "Sangram 2025",
      description: "Four days of cricket, football, and badminton across campus.",
      blurb: "Last-over drama under the lights",
      venue: "Sports Complex",
      status: "completed",
    },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.json.data.blurb, "Last-over drama under the lights");
  assert.equal(created.json.data.venue, "Sports Complex");
});

test("gallery photos can be linked to the tournament they belong to, and filtered by it", async () => {
  const tournament = await request("/api/v1/tournaments", {
    method: "POST", role: "admin", userId: "admin-1",
    body: { name: "Mahasangram 2024", status: "completed" },
  });
  const tournamentId = tournament.json.data.id;

  const otherTournament = await request("/api/v1/tournaments", {
    method: "POST", role: "admin", userId: "admin-1",
    body: { name: "Hell's League 2024", status: "completed" },
  });

  await request("/api/v1/gallery", {
    method: "POST", role: "admin", userId: "admin-1",
    body: { title: "Trophy moment", mediaUrl: "https://example.com/1.jpg", tournamentId },
  });
  await request("/api/v1/gallery", {
    method: "POST", role: "admin", userId: "admin-1",
    body: { title: "Unrelated photo", mediaUrl: "https://example.com/2.jpg", tournamentId: otherTournament.json.data.id },
  });

  const scoped = await request(`/api/v1/public/gallery?tournamentId=${tournamentId}`);
  assert.equal(scoped.json.data.length, 1);
  assert.equal(scoped.json.data[0].title, "Trophy moment");
});

test("standings: scorekeepers can maintain a tournament's points table, requesters cannot", async () => {
  const tournament = await request("/api/v1/tournaments", {
    method: "POST", role: "admin", userId: "admin-1",
    body: { name: "Sangram 2026", status: "live" },
  });
  const tournamentId = tournament.json.data.id;

  const forbidden = await request("/api/v1/standings", {
    method: "POST",
    body: { tournamentId, section: "Section A", sport: "cricket", points: 8 },
  });
  assert.equal(forbidden.response.status, 403);

  const created = await request("/api/v1/standings", {
    method: "POST", role: "scorekeeper", userId: "scorekeeper-1",
    body: { tournamentId, section: "Section A", sport: "cricket", points: 8 },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.json.data.points, 8);

  const updated = await request(`/api/v1/standings/${created.json.data.id}`, {
    method: "PATCH", role: "scorekeeper", userId: "scorekeeper-1",
    body: { points: 12 },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.json.data.points, 12);

  const scoped = await request(`/api/v1/public/standings?tournamentId=${tournamentId}`);
  assert.equal(scoped.json.data.length, 1);
  assert.equal(scoped.json.data[0].points, 12);
});

test("sports content can be deleted (admin for committee/gallery/tournaments, scorekeeper or admin for matches/standings)", async () => {
  const committee = await request("/api/v1/committee", {
    method: "POST", role: "admin", userId: "admin-1",
    body: { name: "Temp Member", title: "Member" },
  });
  const committeeId = committee.json.data.id;

  const deniedDelete = await request(`/api/v1/committee/${committeeId}`, { method: "DELETE", role: "requester" });
  assert.equal(deniedDelete.response.status, 403);

  const deleted = await request(`/api/v1/committee/${committeeId}`, { method: "DELETE", role: "admin", userId: "admin-1" });
  assert.equal(deleted.response.status, 200);

  const afterDelete = await request(`/api/v1/committee/${committeeId}`, { method: "PATCH", role: "admin", userId: "admin-1", body: { title: "Ghost" } });
  assert.equal(afterDelete.response.status, 404);

  const tournament = await request("/api/v1/tournaments", {
    method: "POST", role: "admin", userId: "admin-1",
    body: { name: "Temp Tournament" },
  });
  const match = await request("/api/v1/matches", {
    method: "POST", role: "scorekeeper", userId: "scorekeeper-1",
    body: { tournamentId: tournament.json.data.id, sport: "badminton", homeTeam: "A", awayTeam: "B", startsAt: "2027-03-01T10:00:00.000Z" },
  });
  const matchDeletedByScorekeeper = await request(`/api/v1/matches/${match.json.data.id}`, { method: "DELETE", role: "scorekeeper", userId: "scorekeeper-1" });
  assert.equal(matchDeletedByScorekeeper.response.status, 200);
});
