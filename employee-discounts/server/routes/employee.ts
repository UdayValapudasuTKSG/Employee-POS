/**
 * The signed-in employee: their allowance, their one live code, getting a new
 * code (confirmed with an emailed passcode), and their history.
 */
import { Router } from "express";
import QRCode from "qrcode";
import { z } from "zod";
import { lockEmployee, remainingCents, usedCents } from "../allowance";
import { bestPercentBp, enabledStores, getTerms, type Terms } from "../settings";
import { checkOtp, claimOtp, fail, OtpError, requireEmployee, sendOtp, type Employee } from "../auth";
import { config } from "../config";
import { audit, pool, tx } from "../db";
import { discountCodeEmail, sendEmail, storeLogoAttachments } from "../email";
import { logger } from "../log";
import {
  STORE_NAMES,
  STORES,
  codeHash,
  currentMonth,
  decryptCode,
  encryptCode,
  fromCents,
  generateDiscountCode,
  maskEmail,
  monthWindow,
  normalizeCode,
  type Store,
} from "../rules";

export const employeeRouter = Router();
employeeRouter.use("/api/me", requireEmployee);
employeeRouter.use("/api/codes", requireEmployee);

/** The participating stores as the employee sees them: each with its own percentage and limit. */
function storesJson(t: Terms) {
  return enabledStores(t).map((s) => ({
    id: s.store,
    name: s.name,
    percent: s.percentBp / 100,
    monthlyCap: s.monthlyCapCents == null ? null : fromCents(s.monthlyCapCents),
  }));
}

/** The terms, for the landing page. Public: nothing here is personal. */
employeeRouter.get("/api/public/terms", async (_req, res) => {
  const t = await getTerms();
  const stores = storesJson(t);
  res.json({
    // The headline: the best any store gives; samePercent says whether every store gives it.
    percent: bestPercentBp(t) / 100,
    samePercent: new Set(stores.map((s) => s.percent)).size <= 1,
    currency: "GYD",
    monthlyCap: fromCents(t.monthlyCapCents),
    codeTtlMinutes: t.codeTtlMinutes,
    stores,
  });
});

interface CodeRow {
  id: string;
  code_enc: string;
  status: string;
  discount_percent: string | null;
  expires_at: Date;
  created_at: Date;
  store: Store | null;
  store_location: string | null;
  redeemed_at: Date | null;
  bill_amount: string | null;
  full_discount_amount: string | null;
  discount_amount: string | null;
}

/** ACTIVE past its time reads as EXPIRED; the row is tidied when the next code is made. */
const statusOf = (c: CodeRow, now = Date.now()) => (c.status === "ACTIVE" && c.expires_at.getTime() <= now ? "EXPIRED" : c.status);

function historyJson(c: CodeRow) {
  return {
    id: c.id,
    status: statusOf(c),
    // Set when used: the percentage the store applied.
    discountPercent: c.discount_percent == null ? null : Number(c.discount_percent),
    createdAt: c.created_at.toISOString(),
    expiresAt: c.expires_at.toISOString(),
    store: c.store,
    storeName: c.store ? STORE_NAMES[c.store] : null,
    storeLocation: c.store_location,
    redeemedAt: c.redeemed_at?.toISOString() ?? null,
    billAmount: c.bill_amount == null ? null : Number(c.bill_amount),
    fullDiscountAmount: c.full_discount_amount == null ? null : Number(c.full_discount_amount),
    discountAmount: c.discount_amount == null ? null : Number(c.discount_amount),
  };
}

employeeRouter.get("/api/me", async (req, res) => {
  const e = req.employee!;
  const t = await getTerms();
  const month = currentMonth();
  const used = await usedCents(pool, e.id, month);
  const stores = await Promise.all(
    storesJson(t).map(async (s) => ({
      ...s,
      // What is left at this store when it has a limit of its own.
      remaining: s.monthlyCap == null ? null : Math.max(0, s.monthlyCap - fromCents(await usedCents(pool, e.id, month, s.id))),
    })),
  );
  const latest = await pool.query<CodeRow>(
    "SELECT * FROM discount_codes WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 1",
    [e.id],
  );
  const last = latest.rows[0];
  const live = last && statusOf(last) === "ACTIVE" ? last : null;
  res.json({
    employee: { firstName: e.first_name, lastName: e.last_name, email: e.email, company: e.company, employeeNumber: e.employee_number },
    allowance: {
      percent: bestPercentBp(t) / 100,
      samePercent: new Set(stores.map((s) => s.percent)).size <= 1,
      currency: "GYD",
      month: month.month,
      monthlyCap: fromCents(t.monthlyCapCents),
      used: fromCents(used),
      remaining: fromCents(Math.max(0, t.monthlyCapCents - used)),
    },
    // The code itself, so it can be shown again on any device until it is used.
    activeCode: live
      ? { id: live.id, code: decryptCode(live.code_enc, config.sessionSecret), expiresAt: live.expires_at.toISOString(), createdAt: live.created_at.toISOString() }
      : null,
    latestCode: last ? historyJson(last) : null,
    stores,
    codeTtlMinutes: t.codeTtlMinutes,
  });
});

const EXHAUSTED = "You have used this month's discount allowance. It renews on the 1st.";

employeeRouter.post("/api/codes/otp", async (req, res) => {
  const e = req.employee!;
  const t = await getTerms();
  if (enabledStores(t).length === 0) return fail(res, 409, "NO_STORES", "No store is taking staff discount codes right now.");
  if ((await remainingCents(pool, e.id, t)) <= 0) return fail(res, 409, "ALLOWANCE_EXHAUSTED", EXHAUSTED);
  try {
    res.json(await sendOtp(e, "CODE"));
  } catch (err) {
    if (err instanceof OtpError) return fail(res, err.status, err.code, err.message);
    throw err;
  }
});

const GenerateBody = z.object({ challengeId: z.string().min(1).max(64), code: z.string().regex(/^\d{6}$/) });

employeeRouter.post("/api/codes", async (req, res) => {
  const e = req.employee!;
  const parsed = GenerateBody.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "INVALID_CODE", "Enter the 6-digit code from your email.");
  try {
    await checkOtp(parsed.data.challengeId, parsed.data.code, "CODE", e.id);
  } catch (err) {
    if (err instanceof OtpError) return fail(res, err.status, err.code, err.message);
    throw err;
  }

  const t = await getTerms();
  const code = generateDiscountCode();
  const outcome = await tx(async (client) => {
    await lockEmployee(client, e.id);
    if ((await remainingCents(client, e.id, t)) <= 0) return { refused: "EXHAUSTED" as const };
    if (!(await claimOtp(client, parsed.data.challengeId))) return { refused: "OTP_USED" as const };
    // One live code: the previous one is retired before the new one exists.
    await client.query(
      `UPDATE discount_codes SET status = CASE WHEN expires_at <= now() THEN 'EXPIRED' ELSE 'REPLACED' END, updated_at = now()
        WHERE employee_id = $1 AND status = 'ACTIVE'`,
      [e.id],
    );
    const r = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO discount_codes (employee_id, code_hash, code_enc, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(mins => $4)) RETURNING id, expires_at`,
      [e.id, codeHash(normalizeCode(code)!), encryptCode(code, config.sessionSecret), t.codeTtlMinutes],
    );
    await audit(client, `employee:${e.id}`, "CODE_GENERATED", r.rows[0]!.id);
    return { created: r.rows[0]! };
  });
  if ("refused" in outcome) {
    return outcome.refused === "EXHAUSTED"
      ? fail(res, 409, "ALLOWANCE_EXHAUSTED", EXHAUSTED)
      : fail(res, 400, "OTP_NOT_FOUND", "This code is no longer valid. Ask for a new one.");
  }

  res.json({
    activeCode: { id: outcome.created.id, code, expiresAt: outcome.created.expires_at.toISOString() },
    emailedTo: await emailCode(e, code, outcome.created.expires_at, t),
  });
});

/** Emails a copy with the QR code. Returns where it went, or null — it never claims a send that failed. */
async function emailCode(e: Employee, code: string, expiresAt: Date, t: Terms): Promise<string | null> {
  if (config.otpDevMode) return null;
  try {
    const qrPng = await QRCode.toBuffer(code, { type: "png", errorCorrectionLevel: "M", margin: 2, width: 440 });
    await sendEmail(e.email, discountCodeEmail({ firstName: e.first_name, code, stores: enabledStores(t).map((s) => ({ store: s.store, name: s.name, percent: s.percentBp / 100 })), expiresAt, qrCid: "code-qr" }), [
      { filename: "discount-code.png", content: qrPng, contentType: "image/png", cid: "code-qr" },
      ...storeLogoAttachments(enabledStores(t).map((s) => s.store)),
    ]);
    return maskEmail(e.email);
  } catch (err) {
    logger.warn("Discount code email not sent", { err, employeeId: e.id });
    return null;
  }
}

const HistoryQuery = z.object({
  store: z.enum(STORES).optional(),
  status: z.enum(["ACTIVE", "REDEEMED", "EXPIRED", "VOIDED", "REPLACED"]).optional(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

employeeRouter.get("/api/codes", async (req, res) => {
  const parsed = HistoryQuery.safeParse(req.query);
  if (!parsed.success) return fail(res, 400, "INVALID_FILTER", "Unknown store or status, or a month that is not YYYY-MM.");
  const { store, status, month } = parsed.data;
  const page = parsed.data.page ?? 1;
  const pageSize = parsed.data.pageSize ?? 10;

  const where = ["employee_id = $1"];
  const args: unknown[] = [req.employee!.id];
  const add = (sql: string, v: unknown) => {
    args.push(v);
    where.push(sql.replace("?", `$${args.length}`));
  };
  if (store) add("store = ?", store);
  // ACTIVE and EXPIRED split one stored status by the clock, as the list shows them.
  if (status === "ACTIVE") where.push("status = 'ACTIVE' AND expires_at > now()");
  else if (status === "EXPIRED") where.push("(status = 'EXPIRED' OR (status = 'ACTIVE' AND expires_at <= now()))");
  else if (status) add("status = ?", status);
  if (month) {
    const w = monthWindow(month);
    add("created_at >= ?", w.start);
    add("created_at < ?", w.end);
  }
  const clause = where.join(" AND ");
  const total = (await pool.query<{ n: number }>(`SELECT count(*) AS n FROM discount_codes WHERE ${clause}`, args)).rows[0]!.n;
  const rows = await pool.query<CodeRow>(
    `SELECT * FROM discount_codes WHERE ${clause} ORDER BY created_at DESC, id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    args,
  );
  res.json({ items: rows.rows.map(historyJson), page, pageSize, totalItems: total, totalPages: Math.ceil(total / pageSize) });
});
