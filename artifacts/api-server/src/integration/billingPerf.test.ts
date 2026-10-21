/**
 * SC-011: billing about 5,000 members across six companies takes under five
 * minutes. Runs only with BILLING_PERF=1: it adds 5,000 synthetic members to
 * the test database for good, so use a disposable one.
 */
import { expect, it } from "vitest";
import { describeDb, ensureStandardRates, makeCompany, useAppRoleGuard } from "./testDb";

const MEMBERS = 5_000;
const COMPANIES = 6;

describeDb("billing performance (SC-011)", () => {
  useAppRoleGuard();

  it.runIf(process.env["BILLING_PERF"] === "1")(
    `generates one month for ${MEMBERS} members in under 5 minutes`,
    async () => {
      const db = await import("@workspace/db");
      const { generateAll } = await import("../lib/billing/runs");
      await ensureStandardRates();
      const companies: string[] = [];
      for (let i = 0; i < COMPANIES; i++) companies.push(await makeCompany(`Perf ${i + 1}`));

      // A fixed pseudo-random sequence, so every run bills the same population.
      let seed = 20261001;
      const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      const created = new Date("2026-08-01T16:00:00Z");
      const tag = Date.now().toString(36);

      await db.withScope(db.SYSTEM_SCOPE, async (tx) => {
        for (let start = 0; start < MEMBERS; start += 500) {
          const batch = Array.from({ length: Math.min(500, MEMBERS - start) }, (_, j) => {
            const i = start + j;
            return {
              companyNumber: companies[i % COMPANIES]!,
              idType: "PERF",
              idNumber: `PERF-${tag}-${i}`,
              firstName: `Perf${i}`,
              lastName: "Member",
              classCode: ["A", "B", "C"][i % 3]!,
              active: true,
              createdAt: created,
            };
          });
          const rows = await tx.insert(db.bhiMemberTable).values(batch).returning({ id: db.bhiMemberTable.memberId, classCode: db.bhiMemberTable.classCode });
          await tx.insert(db.memberClassHistoryTable).values(rows.map((r) => ({ memberId: r.id, classCode: r.classCode, recordedAt: created, recordedBy: "PERF" })));
          const deps = rows.flatMap((r) =>
            Array.from({ length: Math.floor(rand() * 8) }, (_, k) => ({
              memberId: r.id,
              dependentFullName: `Dep${k} Member`,
              relationship: "CHILD",
              active: true,
              createdAt: created,
            })),
          );
          for (let k = 0; k < deps.length; k += 1000) await tx.insert(db.bhiDependentTable).values(deps.slice(k, k + 1000));
        }
      });

      const started = Date.now();
      const results = await generateAll("2026-10", { email: "perf@integration.test", role: "ROLE_PLATFORM_ADMIN" }, companies);
      const ms = Date.now() - started;
      // eslint-disable-next-line no-console
      console.info(`[billingPerf] ${MEMBERS} members, ${COMPANIES} companies: ${(ms / 1000).toFixed(1)} s`);

      expect(results.every((r) => r.status === "DRAFT")).toBe(true);
      const lines = results.reduce((n, r) => n + (r.status === "DRAFT" ? r.lines : 0), 0);
      expect(lines).toBe(MEMBERS);
      expect(ms).toBeLessThan(5 * 60 * 1000);
    },
    15 * 60 * 1000,
  );
});
