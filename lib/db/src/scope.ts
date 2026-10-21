/**
 * Company scope for the shared BHI tables.
 *
 * Every company's data lives in the same bhi tables, and row-level security
 * (deploy/db/schema.sql) lets a transaction see only the
 * companies named in its settings. `withScope` is the only way application
 * code should reach those tables: it opens a transaction, sets the scope for
 * that transaction alone, and runs the callback inside it.
 *
 * The settings are transaction-local (`set_config(..., true)`), so a pooled
 * connection goes back to the pool with no scope and a query that ran outside
 * `withScope` sees no company's rows at all — segregation fails closed (spec
 * FR-011). See specs/002-per-company-schema/research.md R4.
 */
import { sql } from "drizzle-orm";
import { db } from "./db";

export type Scope =
  /** Every company: super admin, support, auditor, and system jobs. */
  | { all: true; readOnly: boolean }
  /** Only these companies: client admins, HR administrators. */
  | { all: false; companies: string[]; readOnly: boolean };

/** Scope for jobs and tools that act on every company (sweeps, migration, lookup). */
export const SYSTEM_SCOPE: Scope = Object.freeze({ all: true, readOnly: false });

export type ScopedTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The companies a scope names, or null for "every company". */
export function scopeCompanies(scope: Scope): string[] | null {
  return scope.all ? null : scope.companies;
}

/** True when the scope reaches this company. */
export function scopeIncludes(scope: Scope, companyNumber: string): boolean {
  return scope.all || scope.companies.includes(companyNumber);
}

/**
 * Runs `fn` in a transaction whose row-level security scope is `scope`.
 *
 * A company number can never contain a comma — the policies split the list on
 * it — so one that does is refused rather than silently widening the scope.
 */
export async function withScope<T>(scope: Scope, fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
  const companies = scope.all ? [] : scope.companies;
  for (const c of companies) {
    if (c.includes(",")) throw new Error(`Invalid company number in scope: ${JSON.stringify(c)}`);
  }
  return db.transaction(async (tx) => {
    await tx.execute(
      sqlSetScope(scope.all ? "on" : "off", companies.join(","), scope.readOnly ? "on" : "off"),
    );
    return fn(tx);
  });
}

function sqlSetScope(all: string, companies: string, readOnly: string) {
  return sql`SELECT set_config('bhi.all', ${all}, true),
                    set_config('bhi.companies', ${companies}, true),
                    set_config('bhi.readonly', ${readOnly}, true)`;
}
