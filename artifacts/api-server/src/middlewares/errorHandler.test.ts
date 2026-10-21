import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { errorHandler, notFoundHandler } from "./errorHandler";

/**
 * These tests exist for two reasons beyond the mapping being correct.
 *
 * The first is that the response envelope is a contract with the portal: every
 * screen reads `error.data.error.message` and nothing else, so a refactor that
 * moved the message or dropped the request id from it would leave the UI
 * silently showing "HTTP 500" again — the exact failure this handler was written
 * to end, and invisible from the server side.
 *
 * The second is leakage. A Postgres error's own message names constraints,
 * tables and often the conflicting value, and the temptation to pass it through
 * for easier debugging is permanent. The assertions below fail if it ever is.
 */

let savedNodeEnv: string | undefined;

beforeEach(() => {
  savedNodeEnv = process.env["NODE_ENV"];
  process.env["NODE_ENV"] = "production";
});

afterEach(() => {
  if (savedNodeEnv === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = savedNodeEnv;
});

type Captured = {
  status: number | undefined;
  body: { error: { code: string; message: string; requestId?: string; detail?: string } } | undefined;
};

function fakeExchange(overrides: Partial<Request> = {}) {
  const captured: Captured = { status: undefined, body: undefined };
  const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), fatal: vi.fn() };

  const res = {
    headersSent: false,
    statusCode: 200,
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: Captured["body"]) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;

  const req = {
    id: "abc123def456",
    method: "GET",
    path: "/v1/admin/members",
    originalUrl: "/api/v1/admin/members?q=someone",
    log,
    ...overrides,
  } as unknown as Request;

  return { req, res, captured, log };
}

/** A node-postgres error carries its SQLSTATE on `code`. */
function pgError(code: string, message = "database said no"): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * What a failed query actually looks like by the time a route throws it.
 *
 * Nothing in this app calls the driver directly — every query goes through
 * Drizzle, which wraps the driver's error, moves it to `cause`, and builds a
 * message containing the SQL *and every bound parameter*. Reproduced faithfully
 * because the first version of the handler read `err.code` off this object, found
 * undefined, and classified every real database failure as an unknown 500 — the
 * precise blindness it was written to remove, and invisible to a test that threw
 * a bare pg error.
 */
function drizzleError(sql: string, params: string[], cause: Error): Error {
  return Object.assign(
    new Error(`Failed query: ${sql}\nparams: ${params.join(",")}`),
    { query: sql, params, cause },
  );
}

const next: NextFunction = vi.fn();

describe("errorHandler", () => {
  it("names an un-run migration instead of returning a blank 500", () => {
    // The everyday cause of a 500 right after a deploy: new code, old schema.
    const { req, res, captured } = fakeExchange();
    errorHandler(pgError("42703", 'column "removed_at" does not exist'), req, res, next);

    expect(captured.status).toBe(500);
    expect(captured.body?.error.code).toBe("SCHEMA_OUT_OF_DATE");
    expect(captured.body?.error.message).toContain("db/migrations");
  });

  it("reports an unreachable database as 503, not 500", () => {
    // 500 says "this request is broken"; 503 says "try again" — and a database
    // that is briefly down is the second, which is what the portal should say.
    const { req, res, captured } = fakeExchange();
    errorHandler(pgError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432"), req, res, next);

    expect(captured.status).toBe(503);
    expect(captured.body?.error.code).toBe("DATABASE_UNAVAILABLE");
  });

  it("treats a malformed identifier as the caller's 400, logged as a warning", () => {
    // /v1/admin/members/undefined reaching Postgres as a uuid. Nothing is wrong
    // with the server, so it must not appear in the log as though something is.
    const { req, res, captured, log } = fakeExchange();
    errorHandler(pgError("22P02", "invalid input syntax for type uuid"), req, res, next);

    expect(captured.status).toBe(400);
    expect(captured.body?.error.code).toBe("INVALID_INPUT");
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("maps a unique violation to 409 without echoing the constraint", () => {
    const { req, res, captured } = fakeExchange();
    errorHandler(
      pgError(
        "23505",
        'duplicate key value violates unique constraint "employee_members_name_unique"',
      ),
      req,
      res,
      next,
    );

    expect(captured.status).toBe(409);
    expect(captured.body?.error.code).toBe("DUPLICATE_RECORD");
    expect(captured.body?.error.message).not.toContain("employee_members");
    expect(captured.body?.error.message).not.toContain("constraint");
  });

  it("puts the request id in the message, where the portal will show it", () => {
    // The UI renders error.data.error.message only. An id anywhere else cannot
    // be quoted by the person looking at the failure.
    const { req, res, captured } = fakeExchange();
    errorHandler(new Error("kaboom"), req, res, next);

    expect(captured.status).toBe(500);
    expect(captured.body?.error.code).toBe("INTERNAL_ERROR");
    expect(captured.body?.error.message).toContain("abc123def456");
    expect(captured.body?.error.requestId).toBe("abc123def456");
  });

  it("logs the failing path without its query string", () => {
    // Query strings on the admin routes carry member names and identifiers.
    const { req, res, log } = fakeExchange();
    errorHandler(new Error("kaboom"), req, res, next);

    expect(log.error).toHaveBeenCalledOnce();
    const [context] = log.error.mock.calls[0]!;
    expect(context.url).toBe("/api/v1/admin/members");
    expect(context.method).toBe("GET");
  });

  it("hides the raw error in production and shows it in development", () => {
    const production = fakeExchange();
    errorHandler(new Error("connect to postgres://user:hunter2@db"), production.req, production.res, next);
    expect(production.captured.body?.error.detail).toBeUndefined();

    process.env["NODE_ENV"] = "development";
    const development = fakeExchange();
    errorHandler(new Error("the real reason"), development.req, development.res, next);
    expect(development.captured.body?.error.detail).toBe("the real reason");
  });

  it("identifies a response that failed its own schema", () => {
    const zodError = Object.assign(new Error("invalid"), {
      name: "ZodError",
      issues: [{ path: ["status"], message: "Required" }],
    });
    const { req, res, captured, log } = fakeExchange();
    errorHandler(zodError, req, res, next);

    expect(captured.status).toBe(500);
    const [context] = log.error.mock.calls[0]!;
    expect(context.hint).toContain("openapi.yaml");
  });

  it("classifies through Drizzle's wrapper, where the real code lives", () => {
    const { req, res, captured } = fakeExchange();
    errorHandler(
      drizzleError(
        'select "removed_at" from "employee_members" where "email" = $1',
        ["someone@example.com"],
        pgError("42703", 'column "removed_at" does not exist'),
      ),
      req,
      res,
      next,
    );

    expect(captured.status).toBe(500);
    expect(captured.body?.error.code).toBe("SCHEMA_OUT_OF_DATE");
  });

  it("sees an unreachable database through the wrapper too", () => {
    const { req, res, captured } = fakeExchange();
    errorHandler(
      drizzleError(
        'select * from "employee_members"',
        ["someone@example.com"],
        pgError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432"),
      ),
      req,
      res,
      next,
    );

    expect(captured.status).toBe(503);
    expect(captured.body?.error.code).toBe("DATABASE_UNAVAILABLE");
  });

  it("logs the failing SQL but never the values bound into it", () => {
    // Drizzle's message and its `params` property carry member emails, phone
    // numbers and identification numbers, and pino copies both into the log.
    const { req, res, log } = fakeExchange();
    errorHandler(
      drizzleError(
        'select * from "employee_members" where "email" = $1',
        ["patient@example.com", "592-600-0473"],
        pgError("42703", 'column "removed_at" does not exist'),
      ),
      req,
      res,
      next,
    );

    const [context] = log.error.mock.calls[0]!;
    expect(context.query).toBe(
      'select * from "employee_members" where "email" = $1',
    );
    // The driver's error is logged in place of the wrapper, so neither the
    // parameter list nor the message quoting it reaches the log.
    expect(JSON.stringify(context)).not.toContain("patient@example.com");
    expect(JSON.stringify(context)).not.toContain("592-600-0473");
    expect((context.err as Error).message).toBe(
      'column "removed_at" does not exist',
    );
  });

  it("survives a cause chain that points at itself", () => {
    // Never built deliberately, but this code runs while already handling a
    // failure and must not be the reason a request hangs.
    const looping = new Error("round and round") as Error & { cause?: unknown };
    looping.cause = looping;
    const { req, res, captured } = fakeExchange();

    errorHandler(looping, req, res, next);

    expect(captured.status).toBe(500);
  });

  it("aborts rather than appending to a response already streaming", () => {
    // Card PDFs stream with proxy_buffering off. Writing an error envelope after
    // the first bytes would produce a file that looks complete and is not.
    const { req, res, captured } = fakeExchange();
    (res as { headersSent: boolean }).headersSent = true;
    const delegated = vi.fn();

    errorHandler(new Error("failed mid-stream"), req, res, delegated);

    expect(captured.status).toBeUndefined();
    expect(captured.body).toBeUndefined();
    expect(delegated).toHaveBeenCalledOnce();
  });
});

describe("notFoundHandler", () => {
  it("answers an unregistered API route with JSON, not express's HTML", () => {
    // A missing route and a crashing route are different problems — a stale
    // frontend build or a proxy_pass that ate the /api prefix, versus a bug.
    const { req, res, captured } = fakeExchange({ method: "POST" });
    notFoundHandler(req, res, next);

    expect(captured.status).toBe(404);
    expect(captured.body?.error.code).toBe("NOT_FOUND");
    expect(captured.body?.error.message).toContain("/v1/admin/members");
  });
});
