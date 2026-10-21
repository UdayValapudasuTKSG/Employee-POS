/**
 * FR-007: a person (ID type + ID number) is a member of at most one company on
 * the platform. The unique key is checked across every company, including rows
 * the caller's scope cannot see, and the answer must not name the other company.
 */
import { expect, it } from "vitest";
import { describeDb, makeCompany, makeMember, useAppRoleGuard } from "./testDb";
import { classifyBhiError, ID_ALREADY_REGISTERED_MESSAGE } from "../lib/bhiErrors";

describeDb("one person, one company (FR-007)", () => {
  useAppRoleGuard();

  it("refuses the same ID in a second company, from a scope that cannot see the first", async () => {
    const db = await import("@workspace/db");
    const a = await makeCompany("Uniqueness A");
    const b = await makeCompany("Uniqueness B");
    const first = await makeMember({ companyNumber: a });

    let caught: unknown = null;
    try {
      await db.withScope({ all: false, companies: [b], readOnly: false }, (tx) =>
        tx.insert(db.bhiMemberTable).values({
          companyNumber: b,
          idType: first.idType,
          idNumber: first.idNumber,
          firstName: "Same",
          lastName: "Person",
          classCode: "A",
          active: true,
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    const answer = classifyBhiError(caught);
    expect(answer).toMatchObject({ status: 409, code: "ID_ALREADY_REGISTERED" });
    expect(answer!.message).toBe(ID_ALREADY_REGISTERED_MESSAGE);
    expect(answer!.message).not.toContain(a);
  });
});
