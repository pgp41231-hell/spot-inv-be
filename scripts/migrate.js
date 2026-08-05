import fs from "node:fs/promises";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const migration = await fs.readFile(new URL("../db/migrations/001_init.sql", import.meta.url), "utf8");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query(migration);
  console.log("Database migration completed");
} finally {
  await client.end();
}
