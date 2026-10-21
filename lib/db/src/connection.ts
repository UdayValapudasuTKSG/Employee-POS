/**
 * The API's database connection: one setting in artifacts/api-server/.env,
 *
 *   DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DATABASE
 *
 * That login owns the tables and runs the migrations. The API connects with it
 * but opens every connection as the restricted role bhi_app ("-c role=bhi_app"
 * at connect time, so even RESET ROLE stays on bhi_app). As bhi_app it cannot
 * DELETE anything, can only append to the activity log, and is subject to the
 * row-level security that keeps each company's data to its own users.
 * deploy/db/migrations/002_roles_grants.sql creates the role and allows the
 * login to switch to it.
 */
import type { PoolConfig } from "pg";

type Env = Record<string, string | undefined>;

/** The role every API connection runs as. */
export const APP_ROLE = "bhi_app";

const urlFrom = (env: Env): string | undefined => {
  const v = env["DATABASE_URL"]?.trim();
  return v ? v : undefined;
};

/** Why the connection cannot be built, or null when it can. */
export function databaseConfigProblem(env: Env = process.env): string | null {
  const url = urlFrom(env);
  if (!url) {
    return "DATABASE_URL is not set in artifacts/api-server/.env (postgresql://USER:PASSWORD@HOST:5432/bhi_portal).";
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    return "DATABASE_URL must be a postgresql:// URL (postgresql://USER:PASSWORD@HOST:5432/bhi_portal).";
  }
  return null;
}

/** The node-postgres pool settings for the API. Throws when DATABASE_URL is unusable. */
export function databaseConfig(env: Env = process.env): PoolConfig {
  const problem = databaseConfigProblem(env);
  if (problem) throw new Error(problem);
  return { connectionString: urlFrom(env)!, options: `-c role=${APP_ROLE}` };
}

/** Login, host, port and database of DATABASE_URL, for messages. Never the password. */
export function describeDatabase(env: Env = process.env): string {
  const url = urlFrom(env);
  if (!url) return "(DATABASE_URL not set)";
  try {
    const u = new URL(url);
    return `${decodeURIComponent(u.username) || "?"}@${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return "(an unreadable DATABASE_URL)";
  }
}
