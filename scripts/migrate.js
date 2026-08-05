import fs from "node:fs/promises";
import pg from "pg";

const databaseUrl = process.env.DIRECT_DATABASE_URL
  || process.env.POSTGRES_URL_NON_POOLING
  || process.env.DATABASE_URL
  || process.env.POSTGRES_URL;
if (!databaseUrl) throw new Error("Set DIRECT_DATABASE_URL, DATABASE_URL, or POSTGRES_URL before migrating");
const migration = await fs.readFile(new URL("../db/migrations/001_init.sql", import.meta.url), "utf8");
const client = new pg.Client({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false },
});
await client.connect();
try {
  await client.query(migration);
  console.log("Database migration completed");
} finally {
  await client.end();
}
