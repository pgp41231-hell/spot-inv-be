import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { PostgresStore } from "../src/store/postgres.js";

test("Supabase configuration selects Supabase auth when AUTH_MODE is omitted", () => {
  const config = loadConfig({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
  });
  assert.equal(config.auth.mode, "supabase");
});

test("Vercel refuses local-only authentication modes", () => {
  assert.throws(() => loadConfig({
    VERCEL: "1",
    DATABASE_URL: "postgresql://example",
    AUTH_MODE: "demo",
  }), /require AUTH_MODE=supabase/i);
});

test("a non-bootstrap identity can never create an admin profile", async () => {
  const postgres = Object.create(PostgresStore.prototype);
  let insertedRole;
  postgres.sql = {
    query: async (_sql, values) => {
      insertedRole = values[3];
      return [{ id: values[0], email: values[1], name: values[2], role: values[3] }];
    },
  };
  const postgresUser = await postgres.ensureUser({
    id: "stale-client",
    email: "sports.committee@iiml.ac.in",
    name: "Old Admin Session",
    role: "admin",
  });
  assert.equal(insertedRole, "requester");
  assert.equal(postgresUser.role, "requester");
});

test("the fixed Sports Committee email still receives the admin role", async () => {
  const postgres = Object.create(PostgresStore.prototype);
  postgres.sql = {
    query: async (_sql, values) => [{ id: values[0], email: values[1], name: values[2], role: values[3] }],
  };
  const user = await postgres.ensureUser({
    id: "real-admin",
    email: "sports@iiml.ac.in",
    name: "Sports Committee",
    role: "requester",
  });
  assert.equal(user.role, "admin");
});
