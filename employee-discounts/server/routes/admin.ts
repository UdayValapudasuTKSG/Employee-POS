/**
 * The admin portal: sign-in, the discount settings, the employees, and the
 * metrics behind the dashboard. Every route but sign-in needs an admin session.
 */
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { checkAdminOtp, endAdminSession, isAdminEmail, requireAdmin, sendAdminOtp, startAdminSession } from "../adminAuth";
import { fail, OtpError } from "../auth";
import { audit, pool, tx } from "../db";
import { STORE_NAMES, STORES, centsOf, currentMonth, fromCents, monthWindow, type Store } from "../rules";
import { getTerms, type Terms } from "../settings";

export const adminRouter = Router();

const limiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false,
  handler: (_req, res) => fail(res, 429, "RATE_LIMITED", "Too many attempts. Wait a minute and try again.") });

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

adminRouter.post("/api/admin/auth/start", limiter, async (req, res) => {
  const parsed = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "INVALID_EMAIL", "Enter your email address.");
  if (!isAdminEmail(parsed.data.email)) {
    return fail(res, 404, "NOT_AN_ADMIN", "That email is not on the admin list. Ask whoever runs the server to add it to ADMIN_EMAILS.");
  }
  try {
    res.json(await sendAdminOtp(parsed.data.email));
  } catch (err) {
    if (err instanceof OtpError) return fail(res, err.status, err.code, err.message);
    throw err;
  }
});

adminRouter.post("/api/admin/auth/verify", limiter, async (req, res) => {
  const parsed = z.object({ challengeId: z.string().min(1).max(64), code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "INVALID_CODE", "Enter the 6-digit code from your email.");
  let email: string;
  try {
    email = await checkAdminOtp(parsed.data.challengeId, parsed.data.code);
  } catch (err) {
    if (err instanceof OtpError) return fail(res, err.status, err.code, err.message);
    throw err;
  }
  const ok = await tx(async (client) => {
    if (!(await startAdminSession(client, parsed.data.challengeId, email, res))) return false;
    await audit(client, `admin:${email}`, "ADMIN_SIGNED_IN", null);
    return true;
  });
  if (!ok) return fail(res, 400, "OTP_NOT_FOUND", "This code is no longer valid. Ask for a new one.");
  res.json({ ok: true, email });
});

adminRouter.post("/api/admin/auth/logout", async (req, res) => {
  await endAdminSession(req, res);
  res.json({ ok: true });
});

adminRouter.use("/api/admin", requireAdmin);

adminRouter.get("/api/admin/me", (req, res) => {
  res.json({ email: req.adminEmail });
});

// ---------------------------------------------------------------------------
// Discount settings
// ---------------------------------------------------------------------------

function termsJson(t: Terms) {
  return {
    monthlyCap: fromCents(t.monthlyCapCents),
    codeTtlMinutes: t.codeTtlMinutes,
    stores: STORES.map((s) => ({
      store: s,
      name: STORE_NAMES[s],
      percent: t.stores[s].percentBp / 100,
      monthlyCap: t.stores[s].monthlyCapCents == null ? null : fromCents(t.stores[s].monthlyCapCents!),
      enabled: t.stores[s].enabled,
    })),
    updatedAt: t.updatedAt?.toISOString() ?? null,
    updatedBy: t.updatedBy,
  };
}

adminRouter.get("/api/admin/settings", async (_req, res) => {
  res.json(termsJson(await getTerms()));
});

const money = z.number().min(0).max(100_000_000).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "two decimals at most");
const SettingsBody = z.object({
  monthlyCap: money,
  codeTtlMinutes: z.number().int().min(1).max(1440),
  stores: z
    .array(
      z.object({
        store: z.enum(STORES),
        percent: z.number().gt(0).max(100).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "two decimals at most"),
        monthlyCap: money.nullable(),
        enabled: z.boolean(),
      }),
    )
    .length(STORES.length)
    .refine((list) => new Set(list.map((s) => s.store)).size === STORES.length, "each store once"),
});

adminRouter.put("/api/admin/settings", async (req, res) => {
  const parsed = SettingsBody.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(res, 400, "INVALID_SETTINGS", `Check the settings: ${issue ? `${issue.path.join(".")} ${issue.message}` : "invalid values"}.`);
  }
  const before = termsJson(await getTerms());
  const by = req.adminEmail!;
  const b = parsed.data;
  await tx(async (client) => {
    await client.query(
      `INSERT INTO program_settings (id, monthly_cap, code_ttl_minutes, updated_at, updated_by) VALUES (1, $1, $2, now(), $3)
       ON CONFLICT (id) DO UPDATE SET monthly_cap = $1, code_ttl_minutes = $2, updated_at = now(), updated_by = $3`,
      [b.monthlyCap.toFixed(2), b.codeTtlMinutes, by],
    );
    for (const s of b.stores) {
      await client.query(
        `INSERT INTO store_settings (store, discount_percent, monthly_cap, enabled, updated_at, updated_by) VALUES ($1, $2, $3, $4, now(), $5)
         ON CONFLICT (store) DO UPDATE SET discount_percent = $2, monthly_cap = $3, enabled = $4, updated_at = now(), updated_by = $5`,
        [s.store, s.percent.toFixed(2), s.monthlyCap == null ? null : s.monthlyCap.toFixed(2), s.enabled, by],
      );
    }
    await audit(client, `admin:${by}`, "SETTINGS_CHANGED", null, { before, after: b });
  });
  res.json(termsJson(await getTerms()));
});

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

const EmployeeQuery = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

adminRouter.get("/api/admin/employees", async (req, res) => {
  const parsed = EmployeeQuery.safeParse(req.query);
  if (!parsed.success) return fail(res, 400, "INVALID_FILTER", "Unknown filter.");
  const page = parsed.data.page ?? 1;
  const pageSize = parsed.data.pageSize ?? 20;
  const month = currentMonth();
  // The filters number their parameters from $1; the month's two come after them, main query only.
  const where: string[] = [];
  const args: unknown[] = [];
  if (parsed.data.search) {
    args.push(`%${parsed.data.search.toLowerCase()}%`);
    where.push(`(lower(e.email) LIKE $${args.length} OR lower(e.first_name || ' ' || e.last_name) LIKE $${args.length} OR lower(coalesce(e.employee_number, '')) LIKE $${args.length})`);
  }
  if (parsed.data.status) where.push(parsed.data.status === "active" ? "e.active" : "NOT e.active");
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (await pool.query<{ n: number }>(`SELECT count(*) AS n FROM employees e ${clause}`, args)).rows[0]!.n;
  const m1 = `$${args.length + 1}`;
  const m2 = `$${args.length + 2}`;
  const rows = await pool.query<{
    id: number; email: string; first_name: string; last_name: string; employee_number: string | null; company: string; active: boolean;
    saved: string | null; used_codes: number; last_used: Date | null;
  }>(
    `SELECT e.id, e.email, e.first_name, e.last_name, e.employee_number, e.company, e.active,
            sum(d.discount_amount) FILTER (WHERE d.status = 'REDEEMED' AND d.redeemed_at >= ${m1} AND d.redeemed_at < ${m2}) AS saved,
            count(d.id) FILTER (WHERE d.status = 'REDEEMED' AND d.redeemed_at >= ${m1} AND d.redeemed_at < ${m2}) AS used_codes,
            max(d.redeemed_at) FILTER (WHERE d.status = 'REDEEMED') AS last_used
       FROM employees e LEFT JOIN discount_codes d ON d.employee_id = e.id
       ${clause}
      GROUP BY e.id ORDER BY e.active DESC, e.last_name, e.first_name
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    [...args, month.start, month.end],
  );
  res.json({
    items: rows.rows.map((r) => ({
      id: r.id,
      email: r.email,
      firstName: r.first_name,
      lastName: r.last_name,
      employeeNumber: r.employee_number,
      company: r.company,
      active: r.active,
      savedThisMonth: fromCents(centsOf(r.saved)),
      codesUsedThisMonth: Number(r.used_codes),
      lastUsedAt: r.last_used?.toISOString() ?? null,
    })),
    page,
    pageSize,
    totalItems: total,
    totalPages: Math.ceil(total / pageSize),
  });
});

const NewEmployee = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  employeeNumber: z.string().trim().max(50).optional().transform((v) => v || null),
  company: z.string().trim().max(150).optional().transform((v) => v || "Edward B. Beharry & Company Ltd"),
});

adminRouter.post("/api/admin/employees", async (req, res) => {
  const parsed = NewEmployee.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "INVALID_EMPLOYEE", "Enter a valid email and the employee's first and last name.");
  const e = parsed.data;
  try {
    const r = await pool.query<{ id: number }>(
      "INSERT INTO employees (email, first_name, last_name, employee_number, company) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [e.email, e.firstName, e.lastName, e.employeeNumber, e.company],
    );
    await audit(pool, `admin:${req.adminEmail}`, "EMPLOYEE_ADDED", String(r.rows[0]!.id), { email: e.email });
    res.status(201).json({ id: r.rows[0]!.id });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return fail(res, 409, "EMPLOYEE_EXISTS", "An employee with that email or employee number already exists.");
    }
    throw err;
  }
});

adminRouter.post("/api/admin/employees/:id/active", async (req, res) => {
  const id = Number(req.params["id"]);
  const parsed = z.object({ active: z.boolean() }).safeParse(req.body);
  if (!Number.isInteger(id) || !parsed.success) return fail(res, 400, "INVALID_INPUT", "Say whether the employee is active.");
  const r = await pool.query("UPDATE employees SET active = $2, updated_at = now() WHERE id = $1", [id, parsed.data.active]);
  if (r.rowCount !== 1) return fail(res, 404, "NOT_FOUND", "No such employee.");
  // Deactivating signs the employee out everywhere.
  if (!parsed.data.active) await pool.query("UPDATE sessions SET revoked_at = now() WHERE employee_id = $1 AND revoked_at IS NULL", [id]);
  await audit(pool, `admin:${req.adminEmail}`, parsed.data.active ? "EMPLOYEE_ACTIVATED" : "EMPLOYEE_DEACTIVATED", String(id));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const TZ = "America/Guyana";

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

interface Kpis {
  redemptions: number;
  saved: number;
  sales: number;
  voids: number;
  employeesSaving: number;
  partial: number;
  generated: number;
  expiredUnused: number;
  signedIn: number;
  atCap: number;
}

async function kpis(month: string, capCents: number): Promise<Kpis> {
  const w = monthWindow(month);
  const r = (
    await pool.query<{ redemptions: number; saved: string | null; sales: string | null; voids: number; employees: number; partial: number }>(
      `SELECT count(*) FILTER (WHERE status = 'REDEEMED') AS redemptions,
              sum(discount_amount) FILTER (WHERE status = 'REDEEMED') AS saved,
              sum(bill_amount) FILTER (WHERE status = 'REDEEMED') AS sales,
              count(*) FILTER (WHERE status = 'VOIDED') AS voids,
              count(DISTINCT employee_id) FILTER (WHERE status = 'REDEEMED') AS employees,
              count(*) FILTER (WHERE status = 'REDEEMED' AND discount_amount < full_discount_amount) AS partial
         FROM discount_codes WHERE redeemed_at >= $1 AND redeemed_at < $2`,
      [w.start, w.end],
    )
  ).rows[0]!;
  const g = (
    await pool.query<{ generated: number; expired: number }>(
      `SELECT count(*) AS generated,
              count(*) FILTER (WHERE status = 'EXPIRED' OR (status = 'ACTIVE' AND expires_at <= now())) AS expired
         FROM discount_codes WHERE created_at >= $1 AND created_at < $2`,
      [w.start, w.end],
    )
  ).rows[0]!;
  const signedIn = (
    await pool.query<{ n: number }>("SELECT count(DISTINCT employee_id) AS n FROM sessions WHERE created_at >= $1 AND created_at < $2", [w.start, w.end])
  ).rows[0]!.n;
  const atCap = (
    await pool.query<{ n: number }>(
      `SELECT count(*) AS n FROM (
         SELECT employee_id FROM discount_codes WHERE status = 'REDEEMED' AND redeemed_at >= $1 AND redeemed_at < $2
          GROUP BY employee_id HAVING sum(discount_amount) >= $3) x`,
      [w.start, w.end, (capCents / 100).toFixed(2)],
    )
  ).rows[0]!.n;
  return {
    redemptions: Number(r.redemptions),
    saved: fromCents(centsOf(r.saved)),
    sales: fromCents(centsOf(r.sales)),
    voids: Number(r.voids),
    employeesSaving: Number(r.employees),
    partial: Number(r.partial),
    generated: Number(g.generated),
    expiredUnused: Number(g.expired),
    signedIn: Number(signedIn),
    atCap: Number(atCap),
  };
}

adminRouter.get("/api/admin/metrics", async (req, res) => {
  const parsed = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }).safeParse(req.query);
  if (!parsed.success) return fail(res, 400, "INVALID_MONTH", "Month must be YYYY-MM.");
  const month = parsed.data.month ?? currentMonth().month;
  const w = monthWindow(month);
  const t = await getTerms();

  const [current, previous] = await Promise.all([kpis(month, t.monthlyCapCents), kpis(shiftMonth(month, -1), t.monthlyCapCents)]);

  const employees = (
    await pool.query<{ total: number; active: number }>("SELECT count(*) AS total, count(*) FILTER (WHERE active) AS active FROM employees")
  ).rows[0]!;
  const liveCodes = (await pool.query<{ n: number }>("SELECT count(*) AS n FROM discount_codes WHERE status = 'ACTIVE' AND expires_at > now()")).rows[0]!.n;

  // Each day of the month, in Guyana dates.
  const dailyRows = await pool.query<{ day: string; n: number; saved: string | null; sales: string | null }>(
    `SELECT to_char((redeemed_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS day, count(*) AS n, sum(discount_amount) AS saved, sum(bill_amount) AS sales
       FROM discount_codes WHERE status = 'REDEEMED' AND redeemed_at >= $1 AND redeemed_at < $2 GROUP BY 1`,
    [w.start, w.end],
  );
  const byDay = new Map(dailyRows.rows.map((r) => [r.day, r]));
  const days: { day: string; redemptions: number; saved: number; sales: number }[] = [];
  for (let d = new Date(w.start.getTime() + 12 * 3600e3); d < w.end; d = new Date(d.getTime() + 86400e3)) {
    const key = new Date(d.getTime() - 4 * 3600e3).toISOString().slice(0, 10);
    const r = byDay.get(key);
    days.push({ day: key, redemptions: Number(r?.n ?? 0), saved: fromCents(centsOf(r?.saved ?? null)), sales: fromCents(centsOf(r?.sales ?? null)) });
  }

  const storeRows = await pool.query<{ store: Store; n: number; saved: string | null; sales: string | null; employees: number; partial: number }>(
    `SELECT store, count(*) AS n, sum(discount_amount) AS saved, sum(bill_amount) AS sales, count(DISTINCT employee_id) AS employees,
            count(*) FILTER (WHERE discount_amount < full_discount_amount) AS partial
       FROM discount_codes WHERE status = 'REDEEMED' AND redeemed_at >= $1 AND redeemed_at < $2 GROUP BY store`,
    [w.start, w.end],
  );
  const storeMap = new Map(storeRows.rows.map((r) => [r.store, r]));
  const stores = STORES.map((s) => {
    const r = storeMap.get(s);
    const n = Number(r?.n ?? 0);
    const sales = centsOf(r?.sales ?? null);
    const saved = centsOf(r?.saved ?? null);
    return {
      store: s,
      name: STORE_NAMES[s],
      enabled: t.stores[s].enabled,
      percent: t.stores[s].percentBp / 100,
      redemptions: n,
      saved: fromCents(saved),
      sales: fromCents(sales),
      employees: Number(r?.employees ?? 0),
      partial: Number(r?.partial ?? 0),
      averageBill: n ? fromCents(Math.round(sales / n)) : 0,
    };
  });

  // The six months up to and including this one.
  const first = monthWindow(shiftMonth(month, -5));
  const monthRows = await pool.query<{ m: string; n: number; saved: string | null; sales: string | null }>(
    `SELECT to_char(redeemed_at AT TIME ZONE '${TZ}', 'YYYY-MM') AS m, count(*) AS n, sum(discount_amount) AS saved, sum(bill_amount) AS sales
       FROM discount_codes WHERE status = 'REDEEMED' AND redeemed_at >= $1 AND redeemed_at < $2 GROUP BY 1`,
    [first.start, w.end],
  );
  const byMonth = new Map(monthRows.rows.map((r) => [r.m, r]));
  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(month, i - 5)).map((m) => {
    const r = byMonth.get(m);
    return { month: m, redemptions: Number(r?.n ?? 0), saved: fromCents(centsOf(r?.saved ?? null)), sales: fromCents(centsOf(r?.sales ?? null)) };
  });

  const hourRows = await pool.query<{ h: number; n: number }>(
    `SELECT extract(hour FROM redeemed_at AT TIME ZONE '${TZ}')::int AS h, count(*) AS n
       FROM discount_codes WHERE status = 'REDEEMED' AND redeemed_at >= $1 AND redeemed_at < $2 GROUP BY 1`,
    [w.start, w.end],
  );
  const byHour = new Map(hourRows.rows.map((r) => [Number(r.h), Number(r.n)]));
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, redemptions: byHour.get(h) ?? 0 }));

  // How much of the allowance active employees used this month.
  const usage = await pool.query<{ used: string | null }>(
    `SELECT sum(d.discount_amount) FILTER (WHERE d.status = 'REDEEMED' AND d.redeemed_at >= $1 AND d.redeemed_at < $2) AS used
       FROM employees e LEFT JOIN discount_codes d ON d.employee_id = e.id WHERE e.active GROUP BY e.id`,
    [w.start, w.end],
  );
  const buckets = [
    { label: "None", min: 0, max: 0 },
    { label: "1–25%", min: 0.0001, max: 25 },
    { label: "26–50%", min: 25.0001, max: 50 },
    { label: "51–75%", min: 50.0001, max: 75 },
    { label: "76–99%", min: 75.0001, max: 99.9999 },
    { label: "All of it", min: 100, max: Infinity },
  ].map((b) => ({ label: b.label, employees: 0, min: b.min, max: b.max }));
  for (const u of usage.rows) {
    const pct = t.monthlyCapCents > 0 ? (centsOf(u.used) / t.monthlyCapCents) * 100 : 0;
    const b = buckets.find((x) => pct >= x.min && pct <= x.max) ?? buckets[buckets.length - 1]!;
    b.employees += 1;
  }

  const top = await pool.query<{ id: number; first_name: string; last_name: string; email: string; employee_number: string | null; n: number; saved: string; sales: string }>(
    `SELECT e.id, e.first_name, e.last_name, e.email, e.employee_number, count(*) AS n, sum(d.discount_amount) AS saved, sum(d.bill_amount) AS sales
       FROM discount_codes d JOIN employees e ON e.id = d.employee_id
      WHERE d.status = 'REDEEMED' AND d.redeemed_at >= $1 AND d.redeemed_at < $2
      GROUP BY e.id ORDER BY sum(d.discount_amount) DESC, count(*) DESC LIMIT 10`,
    [w.start, w.end],
  );

  const recent = await pool.query<{
    id: string; redeemed_at: Date; status: string; store: Store; store_location: string | null; bill_amount: string; discount_amount: string;
    full_discount_amount: string | null; discount_percent: string | null; first_name: string; last_name: string; voided_at: Date | null;
  }>(
    `SELECT d.id, d.redeemed_at, d.status, d.store, d.store_location, d.bill_amount, d.discount_amount, d.full_discount_amount,
            d.discount_percent, d.voided_at, e.first_name, e.last_name
       FROM discount_codes d JOIN employees e ON e.id = d.employee_id
      WHERE d.status IN ('REDEEMED', 'VOIDED') AND d.redeemed_at >= $1 AND d.redeemed_at < $2
      ORDER BY d.redeemed_at DESC LIMIT 12`,
    [w.start, w.end],
  );

  res.json({
    month,
    isCurrentMonth: month === currentMonth().month,
    terms: termsJson(t),
    kpis: { current, previous },
    employees: { total: Number(employees.total), active: Number(employees.active) },
    liveCodes: Number(liveCodes),
    days,
    stores,
    months,
    hours,
    allowanceUse: buckets.map(({ label, employees: n }) => ({ label, employees: n })),
    topEmployees: top.rows.map((r) => ({
      id: r.id,
      name: `${r.first_name} ${r.last_name}`,
      email: r.email,
      employeeNumber: r.employee_number,
      redemptions: Number(r.n),
      saved: fromCents(centsOf(r.saved)),
      sales: fromCents(centsOf(r.sales)),
    })),
    recent: recent.rows.map((r) => ({
      id: r.id,
      at: r.redeemed_at.toISOString(),
      status: r.status,
      store: r.store,
      storeName: STORE_NAMES[r.store],
      storeLocation: r.store_location,
      employee: `${r.first_name} ${r.last_name}`,
      billAmount: Number(r.bill_amount),
      discountAmount: Number(r.discount_amount),
      percent: r.discount_percent == null ? null : Number(r.discount_percent),
      partial: r.full_discount_amount != null && Number(r.discount_amount) < Number(r.full_discount_amount),
    })),
  });
});
