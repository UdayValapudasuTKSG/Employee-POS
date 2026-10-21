import { describe, expect, it } from "vitest";
import {
  DEPENDENT_RELATIONSHIPS,
  decideApproval,
  effectiveChanges,
  formatRelationship,
  requestedFullName,
  reviewerFor,
  subjectName,
  type ReviewerAccount,
  type StoredRequest,
  type SubjectSnapshot,
} from "./changeRequest";

// A BHI dependant's snapshot: the whole DependentFullName in firstName.
const dependant: SubjectSnapshot = {
  firstName: "Uma Singh",
  lastName: "",
  dateOfBirth: "2008-05-25",
  relationship: "CHILD",
};

const member: SubjectSnapshot = {
  firstName: "Kamla",
  lastName: "Narine",
  dateOfBirth: "1985-03-02",
  relationship: null,
};

const pending = (over: Partial<StoredRequest> = {}): StoredRequest => ({
  status: "PENDING",
  subjectType: "DEPENDENT",
  currentFirstName: dependant.firstName,
  currentLastName: dependant.lastName,
  currentDateOfBirth: dependant.dateOfBirth,
  currentRelationship: dependant.relationship,
  ...over,
});

describe("effectiveChanges", () => {
  it("reports only the fields that actually differ", () => {
    const changes = effectiveChanges(
      { requestedDateOfBirth: "2008-05-27", requestedFirstName: "Uma", requestedLastName: "Singh" },
      dependant,
      "DEPENDENT",
    );
    expect(changes).toEqual([
      { field: "dateOfBirth", current: "2008-05-25", requested: "2008-05-27" },
    ]);
  });

  it("joins a dependant's requested first and last name into the one full-name field", () => {
    expect(
      effectiveChanges({ requestedFirstName: "Uma", requestedLastName: "Persaud" }, dependant, "DEPENDENT"),
    ).toEqual([{ field: "fullName", current: "Uma Singh", requested: "Uma Persaud" }]);
    expect(requestedFullName("  Uma ", null)).toBe("Uma");
    expect(requestedFullName(" ", "")).toBeNull();
  });

  it("compares a missing date of birth as no current value", () => {
    expect(
      effectiveChanges({ requestedDateOfBirth: "2010-01-01" }, { ...dependant, dateOfBirth: null }, "DEPENDENT"),
    ).toEqual([{ field: "dateOfBirth", current: null, requested: "2010-01-01" }]);
  });

  it("ignores blank and whitespace-only values", () => {
    expect(
      effectiveChanges(
        { requestedFirstName: "   ", requestedLastName: "", requestedDateOfBirth: null },
        dependant,
        "DEPENDENT",
      ),
    ).toEqual([]);
  });

  it("picks up a relationship correction on a dependant", () => {
    const changes = effectiveChanges(
      { requestedRelationship: "DAUGHTER" as never },
      dependant,
      "DEPENDENT",
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.field).toBe("relationship");
  });

  it("ignores relationship for a member subject", () => {
    // Members have no relationship; a client sending one must not create a diff.
    expect(
      effectiveChanges({ requestedRelationship: "MOTHER" }, member, "MEMBER"),
    ).toEqual([]);
  });

  it("handles a multi-field change, such as a marriage", () => {
    const changes = effectiveChanges(
      { requestedLastName: "Persaud", requestedFirstName: "Kamla Devi" },
      member,
      "MEMBER",
    );
    expect(changes.map((c) => c.field).sort()).toEqual(["firstName", "lastName"]);
  });

  it("trims before comparing, so padded input is not a change", () => {
    expect(effectiveChanges({ requestedFirstName: "  Uma Singh  " }, dependant, "DEPENDENT")).toEqual(
      [],
    );
  });
});

describe("decideApproval", () => {
  it("applies the requested fields when the record has not moved", () => {
    const outcome = decideApproval(
      pending({ requestedDateOfBirth: "2008-05-27", requestedRelationship: "SISTER" }),
      dependant,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.changes).toEqual({ dateOfBirth: "2008-05-27", relationship: "SISTER" });
  });

  it("refuses a request that has already been decided", () => {
    for (const status of ["APPROVED", "REJECTED"]) {
      const outcome = decideApproval(
        pending({ status, requestedFirstName: "Uma Devi" }),
        dependant,
      );
      expect(outcome.ok, status).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.code).toBe("NOT_PENDING");
    }
  });

  it("refuses when the record drifted since submission", () => {
    // HR would otherwise approve a before/after they never saw, silently
    // overwriting whatever changed in between.
    const outcome = decideApproval(
      pending({ requestedDateOfBirth: "2008-05-27" }),
      { ...dependant, firstName: "Uma Narine" },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("STALE_REQUEST");
  });

  it("detects drift in the relationship of a dependant", () => {
    const outcome = decideApproval(
      pending({ requestedFirstName: "Uma Devi" }),
      { ...dependant, relationship: "SISTER" },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("STALE_REQUEST");
  });

  it("ignores relationship drift for a member subject", () => {
    const outcome = decideApproval(
      pending({
        subjectType: "MEMBER",
        currentFirstName: member.firstName,
        currentLastName: member.lastName,
        currentDateOfBirth: member.dateOfBirth,
        currentRelationship: null,
        requestedLastName: "Persaud",
      }),
      { ...member, relationship: "ANYTHING" },
    );
    expect(outcome.ok).toBe(true);
  });

  it("applies a dependant's name change as fullName", () => {
    const outcome = decideApproval(pending({ requestedFirstName: "Uma Devi Singh" }), dependant);
    expect(outcome).toEqual({ ok: true, changes: { fullName: "Uma Devi Singh" } });
  });

  it("refuses when the request no longer changes anything", () => {
    const outcome = decideApproval(pending({ requestedFirstName: "Uma Singh" }), dependant);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("NO_CHANGES");
  });

  it("never emits a relationship outside the allowed vocabulary for a member", () => {
    const outcome = decideApproval(
      pending({
        subjectType: "MEMBER",
        currentFirstName: member.firstName,
        currentLastName: member.lastName,
        currentDateOfBirth: member.dateOfBirth,
        currentRelationship: null,
        requestedRelationship: "MOTHER",
        requestedLastName: "Persaud",
      }),
      member,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.changes.relationship).toBeUndefined();
  });
});

describe("display helpers", () => {
  it("title-cases a stored relationship", () => {
    expect(formatRelationship("MOTHER")).toBe("Mother");
    expect(formatRelationship("CHILD")).toBe("Child");
    expect(formatRelationship(null)).toBeNull();
  });

  it("covers every relationship in the vocabulary", () => {
    for (const r of DEPENDENT_RELATIONSHIPS) {
      expect(formatRelationship(r)).toMatch(/^[A-Z][a-z]+$/);
    }
  });

  it("builds a subject name", () => {
    expect(subjectName("Uma", "Singh")).toBe("Uma Singh");
    expect(subjectName("Uma", "")).toBe("Uma");
  });
});

describe("reviewerFor", () => {
  const accounts = new Map<string, ReviewerAccount>([
    [
      "hr.foods@bhi-demo.test",
      { email: "hr.foods@bhi-demo.test", displayName: "Farah Khan", role: "ROLE_HR_ADMIN" },
    ],
  ]);

  it("names the reviewer and their role for a group-level admin", () => {
    expect(reviewerFor(true, "hr.foods@bhi-demo.test", accounts)).toEqual({
      email: "hr.foods@bhi-demo.test",
      name: "Farah Khan",
      role: "ROLE_HR_ADMIN",
    });
  });

  it("matches the account regardless of the stored email's case", () => {
    expect(reviewerFor(true, "HR.Foods@bhi-demo.test", accounts)?.name).toBe("Farah Khan");
  });

  it("tells a company-scoped admin nothing", () => {
    expect(reviewerFor(false, "hr.foods@bhi-demo.test", accounts)).toBeNull();
  });

  it("has no reviewer while the request is pending", () => {
    expect(reviewerFor(true, null, accounts)).toBeNull();
  });

  it("keeps the email when the reviewer's account no longer exists", () => {
    expect(reviewerFor(true, "gone@bhi-demo.test", accounts)).toEqual({
      email: "gone@bhi-demo.test",
      name: "gone@bhi-demo.test",
      role: null,
    });
  });
});
