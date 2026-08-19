import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store/memory.js";
import { BOOTSTRAP_ADMIN_EMAIL, DEFAULT_EMAIL_PATTERN, LOCAL_TEST_ACCOUNTS, ensureLocalAdmin, ensureLocalTestAccounts, loginWithPassword, verifyPassword } from "../src/password-auth.js";

const passwordAuth = { mode: "password", issuer: "", audience: "", jwksUri: "" };

test("local admin seed is login-ready and never overwrites an existing password", async () => {
  const store = new MemoryStore();
  const user = await ensureLocalAdmin(store, BOOTSTRAP_ADMIN_EMAIL);
  assert.equal(user.role, "admin");
  assert.equal(await verifyPassword(BOOTSTRAP_ADMIN_EMAIL, await store.getPasswordHash(user.id)), true);
  await ensureLocalAdmin(store, "replacement-password");
  assert.equal(await verifyPassword(BOOTSTRAP_ADMIN_EMAIL, await store.getPasswordHash(user.id)), true);
});

test("local test accounts cover every non-admin role and can log in", async () => {
  const store = new MemoryStore();
  await ensureLocalTestAccounts(store);
  assert.deepEqual(LOCAL_TEST_ACCOUNTS.map((account) => account.role).sort(), ["approver", "inventory_kiosk", "requester", "scorekeeper"]);
  for (const account of LOCAL_TEST_ACCOUNTS) {
    const login = await loginWithPassword(store, { email: account.email, password: account.email });
    assert.equal(login.user.role, account.role);
  }
  const originalHash = await store.getPasswordHash("local-student");
  await ensureLocalTestAccounts(store);
  assert.equal(await store.getPasswordHash("local-student"), originalHash);
});

async function request(app, path, { method = "GET", body, token } = {}) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = response.status === 204 ? null : await response.json();
    return { status: response.status, body: data };
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

test("eligible users sign up, log in, and receive the requester role", async () => {
  const app = createApp({ store: new MemoryStore(), auth: passwordAuth });
  const signup = await request(app, "/api/v1/auth/signup", { method: "POST", body: {
    name: "Student One", email: "PGP12345@IIML.AC.IN", password: "strong-pass-123",
  } });
  assert.equal(signup.status, 201);
  assert.equal(signup.body.data.user.email, "pgp12345@iiml.ac.in");
  assert.equal(signup.body.data.user.role, "requester");
  assert.equal((await request(app, "/api/v1/me", { token: signup.body.data.token })).status, 200);
  const login = await request(app, "/api/v1/auth/login", { method: "POST", body: {
    email: "pgp12345@iiml.ac.in", password: "strong-pass-123",
  } });
  assert.equal(login.status, 200);
});

test("signup rejects an email outside the active rule", async () => {
  const app = createApp({ store: new MemoryStore(), auth: passwordAuth });
  const response = await request(app, "/api/v1/auth/signup", { method: "POST", body: {
    name: "Outsider", email: "person@gmail.com", password: "strong-pass-123",
  } });
  assert.equal(response.status, 403);
  assert.match(response.body.error.message, /not eligible/i);
});

test("only the fixed Sports Committee account becomes admin and manages roles and regex", async () => {
  const store = new MemoryStore();
  const app = createApp({ store, auth: passwordAuth });
  const admin = await request(app, "/api/v1/auth/signup", { method: "POST", body: {
    name: "Sports Committee", email: BOOTSTRAP_ADMIN_EMAIL, password: "committee-pass-123",
  } });
  assert.equal(admin.status, 201);
  assert.equal(admin.body.data.user.role, "admin");
  const student = await request(app, "/api/v1/auth/signup", { method: "POST", body: {
    name: "Student", email: "pgp54321@iiml.ac.in", password: "student-pass-123",
  } });
  assert.equal(student.status, 201);
  const token = admin.body.data.token;
  const role = await request(app, `/api/v1/admin/users/${student.body.data.user.id}/role`, { method: "PATCH", token, body: { role: "approver" } });
  assert.equal(role.status, 200);
  assert.equal(role.body.data.role, "approver");
  assert.equal((await request(app, `/api/v1/admin/users/${student.body.data.user.id}/role`, { method: "PATCH", token, body: { role: "admin" } })).status, 400);
  const settings = await request(app, "/api/v1/admin/auth-settings", { method: "PUT", token, body: { emailPattern: String.raw`^ipmx\d+@iiml\.ac\.in$` } });
  assert.equal(settings.status, 200);
  assert.notEqual(settings.body.data.emailPattern, DEFAULT_EMAIL_PATTERN);
  const blocked = await request(app, "/api/v1/auth/login", { method: "POST", body: {
    email: "pgp54321@iiml.ac.in", password: "student-pass-123",
  } });
  assert.equal(blocked.status, 403);
});

test("admin assigns a role by email before signup and removal restores the student default", async () => {
  const store = new MemoryStore();
  const app = createApp({ store, auth: passwordAuth });
  const admin = await request(app, "/api/v1/auth/signup", { method: "POST", body: {
    name: "Sports Committee", email: BOOTSTRAP_ADMIN_EMAIL, password: "committee-pass-123",
  } });
  const token = admin.body.data.token;
  const assigned = await request(app, "/api/v1/admin/role-assignments", { method: "POST", token, body: {
    email: "pgp11111@iiml.ac.in", role: "approver",
  } });
  assert.equal(assigned.status, 201);
  const signup = await request(app, "/api/v1/auth/signup", { method: "POST", body: {
    name: "Future Member", email: "pgp11111@iiml.ac.in", password: "member-pass-123",
  } });
  assert.equal(signup.body.data.user.role, "approver");
  const removed = await request(app, "/api/v1/admin/role-assignments/pgp11111%40iiml.ac.in", { method: "DELETE", token });
  assert.equal(removed.status, 204);
  const login = await request(app, "/api/v1/auth/login", { method: "POST", body: {
    email: "pgp11111@iiml.ac.in", password: "member-pass-123",
  } });
  assert.equal(login.body.data.user.role, "requester");
});

test("admin adds a sport and assigns its captain by student email", async () => {
  const store = new MemoryStore();
  const app = createApp({ store, auth: passwordAuth });
  const admin = await request(app, "/api/v1/auth/signup", { method: "POST", body: {
    name: "Sports Committee", email: BOOTSTRAP_ADMIN_EMAIL, password: "committee-pass-123",
  } });
  await request(app, "/api/v1/auth/signup", { method: "POST", body: {
    name: "Student Captain", email: "pgp22222@iiml.ac.in", password: "student-pass-123",
  } });
  const sport = await request(app, "/api/v1/admin/sports", { method: "POST", token: admin.body.data.token, body: { name: "Hockey", active: true } });
  assert.equal(sport.status, 201);
  const assigned = await request(app, `/api/v1/admin/sports/${sport.body.data.id}/captain`, { method: "PUT", token: admin.body.data.token, body: { email: "PGP22222@IIML.AC.IN" } });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.data.sportName, "Hockey");
  assert.equal(assigned.body.data.captainEmail, "pgp22222@iiml.ac.in");
  const teams = await request(app, "/api/v1/equipment-module/teams", { token: admin.body.data.token });
  assert.equal(teams.body.data.filter((team) => team.active).length, 1);
});
