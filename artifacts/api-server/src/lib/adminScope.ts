/**
 * Request helpers shared by every admin route file.
 *
 * These lived in routes/admin.ts until the member-create, data-quality and
 * change-request features all needed them. Moved verbatim — behaviour is
 * unchanged, including the deliberate choice to report a cross-scope read as
 * 404 rather than 403.
 */

import type { Request, Response } from "express";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  activityLogTable,
  bhiCompanyTable,
  bhiMemberTable,
  scopeCompanies,
  scopeIncludes,
  employeeSessionsTable,
  withScope,
  type Scope,
  type BhiCompany,
  type BhiMember,
} from "@workspace/db";
import { hasPermission } from "./rbac";
import { maskEmail, maskPhone } from "./masking";
import type { AdminContext } from "../middlewares/adminAuth";

export const UUID_RE = /^[0-9a-f-]{36}$/i;

export function paramId(req: Request, name: string): string {
  const raw = req.params[name];
  return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
}

export function notFound(res: Response): void {
  // Cross-scope access intentionally reads as 404, not 403.
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Member not found." } });
}

export function pageParams(req: Request): { page: number; pageSize: number } {
  const page = Math.max(1, Number(req.query["page"]) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query["pageSize"]) || 20));
  return { page, pageSize };
}

export function contact(admin: AdminContext, email: string | null, phone: string | null) {
  const unmask = hasPermission(admin.role, "CONTACT_UNMASK");
  return {
    email: email == null ? null : unmask ? email : maskEmail(email),
    phone: phone == null ? null : unmask ? phone : maskPhone(phone),
  };
}

// ---------------------------------------------------------------------------
// Shared BHI model (specs/002-per-company-schema/research.md R4, R8)
// ---------------------------------------------------------------------------

/** A company number from a path: 1–20 characters, no comma (scope lists split on it). */
const COMPANY_NUMBER_RE = /^[^,\s]{1,20}$/;

/** A positive integer id from a path, or null. */
export function intParam(req: Request, name: string): number | null {
  const raw = paramId(req, name);
  if (!/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

/** The `companyNumber` path parameter, or null when it cannot be a company number. */
export function companyParam(req: Request): string | null {
  const raw = paramId(req, "companyNumber");
  return COMPANY_NUMBER_RE.test(raw) ? raw : null;
}

/** True when the admin's scope reaches this company. */
export function inScope(admin: AdminContext, companyNumber: string): boolean {
  return scopeIncludes(admin.scope, companyNumber);
}

/**
 * Refuses a write from a read-only scope (support, auditor — spec FR-014).
 * Returns false after answering 403, so a route can `if (!writable(...)) return`.
 * Row-level security refuses the write anyway; this gives the caller a clear
 * answer instead of a database error.
 */
export function writable(admin: AdminContext, res: Response): boolean {
  if (!admin.scope.readOnly) return true;
  res.status(403).json({
    error: { code: "FORBIDDEN", message: "You do not have permission to perform this action." },
  });
  return false;
}

/**
 * A list of company numbers as one SQL text[] parameter. Interpolating a JS
 * array into raw SQL expands it into a row, ($1, $2, …), which cannot be cast
 * to text[]. Company numbers never contain a comma (withScope refuses them).
 */
export function scopeArray(list: string[]): SQL {
  return sql`string_to_array(${list.join(",")}, ',')`;
}

/**
 * The audit entries of activity_log for companies in the scope (every audit
 * entry for an all-companies scope). Employee-side EVENT entries are never
 * part of the audit trail an admin reads.
 */
export function auditInScope(scope: Scope): SQL {
  const audit = eq(activityLogTable.kind, "AUDIT");
  const list = scopeCompanies(scope);
  if (!list) return audit;
  if (list.length === 0) return sql`false`;
  return and(audit, inArray(activityLogTable.companyCode, list))!;
}

/**
 * The audit entries an admin may read, on the dashboard and the Audit screen:
 *   super admin   every entry, by every role
 *   client admin  its company's entries made by a client admin or HR administrator
 *                 (not a super admin's work on the company)
 *   HR admin      its own entries only
 * Support and auditor keep their scope's entries (every company).
 */
export function auditVisibleTo(admin: AdminContext): SQL {
  switch (admin.role) {
    case "ROLE_HR_ADMIN":
      return and(eq(activityLogTable.kind, "AUDIT"), eq(activityLogTable.actor, admin.user.email))!;
    case "ROLE_CLIENT_ADMIN":
      return and(
        auditInScope(admin.scope),
        inArray(activityLogTable.actorRole, ["ROLE_CLIENT_ADMIN", "ROLE_HR_ADMIN"]),
      )!;
    default:
      return auditInScope(admin.scope);
  }
}

/**
 * Employee sessions that matched a member of a company in the scope. A
 * session matches across companies (spec FR-016), so this looks inside
 * matched_members, and company_code once a card was chosen.
 * Decoy sessions match no company and are visible only to all-companies scopes.
 */
export function verificationsInScope(scope: Scope): SQL | undefined {
  const list = scopeCompanies(scope);
  if (!list) return undefined;
  if (list.length === 0) return sql`false`;
  return sql`(${employeeSessionsTable.companyCode} = ANY(${scopeArray(list)})
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(${employeeSessionsTable.matchedMembers}) e
                WHERE e->>'companyNumber' = ANY(${scopeArray(list)})))`;
}

/** The company to show for a verification session: one the viewer's scope reaches. */
export function sessionCompany(
  session: { companyCode: string | null; matchedMembers: { companyNumber: string }[] },
  scope: Scope,
): string | null {
  const candidates = [
    ...(session.companyCode ? [session.companyCode] : []),
    ...session.matchedMembers.map((m) => m.companyNumber),
  ];
  return candidates.find((c) => scopeIncludes(scope, c)) ?? null;
}

/**
 * Resolves a BHI member by id alone — for records such as change requests that
 * carry only member_ref — when the admin's scope reaches it. Row-level security
 * hides members outside the scope, so they come back null like missing ones.
 */
export async function scopedBhiMemberById(
  admin: AdminContext,
  memberId: number | null,
): Promise<{ member: BhiMember; company: BhiCompany } | null> {
  if (memberId == null) return null;
  return withScope(admin.scope, async (tx) => {
    const [row] = await tx
      .select({ member: bhiMemberTable, company: bhiCompanyTable })
      .from(bhiMemberTable)
      .innerJoin(bhiCompanyTable, eq(bhiCompanyTable.companyNumber, bhiMemberTable.companyNumber))
      .where(eq(bhiMemberTable.memberId, memberId));
    return row ?? null;
  });
}

/**
 * Resolves a BHI member only if the admin's scope reaches its company. Out of
 * scope and not found look the same — null, answered as 404 — so a
 * company-scoped user cannot probe which records exist elsewhere (spec FR-010).
 */
export async function scopedBhiMember(
  admin: AdminContext,
  companyNumber: string,
  memberId: number,
): Promise<{ member: BhiMember; company: BhiCompany } | null> {
  if (!inScope(admin, companyNumber)) return null;
  return withScope(admin.scope, async (tx) => {
    const [member] = await tx
      .select()
      .from(bhiMemberTable)
      .where(and(eq(bhiMemberTable.memberId, memberId), eq(bhiMemberTable.companyNumber, companyNumber)));
    if (!member) return null;
    const [company] = await tx
      .select()
      .from(bhiCompanyTable)
      .where(eq(bhiCompanyTable.companyNumber, companyNumber));
    return company ? { member, company } : null;
  });
}
