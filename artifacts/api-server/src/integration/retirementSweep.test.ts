/**
 * Research R19: the age-65 sweep deactivates members through setActive (so the
 * status history billing reads is written), leaves offboarded companies alone,
 * and reports members it cannot judge for lack of a date of birth.
 */
import { expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { describeDb, makeCompany, makeMember, useAppRoleGuard } from "./testDb";

describeDb("retirement sweep (R19)", () => {
  useAppRoleGuard();

  it("deactivates members of active companies who reached 65, with history and audit", async () => {
    const db = await import("@workspace/db");
    const { sweepRetirementAge, RETIREMENT_INACTIVE_REASON } = await import("../lib/retirementSweep");
    const company = await makeCompany("Sweep active");
    const frozen = await makeCompany("Sweep offboarded");
    const old = await makeMember({ companyNumber: company, dateOfBirth: "1955-03-01" });
    const young = await makeMember({ companyNumber: company, dateOfBirth: "1990-03-01" });
    const unknown = await makeMember({ companyNumber: company, dateOfBirth: null });
    const oldFrozen = await makeMember({ companyNumber: frozen, dateOfBirth: "1950-01-01" });
    await db.withScope(db.SYSTEM_SCOPE, (tx) =>
      tx.update(db.bhiCompanyTable).set({ active: false }).where(eq(db.bhiCompanyTable.companyNumber, frozen)),
    );

    const result = await sweepRetirementAge("2026-09-29");
    expect(result.deactivated).toContainEqual({ companyNumber: company, memberId: old.memberId });
    expect(result.deactivated.map((d) => d.memberId)).not.toContain(young.memberId);
    expect(result.deactivated.map((d) => d.memberId)).not.toContain(oldFrozen.memberId);
    expect(result.noDateOfBirth).toContainEqual({ companyNumber: company, memberId: unknown.memberId });

    const { member, history, audit } = await db.withScope(db.SYSTEM_SCOPE, async (tx) => ({
      member: (await tx.select().from(db.bhiMemberTable).where(eq(db.bhiMemberTable.memberId, old.memberId)))[0]!,
      history: await tx
        .select()
        .from(db.bhiEnrollmentStatusHistoryTable)
        .where(
          and(
            eq(db.bhiEnrollmentStatusHistoryTable.entityType, "MEMBER"),
            eq(db.bhiEnrollmentStatusHistoryTable.entityId, old.memberId),
          ),
        ),
      audit: await tx
        .select()
        .from(db.activityLogTable)
        .where(
          and(
            eq(db.activityLogTable.action, "MEMBER_DEACTIVATED_RETIREMENT_AGE"),
            eq(db.activityLogTable.entityId, String(old.memberId)),
          ),
        ),
    }));
    expect(member).toMatchObject({ active: false, inactiveDate: "2026-09-29", inactiveReason: RETIREMENT_INACTIVE_REASON });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ oldActive: true, newActive: false, changedBy: "SYSTEM" });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: "SYSTEM", companyCode: company });

    // A second run finds nothing new for this member.
    const again = await sweepRetirementAge("2026-09-29");
    expect(again.deactivated.map((d) => d.memberId)).not.toContain(old.memberId);
  });
});
