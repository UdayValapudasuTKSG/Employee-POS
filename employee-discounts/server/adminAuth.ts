/**
 * Admin sign-in: an emailed code, for addresses listed in ADMIN_EMAILS.
 *
 * Separate passcodes, sessions and cookie from the employees', so neither kind
 * of session can stand in for the other. The list is checked on every request:
 * an address taken out of ADMIN_EMAILS loses access at the next restart, even
 * mid-session.
 */
import type { NextFunction, Request, Response } from "express";
import type pg from "pg";
import { fail, OtpError, type SentOtp } from "./auth";
import { config } from "./config";
import { pool } from "./db";
import { emailConfigured, otpEmail, sendEmail } from "./email";
import { logger } from "./log";
import { generateOtp, generateSessionToken, maskEmail, sha256 } from "./rules";

export const ADMIN_COOKIE = "bsd_admin";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isAdminEmail = (email: string) => config.adminEmails.has(email.trim().toLowerCase());

export async function sendAdminOtp(email: string): Promise<SentOtp> {
  const latest = await pool.query<{ created_at: Date }>(
    "SELECT created_at FROM admin_otp_challenges WHERE email = $1 AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1",
    [email],
  );
  const since = latest.rows[0] ? (Date.now() - latest.rows[0].created_at.getTime()) / 1000 : Infinity;
  if (since < config.otpResendSeconds) {
    const wait = Math.ceil(config.otpResendSeconds - since);
    throw new OtpError(429, "OTP_TOO_SOON", `Wait ${wait} second${wait === 1 ? "" : "s"} before asking for another code.`);
  }
  if (!config.otpDevMode && !emailConfigured()) {
    throw new OtpError(503, "EMAIL_NOT_CONFIGURED", "Email is not set up on this server yet.");
  }
  const otp = generateOtp();
  await pool.query("UPDATE admin_otp_challenges SET status = 'SUPERSEDED' WHERE email = $1 AND status = 'PENDING'", [email]);
  const r = await pool.query<{ id: string; expires_at: Date }>(
    `INSERT INTO admin_otp_challenges (email, code_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3)) RETURNING id, expires_at`,
    [email, sha256(`admin-otp:${otp}`), config.otpTtlMinutes],
  );
  const { id, expires_at } = r.rows[0]!;
  if (config.otpDevMode) {
    logger.info("[OTP dev mode] admin code not emailed", { email: maskEmail(email), otp });
  } else {
    try {
      await sendEmail(email, otpEmail(otp, config.otpTtlMinutes, "ADMIN"));
    } catch {
      await pool.query("UPDATE admin_otp_challenges SET status = 'SUPERSEDED' WHERE id = $1", [id]);
      throw new OtpError(503, "OTP_DELIVERY_FAILED", "We could not send your code just now. Try again in a minute.");
    }
  }
  return {
    challengeId: id,
    maskedEmail: maskEmail(email),
    expiresAt: expires_at.toISOString(),
    resendAfterSeconds: config.otpResendSeconds,
    devCode: config.otpDevMode ? otp : null,
  };
}

/**
 * Checks an admin passcode, counting a wrong one, and returns the address it
 * belongs to. Not yet marked used: startAdminSession claims it, inside the
 * transaction that creates the session.
 */
export async function checkAdminOtp(challengeId: string, otp: string): Promise<string> {
  const notFound = () => new OtpError(400, "OTP_NOT_FOUND", "This code is no longer valid. Ask for a new one.");
  if (!UUID.test(challengeId)) throw notFound();
  const r = await pool.query<{ email: string; code_hash: string; status: string; expires_at: Date }>(
    "SELECT email, code_hash, status, expires_at FROM admin_otp_challenges WHERE id = $1",
    [challengeId],
  );
  const c = r.rows[0];
  if (!c || c.status === "USED" || !isAdminEmail(c.email)) throw notFound();
  if (c.status === "SUPERSEDED") throw new OtpError(400, "OTP_SUPERSEDED", "A newer code was sent. Enter the latest one.");
  if (c.status === "LOCKED") throw new OtpError(423, "OTP_LOCKED", "Too many incorrect attempts. Ask for a new code.");
  if (c.expires_at.getTime() <= Date.now()) throw new OtpError(400, "OTP_EXPIRED", "This code has expired. Ask for a new one.");
  if (sha256(`admin-otp:${otp}`) !== c.code_hash) {
    // Counted in the database, so parallel guesses cannot each see the old count.
    const u = await pool.query<{ attempts: number }>(
      `UPDATE admin_otp_challenges SET attempts = attempts + 1,
         status = CASE WHEN attempts + 1 >= $2 THEN 'LOCKED' ELSE status END
       WHERE id = $1 AND status = 'PENDING' RETURNING attempts`,
      [challengeId, config.otpMaxAttempts],
    );
    const attempts = u.rows[0]?.attempts ?? config.otpMaxAttempts;
    if (attempts >= config.otpMaxAttempts) throw new OtpError(423, "OTP_LOCKED", "Too many incorrect attempts. Ask for a new code.");
    const left = config.otpMaxAttempts - attempts;
    throw new OtpError(400, "OTP_INCORRECT", `That code is not correct. ${left} attempt${left === 1 ? "" : "s"} left.`);
  }
  return c.email;
}

/** Claims a checked passcode and starts the session; false when another request claimed it first. */
export async function startAdminSession(client: pg.PoolClient, challengeId: string, email: string, res: Response): Promise<boolean> {
  const claimed = await client.query("UPDATE admin_otp_challenges SET status = 'USED', used_at = now() WHERE id = $1 AND status = 'PENDING'", [
    challengeId,
  ]);
  if (claimed.rowCount !== 1) return false;
  const token = generateSessionToken();
  await client.query(
    "INSERT INTO admin_sessions (email, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))",
    [email, sha256(`admin-session:${token}`), config.sessionHours],
  );
  res.cookie(ADMIN_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: config.isProduction, maxAge: config.sessionHours * 3600 * 1000, path: "/" });
  return true;
}

export async function endAdminSession(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[ADMIN_COOKIE];
  if (typeof token === "string" && token) {
    await pool.query("UPDATE admin_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [
      sha256(`admin-session:${token}`),
    ]);
  }
  res.clearCookie(ADMIN_COOKIE, { path: "/" });
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminEmail?: string;
    }
  }
}

/** 401 unless a live admin session whose address is still in ADMIN_EMAILS. */
export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[ADMIN_COOKIE];
  if (typeof token !== "string" || !token) return fail(res, 401, "ADMIN_SIGNED_OUT", "Sign in to the admin portal.");
  const r = await pool.query<{ email: string }>(
    "SELECT email FROM admin_sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()",
    [sha256(`admin-session:${token}`)],
  );
  const email = r.rows[0]?.email;
  if (!email || !isAdminEmail(email)) {
    res.clearCookie(ADMIN_COOKIE, { path: "/" });
    return fail(res, 401, "ADMIN_SIGNED_OUT", "Your admin session has ended. Sign in again.");
  }
  req.adminEmail = email;
  next();
}
