/** Signing in with a code emailed to the employee's work address, and out again. */
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { checkOtp, claimOtp, endSession, fail, OtpError, sendOtp, startSession, type Employee } from "../auth";
import { audit, pool, tx } from "../db";

export const authRouter = Router();

// Slows guessing of emails and codes from one address; the per-code limit of
// three tries is the real defence.
const limiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false,
  handler: (_req, res) => fail(res, 429, "RATE_LIMITED", "Too many attempts. Wait a minute and try again.") });

const StartBody = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
const VerifyBody = z.object({ challengeId: z.string().min(1).max(64), code: z.string().regex(/^\d{6}$/) });

authRouter.post("/api/auth/start", limiter, async (req, res) => {
  const parsed = StartBody.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, "INVALID_EMAIL", "Enter your work email address.");
    return;
  }
  const r = await pool.query<Employee>(
    "SELECT id, email, first_name, last_name, employee_number, company FROM employees WHERE email = $1 AND active",
    [parsed.data.email],
  );
  const employee = r.rows[0];
  if (!employee) {
    // A product decision, as in the health card portal: an unknown address is
    // told so rather than left waiting for a code that will never come.
    fail(res, 404, "EMAIL_NOT_FOUND", "We couldn't find that email. Use the work email your employer has on file.");
    return;
  }
  try {
    res.json(await sendOtp(employee, "LOGIN"));
  } catch (err) {
    if (err instanceof OtpError) return fail(res, err.status, err.code, err.message);
    throw err;
  }
});

authRouter.post("/api/auth/verify", limiter, async (req, res) => {
  const parsed = VerifyBody.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, "INVALID_CODE", "Enter the 6-digit code from your email.");
    return;
  }
  let employeeId: number;
  try {
    employeeId = await checkOtp(parsed.data.challengeId, parsed.data.code, "LOGIN");
  } catch (err) {
    if (err instanceof OtpError) return fail(res, err.status, err.code, err.message);
    throw err;
  }
  const ok = await tx(async (client) => {
    if (!(await claimOtp(client, parsed.data.challengeId))) return false;
    await startSession(client, employeeId, res);
    await audit(client, `employee:${employeeId}`, "SIGNED_IN", String(employeeId));
    return true;
  });
  if (!ok) return fail(res, 400, "OTP_NOT_FOUND", "This code is no longer valid. Ask for a new one.");
  res.json({ ok: true });
});

authRouter.post("/api/auth/logout", async (req, res) => {
  await endSession(req, res);
  res.json({ ok: true });
});
