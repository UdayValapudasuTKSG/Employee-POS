/**
 * The single member response builder (MemberDetail). Every member mutation
 * returns this shape so the portal can invalidate one query key and re-render
 * the whole screen.
 *
 * Reads the shared BHI tables inside the caller's scope, so row-level security
 * applies here too.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import {
  bhiBeneficiaryTable,
  bhiClassTable,
  bhiDependentTable,
  employeeSessionsTable,
  policyMembershipsTable,
  withScope,
  type BhiCompany,
  type BhiMember,
  type ScopedTx,
} from "@workspace/db";
import { contact } from "./adminScope";
import { tierFor } from "./rateBands";
import type { AdminContext } from "../middlewares/adminAuth";

function money(v: string | null): string | null {
  return v == null ? null : v;
}

function num(v: string | null): number | null {
  return v == null ? null : Number(v);
}

/** Builds MemberDetail inside an existing scoped transaction. */
export async function memberDetailInTx(
  tx: ScopedTx,
  admin: AdminContext,
  member: BhiMember,
  company: BhiCompany,
) {
  const [policy] = await tx
    .select()
    .from(policyMembershipsTable)
    .where(eq(policyMembershipsTable.memberRef, member.memberId));
  const deps = await tx
    .select()
    .from(bhiDependentTable)
    .where(eq(bhiDependentTable.memberId, member.memberId))
    .orderBy(asc(bhiDependentTable.dateOfBirth), asc(bhiDependentTable.dependentId));
  const bens = await tx
    .select()
    .from(bhiBeneficiaryTable)
    .where(eq(bhiBeneficiaryTable.memberId, member.memberId))
    .orderBy(asc(bhiBeneficiaryTable.beneficiaryId));
  const [cls] = await tx
    .select({ className: bhiClassTable.className })
    .from(bhiClassTable)
    .where(eq(bhiClassTable.classCode, member.classCode));
  const [alert] = await tx
    .select({ id: employeeSessionsTable.id })
    .from(employeeSessionsTable)
    .where(
      and(
        eq(employeeSessionsTable.alertStatus, "OPEN"),
        sql`${employeeSessionsTable.alertMatches} @> ${JSON.stringify([
          { companyNumber: member.companyNumber, memberId: member.memberId },
        ])}::jsonb`,
      ),
    )
    .limit(1);

  const activeDependentCount = deps.filter((d) => d.active).length;
  const tier = tierFor(activeDependentCount);
  const c = contact(admin, member.email, member.phone);
  return {
    memberId: member.memberId,
    companyNumber: member.companyNumber,
    companyName: company.companyName,
    idType: member.idType,
    idNumber: member.idNumber,
    firstName: member.firstName,
    lastName: member.lastName,
    middleInitials: member.middleInitials,
    dateOfBirth: member.dateOfBirth,
    sex: member.sex,
    classCode: member.classCode,
    className: cls?.className ?? member.classCode,
    addressLine1: member.addressLine1,
    addressLine2: member.addressLine2,
    email: c.email,
    phone: c.phone,
    employmentDate: member.employmentDate,
    planDate: member.planDate,
    rateOfPay: money(member.rateOfPay),
    occupation: member.occupation,
    active: member.active,
    inactiveDate: member.inactiveDate,
    inactiveReason: member.inactiveReason,
    notes: member.notes,
    activeDependentCount,
    currentTier: {
      dependentBand: tier.dependentBand,
      coverageBand: tier.coverageBand,
      coverageLabel: tier.coverageLabel,
    },
    sharedContactAlert: Boolean(alert),
    policy: policy
      ? {
          policyholder: policy.policyholder,
          policyNumber: policy.policyNumber,
          groupNumber: policy.groupNumber,
          memberId: policy.memberNumber,
          certificateNumber: policy.certificateNumber,
          planName: policy.planName,
          effectiveDate: policy.effectiveDate,
          expiryDate: policy.expiryDate,
          insurerName: policy.insurerName,
        }
      : null,
    dependents: deps.map((d) => ({
      dependentId: d.dependentId,
      fullName: d.dependentFullName,
      relationship: d.relationship,
      dateOfBirth: d.dateOfBirth,
      idType: d.idType,
      idNumber: d.idNumber,
      sex: d.sex,
      active: d.active,
      inactiveDate: d.inactiveDate,
      inactiveReason: d.inactiveReason,
      notes: d.notes,
    })),
    beneficiaries: bens.map((b) => ({
      beneficiaryId: b.beneficiaryId,
      fullName: b.beneficiaryFullName,
      relationship: b.relationship,
      dateOfBirth: b.dateOfBirth,
      idType: b.idType,
      idNumber: b.idNumber,
      sex: b.sex,
      phone: b.phone,
      email: b.email,
      sharePercent: num(b.sharePercent),
      active: b.active,
      inactiveDate: b.inactiveDate,
      inactiveReason: b.inactiveReason,
      notes: b.notes,
    })),
    createdAt: member.createdAt?.toISOString() ?? null,
    updatedAt: member.updatedAt?.toISOString() ?? null,
  };
}

/** Builds MemberDetail in its own scoped transaction. */
export async function memberDetailJson(admin: AdminContext, member: BhiMember, company: BhiCompany) {
  return withScope(admin.scope, (tx) => memberDetailInTx(tx, admin, member, company));
}
