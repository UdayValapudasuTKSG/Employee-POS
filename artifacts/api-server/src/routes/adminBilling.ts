/**
 * Monthly billing (spec FR-028 to FR-036; contracts/admin-api.md, Billing).
 *
 * Super admins generate, recalculate and finalise runs (lib/billing/runs.ts).
 * Anyone with BILLING_READ reads the runs of the companies in their scope —
 * row-level security returns nothing else — and exports the lines as CSV.
 */
import { Router, type IRouter, type Response } from "express";
import { and, asc, count, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import {
  billingRunIssuesTable,
  bhiBillingLineTable,
  bhiBillingRunTable,
  bhiCompanyTable,
  bhiMemberTable,
  bhiPremiumRatesTable,
  withScope,
  type BhiBillingRun,
  type ScopedTx,
} from "@workspace/db";
import { FinaliseBillingRunBody, GenerateBillingRunsBody } from "@workspace/api-zod";
import { intParam } from "../lib/adminScope";
import { RATE_BANDS } from "../lib/rateBands";
import { BillingError, finaliseRun, generateAll, isMonth, sumTotals } from "../lib/billing/runs";
import { requireAdmin, requirePermission } from "../middlewares/adminAuth";

const router: IRouter = Router();

const error = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } });

/** Summaries (counts and totals) of the runs matching `where`, in the transaction's scope. */
async function runSummaries(tx: ScopedTx, where: SQL | undefined) {
  const runs = await tx
    .select({ run: bhiBillingRunTable, companyName: bhiCompanyTable.companyName })
    .from(bhiBillingRunTable)
    .leftJoin(bhiCompanyTable, eq(bhiCompanyTable.companyNumber, bhiBillingRunTable.companyNumber))
    .where(where)
    .orderBy(desc(bhiBillingRunTable.billingMonth), asc(bhiBillingRunTable.companyNumber), desc(bhiBillingRunTable.billingRunId));
  const ids = runs.map((r) => r.run.billingRunId);
  if (ids.length === 0) return [];
  const sums = await tx
    .select({
      runId: bhiBillingLineTable.billingRunId,
      n: count(),
      total: sql<string>`coalesce(sum(${bhiBillingLineTable.totalPremium}), 0)::numeric(15,2)::text`,
      company: sql<string>`coalesce(sum(${bhiBillingLineTable.companyPremium}), 0)::numeric(15,2)::text`,
      employee: sql<string>`coalesce(sum(${bhiBillingLineTable.employeePremium}), 0)::numeric(15,2)::text`,
    })
    .from(bhiBillingLineTable)
    .where(inArray(bhiBillingLineTable.billingRunId, ids))
    .groupBy(bhiBillingLineTable.billingRunId);
  const issues = await tx
    .select({ runId: billingRunIssuesTable.billingRunId, n: count() })
    .from(billingRunIssuesTable)
    .where(inArray(billingRunIssuesTable.billingRunId, ids))
    .groupBy(billingRunIssuesTable.billingRunId);
  const sumBy = new Map(sums.map((s) => [s.runId, s]));
  const issuesBy = new Map(issues.map((i) => [i.runId, i.n]));
  return runs.map(({ run, companyName }) => summaryJson(run, companyName, sumBy.get(run.billingRunId), issuesBy.get(run.billingRunId) ?? 0));
}

function summaryJson(
  run: BhiBillingRun,
  companyName: string | null,
  sums: { n: number; total: string; company: string; employee: string } | undefined,
  issueCount: number,
) {
  return {
    billingRunId: run.billingRunId,
    companyNumber: run.companyNumber,
    companyName,
    billingMonth: run.billingMonth.slice(0, 7),
    billingDate: run.billingDate,
    generatedAt: run.generatedAt?.toISOString() ?? null,
    generatedBy: run.generatedBy,
    status: (run.status ?? "DRAFT") as "DRAFT" | "FINAL" | "SUPERSEDED",
    lineCount: sums?.n ?? 0,
    issueCount,
    totals: {
      totalPremium: sums?.total ?? "0.00",
      companyPremium: sums?.company ?? "0.00",
      employeePremium: sums?.employee ?? "0.00",
    },
  };
}

async function runDetail(tx: ScopedTx, runId: number) {
  const [summary] = await runSummaries(tx, eq(bhiBillingRunTable.billingRunId, runId));
  if (!summary) return null;
  const lines = await tx
    .select({ line: bhiBillingLineTable, rateCompany: bhiPremiumRatesTable.companyNumber })
    .from(bhiBillingLineTable)
    .leftJoin(bhiPremiumRatesTable, eq(bhiPremiumRatesTable.premiumRateId, bhiBillingLineTable.premiumRateId))
    .where(eq(bhiBillingLineTable.billingRunId, runId))
    .orderBy(asc(bhiBillingLineTable.memberName), asc(bhiBillingLineTable.memberId));
  const issues = await tx
    .select({
      memberId: billingRunIssuesTable.memberId,
      reason: billingRunIssuesTable.reason,
      firstName: bhiMemberTable.firstName,
      lastName: bhiMemberTable.lastName,
      idNumber: bhiMemberTable.idNumber,
      classCode: bhiMemberTable.classCode,
    })
    .from(billingRunIssuesTable)
    .leftJoin(bhiMemberTable, eq(bhiMemberTable.memberId, billingRunIssuesTable.memberId))
    .where(eq(billingRunIssuesTable.billingRunId, runId))
    .orderBy(asc(billingRunIssuesTable.memberId));

  const lineJson = lines.map(({ line: l, rateCompany }) => ({
    billingLineId: l.billingLineId,
    memberId: l.memberId,
    idType: l.idType,
    idNumber: l.idNumber,
    memberName: l.memberName,
    classCode: l.classCode,
    activeDependentCount: l.activeDependentCount,
    coverageBand: l.coverageBand,
    coverageLabel: l.coverageLabel,
    totalPremium: l.totalPremium,
    companyPremium: l.companyPremium,
    employeePremium: l.employeePremium,
    rateEffectiveDate: l.rateEffectiveDate,
    premiumRateId: l.premiumRateId,
    rateSource: rateCompany ? ("COMPANY" as const) : ("STANDARD" as const),
  }));

  // Headcount × rate per class and tier, as the client's Access process totals it.
  const groups = new Map<string, typeof lineJson>();
  for (const l of lineJson) {
    const key = `${l.classCode}|${l.coverageBand}`;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const bandOrder = RATE_BANDS.map((b) => b.coverageBand);
  const totalsByClassTier = [...groups.values()]
    .map((g) => {
      const t = sumTotals(g);
      return {
        classCode: g[0]!.classCode,
        dependentBand: Math.max(0, bandOrder.indexOf(g[0]!.coverageBand)),
        coverageBand: g[0]!.coverageBand,
        coverageLabel: g[0]!.coverageLabel,
        headcount: g.length,
        ...t,
      };
    })
    .sort((a, b) => (a.classCode < b.classCode ? -1 : a.classCode > b.classCode ? 1 : a.dependentBand - b.dependentBand));

  return {
    run: summary,
    totalsByClassTier,
    lines: lineJson,
    issues: issues.map((i) => ({
      memberId: i.memberId,
      memberName: i.firstName ? `${i.firstName} ${i.lastName}` : null,
      idNumber: i.idNumber,
      classCode: i.classCode,
      reason: i.reason,
    })),
  };
}

router.get(
  "/v1/admin/billing/runs",
  requireAdmin,
  requirePermission("BILLING_READ"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const str = (k: string) => (typeof req.query[k] === "string" ? (req.query[k] as string).trim() : "");
    const company = str("company").toUpperCase();
    const month = str("month");
    const status = str("status").toUpperCase();
    if (month && !isMonth(month)) {
      error(res, 400, "INVALID_INPUT", "month must be YYYY-MM.");
      return;
    }
    if (status && !["DRAFT", "FINAL", "SUPERSEDED"].includes(status)) {
      error(res, 400, "INVALID_INPUT", "status must be DRAFT, FINAL or SUPERSEDED.");
      return;
    }
    const where = and(
      company ? eq(bhiBillingRunTable.companyNumber, company) : undefined,
      month ? eq(bhiBillingRunTable.billingMonth, `${month}-01`) : undefined,
      status ? eq(bhiBillingRunTable.status, status) : ne(bhiBillingRunTable.status, "SUPERSEDED"),
    );
    res.json({ runs: await withScope(admin.scope, (tx) => runSummaries(tx, where)) });
  },
);

router.post(
  "/v1/admin/billing/runs",
  requireAdmin,
  requirePermission("BILLING_MANAGE"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const parsed = GenerateBillingRunsBody.safeParse(req.body);
    if (!parsed.success || !isMonth(parsed.data.month)) {
      error(res, 400, "INVALID_INPUT", 'Give a month (YYYY-MM) and companies: "ALL" or a list of company numbers.');
      return;
    }
    const companies = parsed.data.companies === "ALL" ? "ALL" : parsed.data.companies.map((c) => c.trim().toUpperCase()).filter(Boolean);
    if (companies !== "ALL" && companies.length === 0) {
      error(res, 400, "INVALID_INPUT", "Name at least one company, or ALL.");
      return;
    }
    const results = await generateAll(parsed.data.month, { email: admin.user.email, role: admin.role, sourceIp: req.ip ?? null }, companies);
    res.json({
      month: parsed.data.month,
      results: results.map((r) => ({
        companyNumber: r.companyNumber,
        status: r.status,
        runId: r.status === "FAILED" ? null : r.runId,
        lines: r.status === "DRAFT" ? r.lines : null,
        issues: r.status === "DRAFT" ? r.issues : null,
        totals: r.status === "DRAFT" ? r.totals : null,
        supersededRunId: r.status === "DRAFT" ? r.supersededRunId : null,
        message:
          r.status === "FAILED"
            ? r.message
            : r.status === "ALREADY_FINAL"
              ? "This month is already final for this company; it was not recalculated."
              : null,
      })),
    });
  },
);

router.get(
  "/v1/admin/billing/runs/:runId",
  requireAdmin,
  requirePermission("BILLING_READ"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const runId = intParam(req, "runId");
    const detail = runId ? await withScope(admin.scope, (tx) => runDetail(tx, runId)) : null;
    if (!detail) {
      error(res, 404, "NOT_FOUND", "Billing run not found.");
      return;
    }
    res.json(detail);
  },
);

const csvCell = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  // Quote anything a spreadsheet could misread, and neutralise formula prefixes.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

router.get(
  "/v1/admin/billing/runs/:runId/export.csv",
  requireAdmin,
  requirePermission("BILLING_READ"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const runId = intParam(req, "runId");
    const detail = runId ? await withScope(admin.scope, (tx) => runDetail(tx, runId)) : null;
    if (!detail) {
      error(res, 404, "NOT_FOUND", "Billing run not found.");
      return;
    }
    const header = [
      "CompanyNumber", "BillingMonth", "RunStatus", "MemberID", "IDType", "IDNumber", "MemberName", "ClassCode",
      "ActiveDependentCount", "CoverageBand", "CoverageLabel", "TotalPremium", "CompanyPremium", "EmployeePremium",
      "RateEffectiveDate", "PremiumRateID", "RateSource",
    ];
    const rows = detail.lines.map((l) => [
      detail.run.companyNumber, detail.run.billingMonth, detail.run.status, l.memberId, l.idType, l.idNumber, l.memberName,
      l.classCode, l.activeDependentCount, l.coverageBand, l.coverageLabel, l.totalPremium, l.companyPremium,
      l.employeePremium, l.rateEffectiveDate, l.premiumRateId, l.rateSource,
    ]);
    const body = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="billing-${detail.run.companyNumber}-${detail.run.billingMonth}-run${detail.run.billingRunId}.csv"`,
    );
    res.send(body);
  },
);

router.post(
  "/v1/admin/billing/runs/:runId/finalise",
  requireAdmin,
  requirePermission("BILLING_MANAGE"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const runId = intParam(req, "runId");
    const parsed = FinaliseBillingRunBody.safeParse(req.body);
    if (!parsed.success) {
      error(res, 400, "INVALID_INPUT", "A reason of at least 3 characters is required.");
      return;
    }
    if (!runId) {
      error(res, 404, "NOT_FOUND", "Billing run not found.");
      return;
    }
    try {
      await finaliseRun(runId, { email: admin.user.email, role: admin.role, sourceIp: req.ip ?? null }, parsed.data.reason);
    } catch (err) {
      if (err instanceof BillingError) {
        error(res, err.code === "NOT_FOUND" ? 404 : 409, err.code, err.message);
        return;
      }
      throw err;
    }
    const [summary] = await withScope(admin.scope, (tx) => runSummaries(tx, eq(bhiBillingRunTable.billingRunId, runId)));
    res.json(summary);
  },
);

export default router;
