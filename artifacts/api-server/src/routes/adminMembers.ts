/**
 * Admin routes for the shared BHI model: dashboard, companies, and every
 * member, dependant, beneficiary and policy route
 * (specs/002-per-company-schema/contracts/admin-api.md, "Members").
 *
 * Every read and write runs inside withScope(admin.scope), so row-level
 * security (deploy/db/schema.sql) enforces the same scope the route checks: a
 * company-scoped user reaches only its company, and super admins, support and
 * auditors every company (spec FR-010 to FR-015).
 * Support and auditors are read-only. A record outside the scope answers
 * exactly like one that does not exist.
 *
 * Nothing is deleted: status changes go through setActive (lib/statusHistory.ts),
 * which records them in bhi.enrollment_status_history for billing.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, count, desc, eq, ilike, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import {
  activityLogTable,
  billingRunIssuesTable,
  bhiBillingRunTable,
  bhiBeneficiaryTable,
  bhiCompanyTable,
  bhiDependentTable,
  bhiImportExceptionTable,
  bhiMemberTable,
  importExceptionResolutionsTable,
  memberClassHistoryTable,
  policyMembershipsTable,
  employeeSessionsTable,
  withScope,
  type BhiCompany,
  type BhiMember,
  type Scope,
  type ScopedTx,
} from "@workspace/db";
import {
  CreateBeneficiaryBody,
  CreateDependentBody,
  CreateMemberBody,
  DeactivateBeneficiaryBody,
  DeactivateDependentBody,
  DeactivateMemberBody,
  ReactivateBeneficiaryBody,
  ReactivateDependentBody,
  ReactivateMemberBody,
  SaveMemberPolicyBody,
  UpdateBeneficiaryBody,
  UpdateDependentBody,
  UpdateMemberBody,
} from "@workspace/api-zod";
import { writeAudit } from "../lib/audit";
import { hasPermission } from "../lib/rbac";
import {
  auditVisibleTo,
  companyParam,
  contact,
  inScope,
  intParam,
  notFound,
  pageParams,
  scopedBhiMember,
  verificationsInScope,
  writable,
} from "../lib/adminScope";
import { memberDetailInTx } from "../lib/memberDetail";
import {
  DEPENDENT_FIELD_SIZES,
  MEMBER_REQUIRED_ON_CREATE,
  normaliseMemberFields,
  type MemberColumnValues,
} from "../lib/memberCreate";
import { parseImportDate, normaliseSex } from "../lib/memberImport";
import { assertAssignable, ClassNotAssignableError } from "../lib/classRules";
import { recalcDraftBills } from "../lib/billing/recalc";
import { setActive, StatusChangeError, type StatusEntity } from "../lib/statusHistory";
import { RETIREMENT_AGE, ageOn, hasReachedRetirementAge } from "../lib/retirement";
import { guyanaToday } from "../lib/guyanaTime";
import { requireAdmin, requirePermission, type AdminContext } from "../middlewares/adminAuth";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function badRequest(res: Response, code: string, message: string): void {
  res.status(400).json({ error: { code, message } });
}

function conflict(res: Response, code: string, message: string): void {
  res.status(409).json({ error: { code, message } });
}

/** Loads the member named by the path, within the admin's scope; answers 404 otherwise. */
async function loadMember(
  req: Request,
  res: Response,
): Promise<{ admin: AdminContext; member: BhiMember; company: BhiCompany } | null> {
  const admin = req.admin!;
  const companyNumber = companyParam(req);
  const memberId = intParam(req, "memberId");
  if (!companyNumber || !memberId) {
    notFound(res);
    return null;
  }
  const found = await scopedBhiMember(admin, companyNumber, memberId);
  if (!found) {
    notFound(res);
    return null;
  }
  return { admin, ...found };
}

/** An offboarded company's records can be read but not changed (spec FR-019). */
function companyWritable(company: BhiCompany, res: Response): boolean {
  if (company.active) return true;
  conflict(res, "COMPANY_INACTIVE", `${company.companyName} has been offboarded; its records can no longer be changed.`);
  return false;
}

function audit(
  req: Request,
  admin: AdminContext,
  tx: ScopedTx,
  entry: {
    action: string;
    entityType: string;
    entityId: string | number;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
    companyNumber: string;
  },
) {
  return writeAudit(
    {
      actor: admin.user.email,
      actorRole: admin.role,
      action: entry.action,
      entityType: entry.entityType,
      entityId: String(entry.entityId),
      beforeValue: entry.before === undefined ? null : JSON.stringify(entry.before),
      afterValue: entry.after === undefined ? null : JSON.stringify(entry.after),
      reason: entry.reason ?? null,
      sourceIp: req.ip ?? null,
      companyCode: entry.companyNumber,
    },
    tx,
  );
}

/** Re-reads the member and returns its detail, inside the same transaction. */
async function detailAfter(tx: ScopedTx, admin: AdminContext, memberId: number, company: BhiCompany) {
  const [member] = await tx.select().from(bhiMemberTable).where(eq(bhiMemberTable.memberId, memberId));
  return memberDetailInTx(tx, admin, member!, company);
}

/** Only the keys whose value differs from the current row, for the audit before/after. */
function diff(current: Record<string, unknown>, changes: Record<string, unknown>) {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined && current[key] !== value) {
      before[key] = current[key];
      after[key] = value;
    }
  }
  return { before, after, changed: Object.keys(after).length > 0 };
}

const blankToNull = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

// ---------------------------------------------------------------------------
// Dashboard and companies
// ---------------------------------------------------------------------------

router.get(
  "/v1/admin/dashboard",
  requireAdmin,
  requirePermission("MEMBER_READ_SCOPED"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const today = guyanaToday();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const stats = await withScope(admin.scope, async (tx) => {
      const companies = await tx.select().from(bhiCompanyTable).orderBy(asc(bhiCompanyTable.companyNumber));
      const byCompanyRows = await tx
        .select({ companyNumber: bhiMemberTable.companyNumber, active: bhiMemberTable.active, n: count() })
        .from(bhiMemberTable)
        .groupBy(bhiMemberTable.companyNumber, bhiMemberTable.active);
      const [deps] = await tx
        .select({ n: count() })
        .from(bhiDependentTable)
        .innerJoin(bhiMemberTable, eq(bhiMemberTable.memberId, bhiDependentTable.memberId))
        .where(and(eq(bhiDependentTable.active, true), eq(bhiMemberTable.active, true)));
      const [expired] = await tx
        .select({ n: count() })
        .from(policyMembershipsTable)
        .innerJoin(bhiMemberTable, eq(bhiMemberTable.memberId, policyMembershipsTable.memberRef))
        .where(and(eq(bhiMemberTable.active, true), lt(policyMembershipsTable.expiryDate, today)));
      // Cover ends at 65, which needs a date of birth: HR fills these in.
      const [noDob] = await tx
        .select({ n: count() })
        .from(bhiMemberTable)
        .where(and(eq(bhiMemberTable.active, true), isNull(bhiMemberTable.dateOfBirth)));
      const verifScope = verificationsInScope(admin.scope);
      const [verifsToday] = await tx
        .select({ n: count() })
        .from(employeeSessionsTable)
        .where(and(sql`${employeeSessionsTable.createdAt} >= ${startOfToday}`, verifScope));
      const [locked] = await tx
        .select({ n: count() })
        .from(employeeSessionsTable)
        .where(and(eq(employeeSessionsTable.status, "LOCKED"), verifScope));
      const recentAudit = await tx
        .select()
        .from(activityLogTable)
        .where(auditVisibleTo(admin))
        .orderBy(desc(activityLogTable.timestamp))
        .limit(8);
      let openLookupAlerts: number | null = null;
      if (admin.role === "ROLE_PLATFORM_ADMIN") {
        const [alerts] = await tx
          .select({ n: count() })
          .from(employeeSessionsTable)
          .where(eq(employeeSessionsTable.alertStatus, "OPEN"));
        openLookupAlerts = alerts?.n ?? 0;
      }
      // Row-level security limits bhi.import_exception to the scope's companies.
      const [held] = await tx
        .select({ n: count() })
        .from(bhiImportExceptionTable)
        .leftJoin(
          importExceptionResolutionsTable,
          eq(importExceptionResolutionsTable.exceptionId, bhiImportExceptionTable.exceptionId),
        )
        .where(isNull(importExceptionResolutionsTable.exceptionId));
      const openImportExceptions = held?.n ?? 0;
      let draftBillingRuns: number | null = null;
      let unpricedMembers: number | null = null;
      if (hasPermission(admin.role, "BILLING_READ")) {
        // Row-level security limits billing_run to the scope; the issues are read through it.
        const [drafts] = await tx.select({ n: count() }).from(bhiBillingRunTable).where(eq(bhiBillingRunTable.status, "DRAFT"));
        const [unpriced] = await tx
          .select({ n: count() })
          .from(billingRunIssuesTable)
          .innerJoin(bhiBillingRunTable, eq(bhiBillingRunTable.billingRunId, billingRunIssuesTable.billingRunId))
          .where(eq(bhiBillingRunTable.status, "DRAFT"));
        draftBillingRuns = drafts?.n ?? 0;
        unpricedMembers = unpriced?.n ?? 0;
      }
      return { companies, byCompanyRows, deps, expired, noDob, verifsToday, locked, recentAudit, openLookupAlerts, openImportExceptions, draftBillingRuns, unpricedMembers };
    });

    const active = stats.byCompanyRows.filter((r) => r.active).reduce((n, r) => n + r.n, 0);
    const inactive = stats.byCompanyRows.filter((r) => !r.active).reduce((n, r) => n + r.n, 0);
    res.json({
      totalMembers: active + inactive,
      activeMembers: active,
      inactiveMembers: inactive,
      totalDependents: stats.deps?.n ?? 0,
      expiredPolicyCount: stats.expired?.n ?? 0,
      membersWithoutDateOfBirth: stats.noDob?.n ?? 0,
      verificationsToday: stats.verifsToday?.n ?? 0,
      lockedVerifications: stats.locked?.n ?? 0,
      openLookupAlerts: stats.openLookupAlerts,
      openImportExceptions: stats.openImportExceptions,
      draftBillingRuns: stats.draftBillingRuns,
      unpricedMembers: stats.unpricedMembers,
      recentAudit: stats.recentAudit.map(auditEntry),
      byCompany: stats.companies.map((c) => {
        const rows = stats.byCompanyRows.filter((r) => r.companyNumber === c.companyNumber);
        return {
          companyNumber: c.companyNumber,
          companyName: c.companyName,
          memberCount: rows.reduce((n, r) => n + r.n, 0),
          activeCount: rows.filter((r) => r.active).reduce((n, r) => n + r.n, 0),
        };
      }),
    });
  },
);

export function auditEntry(a: typeof activityLogTable.$inferSelect) {
  return {
    id: a.id,
    actor: a.actor,
    actorRole: a.actorRole,
    action: a.action,
    entityType: a.entityType,
    entityId: a.entityId,
    beforeValue: a.beforeValue,
    afterValue: a.afterValue,
    reason: a.reason,
    sourceIp: a.sourceIp,
    timestamp: a.timestamp.toISOString(),
  };
}

router.get(
  "/v1/admin/companies",
  requireAdmin,
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const rows = await withScope(admin.scope, async (tx) => {
      const companies = await tx
        .select({
          companyNumber: bhiCompanyTable.companyNumber,
          companyName: bhiCompanyTable.companyName,
          active: bhiCompanyTable.active,
          address1: bhiCompanyTable.address1,
          address2: bhiCompanyTable.address2,
          city: bhiCompanyTable.city,
          contactName: bhiCompanyTable.contactName,
          contactPhone: bhiCompanyTable.contactPhone,
          contactEmail: bhiCompanyTable.contactEmail,
          notes: bhiCompanyTable.notes,
        })
        .from(bhiCompanyTable)
        .orderBy(asc(bhiCompanyTable.companyNumber));
      const counts = await tx
        .select({ companyNumber: bhiMemberTable.companyNumber, active: bhiMemberTable.active, n: count() })
        .from(bhiMemberTable)
        .groupBy(bhiMemberTable.companyNumber, bhiMemberTable.active);
      return companies.map((c) => ({
        ...c,
        activeMembers: counts.find((x) => x.companyNumber === c.companyNumber && x.active)?.n ?? 0,
        inactiveMembers: counts.find((x) => x.companyNumber === c.companyNumber && !x.active)?.n ?? 0,
      }));
    });
    res.json(rows);
  },
);

// ---------------------------------------------------------------------------
// Members: list, create, read, update
// ---------------------------------------------------------------------------

router.get(
  "/v1/admin/members",
  requireAdmin,
  requirePermission("MEMBER_READ_SCOPED"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const { page, pageSize } = pageParams(req);
    const str = (k: string) => (typeof req.query[k] === "string" ? (req.query[k] as string).trim() : "");
    const q = str("q");
    const company = str("company");
    const active = str("active");
    const classCode = str("classCode").toUpperCase();
    const missingDateOfBirth = str("missingDateOfBirth") === "true";

    const conditions: SQL[] = [];
    if (missingDateOfBirth) conditions.push(isNull(bhiMemberTable.dateOfBirth));
    if (company) conditions.push(eq(bhiMemberTable.companyNumber, company));
    if (active === "true" || active === "false") conditions.push(eq(bhiMemberTable.active, active === "true"));
    if (classCode) conditions.push(eq(bhiMemberTable.classCode, classCode));
    if (q) {
      const like = `%${q}%`;
      conditions.push(
        or(
          ilike(bhiMemberTable.firstName, like),
          ilike(bhiMemberTable.lastName, like),
          ilike(bhiMemberTable.idNumber, like),
          ilike(bhiMemberTable.email, like),
          ilike(bhiMemberTable.phone, like),
          sql`${bhiMemberTable.firstName} || ' ' || ${bhiMemberTable.lastName} ILIKE ${like}`,
        )!,
      );
    }
    const where = conditions.length ? and(...conditions) : undefined;

    const result = await withScope(admin.scope, async (tx) => {
      const [{ n: totalItems } = { n: 0 }] = await tx.select({ n: count() }).from(bhiMemberTable).where(where);
      const rows = await tx
        .select({ member: bhiMemberTable, companyName: bhiCompanyTable.companyName })
        .from(bhiMemberTable)
        .innerJoin(bhiCompanyTable, eq(bhiCompanyTable.companyNumber, bhiMemberTable.companyNumber))
        .where(where)
        .orderBy(asc(bhiMemberTable.lastName), asc(bhiMemberTable.firstName), asc(bhiMemberTable.memberId))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const ids = rows.map((r) => r.member.memberId);
      const depCounts = ids.length
        ? await tx
            .select({ memberId: bhiDependentTable.memberId, n: count() })
            .from(bhiDependentTable)
            .where(and(inArray(bhiDependentTable.memberId, ids), eq(bhiDependentTable.active, true)))
            .groupBy(bhiDependentTable.memberId)
        : [];
      const policies = ids.length
        ? await tx
            .select({ memberId: policyMembershipsTable.memberRef, expiryDate: policyMembershipsTable.expiryDate })
            .from(policyMembershipsTable)
            .where(inArray(policyMembershipsTable.memberRef, ids))
        : [];
      return { totalItems, rows, depCounts, policies };
    });

    const depMap = new Map(result.depCounts.map((d) => [d.memberId, d.n]));
    // ON_FILE: a policy that has not expired; EXPIRED: only lapsed ones; NONE:
    // no policy, so the member's card lookup says there is no active policy.
    const today = guyanaToday();
    const policyStatus = new Map<number, "ON_FILE" | "EXPIRED">();
    for (const p of result.policies) {
      if (p.memberId == null) continue;
      const current = !p.expiryDate || p.expiryDate >= today;
      if (current) policyStatus.set(p.memberId, "ON_FILE");
      else if (!policyStatus.has(p.memberId)) policyStatus.set(p.memberId, "EXPIRED");
    }
    res.json({
      items: result.rows.map(({ member: m, companyName }) => {
        const c = contact(admin, m.email, m.phone);
        return {
          memberId: m.memberId,
          companyNumber: m.companyNumber,
          companyName,
          idType: m.idType,
          idNumber: m.idNumber,
          firstName: m.firstName,
          lastName: m.lastName,
          classCode: m.classCode,
          email: c.email,
          phone: c.phone,
          active: m.active,
          activeDependentCount: depMap.get(m.memberId) ?? 0,
          policyStatus: policyStatus.get(m.memberId) ?? "NONE",
        };
      }),
      page,
      pageSize,
      totalItems: result.totalItems,
      totalPages: Math.ceil(result.totalItems / pageSize),
    });
  },
);

interface DependantValues {
  dependentFullName: string;
  relationship: string;
  dateOfBirth: string | null;
  idType: string | null;
  idNumber: string | null;
  sex: string | null;
}

/** Validates the dependants sent with a new member; returns an error message or the values. */
function dependantValuesFrom(
  items: { fullName: string; relationship: string; dateOfBirth?: string | null; idType?: string | null; idNumber?: string | null; sex?: string | null }[],
): { ok: true; values: DependantValues[] } | { ok: false; message: string } {
  const values: DependantValues[] = [];
  for (const [i, d] of items.entries()) {
    const label = `Dependant ${i + 1}`;
    const fullName = d.fullName.trim();
    if (!fullName) return { ok: false, message: `${label}: full name is required.` };
    if (fullName.length > DEPENDENT_FIELD_SIZES.fullName) {
      return { ok: false, message: `${label}: full name is ${fullName.length} characters; the most allowed is ${DEPENDENT_FIELD_SIZES.fullName}.` };
    }
    let dateOfBirth: string | null = null;
    if (blankToNull(d.dateOfBirth)) {
      dateOfBirth = parseImportDate(d.dateOfBirth!);
      if (!dateOfBirth) return { ok: false, message: `${label} (${fullName}): date of birth "${d.dateOfBirth}" is not a date we recognise.` };
    }
    const idType = blankToNull(d.idType)?.toUpperCase() ?? null;
    const idNumber = blankToNull(d.idNumber);
    const sex = blankToNull(d.sex) ? normaliseSex(d.sex!) : null;
    if ((idType?.length ?? 0) > DEPENDENT_FIELD_SIZES.idType) return { ok: false, message: `${label}: ID type is too long.` };
    if ((idNumber?.length ?? 0) > DEPENDENT_FIELD_SIZES.idNumber) return { ok: false, message: `${label}: ID number is too long.` };
    if ((sex?.length ?? 0) > DEPENDENT_FIELD_SIZES.sex) return { ok: false, message: `${label}: sex is too long.` };
    values.push({ dependentFullName: fullName, relationship: d.relationship, dateOfBirth, idType, idNumber, sex });
  }
  return { ok: true, values };
}

/** Refuses a member who has already reached 65: cover ends there (lib/retirement.ts). */
function retirementRefusal(res: Response, name: string, dateOfBirth: string | null | undefined, verb: string): boolean {
  if (!dateOfBirth) return false;
  const today = guyanaToday();
  if (!hasReachedRetirementAge(dateOfBirth, today)) return false;
  badRequest(
    res,
    "RETIREMENT_AGE_REACHED",
    `${name} is ${ageOn(dateOfBirth, today)} and the plan's cover ends at ${RETIREMENT_AGE}, so they cannot be ${verb}. ` +
      "Check the date of birth if this is wrong.",
  );
  return true;
}

router.post(
  "/v1/admin/companies/:companyNumber/members",
  requireAdmin,
  requirePermission("MEMBER_CREATE"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    if (!writable(admin, res)) return;
    const companyNumber = companyParam(req);
    if (!companyNumber || !inScope(admin, companyNumber)) {
      notFound(res);
      return;
    }
    const parsed = CreateMemberBody.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, "INVALID_INPUT", "Check the form. ID type, ID number, first and last name, date of birth, class and a reason of at least 3 characters are required.");
      return;
    }
    const { reason, dependants = [], ...fields } = parsed.data;
    const normalised = normaliseMemberFields(fields, MEMBER_REQUIRED_ON_CREATE);
    if (!normalised.ok) {
      badRequest(res, "INVALID_INPUT", normalised.message);
      return;
    }
    const values = normalised.values;
    if (retirementRefusal(res, `${values.firstName} ${values.lastName}`, values.dateOfBirth, "added as a member")) return;
    const deps = dependantValuesFrom(dependants);
    if (!deps.ok) {
      badRequest(res, "INVALID_INPUT", deps.message);
      return;
    }

    try {
      const detail = await withScope(admin.scope, async (tx) => {
        const [company] = await tx.select().from(bhiCompanyTable).where(eq(bhiCompanyTable.companyNumber, companyNumber));
        if (!company) return { status: "NOT_FOUND" as const };
        if (!company.active) return { status: "INACTIVE" as const, company };
        await assertAssignable(tx, values.classCode!);
        const [member] = await tx
          .insert(bhiMemberTable)
          .values({ ...(values as Required<Pick<MemberColumnValues, "idType" | "idNumber" | "firstName" | "lastName" | "classCode">> & MemberColumnValues), companyNumber, active: true })
          .returning();
        await tx.insert(memberClassHistoryTable).values({
          memberId: member!.memberId,
          classCode: member!.classCode,
          recordedBy: admin.user.email,
        });
        if (deps.values.length) {
          await tx.insert(bhiDependentTable).values(deps.values.map((d) => ({ ...d, memberId: member!.memberId, active: true })));
        }
        await audit(req, admin, tx, {
          action: "MEMBER_CREATED",
          entityType: "MEMBER",
          entityId: member!.memberId,
          after: {
            idType: member!.idType,
            idNumber: member!.idNumber,
            firstName: member!.firstName,
            lastName: member!.lastName,
            classCode: member!.classCode,
            companyNumber,
            // Named, not just counted: a dependant appears on the card and sets the premium tier.
            dependants: deps.values.map((d) => `${d.dependentFullName} (${d.relationship})`),
          },
          reason,
          companyNumber,
        });
        return { status: "OK" as const, detail: await memberDetailInTx(tx, admin, member!, company) };
      });
      if (detail.status === "NOT_FOUND") {
        notFound(res);
        return;
      }
      if (detail.status === "INACTIVE") {
        companyWritable(detail.company, res);
        return;
      }
      await recalcDraftBills(req, admin, [companyNumber], "Member added");
      res.json(detail.detail);
    } catch (err) {
      if (err instanceof ClassNotAssignableError) {
        badRequest(res, err.code, err.message);
        return;
      }
      throw err;
    }
  },
);

router.get(
  "/v1/admin/companies/:companyNumber/members/:memberId",
  requireAdmin,
  requirePermission("MEMBER_READ_SCOPED"),
  async (req, res): Promise<void> => {
    const found = await loadMember(req, res);
    if (!found) return;
    res.json(await withScope(found.admin.scope, (tx) => memberDetailInTx(tx, found.admin, found.member, found.company)));
  },
);

router.patch(
  "/v1/admin/companies/:companyNumber/members/:memberId",
  requireAdmin,
  requirePermission("MEMBER_UPDATE"),
  async (req, res): Promise<void> => {
    if (!writable(req.admin!, res)) return;
    const parsed = UpdateMemberBody.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, "INVALID_INPUT", "Check the form. A reason of at least 3 characters is required.");
      return;
    }
    const found = await loadMember(req, res);
    if (!found) return;
    const { admin, member, company } = found;
    if (!companyWritable(company, res)) return;
    const { reason, ...fields } = parsed.data;
    const normalised = normaliseMemberFields(fields);
    if (!normalised.ok) {
      badRequest(res, "INVALID_INPUT", normalised.message);
      return;
    }
    const { before, after, changed } = diff(member as unknown as Record<string, unknown>, normalised.values as Record<string, unknown>);
    try {
      const detail = await withScope(admin.scope, async (tx) => {
        if (changed) {
          if ("classCode" in after) await assertAssignable(tx, after["classCode"] as string);
          await tx.update(bhiMemberTable).set(after).where(eq(bhiMemberTable.memberId, member.memberId));
          if ("classCode" in after) {
            await tx.insert(memberClassHistoryTable).values({
              memberId: member.memberId,
              classCode: after["classCode"] as string,
              recordedBy: admin.user.email,
            });
          }
        }
        await audit(req, admin, tx, {
          action: "MEMBER_UPDATED",
          entityType: "MEMBER",
          entityId: member.memberId,
          before,
          after,
          reason,
          companyNumber: company.companyNumber,
        });
        return detailAfter(tx, admin, member.memberId, company);
      });
      if (fields.classCode !== undefined) await recalcDraftBills(req, admin, [company.companyNumber], "Member class changed");
      res.json(detail);
    } catch (err) {
      if (err instanceof ClassNotAssignableError) {
        badRequest(res, err.code, err.message);
        return;
      }
      throw err;
    }
  },
);

router.post(
  "/v1/admin/companies/:companyNumber/members/:memberId/policy",
  requireAdmin,
  requirePermission("POLICY_MANAGE"),
  async (req, res): Promise<void> => {
    if (!writable(req.admin!, res)) return;
    const parsed = SaveMemberPolicyBody.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, "INVALID_INPUT", "Check the form. All policy fields and a reason of at least 3 characters are required.");
      return;
    }
    const found = await loadMember(req, res);
    if (!found) return;
    const { admin, member, company } = found;
    if (!companyWritable(company, res)) return;
    const { reason, ...f } = parsed.data;
    const effectiveDate = parseImportDate(f.effectiveDate);
    if (!effectiveDate) {
      badRequest(res, "INVALID_INPUT", "Effective date is not a date we recognise.");
      return;
    }
    const expiryDate = f.expiryDate ? parseImportDate(f.expiryDate) : null;
    if (f.expiryDate && !expiryDate) {
      badRequest(res, "INVALID_INPUT", "Expiry date is not a date we recognise.");
      return;
    }
    const values = {
      policyholder: f.policyholder.trim(),
      policyNumber: f.policyNumber.trim(),
      groupNumber: f.groupNumber.trim(),
      memberNumber: f.memberNumber.trim(),
      certificateNumber: f.certificateNumber.trim(),
      planName: f.planName.trim(),
      insurerName: f.insurerName.trim(),
      effectiveDate,
      expiryDate,
    };
    const detail = await withScope(admin.scope, async (tx) => {
      const [existing] = await tx
        .select()
        .from(policyMembershipsTable)
        .where(eq(policyMembershipsTable.memberRef, member.memberId));
      if (existing) {
        await tx.update(policyMembershipsTable).set(values).where(eq(policyMembershipsTable.id, existing.id));
      } else {
        await tx.insert(policyMembershipsTable).values({ memberRef: member.memberId, ...values });
      }
      await audit(req, admin, tx, {
        action: existing ? "POLICY_UPDATED" : "POLICY_CREATED",
        entityType: "POLICY",
        // Keyed to the member: a policy is 1:1 with a member and has no identity of its own in the UI.
        entityId: member.memberId,
        before: existing ?? undefined,
        after: values,
        reason,
        companyNumber: company.companyNumber,
      });
      return memberDetailInTx(tx, admin, member, company);
    });
    res.json(detail);
  },
);

// ---------------------------------------------------------------------------
// Status: deactivate and reactivate (members, dependants, beneficiaries)
// ---------------------------------------------------------------------------

async function changeStatus(
  req: Request,
  res: Response,
  opts: {
    entityType: StatusEntity;
    active: boolean;
    body: { safeParse: (v: unknown) => { success: boolean; data?: { reason: string; effectiveDate?: string | null } } };
    idParam?: "dependentId" | "beneficiaryId";
  },
): Promise<void> {
  if (!writable(req.admin!, res)) return;
  const parsed = opts.body.safeParse(req.body);
  if (!parsed.success || !parsed.data) {
    badRequest(res, "INVALID_INPUT", "A reason of at least 3 characters is required.");
    return;
  }
  const found = await loadMember(req, res);
  if (!found) return;
  const { admin, member, company } = found;
  if (!companyWritable(company, res)) return;

  let entityId = member.memberId;
  if (opts.idParam) {
    const childId = intParam(req, opts.idParam);
    if (!childId) {
      notFound(res);
      return;
    }
    entityId = childId;
  }

  let effectiveDate: string | undefined;
  if (parsed.data.effectiveDate) {
    const d = parseImportDate(parsed.data.effectiveDate);
    if (!d) {
      badRequest(res, "INVALID_INPUT", "Effective date is not a date we recognise.");
      return;
    }
    effectiveDate = d;
  }

  if (opts.entityType === "MEMBER" && opts.active) {
    if (retirementRefusal(res, `${member.firstName} ${member.lastName}`, member.dateOfBirth, "reactivated")) return;
  }

  try {
    const result = await withScope(admin.scope, async (tx) => {
      // A dependant or beneficiary must belong to the member in the path.
      if (opts.entityType !== "MEMBER") {
        const table = opts.entityType === "DEPENDENT" ? bhiDependentTable : bhiBeneficiaryTable;
        const idCol = opts.entityType === "DEPENDENT" ? bhiDependentTable.dependentId : bhiBeneficiaryTable.beneficiaryId;
        const [row] = await tx
          .select({ memberId: table.memberId })
          .from(table)
          .where(and(eq(idCol, entityId), eq(table.memberId, member.memberId)));
        if (!row) return null;
      }
      const change = await setActive(tx, {
        entityType: opts.entityType,
        id: entityId,
        active: opts.active,
        reason: parsed.data!.reason,
        effectiveDate,
        actor: admin.user.email,
      });
      if (!change.changed) return { unchanged: true as const };
      await audit(req, admin, tx, {
        action: `${opts.entityType}_${opts.active ? "REACTIVATED" : "DEACTIVATED"}`,
        entityType: opts.entityType,
        entityId,
        before: change.before,
        after: { ...change.after, cardSessionsRevoked: change.cardSessionsRevoked || undefined },
        reason: parsed.data!.reason,
        companyNumber: company.companyNumber,
      });
      return { unchanged: false as const, detail: await detailAfter(tx, admin, member.memberId, company) };
    });
    if (!result) {
      notFound(res);
      return;
    }
    if (result.unchanged) {
      badRequest(
        res,
        opts.active ? "ALREADY_ACTIVE" : "ALREADY_INACTIVE",
        opts.active ? "This record is already active." : "This record is already inactive.",
      );
      return;
    }
    if (opts.entityType !== "BENEFICIARY") {
      const what = opts.entityType === "MEMBER" ? "Member" : "Dependant";
      await recalcDraftBills(req, admin, [company.companyNumber], `${what} ${opts.active ? "reactivated" : "deactivated"}`);
    }
    res.json(result.detail);
  } catch (err) {
    if (err instanceof StatusChangeError) {
      if (err.code === "NOT_FOUND") notFound(res);
      else badRequest(res, "INVALID_INPUT", err.message);
      return;
    }
    throw err;
  }
}

router.post(
  "/v1/admin/companies/:companyNumber/members/:memberId/deactivate",
  requireAdmin,
  requirePermission("MEMBER_DELETE"),
  (req, res) => changeStatus(req, res, { entityType: "MEMBER", active: false, body: DeactivateMemberBody }),
);

router.post(
  "/v1/admin/companies/:companyNumber/members/:memberId/reactivate",
  requireAdmin,
  requirePermission("MEMBER_REACTIVATE"),
  (req, res) => changeStatus(req, res, { entityType: "MEMBER", active: true, body: ReactivateMemberBody }),
);

router.post(
  "/v1/admin/companies/:companyNumber/members/:memberId/dependents/:dependentId/deactivate",
  requireAdmin,
  requirePermission("DEPENDENT_UPDATE"),
  (req, res) =>
    changeStatus(req, res, { entityType: "DEPENDENT", active: false, body: DeactivateDependentBody, idParam: "dependentId" }),
);

router.post(
  "/v1/admin/companies/:companyNumber/members/:memberId/dependents/:dependentId/reactivate",
  requireAdmin,
  requirePermission("DEPENDENT_UPDATE"),
  (req, res) =>
    changeStatus(req, res, { entityType: "DEPENDENT", active: true, body: ReactivateDependentBody, idParam: "dependentId" }),
);

router.post(
  "/v1/admin/companies/:companyNumber/members/:memberId/beneficiaries/:beneficiaryId/deactivate",
  requireAdmin,
  requirePermission("BENEFICIARY_MANAGE"),
  (req, res) =>
    changeStatus(req, res, { entityType: "BENEFICIARY", active: false, body: DeactivateBeneficiaryBody, idParam: "beneficiaryId" }),
);

router.post(
  "/v1/admin/companies/:companyNumber/members/:memberId/beneficiaries/:beneficiaryId/reactivate",
  requireAdmin,
  requirePermission("BENEFICIARY_MANAGE"),
  (req, res) =>
    changeStatus(req, res, { entityType: "BENEFICIARY", active: true, body: ReactivateBeneficiaryBody, idParam: "beneficiaryId" }),
);

// ---------------------------------------------------------------------------
// Dependants and beneficiaries: edit and add
// ---------------------------------------------------------------------------

router.post(
  "/v1/admin/companies/:companyNumber/members/:memberId/dependents",
  requireAdmin,
  requirePermission("DEPENDENT_UPDATE"),
  async (req, res): Promise<void> => {
    if (!writable(req.admin!, res)) return;
    const parsed = CreateDependentBody.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, "INVALID_INPUT", "Check the form. A full name, a relationship and a reason of at least 3 characters are required.");
      return;
    }
    const found = await loadMember(req, res);
    if (!found) return;
    const { admin, member, company } = found;
    if (!companyWritable(company, res)) return;
    const { reason, notes, ...input } = parsed.data;
    // The same checks as a dependant given with a new member.
    const deps = dependantValuesFrom([input]);
    if (!deps.ok) {
      // Drop the "Dependant 1:" prefix meant for a list of several.
      const message = deps.message.replace(/^Dependant 1(?: \([^)]*\))?: /, "");
      badRequest(res, "INVALID_INPUT", message.charAt(0).toUpperCase() + message.slice(1));
      return;
    }
    const values = { ...deps.values[0]!, notes: blankToNull(notes) };
    const detail = await withScope(admin.scope, async (tx) => {
      // Active from today: the next bill counts it and moves the member's tier.
      const [created] = await tx
        .insert(bhiDependentTable)
        .values({ ...values, memberId: member.memberId, active: true })
        .returning();
      await audit(req, admin, tx, {
        action: "DEPENDENT_ADDED",
        entityType: "DEPENDENT",
        entityId: created!.dependentId,
        after: values,
        reason,
        companyNumber: company.companyNumber,
      });
      return memberDetailInTx(tx, admin, member, company);
    });
    await recalcDraftBills(req, admin, [company.companyNumber], "Dependant added");
    res.json(detail);
  },
);

router.patch(
  "/v1/admin/companies/:companyNumber/members/:memberId/dependents/:dependentId",
  requireAdmin,
  requirePermission("DEPENDENT_UPDATE"),
  async (req, res): Promise<void> => {
    if (!writable(req.admin!, res)) return;
    const parsed = UpdateDependentBody.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, "INVALID_INPUT", "Check the form. A reason of at least 3 characters is required.");
      return;
    }
    const found = await loadMember(req, res);
    const dependentId = intParam(req, "dependentId");
    if (!found) return;
    if (!dependentId) {
      notFound(res);
      return;
    }
    const { admin, member, company } = found;
    if (!companyWritable(company, res)) return;
    const { reason, fullName, dateOfBirth, idType, idNumber, sex, ...rest } = parsed.data;
    const changes: Record<string, unknown> = {};
    if (fullName !== undefined) changes["dependentFullName"] = fullName.trim();
    if (rest.relationship !== undefined) changes["relationship"] = rest.relationship;
    if (rest.notes !== undefined) changes["notes"] = blankToNull(rest.notes);
    if (idType !== undefined) changes["idType"] = blankToNull(idType)?.toUpperCase() ?? null;
    if (idNumber !== undefined) changes["idNumber"] = blankToNull(idNumber);
    if (sex !== undefined) changes["sex"] = blankToNull(sex) ? normaliseSex(sex!) : null;
    if (dateOfBirth !== undefined) {
      const raw = blankToNull(dateOfBirth);
      const parsedDob = raw ? parseImportDate(raw) : null;
      if (raw && !parsedDob) {
        badRequest(res, "INVALID_INPUT", `Date of birth "${raw}" is not a date we recognise.`);
        return;
      }
      changes["dateOfBirth"] = parsedDob;
    }
    const detail = await withScope(admin.scope, async (tx) => {
      const [dependent] = await tx
        .select()
        .from(bhiDependentTable)
        .where(and(eq(bhiDependentTable.dependentId, dependentId), eq(bhiDependentTable.memberId, member.memberId)));
      if (!dependent) return null;
      const d = diff(dependent as unknown as Record<string, unknown>, changes);
      if (d.changed) {
        await tx.update(bhiDependentTable).set(d.after).where(eq(bhiDependentTable.dependentId, dependentId));
      }
      await audit(req, admin, tx, {
        action: "DEPENDENT_UPDATED",
        entityType: "DEPENDENT",
        entityId: dependentId,
        before: d.before,
        after: d.after,
        reason,
        companyNumber: company.companyNumber,
      });
      return memberDetailInTx(tx, admin, member, company);
    });
    if (!detail) {
      notFound(res);
      return;
    }
    res.json(detail);
  },
);

function beneficiaryValues(
  input: {
    fullName?: string;
    relationship?: string | null;
    dateOfBirth?: string | null;
    idType?: string | null;
    idNumber?: string | null;
    sex?: string | null;
    phone?: string | null;
    email?: string | null;
    sharePercent?: number | null;
    notes?: string | null;
  },
): { ok: true; values: Record<string, unknown> } | { ok: false; message: string } {
  const v: Record<string, unknown> = {};
  if (input.fullName !== undefined) v["beneficiaryFullName"] = input.fullName.trim();
  if (input.relationship !== undefined) v["relationship"] = input.relationship ?? null;
  if (input.idType !== undefined) v["idType"] = blankToNull(input.idType)?.toUpperCase() ?? null;
  if (input.idNumber !== undefined) v["idNumber"] = blankToNull(input.idNumber);
  if (input.sex !== undefined) v["sex"] = blankToNull(input.sex) ? normaliseSex(input.sex!) : null;
  if (input.email !== undefined) v["email"] = blankToNull(input.email);
  if (input.notes !== undefined) v["notes"] = blankToNull(input.notes);
  if (input.sharePercent !== undefined) v["sharePercent"] = input.sharePercent == null ? null : String(input.sharePercent);
  if (input.phone !== undefined) {
    // A beneficiary is never sent a code and may live abroad, so the number is
    // stored as given rather than normalised to Guyana.
    v["phone"] = blankToNull(input.phone);
  }
  if (input.dateOfBirth !== undefined) {
    const raw = blankToNull(input.dateOfBirth);
    const d = raw ? parseImportDate(raw) : null;
    if (raw && !d) return { ok: false, message: `Date of birth "${raw}" is not a date we recognise.` };
    v["dateOfBirth"] = d;
  }
  return { ok: true, values: v };
}

router.post(
  "/v1/admin/companies/:companyNumber/members/:memberId/beneficiaries",
  requireAdmin,
  requirePermission("BENEFICIARY_MANAGE"),
  async (req, res): Promise<void> => {
    if (!writable(req.admin!, res)) return;
    const parsed = CreateBeneficiaryBody.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, "INVALID_INPUT", "Check the form. A full name and a reason of at least 3 characters are required.");
      return;
    }
    const found = await loadMember(req, res);
    if (!found) return;
    const { admin, member, company } = found;
    if (!companyWritable(company, res)) return;
    const { reason, ...input } = parsed.data;
    const values = beneficiaryValues(input);
    if (!values.ok) {
      badRequest(res, "INVALID_INPUT", values.message);
      return;
    }
    const detail = await withScope(admin.scope, async (tx) => {
      const [created] = await tx
        .insert(bhiBeneficiaryTable)
        .values({
          ...(values.values as { beneficiaryFullName: string }),
          memberId: member.memberId,
          active: true,
        })
        .returning();
      await audit(req, admin, tx, {
        action: "BENEFICIARY_ADDED",
        entityType: "BENEFICIARY",
        entityId: created!.beneficiaryId,
        after: values.values,
        reason,
        companyNumber: company.companyNumber,
      });
      return memberDetailInTx(tx, admin, member, company);
    });
    res.json(detail);
  },
);

router.patch(
  "/v1/admin/companies/:companyNumber/members/:memberId/beneficiaries/:beneficiaryId",
  requireAdmin,
  requirePermission("BENEFICIARY_MANAGE"),
  async (req, res): Promise<void> => {
    if (!writable(req.admin!, res)) return;
    const parsed = UpdateBeneficiaryBody.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, "INVALID_INPUT", "Check the form. A reason of at least 3 characters is required.");
      return;
    }
    const found = await loadMember(req, res);
    const beneficiaryId = intParam(req, "beneficiaryId");
    if (!found) return;
    if (!beneficiaryId) {
      notFound(res);
      return;
    }
    const { admin, member, company } = found;
    if (!companyWritable(company, res)) return;
    const { reason, ...input } = parsed.data;
    const values = beneficiaryValues(input);
    if (!values.ok) {
      badRequest(res, "INVALID_INPUT", values.message);
      return;
    }
    const detail = await withScope(admin.scope, async (tx) => {
      const [beneficiary] = await tx
        .select()
        .from(bhiBeneficiaryTable)
        .where(and(eq(bhiBeneficiaryTable.beneficiaryId, beneficiaryId), eq(bhiBeneficiaryTable.memberId, member.memberId)));
      if (!beneficiary) return null;
      const d = diff(beneficiary as unknown as Record<string, unknown>, values.values);
      if (d.changed) {
        await tx.update(bhiBeneficiaryTable).set(d.after).where(eq(bhiBeneficiaryTable.beneficiaryId, beneficiaryId));
      }
      await audit(req, admin, tx, {
        action: "BENEFICIARY_UPDATED",
        entityType: "BENEFICIARY",
        entityId: beneficiaryId,
        before: d.before,
        after: d.after,
        reason,
        companyNumber: company.companyNumber,
      });
      return memberDetailInTx(tx, admin, member, company);
    });
    if (!detail) {
      notFound(res);
      return;
    }
    res.json(detail);
  },
);

export default router;
