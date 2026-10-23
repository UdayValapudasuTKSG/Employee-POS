import type { Db } from "./db";
import { centsOf, currentMonth, type Month, type Store } from "./rules";
import type { Terms } from "./settings";

/** Discount already given to this employee in this month, in cents; only redeemed codes count. One store, or all. */
export async function usedCents(db: Db, employeeId: number, month: Month = currentMonth(), store?: Store): Promise<number> {
  const r = await db.query<{ total: string | null }>(
    `SELECT sum(discount_amount) AS total FROM discount_codes
      WHERE employee_id = $1 AND status = 'REDEEMED' AND redeemed_at >= $2 AND redeemed_at < $3
        AND ($4::text IS NULL OR store = $4)`,
    [employeeId, month.start, month.end, store ?? null],
  );
  return centsOf(r.rows[0]?.total ?? null);
}

/** What is left of the overall monthly allowance. */
export async function remainingCents(db: Db, employeeId: number, terms: Terms, month?: Month): Promise<number> {
  return terms.monthlyCapCents - (await usedCents(db, employeeId, month));
}

export interface Available {
  /** What can be given at this store now: the overall allowance, and the store's own limit if it has one. */
  cents: number;
  overallCents: number;
  storeCents: number | null;
  /** Which limit binds, for the message the cashier sees. */
  limitedBy: "OVERALL" | "STORE";
}

export async function availableAt(db: Db, employeeId: number, store: Store, terms: Terms, month: Month = currentMonth()): Promise<Available> {
  const overall = terms.monthlyCapCents - (await usedCents(db, employeeId, month));
  const cap = terms.stores[store].monthlyCapCents;
  const storeLeft = cap == null ? null : cap - (await usedCents(db, employeeId, month, store));
  const limitedBy = storeLeft != null && storeLeft < overall ? "STORE" : "OVERALL";
  return { cents: Math.max(0, Math.min(overall, storeLeft ?? overall)), overallCents: overall, storeCents: storeLeft, limitedBy };
}

/** Serialises everything that spends one employee's allowance. Call inside a transaction. */
export async function lockEmployee(db: Db, employeeId: number): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(727002, $1)", [employeeId]);
}
