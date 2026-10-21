/**
 * The one way to change whether a member, dependant or beneficiary is active.
 *
 * The BHI Active flag, with InactiveDate and InactiveReason, is the only status
 * (spec FR-038). Every change also writes a row to
 * bhi.enrollment_status_history, whose `changed_at` billing relies on: a change
 * counts for the first bill whose month starts after it was recorded (research
 * R11). Routes, the age-65 sweep, bulk import and the legacy migration all come
 * through here so that record is never skipped.
 *
 * Nothing is deleted (Constitution Principle III). Deactivating a member also
 * revokes their card sessions, so a card open on a phone stops working.
 */
import { and, eq } from "drizzle-orm";
import {
  bhiBeneficiaryTable,
  bhiDependentTable,
  bhiEnrollmentStatusHistoryTable,
  bhiMemberTable,
  employeeSessionsTable,
  type ScopedTx,
} from "@workspace/db";
import { guyanaToday } from "./guyanaTime";

export type StatusEntity = "MEMBER" | "DEPENDENT" | "BENEFICIARY";

export interface SetActiveInput {
  entityType: StatusEntity;
  id: number;
  active: boolean;
  /** Required when deactivating; recorded in the history either way. */
  reason: string;
  /** Defaults to today in Guyana. Becomes InactiveDate when deactivating. */
  effectiveDate?: string;
  /** Admin email, or "SYSTEM" for jobs. */
  actor: string;
  /** When the change happened; defaults to now. The migration backdates it. */
  changedAt?: Date;
}

export interface SetActiveResult {
  /** False when the record was already in the requested state (nothing written). */
  changed: boolean;
  companyNumber: string;
  memberId: number;
  before: { active: boolean; inactiveDate: string | null; inactiveReason: string | null };
  after: { active: boolean; inactiveDate: string | null; inactiveReason: string | null };
  cardSessionsRevoked: number;
}

export class StatusChangeError extends Error {
  constructor(public readonly code: "NOT_FOUND" | "REASON_REQUIRED", message: string) {
    super(message);
  }
}

interface Subject {
  memberId: number;
  companyNumber: string;
  personName: string;
  personIdentifier: string | null;
  active: boolean;
  inactiveDate: string | null;
  inactiveReason: string | null;
}

async function loadSubject(tx: ScopedTx, entityType: StatusEntity, id: number): Promise<Subject | null> {
  if (entityType === "MEMBER") {
    const [m] = await tx.select().from(bhiMemberTable).where(eq(bhiMemberTable.memberId, id));
    if (!m) return null;
    return {
      memberId: m.memberId,
      companyNumber: m.companyNumber,
      personName: `${m.firstName} ${m.lastName}`.slice(0, 180),
      personIdentifier: `${m.idType} ${m.idNumber}`.slice(0, 100),
      active: m.active,
      inactiveDate: m.inactiveDate,
      inactiveReason: m.inactiveReason,
    };
  }
  const table = entityType === "DEPENDENT" ? bhiDependentTable : bhiBeneficiaryTable;
  const idColumn = entityType === "DEPENDENT" ? bhiDependentTable.dependentId : bhiBeneficiaryTable.beneficiaryId;
  const [row] = await tx
    .select({
      memberId: table.memberId,
      idType: table.idType,
      idNumber: table.idNumber,
      active: table.active,
      inactiveDate: table.inactiveDate,
      inactiveReason: table.inactiveReason,
      fullName:
        entityType === "DEPENDENT" ? bhiDependentTable.dependentFullName : bhiBeneficiaryTable.beneficiaryFullName,
      companyNumber: bhiMemberTable.companyNumber,
    })
    .from(table)
    .innerJoin(bhiMemberTable, eq(bhiMemberTable.memberId, table.memberId))
    .where(eq(idColumn, id));
  if (!row) return null;
  return {
    memberId: row.memberId,
    companyNumber: row.companyNumber,
    personName: row.fullName.slice(0, 180),
    personIdentifier: row.idNumber ? `${row.idType ?? ""} ${row.idNumber}`.trim().slice(0, 100) : null,
    active: row.active,
    inactiveDate: row.inactiveDate,
    inactiveReason: row.inactiveReason,
  };
}

export async function setActive(tx: ScopedTx, input: SetActiveInput): Promise<SetActiveResult> {
  const reason = input.reason?.trim() ?? "";
  if (!input.active && reason.length < 3) {
    throw new StatusChangeError("REASON_REQUIRED", "A reason of at least 3 characters is required.");
  }
  const subject = await loadSubject(tx, input.entityType, input.id);
  if (!subject) throw new StatusChangeError("NOT_FOUND", "Record not found.");

  const before = {
    active: subject.active,
    inactiveDate: subject.inactiveDate,
    inactiveReason: subject.inactiveReason,
  };
  if (subject.active === input.active) {
    return {
      changed: false,
      companyNumber: subject.companyNumber,
      memberId: subject.memberId,
      before,
      after: before,
      cardSessionsRevoked: 0,
    };
  }

  const effectiveDate = input.effectiveDate ?? guyanaToday(input.changedAt);
  const after = input.active
    ? { active: true, inactiveDate: null, inactiveReason: null }
    : { active: false, inactiveDate: effectiveDate, inactiveReason: reason };

  if (input.entityType === "MEMBER") {
    await tx.update(bhiMemberTable).set(after).where(eq(bhiMemberTable.memberId, input.id));
  } else if (input.entityType === "DEPENDENT") {
    await tx.update(bhiDependentTable).set(after).where(eq(bhiDependentTable.dependentId, input.id));
  } else {
    await tx.update(bhiBeneficiaryTable).set(after).where(eq(bhiBeneficiaryTable.beneficiaryId, input.id));
  }

  await tx.insert(bhiEnrollmentStatusHistoryTable).values({
    entityType: input.entityType,
    entityId: input.id,
    memberId: subject.memberId,
    companyNumber: subject.companyNumber,
    personIdentifier: subject.personIdentifier,
    personName: subject.personName,
    oldActive: subject.active,
    newActive: input.active,
    effectiveDate,
    reason: reason || (input.active ? "Reactivated" : "Deactivated"),
    cascadeApplied: false,
    relatedRecordsChanged: null,
    changedAt: input.changedAt ?? new Date(),
    changedBy: input.actor.slice(0, 100),
  });

  let cardSessionsRevoked = 0;
  if (input.entityType === "MEMBER" && !input.active) {
    const revoked = await tx
      .update(employeeSessionsTable)
      .set({ cardRevoked: true })
      .where(and(eq(employeeSessionsTable.cardMemberId, input.id), eq(employeeSessionsTable.cardRevoked, false)))
      .returning({ id: employeeSessionsTable.id });
    cardSessionsRevoked = revoked.length;
  }

  return {
    changed: true,
    companyNumber: subject.companyNumber,
    memberId: subject.memberId,
    before,
    after,
    cardSessionsRevoked,
  };
}
