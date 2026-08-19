import fs from "node:fs/promises";
import pg from "pg";
import { postgresConnectionConfig } from "../src/database-config.js";

const databaseUrl = process.env.DIRECT_DATABASE_URL
  || process.env.POSTGRES_URL
  || process.env.DATABASE_URL
  || process.env.POSTGRES_PRISMA_URL
  || process.env.POSTGRES_URL_NON_POOLING
  || process.env.SUPABASE_DB_URL;
if (!databaseUrl) throw new Error("Set DIRECT_DATABASE_URL, DATABASE_URL, or POSTGRES_URL before migrating");

// Every migration is written to be idempotent (IF NOT EXISTS / guarded DO blocks),
// so running the whole directory in filename order is safe on every deploy.
const directory = new URL("../db/migrations/", import.meta.url);
const files = (await fs.readdir(directory))
  .filter((file) => file.endsWith(".sql"))
  .sort();

const client = new pg.Client(postgresConnectionConfig(databaseUrl));
await client.connect();
try {
  for (const file of files) {
    await client.query("BEGIN");
    try {
      await client.query(await fs.readFile(new URL(file, directory), "utf8"));
      await client.query("COMMIT");
      console.log(`Applied ${file}`);
    } catch (error) {
      await client.query("ROLLBACK");
      error.message = `Migration ${file} failed: ${error.message}`;
      throw error;
    }
  }
  console.log(`Database migration completed (${files.length} file(s))`);
} finally {
  await client.end();
}
