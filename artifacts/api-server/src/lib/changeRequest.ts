/**
 * Decision logic for employee Requests For Modification.
 *
 * Pure, in the style of lastAdmin.ts: the invariants live here and the
 * transaction in the route just calls them. That keeps the interesting rules —
 * "is this actually a change", "did the record move underneath us" — testable
 * without a database.
 */

/** The Access database's DependentRelationship list: what an employee may request. */
export const DEPENDENT_RELATIONSHIPS = ["SPOUSE", "SON", "DAUGHTER", "OTHER"] as const;

export type DependentRelationship = (typeof DEPENDENT_RELATIONSHIPS)[number];

export type ChangeField = "firstName" | "lastName" | "fullName" | "dateOfBirth" | "relationship";

/**
 * The subject as it stands right now. `relationship` is null for a member.
 *
 * A BHI dependant has one name field, DependentFullName. Its snapshot keeps the
 * whole name in `firstName` and an empty `lastName`, and a requested name
 * change is compared and applied as `fullName` (see effectiveChanges).
 */
export interface SubjectSnapshot {
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  relationship: string | null;
}

/**
 * What a dependant's requested name is: the employee's first and last name
 * fields joined, since the record holds one full name. Null when neither was
 * given.
 */
export function requestedFullName(first: string | null | undefined, last: string | null | undefined): string | null {
  const joined = [clean(first), clean(last)].filter((v): v is string => v != null).join(" ");
  return joined === "" ? null : joined;
}

/** What the employee asked for. Absent fields are not being changed. */
export interface RequestedChanges {
  requestedFirstName?: string | null;
  requestedLastName?: string | null;
  requestedDateOfBirth?: string | null;
  requestedRelationship?: string | null;
}

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

/**
 * The fields that would actually change, comparing the request against a
 * snapshot. A request that restates the current value is not a change — that is
 * what stops "correct my name to the name I already have" reaching HR.
 *
 * `relationship` is ignored for a member subject: members have no relationship.
 */
export function effectiveChanges(
  requested: RequestedChanges,
  subject: SubjectSnapshot,
  subjectType: "MEMBER" | "DEPENDENT",
): { field: ChangeField; current: string | null; requested: string }[] {
  const out: { field: ChangeField; current: string | null; requested: string }[] = [];

  const consider = (field: ChangeField, value: string | null, current: string | null) => {
    if (value === null) return;
    if (current !== null && value === current) return;
    out.push({ field, current, requested: value });
  };

  if (subjectType === "DEPENDENT") {
    consider(
      "fullName",
      requestedFullName(requested.requestedFirstName, requested.requestedLastName),
      subject.firstName,
    );
  } else {
    consider("firstName", clean(requested.requestedFirstName), subject.firstName);
    consider("lastName", clean(requested.requestedLastName), subject.lastName);
  }
  consider("dateOfBirth", clean(requested.requestedDateOfBirth), subject.dateOfBirth);
  if (subjectType === "DEPENDENT") {
    consider("relationship", clean(requested.requestedRelationship), subject.relationship);
  }

  return out;
}

export type ApprovalOutcome =
  | {
      ok: true;
      changes: {
        firstName?: string;
        lastName?: string;
        /** A dependant's DependentFullName. */
        fullName?: string;
        dateOfBirth?: string;
        relationship?: DependentRelationship;
      };
    }
  | { ok: false; code: "NOT_PENDING" | "STALE_REQUEST" | "NO_CHANGES"; message: string };

export interface StoredRequest extends RequestedChanges {
  status: string;
  subjectType: "MEMBER" | "DEPENDENT";
  /** The subject as it was when the employee filed. */
  currentFirstName: string;
  currentLastName: string;
  currentDateOfBirth: string | null;
  currentRelationship: string | null;
}

/**
 * Decides whether an approval can be applied, and to what.
 *
 * `live` is the subject re-read inside the approving transaction. If it no
 * longer matches the snapshot taken at submission, the request is stale: HR
 * would be approving a diff they never saw, and silently overwriting whatever
 * changed in between. Refusing is the only safe answer — the employee can
 * re-file against the current values.
 */
export function decideApproval(
  request: StoredRequest,
  live: SubjectSnapshot,
): ApprovalOutcome {
  if (request.status !== "PENDING") {
    return {
      ok: false,
      code: "NOT_PENDING",
      message: "This request has already been decided.",
    };
  }

  const drifted =
    live.firstName !== request.currentFirstName ||
    live.lastName !== request.currentLastName ||
    live.dateOfBirth !== request.currentDateOfBirth ||
    (request.subjectType === "DEPENDENT" &&
      live.relationship !== request.currentRelationship);
  if (drifted) {
    return {
      ok: false,
      code: "STALE_REQUEST",
      message:
        "The record has changed since this request was raised. Reject it and ask the employee to submit a new one.",
    };
  }

  const changes = effectiveChanges(request, live, request.subjectType);
  if (changes.length === 0) {
    return {
      ok: false,
      code: "NO_CHANGES",
      message: "This request no longer changes anything.",
    };
  }

  const out: {
    firstName?: string;
    lastName?: string;
    fullName?: string;
    dateOfBirth?: string;
    relationship?: DependentRelationship;
  } = {};
  for (const c of changes) {
    if (c.field === "relationship") {
      out.relationship = c.requested as DependentRelationship;
    } else {
      out[c.field] = c.requested;
    }
  }
  return { ok: true, changes: out };
}

/** Human label for a subject, used in the queue and the member's own list. */
export function subjectName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.trim();
}

/** Title-cases a stored relationship for display: MOTHER -> Mother. */
export function formatRelationship(value: string | null): string | null {
  if (!value) return null;
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

export interface ReviewerAccount {
  email: string;
  displayName: string;
  role: string;
}

export interface ReviewerInfo {
  email: string;
  name: string;
  role: string | null;
}

/**
 * Who decided a request, as the queue shows it.
 *
 * Only super admins are told: they oversee every company's reviewers, whereas
 * a company HR admin reviewing their own queue gains nothing from it. Pending requests have no reviewer. The stored
 * `reviewedBy` is an email, so the name comes from the admin account — and an
 * account that has since been deleted still reports the email rather than
 * losing who made the decision.
 */
export function reviewerFor(
  viewerIsSuperAdmin: boolean,
  reviewedBy: string | null,
  accounts: ReadonlyMap<string, ReviewerAccount>,
): ReviewerInfo | null {
  if (!viewerIsSuperAdmin || !reviewedBy) return null;
  const account = accounts.get(reviewedBy.toLowerCase());
  return {
    email: reviewedBy,
    name: account?.displayName ?? reviewedBy,
    role: account?.role ?? null,
  };
}
