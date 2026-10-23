import pg from "pg";
import { config } from "./config";

// Numeric columns come back as strings ("1500.00"), which is what the money
// code expects; bigint counts are parsed so COUNT(*) reads as a number.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export type Db = pg.Pool | pg.PoolClient;

/** Runs `fn` in one transaction; rolls back on any throw. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Appends to the audit trail. Pass the transaction's client to commit with it. */
export async function audit(db: Db, actor: string, action: string, entityId: string | null, detail?: unknown): Promise<void> {
  await db.query("INSERT INTO audit_log (actor, action, entity_id, detail) VALUES ($1, $2, $3, $4)", [
    actor,
    action,
    entityId,
    detail === undefined ? null : JSON.stringify(detail),
  ]);
}
