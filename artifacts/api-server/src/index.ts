// First import, on purpose: it installs the process-level crash handlers, and
// ES modules evaluate imports in order, so anything below can be logged properly
// when it fails during startup. See lib/crashLogging.ts.
import "./lib/crashLogging";

import app from "./app";
import { logger } from "./lib/logger";
import { seedIfEmpty } from "./lib/seed";
import { logOriginPolicy } from "./lib/cors";
import { activeCardEmailRedirect } from "./lib/otpDelivery";
import { startRetirementSweep } from "./lib/retirementSweep";
import { logDatabaseStatusAtStartup, watchPool } from "./lib/dbHealth";
import { checkAppRole } from "@workspace/db";

/**
 * A misconfiguration that stops the server starting, logged rather than thrown.
 *
 * A bare throw here reaches journald as an unformatted stack trace among
 * structured lines, and the message an operator needs is not "Error: PORT
 * environment variable is required" but which file to put it in. The systemd
 * unit reads /opt/bhi-api/.env, so that is what this says.
 */
function exitOnMisconfiguration(message: string): never {
  logger.fatal(
    { hint: "Set it in /opt/bhi-api/.env (see artifacts/api-server/.env.example), then: sudo systemctl restart bhi-api" },
    message,
  );
  logger.flush?.();
  process.exit(1);
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  exitOnMisconfiguration(
    "PORT is not set, so the server cannot start. nginx proxies to 127.0.0.1:3001, so set PORT=3001.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  exitOnMisconfiguration(`PORT is not a usable port number: "${rawPort}"`);
}

// One listener for the connection pool's own failures, before any query runs.
// Without it, an idle client failing when Postgres restarts is an unhandled
// `error` event, which ends the process — see lib/dbHealth.ts.
watchPool();

/**
 * Refuse to run as a role that bypasses row-level security.
 *
 * Every company's members sit in the same bhi tables, kept apart by row-level
 * security, which a superuser or a BYPASSRLS role skips — one company's users
 * could then read another's data. In production that is a hard stop; elsewhere
 * a loud warning, so a developer pointed at the owner role still sees why their
 * segregation checks pass when they should not. An unreachable database is
 * dbHealth's job to report, not this check's, so it only warns.
 */
const roleChecked = checkAppRole()
  .then(({ role, bypassesRls }) => {
    if (!bypassesRls) return;
    const message =
      `The API connects to the database as "${role}", which bypasses row-level security, so companies' data ` +
      "would not be kept apart. Run the migrations (they create the bhi_app role) and restart.";
    if (process.env["NODE_ENV"] === "production") exitOnMisconfiguration(message);
    logger.warn(message);
  })
  .catch((err) => {
    logger.warn({ err }, "Could not check which database role the API connects as");
  });

const seeding = roleChecked
  .then(() => seedIfEmpty())
  .catch((err) => {
    logger.error({ err }, "Seeding failed");
  });

// Bind address: defaults to all interfaces for the dev environment; set
// HOST=127.0.0.1 in production so nginx is the sole public entry point.
const host = process.env["HOST"] || "0.0.0.0";

const server = app.listen(port, host, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  logOriginPolicy();

  /**
   * Whether the database answers, said once at startup.
   *
   * The pool is constructed from a connection string and never dials until the
   * first query, so a wrong DATABASE_URL, a stopped Postgres or a pg_hba.conf
   * that refuses this user all produce a server that starts cleanly and then
   * fails every request that touches data. This turns that into one line at the
   * top of the log. It does not stop the server on failure — the reasoning is in
   * lib/dbHealth.ts — and /api/readyz reports the live state afterwards.
   */
  void logDatabaseStatusAtStartup();

  // Members who have reached 65 come off the roster: once now, then daily. This
  // only keeps the list honest — routes/employee.ts refuses them a card on the
  // birthday itself, whether or not the sweep has run.
  //
  // Chained off seeding rather than started alongside it. On a fresh database the
  // two would otherwise race, and the sweep would usually win — leaving the
  // demo's deliberately over-65 members sitting on the roster until the next
  // daily run. `finally`, not `then`: a failed seed must not stop the sweep,
  // which on a real installation is the case that matters.
  void seeding.finally(() => {
    startRetirementSweep();
  });

  // Loud on every start: while this is on, no member receives their own card.
  const redirect = activeCardEmailRedirect();
  if (redirect) {
    logger.warn(
      { redirectTo: redirect },
      "CARD_EMAIL_OVERRIDE is set — every member's card is emailed to this address " +
        "instead of to them. Unset it before real members use this portal.",
    );
  }
});

/**
 * Shutdown, logged and orderly.
 *
 * `systemctl restart` and `systemctl stop` both send SIGTERM. Without a line for
 * it the log simply stops, and a restart is indistinguishable from a crash —
 * which is the first thing to establish when the portal is returning 502, since
 * a crash loop and a deliberate stop need opposite responses.
 *
 * Closing the server first lets requests in flight finish rather than having
 * their connections cut, which for a bulk import means the difference between a
 * committed transaction and a failed one.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "Shutting down (this was requested, not a crash)");
    server.close(() => {
      logger.flush?.();
      process.exit(0);
    });
    /**
     * A connection nginx is holding open with keep-alive can keep `close` from
     * ever calling back. systemd would eventually send SIGKILL; this exits
     * first, so the shutdown still ends with a log line saying it was clean.
     */
    setTimeout(() => {
      logger.warn("Connections still open after 10s; exiting anyway");
      logger.flush?.();
      process.exit(0);
    }, 10_000).unref();
  });
}
