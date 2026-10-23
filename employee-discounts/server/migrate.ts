/**
 * Brings any database up to date on start: an empty one gets the whole
 * schema, an existing one only what it lacks. Files in db/migrations run in
 * name order, each once, each in its own transaction, recorded in
 * schema_migrations. An advisory lock keeps two starting instances apart.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db";
import { logger } from "./log";

const LOCK_ID = 727_001;

export function migrationsDir(): string {
  // dist/server.mjs and server/*.ts both sit one level below the app root.
  const candidates = [
    path.resolve(process.cwd(), "db/migrations"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations"),
  ];
  const found = candidates.find((d) => fs.existsSync(d));
  if (!found) throw new Error(`No db/migrations folder found (looked in ${candidates.join(", ")})`);
  return found;
}

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const dir = migrationsDir();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        logger.info(`Applied migration ${file}`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
