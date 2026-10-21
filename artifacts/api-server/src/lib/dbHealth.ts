import { pool } from "@workspace/db";
import { describeDatabase } from "@workspace/db/connection";
import { logger } from "./logger";

/**
 * Keeping the connection pool from taking the whole server down with it, and
 * answering "is the database actually reachable?" on demand.
 *
 * Both exist because a database that has gone away is invisible in this app
 * otherwise. The pool is created at import time in lib/db with nothing but a
 * connection string, so the process starts happily against a database it cannot
 * reach and only fails later, one request at a time, with no startup signal
 * that says why.
 */

/**
 * Attaches the pool's `error` listener. Call once, at startup.
 *
 * node-postgres emits `error` on the pool when a *pooled, idle* client fails —
 * Postgres restarted, a connection was killed, the network dropped. There is no
 * request in flight to attach that error to, so it surfaces on the pool itself,
 * and an EventEmitter that emits `error` with no listener throws: the exception
 * is uncaught, the process dies, systemd restarts it, and every request in
 * between is a 502 from nginx with nothing in the API log to explain it.
 *
 * One listener converts that from a crash into a log line. The pool discards the
 * broken client and opens a fresh one on the next query by itself, so there is
 * nothing else to do here — recovery is automatic, and this is only about not
 * dying first.
 */
export function watchPool(): void {
  pool.on("error", (err) => {
    logger.error(
      { err },
      "Idle database client failed. The pool will reconnect on the next query; " +
        "no restart is needed. Repeated occurrences mean Postgres is dropping " +
        "connections — check its log and any idle timeout in front of it.",
    );
  });
}

export type DatabaseCheck =
  | { ok: true; latencyMs: number }
  | { ok: false; reason: string };

/**
 * Runs the cheapest possible query to prove the database answers.
 *
 * `select 1` and not a count of anything real: this has to stay cheap enough to
 * call on every readiness probe, and its job is to distinguish "the database is
 * reachable" from "it is not", which no table is needed for.
 *
 * The reason string is for an operator reading a log or a probe response, so it
 * carries the driver's own message — "ECONNREFUSED", "password authentication
 * failed", "database does not exist" each point at a different fix, and
 * collapsing them into "database error" throws away the answer.
 */
export async function checkDatabase(timeoutMs = 5_000): Promise<DatabaseCheck> {
  // A pool with no free connection and an unreachable host leaves `query`
  // pending, so the probe needs its own deadline or it inherits nginx's 60s one
  // and reports nothing until then.
  const started = process.hrtime.bigint();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pool.query("select 1"),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`No response within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    const latencyMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    return { ok: true, latencyMs: Math.round(latencyMs) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The startup probe. Logs what it found and returns nothing — deliberately not
 * fatal.
 *
 * Exiting on a failed probe would be the usual fail-fast choice, and it is the
 * wrong one here. systemd's `After=postgresql.service` orders the units but does
 * not wait for Postgres to accept connections, so on a reboot this probe can
 * lose a race it would then turn into a restart loop; and `Restart=on-failure`
 * with `RestartSec=5` would keep the portal's static pages down too, since a
 * dead API is a 502 for every path nginx proxies.
 *
 * So: stay up, say so loudly, and let /api/readyz be the thing that reports the
 * state. The failure is now one line at the top of `journalctl -u bhi-api`
 * instead of an unexplained 500 on every admin screen.
 */
export async function logDatabaseStatusAtStartup(): Promise<void> {
  const result = await checkDatabase();
  if (result.ok) {
    logger.info({ latencyMs: result.latencyMs }, "Database reachable");
    return;
  }
  logger.error(
    { reason: result.reason },
    "DATABASE UNREACHABLE — the server is listening but every request that " +
      "touches data will fail. Check DATABASE_URL in .env, that Postgres is " +
      "running, and that this host and user may connect (pg_hba.conf). " +
      `Tried: ${describeDatabase()}.`,
  );
}
