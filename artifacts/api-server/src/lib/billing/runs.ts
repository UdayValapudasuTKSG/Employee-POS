/**
 * Monthly billing runs (spec FR-028 to FR-036; research R13).
 *
 * One live run per company and month. Generating again recalculates: the old
 * DRAFT becomes SUPERSEDED (kept, with its lines) and a new DRAFT is written.
 * A FINAL run is frozen — the database refuses to change it or its lines
 * (deploy/db/schema.sql) — and generating a FINAL month answers
 * ALREADY_FINAL. BHI's (company, month) index is not unique, so the one-live-
 * run rule is held under an advisory lock on (company, month).
 *
 * Every company runs in its own transaction under SYSTEM_SCOPE, the only scope
 * row-level security lets write billing.
 *
 * Draft runs follow the data (spec FR-033): after a change that can move a
 * bill — a member added, deactivated, reactivated or given another class, a
 * dependant added or removed, an import, a rate or billing rule — the
 * company's DRAFT runs are recalculated (recalculateDrafts). A draft is
 * replaced only when its lines or issues actually differ, so edits that do not
 * touch billing leave no trail of superseded copies. FINAL runs never change.
 */
import { and, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  SYSTEM_SCOPE,
  billingRunIssuesTable,
  bhiBillingLineTable,
  bhiBillingRunTable,
  bhiClassTable,
  bhiCompanyBillingRuleTable,
  bhiCompanyTable,
  bhiPremiumRatesTable,
  withScope,
  type ScopedTx,
} from "@workspace/db";
import { writeAudit } from "../audit";
import { errorSummary } from "../bhiErrors";
import { guyanaToday } from "../guyanaTime";
import { centsToMoney, toCents } from "../rateBands";
import { membersAsOf } from "./asOf";
import { chooseRate, chooseRule, monthDate, monthStart, split, tierFor } from "./pricing";

export interface Actor {
  email: string;
  role: string;
  sourceIp?: string | null;
  /** Set for an automatic recalculation: what changed. */
  cause?: string;
}

export interface Totals {
  totalPremium: string;
  companyPremium: string;
  employeePremium: string;
}

export type GenerateResult =
  | { companyNumber: string; status: "DRAFT"; runId: number; lines: number; issues: number; totals: Totals; supersededRunId: number | null }
  | { companyNumber: string; status: "ALREADY_FINAL"; runId: number }
  /** Only from recalculateDrafts: the draft already matches the data, so it was kept. */
  | { companyNumber: string; status: "UNCHANGED"; runId: number }
  | { companyNumber: string; status: "FAILED"; message: string };

export class BillingError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "RUN_NOT_DRAFT" | "RUN_HAS_ISSUES" | "UNKNOWN_COMPANY",
    message: string,
  ) {
    super(message);
  }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isMonth = (m: string) => MONTH_RE.test(m);

export function sumTotals(lines: { totalPremium: string; companyPremium: string; employeePremium: string }[]): Totals {
  let total = 0;
  let company = 0;
  let employee = 0;
  for (const l of lines) {
    total += toCents(l.totalPremium)!;
    company += toCents(l.companyPremium)!;
    employee += toCents(l.employeePremium)!;
  }
  return { totalPremium: centsToMoney(total), companyPremium: centsToMoney(company), employeePremium: centsToMoney(employee) };
}

type LineValues = Omit<typeof bhiBillingLineTable.$inferInsert, "billingRunId">;
type IssueValues = Omit<typeof billingRunIssuesTable.$inferInsert, "billingRunId">;

/** What a run says, independent of its id: equal fingerprints mean the same bill. */
function fingerprint(lines: LineValues[], issues: IssueValues[]): string {
  const l = lines
    .map((x) => [x.memberId, x.classCode, x.activeDependentCount, x.coverageBand, x.totalPremium, x.companyPremium, x.employeePremium, x.premiumRateId].join("|"))
    .sort();
  const i = issues.map((x) => `${x.memberId}|${x.reason}`).sort();
  return JSON.stringify([l, i]);
}

async function generateInTx(
  tx: ScopedTx,
  companyNumber: string,
  month: string,
  actor: Actor,
  now: Date,
  opts: { onlyIfChanged?: boolean } = {},
): Promise<GenerateResult> {
  const billingMonth = monthDate(month);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`billing:${companyNumber}:${billingMonth}`}))`);

  const existing = await tx
    .select()
    .from(bhiBillingRunTable)
    .where(and(eq(bhiBillingRunTable.companyNumber, companyNumber), eq(bhiBillingRunTable.billingMonth, billingMonth)));
  const final = existing.find((r) => r.status === "FINAL");
  if (final) return { companyNumber, status: "ALREADY_FINAL", runId: final.billingRunId };
  const drafts = existing.filter((r) => r.status === "DRAFT");

  const t = monthStart(month);
  const asOf = billingMonth;
  const members = await membersAsOf(tx, companyNumber, t);
  const rates = await tx
    .select()
    .from(bhiPremiumRatesTable)
    .where(
      and(
        eq(bhiPremiumRatesTable.active, true),
        or(isNull(bhiPremiumRatesTable.companyNumber), eq(bhiPremiumRatesTable.companyNumber, companyNumber)),
      ),
    );
  const rules = await tx.select().from(bhiCompanyBillingRuleTable).where(eq(bhiCompanyBillingRuleTable.companyNumber, companyNumber));
  const rule = chooseRule(rules, asOf);
  const classes = new Map((await tx.select().from(bhiClassTable)).map((c) => [c.classCode, c]));

  const lines: LineValues[] = [];
  const issues: IssueValues[] = [];
  for (const m of members) {
    const band = tierFor(m.activeDependentCount);
    const rate = chooseRate(rates, { companyNumber, classCode: m.classCode, band: band.dependentBand, asOf });
    if (!rate) {
      issues.push({
        memberId: m.memberId,
        reason: classes.get(m.classCode)?.active === false ? "CLASS_RETIRED_NO_RATE" : "NO_RATE",
      });
      continue;
    }
    lines.push({
      memberId: m.memberId,
      idType: m.idType,
      idNumber: m.idNumber,
      memberName: m.memberName,
      companyNumber,
      classCode: m.classCode,
      activeDependentCount: m.activeDependentCount,
      coverageBand: band.coverageBand,
      coverageLabel: band.coverageLabel,
      ...split(rate, rule),
      rateEffectiveDate: rate.effectiveDate,
      premiumRateId: rate.premiumRateId,
    });
  }
  // A recalculation keeps the current draft when nothing in it would change.
  const current = drafts.at(-1);
  if (opts.onlyIfChanged && current) {
    const onFileLines = await tx.select().from(bhiBillingLineTable).where(eq(bhiBillingLineTable.billingRunId, current.billingRunId));
    const onFileIssues = await tx.select().from(billingRunIssuesTable).where(eq(billingRunIssuesTable.billingRunId, current.billingRunId));
    if (fingerprint(onFileLines, onFileIssues) === fingerprint(lines, issues)) {
      return { companyNumber, status: "UNCHANGED", runId: current.billingRunId };
    }
  }

  if (drafts.length) {
    await tx
      .update(bhiBillingRunTable)
      .set({ status: "SUPERSEDED" })
      .where(inArray(bhiBillingRunTable.billingRunId, drafts.map((d) => d.billingRunId)));
  }
  const [run] = await tx
    .insert(bhiBillingRunTable)
    .values({
      companyNumber,
      billingMonth,
      billingDate: guyanaToday(now),
      generatedAt: now,
      generatedBy: actor.email.slice(0, 80),
      status: "DRAFT",
    })
    .returning();
  const runId = run!.billingRunId;
  const withRun = <T,>(rows: T[]) => rows.map((r) => ({ ...r, billingRunId: runId }));
  for (let i = 0; i < lines.length; i += 500) await tx.insert(bhiBillingLineTable).values(withRun(lines.slice(i, i + 500)));
  for (let i = 0; i < issues.length; i += 500) await tx.insert(billingRunIssuesTable).values(withRun(issues.slice(i, i + 500)));

  const totals = sumTotals(lines as Totals[]);
  await writeAudit(
    {
      actor: actor.email,
      actorRole: actor.role,
      action: actor.cause ? "BILLING_RUN_RECALCULATED" : "BILLING_RUN_GENERATED",
      reason: actor.cause ?? null,
      entityType: "BILLING_RUN",
      entityId: String(runId),
      afterValue: JSON.stringify({
        month,
        lines: lines.length,
        issues: issues.length,
        ...totals,
        supersededRunIds: drafts.map((d) => d.billingRunId),
        billingRule: rule ? { companySharePercent: rule.companySharePercent, effectiveDate: rule.effectiveDate } : null,
      }),
      sourceIp: actor.sourceIp ?? null,
      companyCode: companyNumber,
    },
    tx,
  );
  return {
    companyNumber,
    status: "DRAFT",
    runId,
    lines: lines.length,
    issues: issues.length,
    totals,
    supersededRunId: drafts.at(-1)?.billingRunId ?? null,
  };
}

/** Generates (or recalculates) one company's run for `month` ("YYYY-MM"). `now` is injectable for tests. */
export async function generateRun(companyNumber: string, month: string, actor: Actor, now: Date = new Date()): Promise<GenerateResult> {
  return withScope(SYSTEM_SCOPE, async (tx) => {
    const [company] = await tx.select().from(bhiCompanyTable).where(eq(bhiCompanyTable.companyNumber, companyNumber));
    if (!company) throw new BillingError("UNKNOWN_COMPANY", `There is no company ${companyNumber}.`);
    return generateInTx(tx, companyNumber, month, actor, now);
  });
}

/**
 * Generates every listed company (or every active one), each in its own
 * transaction, so one company's failure does not stop the others.
 */
export async function generateAll(
  month: string,
  actor: Actor,
  companies: "ALL" | string[] = "ALL",
  now: Date = new Date(),
): Promise<GenerateResult[]> {
  const targets =
    companies === "ALL"
      ? (
          await withScope(SYSTEM_SCOPE, (tx) =>
            tx.select({ n: bhiCompanyTable.companyNumber }).from(bhiCompanyTable).where(eq(bhiCompanyTable.active, true)),
          )
        )
          .map((c) => c.n)
          .sort()
      : [...new Set(companies)];
  const results: GenerateResult[] = [];
  for (const companyNumber of targets) {
    try {
      results.push(await generateRun(companyNumber, month, actor, now));
    } catch (err) {
      results.push({ companyNumber, status: "FAILED", message: errorSummary(err) });
    }
  }
  return results;
}

/**
 * Recalculates the DRAFT runs of the given companies (or of every company)
 * after a change that can move a bill. Each (company, month) runs in its own
 * transaction and keeps its draft when nothing would change. Never throws: a
 * failure is logged by the caller from the FAILED result, and the change that
 * prompted the recalculation stands either way.
 */
export async function recalculateDrafts(companies: "ALL" | string[], actor: Actor & { cause: string }, now: Date = new Date()): Promise<GenerateResult[]> {
  if (companies !== "ALL" && companies.length === 0) return [];
  let targets: { companyNumber: string; billingMonth: string }[];
  try {
    targets = await withScope(SYSTEM_SCOPE, (tx) =>
      tx
        .selectDistinct({ companyNumber: bhiBillingRunTable.companyNumber, billingMonth: bhiBillingRunTable.billingMonth })
        .from(bhiBillingRunTable)
        .where(
          companies === "ALL"
            ? eq(bhiBillingRunTable.status, "DRAFT")
            : and(eq(bhiBillingRunTable.status, "DRAFT"), inArray(bhiBillingRunTable.companyNumber, [...new Set(companies)])),
        ),
    );
  } catch (err) {
    return [{ companyNumber: companies === "ALL" ? "ALL" : companies.join(","), status: "FAILED", message: errorSummary(err) }];
  }
  const results: GenerateResult[] = [];
  for (const t of targets) {
    try {
      results.push(
        await withScope(SYSTEM_SCOPE, (tx) =>
          generateInTx(tx, t.companyNumber, t.billingMonth.slice(0, 7), actor, now, { onlyIfChanged: true }),
        ),
      );
    } catch (err) {
      results.push({ companyNumber: t.companyNumber, status: "FAILED", message: errorSummary(err) });
    }
  }
  return results;
}

/** Freezes a DRAFT run. Refused while any member is unpriced. */
export async function finaliseRun(runId: number, actor: Actor, reason: string): Promise<{ runId: number; companyNumber: string }> {
  return withScope(SYSTEM_SCOPE, async (tx) => {
    const [run] = await tx.select().from(bhiBillingRunTable).where(eq(bhiBillingRunTable.billingRunId, runId));
    if (!run) throw new BillingError("NOT_FOUND", "Billing run not found.");
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`billing:${run.companyNumber}:${run.billingMonth}`}))`);
    const [fresh] = await tx.select().from(bhiBillingRunTable).where(eq(bhiBillingRunTable.billingRunId, runId));
    if (fresh!.status !== "DRAFT") {
      throw new BillingError("RUN_NOT_DRAFT", `This run is ${fresh!.status}; only a draft can be finalised.`);
    }
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(billingRunIssuesTable).where(eq(billingRunIssuesTable.billingRunId, runId));
    if (n > 0) {
      throw new BillingError("RUN_HAS_ISSUES", `${n} member${n === 1 ? " has" : "s have"} no rate. Add the missing rates and recalculate first.`);
    }
    await tx.update(bhiBillingRunTable).set({ status: "FINAL" }).where(eq(bhiBillingRunTable.billingRunId, runId));
    await writeAudit(
      {
        actor: actor.email,
        actorRole: actor.role,
        action: "BILLING_RUN_FINALISED",
        entityType: "BILLING_RUN",
        entityId: String(runId),
        beforeValue: JSON.stringify({ status: "DRAFT" }),
        afterValue: JSON.stringify({ status: "FINAL", month: run.billingMonth.slice(0, 7) }),
        reason,
        sourceIp: actor.sourceIp ?? null,
        companyCode: run.companyNumber,
      },
      tx,
    );
    return { runId, companyNumber: run.companyNumber };
  });
}
