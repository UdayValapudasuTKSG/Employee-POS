/**
 * Database errors from the shared BHI tables that deserve their own answer.
 *
 * Routes check these conditions first and answer with a precise message; this
 * is the net for a race or a path that did not (two admins adding the same
 * person at once, say). Used by middlewares/errorHandler.ts before its generic
 * classification.
 */

/** The driver error, wherever Drizzle's wrapping put it. */
function driverError(err: unknown): { code?: string; constraint?: string; message?: string } | null {
  let current: unknown = err;
  for (let depth = 0; current != null && depth < 5; depth++) {
    const c = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (typeof c.code === "string") {
      return {
        code: c.code,
        constraint: typeof c.constraint === "string" ? c.constraint : undefined,
        message: typeof c.message === "string" ? c.message : undefined,
      };
    }
    current = c.cause;
  }
  return null;
}

export interface BhiErrorAnswer {
  status: number;
  code: string;
  message: string;
  level: "warn" | "error";
  hint?: string;
}

/** The message a company-scoped user sees for a person registered elsewhere (spec FR-007). */
export const ID_ALREADY_REGISTERED_MESSAGE =
  "This ID is already registered on the platform. Contact NALICO.";

export function classifyBhiError(err: unknown): BhiErrorAnswer | null {
  const d = driverError(err);
  if (!d) return null;

  // One person, one company (spec FR-007). The unique key is checked across
  // every company, including rows the caller's scope cannot see — which is why
  // the message must not say where the other record is.
  if (d.code === "23505" && d.constraint === "member_id_type_id_number_uq") {
    return { status: 409, code: "ID_ALREADY_REGISTERED", message: ID_ALREADY_REGISTERED_MESSAGE, level: "warn" };
  }
  if (d.code === "23505" && d.constraint === "company_pk") {
    return {
      status: 409,
      code: "COMPANY_EXISTS",
      message: "A company with this number already exists.",
      level: "warn",
    };
  }
  if (d.code === "23505" && d.constraint === "class_pk") {
    return { status: 409, code: "CLASS_EXISTS", message: "A class with this code already exists.", level: "warn" };
  }
  if (d.code === "23505" && d.constraint === "premium_rates_company_class_band_date_uq") {
    return {
      status: 409,
      code: "RATE_EXISTS",
      message: "A rate for this class, tier and effective date already exists.",
      level: "warn",
    };
  }

  // deploy/db/schema.sql: a FINAL bill, its lines and the rates it used are frozen.
  if (d.code === "BHF01") {
    return { status: 409, code: "BILL_FINAL", message: "This bill is final and cannot be changed.", level: "warn" };
  }
  if (d.code === "23505" && d.constraint === "company_billing_rule_company_date_uq") {
    return {
      status: 409,
      code: "RULE_EXISTS",
      message: "This company already has a billing rule from that date.",
      level: "warn",
    };
  }

  // varchar(n) overflow. PostgreSQL does not name the column, so neither can
  // this; routes validate lengths first and name the field themselves.
  if (d.code === "22001") {
    return {
      status: 400,
      code: "VALUE_TOO_LONG",
      message: "A value is longer than its field allows.",
      level: "warn",
    };
  }

  // A write the row-level security policy refused: a company outside the
  // caller's scope, or an inactive one. Answered exactly like a record that
  // does not exist (spec FR-010).
  if (d.code === "42501" && /row-level security/i.test(d.message ?? "")) {
    return {
      status: 404,
      code: "NOT_FOUND",
      message: "Not found.",
      level: "warn",
      hint: "A write was refused by a row-level security policy (out of scope or inactive company).",
    };
  }

  return null;
}

/**
 * A one-line description of an error that is safe to log or print.
 *
 * Drizzle wraps a failed query in an error whose message repeats the SQL and
 * its parameters — member names, ID numbers, emails. This keeps only the
 * database's own message and SQLSTATE.
 */
export function errorSummary(err: unknown): string {
  const e = err as { query?: unknown; cause?: { message?: unknown; code?: unknown }; message?: unknown; code?: unknown } | null;
  if (e && typeof e.query === "string" && e.cause) {
    const code = typeof e.cause.code === "string" ? ` (${e.cause.code})` : "";
    return `${String(e.cause.message ?? "database error")}${code}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
