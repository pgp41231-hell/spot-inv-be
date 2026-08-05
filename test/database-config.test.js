import test from "node:test";
import assert from "node:assert/strict";
import { postgresConnectionConfig } from "../src/database-config.js";

test("Supabase SSL URL parameters cannot override the explicit TLS configuration", () => {
  const config = postgresConnectionConfig(
    "postgresql://user:password@example.supabase.co:6543/postgres?sslmode=require&uselibpqcompat=true",
  );

  assert.equal(config.connectionString.includes("sslmode"), false);
  assert.equal(config.connectionString.includes("uselibpqcompat"), false);
  assert.deepEqual(config.ssl, { rejectUnauthorized: false });
});

test("local PostgreSQL connections do not force TLS", () => {
  const config = postgresConnectionConfig("postgresql://postgres:postgres@localhost:5432/app");
  assert.equal(config.ssl, false);
});
