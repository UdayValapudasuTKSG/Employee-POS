/**
 * Integration test harness.
 *
 * Every suite in this folder talks to a real PostgreSQL through TEST_DATABASE_URL
 * (vitest.config.ts maps it onto DATABASE_URL). It must be the application role:
 * a superuser, or a role with BYPASSRLS, skips row-level security, and a
 * segregation test that passes that way proves nothing. `assertAppRole` makes
 * that a hard failure rather than a silent pass.
 *
 * Data isolation between tests comes from throwaway companies with random
 * numbers, not from truncating tables — the application role cannot DELETE on
 * the BHI tables anyway, which is the point.
 */
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { beforeAll, describe } from "vitest";

export const hasTestDb = Boolean(process.env["TEST_DATABASE_URL"]);

/** `describe`, or `describe.skip` with a reason when no test database is set. */
export const describeDb: typeof describe = hasTestDb
  ? describe
  : (describe.skip as typeof describe);

if (!hasTestDb) {
  // One line per run is enough to explain the skips.
  // eslint-disable-next-line no-console
  console.info(
    "[integration] TEST_DATABASE_URL is not set — integration suites skipped. " +
      "Point it at the bhi_app role of a disposable database.",
  );
}

/** Fails the suite when connected as a role that bypasses row-level security. */
export function useAppRoleGuard(): void {
  beforeAll(async () => {
    const { pool } = await import("@workspace/db");
    const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
      "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    const r = rows[0];
    if (!r || r.rolsuper || r.rolbypassrls) {
      throw new Error(
        `TEST_DATABASE_URL connects as "${r?.rolname}", which bypasses row-level security. ` +
          "Use the bhi_app role; a segregation test that passes as a superuser proves nothing.",
      );
    }
  });
}

/** A random company number that no real data uses: T + 6 upper-case hex characters. */
export function randomCompanyNumber(): string {
  return "T" + randomBytes(3).toString("hex").toUpperCase();
}

/** A random id number, so members from different tests never collide on (id_type, id_number). */
export function randomIdNumber(): string {
  return "TEST-" + randomBytes(6).toString("hex");
}

/**
 * Inserts an active company visible only to scopes that include it. Returns its
 * number. Runs with the all-companies scope, as onboarding does.
 */
export async function makeCompany(name = "Test company"): Promise<string> {
  const { withScope, SYSTEM_SCOPE, bhiCompanyTable } = await import("@workspace/db");
  const companyNumber = randomCompanyNumber();
  await withScope(SYSTEM_SCOPE, (tx) =>
    tx.insert(bhiCompanyTable).values({ companyNumber, companyName: name, active: true }),
  );
  return companyNumber;
}

export interface MemberFixture {
  companyNumber: string;
  classCode?: string;
  firstName?: string;
  lastName?: string;
  email?: string | null;
  phone?: string | null;
  dateOfBirth?: string | null;
  active?: boolean;
}

/** Inserts a member (and its class history row) and returns its MemberID. */
export async function makeMember(f: MemberFixture): Promise<{ memberId: number; idType: string; idNumber: string }> {
  const { withScope, SYSTEM_SCOPE, bhiMemberTable, memberClassHistoryTable } = await import("@workspace/db");
  const idType = "NATIONAL ID";
  const idNumber = randomIdNumber();
  const classCode = f.classCode ?? "A";
  const memberId = await withScope(SYSTEM_SCOPE, async (tx) => {
    const [row] = await tx
      .insert(bhiMemberTable)
      .values({
        companyNumber: f.companyNumber,
        idType,
        idNumber,
        firstName: f.firstName ?? "Test",
        lastName: f.lastName ?? "Member",
        classCode,
        email: f.email ?? null,
        phone: f.phone ?? null,
        dateOfBirth: f.dateOfBirth === undefined ? "1990-01-01" : f.dateOfBirth,
        active: f.active ?? true,
        inactiveDate: f.active === false ? "2026-01-01" : null,
        inactiveReason: f.active === false ? "Test fixture" : null,
      })
      .returning({ memberId: bhiMemberTable.memberId });
    await tx.insert(memberClassHistoryTable).values({
      memberId: row!.memberId,
      classCode,
      recordedBy: "TEST",
    });
    return row!.memberId;
  });
  return { memberId, idType, idNumber };
}

/**
 * Loads the placeholder standard rates for classes A, B and C, if missing. A
 * class can be given to a member only once its four tiers are priced.
 */
export async function ensureStandardRates(): Promise<void> {
  const { withScope, SYSTEM_SCOPE } = await import("@workspace/db");
  const { DEMO_STANDARD_RATES_CSV, insertStandardRates, parseRateCard } = await import("../lib/standardRates");
  await withScope(SYSTEM_SCOPE, (tx) => insertStandardRates(tx, parseRateCard(DEMO_STANDARD_RATES_CSV).sets, "TEST"));
}

/** Starts the Express app in-process on a random port. */
export async function startApp(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  await ensureStandardRates();
  const { default: app } = await import("../app");
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/api`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
