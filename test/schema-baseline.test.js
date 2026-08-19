import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const migrationDirectory = new URL("../db/migrations/", import.meta.url);

test("fresh deployments use one complete final-state schema baseline", async () => {
  const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  assert.deepEqual(files, ["001_schema.sql"]);

  const sql = await readFile(new URL("001_schema.sql", migrationDirectory), "utf8");
  const requiredTables = [
    "app_users", "role_assignments", "auth_settings", "sports", "campus_locations",
    "venues", "bookings", "slot_holds", "teams", "team_members", "equipment_items",
    "equipment_assets", "equipment_allocations", "equipment_requests",
    "equipment_request_items", "equipment_custody", "equipment_qr_tokens",
    "equipment_state_audit", "audit_log",
  ];

  for (const table of requiredTables) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\b`, "i"), `${table} must be created`);
  }
  assert.doesNotMatch(sql, /UPDATE\s+audit_log\b/i, "the append-only audit log must never be rewritten");
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS\s+app_users_email_unique/i);
  assert.match(sql, /INSERT INTO storage\.buckets/i);
});
