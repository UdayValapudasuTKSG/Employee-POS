import type { ErrorRequestHandler, RequestHandler } from "express";
import { logger } from "../lib/logger";
import { classifyBhiError } from "../lib/bhiErrors";

/**
 * The last two middlewares in the stack: one for a route that does not exist,
 * one for a route that threw.
 *
 * Until these existed, `app.use("/api", router)` was the final line in app.ts,
 * which left express's built-in handler to answer anything unexpected. It sends
 * a bare `500 Internal Server Error` as HTML, with no error code and no message,
 * and the portal — which reads `error.data.error.message` everywhere — could
 * only show "HTTP 500 Internal Server Error". So a failure had no name in the
 * response, no reference in the log, and nothing linking the two. Every
 * diagnosis started from "reproduce it and hope".
 *
 * What replaces that:
 *
 *   - one log line per failure carrying the stack, the request id, the method
 *     and the path;
 *   - the response envelope the rest of the API already uses, so the portal
 *     shows a real message;
 *   - the request id in that message, so the reference on an administrator's
 *     screen is the one to search the log for.
 *
 * The classification below is not decoration. Three of the errors it names —
 * an out-of-date schema, an unreachable database, a malformed id in a URL —
 * are the everyday causes of a 500 in this app, and each says exactly what to
 * do about it instead of "something went wrong".
 */

/**
 * Postgres SQLSTATE codes worth telling apart. Values are from the Postgres
 * appendix of error codes; the driver puts them on `err.code`.
 */
const PG = {
  UNDEFINED_COLUMN: "42703",
  UNDEFINED_TABLE: "42P01",
  UNDEFINED_FUNCTION: "42883",
  INVALID_TEXT_REPRESENTATION: "22P02",
  UNIQUE_VIOLATION: "23505",
  FOREIGN_KEY_VIOLATION: "23503",
  NOT_NULL_VIOLATION: "23502",
  CHECK_VIOLATION: "23514",
  TOO_MANY_CONNECTIONS: "53300",
  ADMIN_SHUTDOWN: "57P01",
  CANNOT_CONNECT_NOW: "57P03",
  CONNECTION_FAILURE: "08006",
  SQLCLIENT_UNABLE_TO_ESTABLISH: "08001",
} as const;

/** Node socket-level failures, which carry no SQLSTATE. */
const UNREACHABLE_SYSCALLS = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "EPIPE",
]);

type Classification = {
  status: number;
  /** Machine-readable code in the response envelope. */
  code: string;
  /** Shown to whoever is using the portal. Must leak nothing. */
  message: string;
  /**
   * Logged, never sent. Where the response has to stay vague to avoid
   * publishing the schema, this says the specific thing an operator needs.
   */
  hint?: string;
  /**
   * `warn` for anything a caller caused, `error` for a genuine server fault.
   * Keeps a malformed URL from reading like an incident when scanning the log
   * for real ones.
   */
  level: "warn" | "error";
};

/**
 * Finds the driver's error code, wherever in the chain it ended up.
 *
 * It is never on the error a route throws. Every database call here goes through
 * Drizzle, which wraps whatever the driver raised in a DrizzleQueryError and puts
 * the original on `cause` — so the wrapper has no `code` at all, and reading
 * `err.code` directly classifies every real database failure as an unknown 500.
 * That is exactly what this handler exists to stop, so the chain gets walked.
 *
 * The depth limit is for a `cause` that points back at itself. Nothing here
 * builds such a chain, but this runs while handling a failure and must not be
 * the reason a request never returns.
 */
function errorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current != null && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Splits a wrapped query failure into the parts that are safe and useful to log.
 *
 * DrizzleQueryError's message is `Failed query: <sql>\nparams: <every bound
 * value>`, and it carries `query` and `params` as enumerable own properties.
 * pino's error serialiser copies the message and those properties into the log,
 * so logging the wrapper as it arrives writes member emails, phone numbers and
 * identification numbers into journald — on every failed request, for a system
 * whose whole subject is medical cover.
 *
 * Taken apart instead:
 *   - the driver's own error is what gets logged as `err`. It holds the SQLSTATE
 *     and the message that says what to fix (`column "removed_at" does not
 *     exist`, `connect ECONNREFUSED`);
 *   - the SQL text is logged beside it, which identifies the statement;
 *   - the bound parameters are dropped. Knowing *which* member's email was being
 *     looked up has never been what makes one of these diagnosable.
 *   - the wrapper's call frames are kept as `callSite`, because the driver's own
 *     stack stops inside the connection pool and this one names the route.
 */
function forLogging(err: unknown): {
  err: unknown;
  query?: string;
  callSite?: string;
} {
  const wrapper = err as
    | { query?: unknown; params?: unknown; cause?: unknown; stack?: unknown }
    | null;

  const isQueryWrapper =
    wrapper != null &&
    typeof wrapper.query === "string" &&
    wrapper.params !== undefined;

  if (!isQueryWrapper) return { err };

  const callSite =
    typeof wrapper.stack === "string" ? stackFrames(wrapper.stack) : undefined;

  return {
    err: wrapper.cause ?? err,
    query: wrapper.query as string,
    ...(callSite ? { callSite } : {}),
  };
}

/**
 * The frame lines of a stack, without its first line.
 *
 * A V8 stack string begins with the error's own message, so keeping the whole
 * thing would put the parameter list back into the log through the back door —
 * which is what the test for this asserts, having caught exactly that. The
 * frames are the part worth having; the message is already logged as `err`.
 */
function stackFrames(stack: string): string | undefined {
  const frames = stack.split("\n").filter((line) => /^\s+at /.test(line));
  return frames.length > 0 ? frames.join("\n") : undefined;
}

/** A response schema that did not match — detected structurally so this file
 *  needs no zod import of its own. */
function isZodError(err: unknown): boolean {
  const candidate = err as { name?: unknown; issues?: unknown } | null;
  return candidate?.name === "ZodError" && Array.isArray(candidate.issues);
}

function classify(err: unknown): Classification {
  // Specific answers for the shared BHI tables (duplicate ID across companies,
  // RLS refusals…) come first; see lib/bhiErrors.ts.
  const bhi = classifyBhiError(err);
  if (bhi) return bhi;

  const code = errorCode(err);

  if (code && UNREACHABLE_SYSCALLS.has(code)) {
    return {
      status: 503,
      code: "DATABASE_UNAVAILABLE",
      message:
        "The service cannot reach its database right now. Try again in a moment.",
      hint:
        `Socket error ${code} talking to Postgres. Check that it is running, ` +
        "that DATABASE_URL in .env points at it, and that a firewall is not in the way.",
      level: "error",
    };
  }

  switch (code) {
    /**
     * The schema is behind the code. This is what an un-run migration looks
     * like from inside a request, and it is worth its own status code and
     * message: it happens on exactly one occasion — a deploy where db/migrations
     * was skipped — and every admin screen touching the new column 500s at
     * once. Naming it turns an afternoon into a single command.
     *
     * Safe to say out loud, unlike most database detail: it describes the
     * server's own state, tells an administrator to call whoever deployed it,
     * and reveals nothing about anybody's data.
     */
    case PG.UNDEFINED_COLUMN:
    case PG.UNDEFINED_TABLE:
    case PG.UNDEFINED_FUNCTION:
      return {
        status: 500,
        code: "SCHEMA_OUT_OF_DATE",
        message:
          "The database is missing a change this version of the portal needs. " +
          "The pending migrations in db/migrations have to be applied.",
        hint:
          "Run every file in db/migrations against the database as its owner (each is " +
          "idempotent) and restart bhi-api.",
        level: "error",
      };

    /**
     * Almost always a uuid-shaped path parameter that is not a uuid —
     * /v1/admin/members/undefined, or a hand-typed id. The caller sent
     * something unusable, so 400 rather than 500.
     */
    case PG.INVALID_TEXT_REPRESENTATION:
      return {
        status: 400,
        code: "INVALID_INPUT",
        message: "That identifier is not valid.",
        hint: "A path or query value was the wrong type for its column.",
        level: "warn",
      };

    /**
     * Integrity violations that a route did not already handle with its own
     * message. 409 because the request is coherent and the stored data refuses
     * it, which is a conflict rather than a server fault.
     *
     * The message stays generic on purpose. The driver's own text names the
     * constraint, the table and often the conflicting value — a schema map and
     * possibly someone's data, handed to whoever poked the endpoint. It goes to
     * the log, where it belongs, via `err`.
     */
    case PG.UNIQUE_VIOLATION:
      return {
        status: 409,
        code: "DUPLICATE_RECORD",
        message: "A record with these details already exists.",
        level: "warn",
      };
    case PG.FOREIGN_KEY_VIOLATION:
      return {
        status: 409,
        code: "RELATED_RECORD_MISSING",
        message:
          "That change refers to a record that no longer exists. Reload the " +
          "page and try again.",
        level: "warn",
      };
    case PG.NOT_NULL_VIOLATION:
    case PG.CHECK_VIOLATION:
      return {
        status: 400,
        code: "INVALID_INPUT",
        message: "Some required details are missing or not allowed.",
        hint: "A column rejected the value a route tried to write.",
        level: "warn",
      };

    /** The database is up but not taking work. Retryable, so 503. */
    case PG.TOO_MANY_CONNECTIONS:
    case PG.ADMIN_SHUTDOWN:
    case PG.CANNOT_CONNECT_NOW:
    case PG.CONNECTION_FAILURE:
    case PG.SQLCLIENT_UNABLE_TO_ESTABLISH:
      return {
        status: 503,
        code: "DATABASE_UNAVAILABLE",
        message:
          "The service cannot reach its database right now. Try again in a moment.",
        hint: `Postgres refused the connection (SQLSTATE ${code}).`,
        level: "error",
      };
  }

  /**
   * A response failed its own schema. The request probably did its work and the
   * reply could not be serialised, so this is a bug in this codebase rather than
   * anything the caller did — worth distinguishing in the log, since the fix is
   * a code change and never a configuration one.
   */
  if (isZodError(err)) {
    return {
      status: 500,
      code: "INTERNAL_ERROR",
      message: "The server built an invalid response for this request.",
      hint:
        "A route's response did not match its schema in lib/api-spec. Compare " +
        "the route against openapi.yaml — the zod issues are in this log entry.",
      level: "error",
    };
  }

  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "Something went wrong handling this request.",
    level: "error",
  };
}

/**
 * Unknown path under /api.
 *
 * Without this, express's default 404 is HTML, so a call to a route that was
 * never registered looks in the portal exactly like one that crashed. They have
 * nothing to do with each other — a missing route is usually a stale frontend
 * build or a proxy_pass with a trailing slash eating the /api prefix, and no
 * amount of reading server logs finds it while the two are indistinguishable.
 */
export const notFoundHandler: RequestHandler = (req, res) => {
  req.log?.warn(
    { method: req.method, url: req.originalUrl.split("?")[0] },
    "No route matched",
  );
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `No API route matches ${req.method} ${req.path}.`,
    },
  });
};

/**
 * The terminal error handler. Must be registered last, and must keep all four
 * parameters — express identifies an error handler by its arity, so dropping
 * the unused `next` silently turns this back into ordinary middleware.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  /**
   * Already streaming: the status line and headers are gone, so nothing can be
   * corrected in the response. Card PDFs stream out of the API with
   * proxy_buffering off, so this is a real case, not a theoretical one. Express's
   * own handler destroys the socket, which is the only honest ending — a
   * truncated PDF must not look like a complete one.
   */
  if (res.headersSent) {
    (req.log ?? logger).error(
      { ...forLogging(err), url: req.originalUrl.split("?")[0] },
      "Request failed after the response had started; connection aborted",
    );
    next(err);
    return;
  }

  const { status, code, message, hint, level } = classify(err);
  const driverCode = errorCode(err);

  // req.log is pino-http's per-request child logger: it already carries the
  // request id, so the two lines for one request line up in the log.
  const log = req.log ?? logger;
  log[level](
    {
      ...forLogging(err),
      errorCode: code,
      status,
      method: req.method,
      // Query strings on these routes carry member names and identifiers.
      url: req.originalUrl.split("?")[0],
      ...(driverCode ? { pgCode: driverCode } : {}),
      ...(hint ? { hint } : {}),
    },
    `${status} ${code}`,
  );

  const requestId = typeof req.id === "string" ? req.id : undefined;

  /**
   * The reference goes in the message text, not only in a field beside it.
   * Every screen in the portal renders `error.data.error.message` and nothing
   * else, so a field the UI never reads cannot be quoted by the person looking
   * at the failure — and being able to quote it is the entire point.
   */
  const reference = requestId ? ` (reference: ${requestId})` : "";

  res.status(status).json({
    error: {
      code,
      message: `${message}${reference}`,
      ...(requestId ? { requestId } : {}),
      /**
       * The raw message, in development only. It is the fastest way to see what
       * actually broke while working locally, and on a real server it would
       * publish SQL, table names and connection strings to anyone who can
       * provoke an error.
       */
      ...(process.env.NODE_ENV !== "production" && err instanceof Error
        ? { detail: err.message }
        : {}),
    },
  });
};
