/**
 * The rate card and premium split rules (spec FR-022 to FR-027;
 * contracts/admin-api.md, Rates).
 *
 * A rate is entered as a set of four tiers for one class — Employee only, +1,
 * +2 and more than two — either on the standard card (companyNumber null),
 * which every company pays, or for one company, which then overrides the
 * standard card for that company from its effective date. Amounts are never
 * edited: a new effective date is a new set. A row can only be deactivated,
 * reactivated or annotated.
 *
 * Writes run in SYSTEM_SCOPE, the only scope row-level security lets write
 * rates and billing rules. Company users read the card in force for their own
 * companies.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, desc, eq, isNull, lte, or } from "drizzle-orm";
import {
  SYSTEM_SCOPE,
  bhiClassTable,
  bhiCompanyBillingRuleTable,
  bhiCompanyTable,
  bhiPremiumRatesTable,
  withScope,
  type BhiCompanyBillingRule,
  type BhiPremiumRates as BhiPremiumRate,
  type ScopedTx,
} from "@workspace/db";
import { CreateBillingRuleBody, CreateRateSetBody, UpdateRateBody } from "@workspace/api-zod";
import { writeAudit } from "../lib/audit";
import { companyParam, inScope, intParam } from "../lib/adminScope";
import { hasPermission } from "../lib/rbac";
import { RATE_BANDS, bandByNumber, toCents, validateRateSet } from "../lib/rateBands";
import { guyanaToday } from "../lib/guyanaTime";
import { recalcDraftBills } from "../lib/billing/recalc";
import { requireAdmin, requirePermission, type AdminContext } from "../middlewares/adminAuth";

const router: IRouter = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: string) => DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

const error = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } });

export function rateJson(r: BhiPremiumRate) {
  return {
    premiumRateId: r.premiumRateId,
    companyNumber: r.companyNumber,
    classCode: r.classCode,
    dependentBand: r.dependentBand,
    coverageBand: r.coverageBand,
    coverageLabel: r.coverageLabel,
    totalPremium: r.totalPremium,
    companyPremium: r.companyPremium,
    employeePremium: r.employeePremium,
    effectiveDate: r.effectiveDate,
    active: r.active,
    notes: r.notes,
    createdAt: r.createdAt?.toISOString() ?? null,
  };
}

function ruleJson(r: BhiCompanyBillingRule) {
  return {
    companyBillingRuleId: r.companyBillingRuleId,
    companyNumber: r.companyNumber,
    companySharePercent: r.companySharePercent,
    employeeSharePercent: r.employeeSharePercent,
    effectiveDate: r.effectiveDate,
    active: r.active,
    notes: r.notes,
    createdAt: r.createdAt?.toISOString() ?? null,
  };
}

function audit(
  req: Request,
  admin: AdminContext,
  tx: ScopedTx,
  entry: { action: string; entityType: string; entityId: string; before?: unknown; after: unknown; reason: string; companyNumber: string | null },
) {
  return writeAudit(
    {
      actor: admin.user.email,
      actorRole: admin.role,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      beforeValue: entry.before === undefined ? null : JSON.stringify(entry.before),
      afterValue: JSON.stringify(entry.after),
      reason: entry.reason,
      sourceIp: req.ip ?? null,
      companyCode: entry.companyNumber,
    },
    tx,
  );
}

/**
 * For each class and tier, the rate in force on `asOf`: the company's own rate
 * with the latest effective date on or before it, else the standard rate the
 * same way. Inactive rows never count.
 */
export function resolveRateCard(rates: BhiPremiumRate[], companyNumber: string | null, asOf: string) {
  const pick = (list: BhiPremiumRate[]) =>
    list
      .filter((r) => r.active && r.effectiveDate <= asOf)
      .sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : a.effectiveDate > b.effectiveDate ? -1 : b.premiumRateId - a.premiumRateId))[0];
  return (classCode: string) =>
    RATE_BANDS.map((band) => {
      const forTier = rates.filter((r) => r.classCode === classCode && r.dependentBand === band.dependentBand);
      const company = companyNumber ? pick(forTier.filter((r) => r.companyNumber === companyNumber)) : undefined;
      const chosen = company ?? pick(forTier.filter((r) => r.companyNumber === null));
      return {
        dependentBand: band.dependentBand,
        coverageBand: band.coverageBand,
        coverageLabel: band.coverageLabel,
        source: chosen ? (company ? ("COMPANY" as const) : ("STANDARD" as const)) : ("NONE" as const),
        premiumRateId: chosen?.premiumRateId ?? null,
        totalPremium: chosen?.totalPremium ?? null,
        companyPremium: chosen?.companyPremium ?? null,
        employeePremium: chosen?.employeePremium ?? null,
        effectiveDate: chosen?.effectiveDate ?? null,
      };
    });
}

// ---- Rate card --------------------------------------------------------------

router.get("/v1/admin/rates", requireAdmin, async (req, res): Promise<void> => {
  const admin = req.admin!;
  const company = typeof req.query["company"] === "string" && req.query["company"].trim() ? req.query["company"].trim().toUpperCase() : null;
  const asOf = typeof req.query["asOf"] === "string" && req.query["asOf"] ? req.query["asOf"] : guyanaToday();
  if (!isDate(asOf)) {
    error(res, 400, "INVALID_INPUT", "asOf must be a date (YYYY-MM-DD).");
    return;
  }
  if (company && !inScope(admin, company)) {
    error(res, 404, "NOT_FOUND", "Company not found.");
    return;
  }
  const card = await withScope(admin.scope, async (tx) => {
    if (company) {
      const [c] = await tx.select().from(bhiCompanyTable).where(eq(bhiCompanyTable.companyNumber, company));
      if (!c) return null;
    }
    const classes = await tx.select().from(bhiClassTable).orderBy(asc(bhiClassTable.sortOrder), asc(bhiClassTable.classCode));
    const rates = await tx
      .select()
      .from(bhiPremiumRatesTable)
      .where(
        and(
          eq(bhiPremiumRatesTable.active, true),
          lte(bhiPremiumRatesTable.effectiveDate, asOf),
          company
            ? or(isNull(bhiPremiumRatesTable.companyNumber), eq(bhiPremiumRatesTable.companyNumber, company))
            : isNull(bhiPremiumRatesTable.companyNumber),
        ),
      );
    const tiersFor = resolveRateCard(rates, company, asOf);
    return classes.map((c) => ({ classCode: c.classCode, className: c.className, active: c.active, tiers: tiersFor(c.classCode) }));
  });
  if (!card) {
    error(res, 404, "NOT_FOUND", "Company not found.");
    return;
  }
  res.json({ companyNumber: company, asOf, classes: card });
});

router.get(
  "/v1/admin/rates/history",
  requireAdmin,
  requirePermission("RATE_MANAGE"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const classCode = typeof req.query["classCode"] === "string" && req.query["classCode"] ? req.query["classCode"].toUpperCase() : null;
    const company = typeof req.query["company"] === "string" && req.query["company"] ? req.query["company"].toUpperCase() : null;
    const rows = await withScope(admin.scope, (tx) =>
      tx
        .select()
        .from(bhiPremiumRatesTable)
        .where(
          and(
            classCode ? eq(bhiPremiumRatesTable.classCode, classCode) : undefined,
            company === "STANDARD"
              ? isNull(bhiPremiumRatesTable.companyNumber)
              : company
                ? eq(bhiPremiumRatesTable.companyNumber, company)
                : undefined,
          ),
        )
        .orderBy(
          asc(bhiPremiumRatesTable.effectiveDate),
          asc(bhiPremiumRatesTable.classCode),
          asc(bhiPremiumRatesTable.dependentBand),
          asc(bhiPremiumRatesTable.premiumRateId),
        ),
    );
    res.json({ rates: rows.map(rateJson) });
  },
);

router.post(
  "/v1/admin/rates",
  requireAdmin,
  requirePermission("RATE_MANAGE"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const parsed = CreateRateSetBody.safeParse(req.body);
    if (!parsed.success) {
      error(res, 400, "INVALID_INPUT", "A class, an effective date, four tiers and a reason of at least 3 characters are required.");
      return;
    }
    const { tiers, reason, notes } = parsed.data;
    const classCode = parsed.data.classCode.trim().toUpperCase();
    const companyNumber = parsed.data.companyNumber?.trim().toUpperCase() || null;
    const effectiveDate = parsed.data.effectiveDate.trim();
    if (!isDate(effectiveDate)) {
      error(res, 400, "INVALID_INPUT", "The effective date must be a date (YYYY-MM-DD).");
      return;
    }
    const problems = validateRateSet(tiers);
    if (problems.length) {
      error(res, 400, "INVALID_INPUT", problems.join(" "));
      return;
    }
    const outcome = await withScope(SYSTEM_SCOPE, async (tx) => {
      const [cls] = await tx.select().from(bhiClassTable).where(eq(bhiClassTable.classCode, classCode));
      if (!cls) return { status: "NO_CLASS" as const };
      if (companyNumber) {
        const [c] = await tx.select().from(bhiCompanyTable).where(eq(bhiCompanyTable.companyNumber, companyNumber));
        if (!c) return { status: "NO_COMPANY" as const };
      }
      const rows = await tx
        .insert(bhiPremiumRatesTable)
        .values(
          [...tiers]
            .sort((a, b) => a.dependentBand - b.dependentBand)
            .map((t) => {
              const band = bandByNumber(t.dependentBand)!;
              return {
                companyNumber,
                classCode,
                coverageBand: band.coverageBand,
                coverageLabel: band.coverageLabel,
                dependentBand: band.dependentBand,
                totalPremium: (toCents(t.totalPremium)! / 100).toFixed(2),
                companyPremium: (toCents(t.companyPremium)! / 100).toFixed(2),
                employeePremium: (toCents(t.employeePremium)! / 100).toFixed(2),
                effectiveDate,
                active: true,
                notes: notes?.trim() || null,
              };
            }),
        )
        .returning();
      await audit(req, admin, tx, {
        action: "RATE_SET_CREATED",
        entityType: "PREMIUM_RATE",
        entityId: rows.map((r) => r.premiumRateId).join(","),
        after: {
          companyNumber,
          classCode,
          effectiveDate,
          tiers: rows.map((r) => ({ band: r.coverageBand, total: r.totalPremium, company: r.companyPremium, employee: r.employeePremium })),
        },
        reason,
        companyNumber,
      });
      return { status: "OK" as const, rows };
    });
    if (outcome.status === "NO_CLASS") {
      error(res, 400, "INVALID_INPUT", `There is no class "${classCode}". Add the class first.`);
      return;
    }
    if (outcome.status === "NO_COMPANY") {
      error(res, 400, "UNKNOWN_COMPANY", `There is no company ${companyNumber}.`);
      return;
    }
    // A standard rate can reach every company's draft; a company rate, that company's.
    await recalcDraftBills(req, admin, companyNumber ? [companyNumber] : "ALL", `Rates added for class ${classCode}`);
    res.status(201).json({ rates: outcome.rows.map(rateJson) });
  },
);

router.patch(
  "/v1/admin/rates/:premiumRateId",
  requireAdmin,
  requirePermission("RATE_MANAGE"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const id = intParam(req, "premiumRateId");
    const parsed = UpdateRateBody.safeParse(req.body);
    if (!parsed.success) {
      // Amounts are not in the body schema, so an attempt to change one fails here.
      error(res, 400, "INVALID_INPUT", "Only active and notes can change, with a reason of at least 3 characters. Amounts are never edited: add a new rate set instead.");
      return;
    }
    if (!id) {
      error(res, 404, "NOT_FOUND", "Rate not found.");
      return;
    }
    const { reason, ...fields } = parsed.data;
    const updated = await withScope(SYSTEM_SCOPE, async (tx) => {
      const [current] = await tx.select().from(bhiPremiumRatesTable).where(eq(bhiPremiumRatesTable.premiumRateId, id));
      if (!current) return null;
      const changes: Partial<BhiPremiumRate> = {};
      if (fields.active !== undefined && fields.active !== current.active) changes.active = fields.active;
      if (fields.notes !== undefined && (fields.notes?.trim() || null) !== current.notes) changes.notes = fields.notes?.trim() || null;
      if (Object.keys(changes).length === 0) return current;
      const [row] = await tx.update(bhiPremiumRatesTable).set(changes).where(eq(bhiPremiumRatesTable.premiumRateId, id)).returning();
      await audit(req, admin, tx, {
        action: "RATE_UPDATED",
        entityType: "PREMIUM_RATE",
        entityId: String(id),
        before: Object.fromEntries(Object.keys(changes).map((k) => [k, current[k as keyof BhiPremiumRate]])),
        after: changes,
        reason,
        companyNumber: current.companyNumber,
      });
      return row!;
    });
    if (!updated) {
      error(res, 404, "NOT_FOUND", "Rate not found.");
      return;
    }
    await recalcDraftBills(req, admin, updated.companyNumber ? [updated.companyNumber] : "ALL", "Rate changed");
    res.json(rateJson(updated));
  },
);

// ---- Billing rules ------------------------------------------------------------

router.get(
  "/v1/admin/companies/:companyNumber/billing-rules",
  requireAdmin,
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    if (!hasPermission(admin.role, "RATE_MANAGE") && !hasPermission(admin.role, "BILLING_READ")) {
      error(res, 403, "FORBIDDEN", "You do not have permission to perform this action.");
      return;
    }
    const companyNumber = companyParam(req);
    if (!companyNumber || !inScope(admin, companyNumber)) {
      error(res, 404, "NOT_FOUND", "Company not found.");
      return;
    }
    const rules = await withScope(admin.scope, async (tx) => {
      const [c] = await tx.select().from(bhiCompanyTable).where(eq(bhiCompanyTable.companyNumber, companyNumber));
      if (!c) return null;
      return tx
        .select()
        .from(bhiCompanyBillingRuleTable)
        .where(eq(bhiCompanyBillingRuleTable.companyNumber, companyNumber))
        .orderBy(desc(bhiCompanyBillingRuleTable.effectiveDate));
    });
    if (!rules) {
      error(res, 404, "NOT_FOUND", "Company not found.");
      return;
    }
    res.json({ rules: rules.map(ruleJson) });
  },
);

/** A share as a percentage with at most two decimals, in hundredths, or null. */
function shareHundredths(v: string): number | null {
  const cents = toCents(v);
  return cents == null || cents < 0 || cents > 10_000 ? null : cents;
}

router.post(
  "/v1/admin/companies/:companyNumber/billing-rules",
  requireAdmin,
  requirePermission("RATE_MANAGE"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const companyNumber = companyParam(req);
    const parsed = CreateBillingRuleBody.safeParse(req.body);
    if (!parsed.success) {
      error(res, 400, "INVALID_INPUT", "Both shares, an effective date and a reason of at least 3 characters are required.");
      return;
    }
    if (!companyNumber) {
      error(res, 404, "NOT_FOUND", "Company not found.");
      return;
    }
    const company = shareHundredths(parsed.data.companySharePercent);
    const employee = shareHundredths(parsed.data.employeeSharePercent);
    if (company == null || employee == null || company + employee !== 10_000) {
      error(res, 400, "INVALID_INPUT", "The company and employee shares are percentages (0–100, two decimals) and must total 100.");
      return;
    }
    const effectiveDate = parsed.data.effectiveDate.trim();
    if (!isDate(effectiveDate)) {
      error(res, 400, "INVALID_INPUT", "The effective date must be a date (YYYY-MM-DD).");
      return;
    }
    const created = await withScope(SYSTEM_SCOPE, async (tx) => {
      const [c] = await tx.select().from(bhiCompanyTable).where(eq(bhiCompanyTable.companyNumber, companyNumber));
      if (!c) return null;
      const [rule] = await tx
        .insert(bhiCompanyBillingRuleTable)
        .values({
          companyNumber,
          companySharePercent: (company / 100).toFixed(2),
          employeeSharePercent: (employee / 100).toFixed(2),
          effectiveDate,
          active: parsed.data.active ?? true,
          notes: parsed.data.notes?.trim() || null,
        })
        .returning();
      await audit(req, admin, tx, {
        action: "BILLING_RULE_CREATED",
        entityType: "BILLING_RULE",
        entityId: String(rule!.companyBillingRuleId),
        after: ruleJson(rule!),
        reason: parsed.data.reason,
        companyNumber,
      });
      return rule!;
    });
    if (!created) {
      error(res, 404, "NOT_FOUND", "Company not found.");
      return;
    }
    await recalcDraftBills(req, admin, [companyNumber], "Billing rule added");
    res.status(201).json(ruleJson(created));
  },
);

export default router;
