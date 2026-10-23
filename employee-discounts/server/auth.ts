/**
 * One-time passcodes and sessions.
 *
 * A passcode is sent to the employee's own email on file, for signing in
 * (LOGIN) or for confirming a new discount code (CODE). Only its sha256 is
 * stored. Five minutes, three tries, one request a minute; a newer passcode
 * retires the older one.
 *
 * A session is an opaque random token in an HttpOnly cookie; only its sha256 is
 * stored, so a database read cannot be replayed as a login.
 */
import type { NextFunction, Request, Response } from "express";
import type pg from "pg";
import { config } from "./config";
import { pool, type Db } from "./db";
import { emailConfigured, otpEmail, sendEmail, type OtpPurpose } from "./email";
import { logger } from "./log";
import { generateOtp, generateSessionToken, maskEmail, sha256 } from "./rules";

export interface Employee {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  employee_number: string | null;
  company: string;
}

export function fail(res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>): void {
  res.status(status).json({ error: { code, message }, ...extra });
}

// ---------------------------------------------------------------------------
// Passcodes
// ---------------------------------------------------------------------------

export class OtpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SentOtp {
  challengeId: string;
  maskedEmail: string;
  expiresAt: string;
  resendAfterSeconds: number;
  /** Only with OTP_DEV_MODE=true. */
  devCode: string | null;
}

/** Sends a new passcode, or throws OtpError (too soon, could not send). */
export async function sendOtp(employee: Employee, purpose: OtpPurpose): Promise<SentOtp> {
  const latest = await pool.query<{ created_at: Date }>(
    `SELECT created_at FROM otp_challenges WHERE employee_id = $1 AND purpose = $2 AND status = 'PENDING'
     ORDER BY created_at DESC LIMIT 1`,
    [employee.id, purpose],
  );
  const since = latest.rows[0] ? (Date.now() - latest.rows[0].created_at.getTime()) / 1000 : Infinity;
  if (since < config.otpResendSeconds) {
    const wait = Math.ceil(config.otpResendSeconds - since);
    throw new OtpError(429, "OTP_TOO_SOON", `Wait ${wait} second${wait === 1 ? "" : "s"} before asking for another code.`);
  }
  if (!config.otpDevMode && !emailConfigured()) {
    throw new OtpError(503, "EMAIL_NOT_CONFIGURED", "Email is not set up on this server yet. Contact your HR department.");
  }

  const otp = generateOtp();
  const client = await pool.connect();
  let id: string;
  let expiresAt: Date;
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE otp_challenges SET status = 'SUPERSEDED' WHERE employee_id = $1 AND purpose = $2 AND status = 'PENDING'",
      [employee.id, purpose],
    );
    const r = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO otp_challenges (employee_id, purpose, code_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(mins => $4)) RETURNING id, expires_at`,
      [employee.id, purpose, sha256(`otp:${otp}`), config.otpTtlMinutes],
    );
    await client.query("COMMIT");
    id = r.rows[0]!.id;
    expiresAt = r.rows[0]!.expires_at;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  if (config.otpDevMode) {
    logger.info("[OTP dev mode] code not emailed", { purpose, email: maskEmail(employee.email), otp });
  } else {
    try {
      await sendEmail(employee.email, otpEmail(otp, config.otpTtlMinutes, purpose));
    } catch {
      // Retire the undelivered code so the employee can ask again at once.
      await pool.query("UPDATE otp_challenges SET status = 'SUPERSEDED' WHERE id = $1", [id]);
      throw new OtpError(503, "OTP_DELIVERY_FAILED", "We could not send your code just now. Try again in a minute.");
    }
  }
  return {
    challengeId: id,
    maskedEmail: maskEmail(employee.email),
    expiresAt: expiresAt.toISOString(),
    resendAfterSeconds: config.otpResendSeconds,
    devCode: config.otpDevMode ? otp : null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Checks a passcode, counting a wrong one. On success returns the employee it
 * belongs to — not yet marked used: the caller claims it with claimOtp inside
 * the transaction that does the work, so a failure there leaves it usable.
 */
export async function checkOtp(challengeId: string, otp: string, purpose: OtpPurpose, employeeId?: number): Promise<number> {
  const notFound = () => new OtpError(400, "OTP_NOT_FOUND", "This code is no longer valid. Ask for a new one.");
  if (!UUID.test(challengeId)) throw notFound();
  const r = await pool.query<{ employee_id: number; code_hash: string; status: string; expires_at: Date; purpose: string }>(
    "SELECT employee_id, code_hash, status, expires_at, purpose FROM otp_challenges WHERE id = $1",
    [challengeId],
  );
  const c = r.rows[0];
  if (!c || c.purpose !== purpose || (employeeId !== undefined && c.employee_id !== employeeId) || c.status === "USED") {
    throw notFound();
  }
  if (c.status === "SUPERSEDED") throw new OtpError(400, "OTP_SUPERSEDED", "A newer code was sent. Enter the latest one.");
  if (c.status === "LOCKED") throw new OtpError(423, "OTP_LOCKED", "Too many incorrect attempts. Ask for a new code.");
  if (c.expires_at.getTime() <= Date.now()) throw new OtpError(400, "OTP_EXPIRED", "This code has expired. Ask for a new one.");
  if (sha256(`otp:${otp}`) !== c.code_hash) {
    // Counted in the database, so parallel guesses cannot each see the old count.
    const u = await pool.query<{ attempts: number }>(
      `UPDATE otp_challenges SET attempts = attempts + 1,
         status = CASE WHEN attempts + 1 >= $2 THEN 'LOCKED' ELSE status END
       WHERE id = $1 AND status = 'PENDING' RETURNING attempts`,
      [challengeId, config.otpMaxAttempts],
    );
    const attempts = u.rows[0]?.attempts ?? config.otpMaxAttempts;
    if (attempts >= config.otpMaxAttempts) throw new OtpError(423, "OTP_LOCKED", "Too many incorrect attempts. Ask for a new code.");
    const left = config.otpMaxAttempts - attempts;
    throw new OtpError(400, "OTP_INCORRECT", `That code is not correct. ${left} attempt${left === 1 ? "" : "s"} left.`);
  }
  return c.employee_id;
}

/** Marks a checked passcode used; false when another request got there first. */
export async function claimOtp(db: Db, challengeId: string): Promise<boolean> {
  const r = await db.query("UPDATE otp_challenges SET status = 'USED', used_at = now() WHERE id = $1 AND status = 'PENDING'", [
    challengeId,
  ]);
  return r.rowCount === 1;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = "bsd_session";

export async function startSession(client: pg.PoolClient, employeeId: number, res: Response): Promise<void> {
  const token = generateSessionToken();
  await client.query(
    "INSERT INTO sessions (employee_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))",
    [employeeId, sha256(`session:${token}`), config.sessionHours],
  );
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.isProduction,
    maxAge: config.sessionHours * 3600 * 1000,
    path: "/",
  });
}

export async function endSession(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token === "string" && token) {
    await pool.query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [
      sha256(`session:${token}`),
    ]);
  }
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      employee?: Employee;
    }
  }
}

/** 401 unless the request carries a live session of an active employee. */
export async function requireEmployee(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== "string" || !token) {
    fail(res, 401, "SIGNED_OUT", "Sign in to continue.");
    return;
  }
  const r = await pool.query<Employee>(
    `SELECT e.id, e.email, e.first_name, e.last_name, e.employee_number, e.company
       FROM sessions s JOIN employees e ON e.id = s.employee_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND e.active`,
    [sha256(`session:${token}`)],
  );
  if (!r.rows[0]) {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    fail(res, 401, "SIGNED_OUT", "Your session has ended. Sign in again.");
    return;
  }
  req.employee = r.rows[0];
  next();
}
