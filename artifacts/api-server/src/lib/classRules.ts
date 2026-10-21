/**
 * Which classes may be given to a member (spec FR-021, FR-022).
 *
 * Classes are shared by every company. A new assignment — creating a member, or
 * changing a member's class — needs a class that is active and whose standard
 * rates are complete: an active standard rate for each of the four tiers, in
 * force by the first month the member is billed on it (the 1st of next month,
 * nextBillingMonthStart), so the member can always be billed. A rate card that
 * only starts later does not make the class ready yet. A member who already carries a class keeps
 * it when it is retired; only new assignments are checked, so this is called
 * when the class changes, never on an unrelated edit.
 */
import { and, eq, isNull, lte } from "drizzle-orm";
import { bhiClassTable, bhiPremiumRatesTable, type ScopedTx } from "@workspace/db";
import { RATE_BANDS } from "./rateBands";
import { nextBillingMonthStart } from "./guyanaTime";

export class ClassNotAssignableError extends Error {
  readonly code = "CLASS_NOT_ASSIGNABLE";
  constructor(message: string) {
    super(message);
  }
}

export interface AssignableClass {
  classCode: string;
  className: string;
}

/**
 * Classes with an active standard rate for every tier in force on `asOf`
 * (YYYY-MM-DD) — by default the first month a member assigned now is billed.
 */
export async function rateCompleteClassCodes(tx: ScopedTx, asOf: string = nextBillingMonthStart()): Promise<Set<string>> {
  const rows = await tx
    .selectDistinct({ classCode: bhiPremiumRatesTable.classCode, band: bhiPremiumRatesTable.dependentBand })
    .from(bhiPremiumRatesTable)
    .where(
      and(
        isNull(bhiPremiumRatesTable.companyNumber),
        eq(bhiPremiumRatesTable.active, true),
        lte(bhiPremiumRatesTable.effectiveDate, asOf),
      ),
    );
  const bands = new Map<string, Set<number>>();
  for (const r of rows) bands.set(r.classCode, (bands.get(r.classCode) ?? new Set()).add(r.band));
  return new Set([...bands].filter(([, b]) => RATE_BANDS.every((t) => b.has(t.dependentBand))).map(([c]) => c));
}

/** Throws ClassNotAssignableError unless `classCode` may be newly assigned. */
export async function assertAssignable(tx: ScopedTx, classCode: string): Promise<AssignableClass> {
  const [cls] = await tx.select().from(bhiClassTable).where(eq(bhiClassTable.classCode, classCode));
  if (!cls) throw new ClassNotAssignableError(`There is no class "${classCode}".`);
  if (!cls.active) {
    throw new ClassNotAssignableError(`Class ${cls.classCode} (${cls.className}) is retired and cannot be given to a member.`);
  }
  const firstBilled = nextBillingMonthStart();
  if (!(await rateCompleteClassCodes(tx, firstBilled)).has(cls.classCode)) {
    throw new ClassNotAssignableError(
      `Class ${cls.classCode} (${cls.className}) has no complete standard rate in force by ${firstBilled}, the first month a member given it now is billed, so it cannot be given to a member yet.`,
    );
  }
  return { classCode: cls.classCode, className: cls.className };
}
