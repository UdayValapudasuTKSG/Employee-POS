import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { checkDatabase } from "../lib/dbHealth";

const router: IRouter = Router();

/**
 * Liveness: is this process running and answering?
 *
 * Deliberately touches nothing — no database, no mail server. That is what makes
 * it the right first question in any diagnosis: an answer here while everything
 * else fails rules out nginx and the process in a single call, and narrows the
 * problem to what a real request depends on. A health check that fails for the
 * same reasons as a real request cannot do that.
 */
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

/**
 * Readiness: is this process able to do any actual work?
 *
 * The companion to the above, and the second question in the same diagnosis.
 * The connection pool is built at import time from a connection string and
 * nothing else, so the server starts perfectly well against a database it can
 * never reach and then fails one request at a time. Between these two endpoints
 * that state finally has a name:
 *
 *   healthz ok, readyz ok   → the fault is in one route; read its log line
 *   healthz ok, readyz 503  → the database; check DATABASE_URL and Postgres
 *   healthz unreachable     → the process is down; journalctl -u bhi-api
 *
 * Not in lib/api-spec/openapi.yaml, unlike every other route here: nothing in
 * the portal calls it and nothing should. It is an operator's probe, and adding
 * it to the spec would generate a client hook implying it is part of the API the
 * frontend is built against.
 *
 * It reports which dependency is down but never why. The driver's message is the
 * useful part — "password authentication failed for user bhi_user" names the
 * account — and this endpoint is reachable by anyone who can reach the portal.
 * So the reason goes to the log, and the log is the operator's, not the
 * internet's.
 */
router.get("/readyz", async (req, res) => {
  const database = await checkDatabase();

  if (!database.ok) {
    req.log?.error(
      { reason: database.reason },
      "Readiness check failed: database unreachable",
    );
    res.status(503).json({ status: "unavailable", database: "down" });
    return;
  }

  res.json({
    status: "ok",
    database: "up",
    databaseLatencyMs: database.latencyMs,
  });
});

export default router;
