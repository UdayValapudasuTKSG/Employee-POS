import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { databaseConfig } from "./connection";

const { Pool } = pg;

// From DATABASE_URL, every connection opened as the restricted role bhi_app;
// see connection.ts. Throws a message naming what is missing.
export const pool = new Pool(databaseConfig());
export const db = drizzle(pool, { schema });

export interface AppRoleCheck {
  role: string;
  /** True when the role would skip row-level security (superuser or BYPASSRLS). */
  bypassesRls: boolean;
}

/**
 * Which role the API connects as, and whether it bypasses row-level
 * security.
 *
 * Companies' data in the shared bhi tables is kept apart by row-level security,
 * which a superuser or a BYPASSRLS role skips entirely — one company's users
 * could then see another's data. The API must connect as bhi_app
 * (specs/002-per-company-schema/research.md R4–R5). Called once at start-up by
 * the API, which refuses to start in production when this is true.
 */
export async function checkAppRole(): Promise<AppRoleCheck> {
  const { rows } = await pool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  const r = rows[0];
  return {
    role: r?.rolname ?? "(unknown)",
    bypassesRls: !r || r.rolsuper || r.rolbypassrls,
  };
}
