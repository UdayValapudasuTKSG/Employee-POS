/**
 * Onboarding, editing and offboarding client companies (spec FR-017, FR-019).
 *
 * Onboarding is a super admin action that needs no code release: one
 * transaction inserts the bhi.company row and issues the company's one client
 * admin login, which then manages the company's own users. If any step fails, nothing is created.
 *
 * Offboarding deactivates rather than deletes: the company and its users become
 * inactive, the company drops out of the card lookup and billing, and every
 * record stays readable to super admins, support and auditors.
 *
 * GET /v1/admin/companies (the in-scope list) lives in routes/adminMembers.ts.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, count, eq, inArray } from "drizzle-orm";
import {
  adminUsersTable,
  bhiCompanyTable,
  bhiMemberTable,
  SYSTEM_SCOPE,
  withScope,
  type BhiCompany,
  type ScopedTx,
} from "@workspace/db";
import { OnboardCompanyBody, OffboardCompanyBody, ReactivateCompanyBody, UpdateCompanyBody } from "@workspace/api-zod";
import { writeAudit } from "../lib/audit";
import { generateOpaqueToken, hashPassword } from "../lib/auth";
import { companyParam, inScope, writable } from "../lib/adminScope";
import { ROLE_LABELS, hasPermission } from "../lib/rbac";
import { requireAdmin, requirePermission, type AdminContext } from "../middlewares/adminAuth";

const router: IRouter = Router();

const PROFILE_FIELDS = [
  "companyName",
  "address1",
  "address2",
  "city",
  "contactName",
  "contactPhone",
  "contactEmail",
  "notes",
] as const;

/** Fields a client admin may edit on its own company; the rest are the super admin's. */
const CONTACT_FIELDS = new Set(["address1", "address2", "city", "contactName", "contactPhone", "contactEmail"]);

const blankToNull = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

function badRequest(res: Response, code: string, message: string): void {
  res.status(400).json({ error: { code, message } });
}

function notFound(res: Response): void {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Company not found." } });
}

async function companyJson(tx: ScopedTx, company: BhiCompany) {
  const counts = await tx
    .select({ active: bhiMemberTable.active, n: count() })
    .from(bhiMemberTable)
    .where(eq(bhiMemberTable.companyNumber, company.companyNumber))
    .groupBy(bhiMemberTable.active);
  return {
    companyNumber: company.companyNumber,
    companyName: company.companyName,
    active: company.active,
    address1: company.address1,
    address2: company.address2,
    city: company.city,
    contactName: company.contactName,
    contactPhone: company.contactPhone,
    contactEmail: company.contactEmail,
    notes: company.notes,
    activeMembers: counts.find((c) => c.active)?.n ?? 0,
    inactiveMembers: counts.find((c) => !c.active)?.n ?? 0,
  };
}

class OnboardError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

router.post(
  "/v1/admin/companies",
  requireAdmin,
  requirePermission("PLATFORM_MANAGE"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const parsed = OnboardCompanyBody.safeParse(req.body);
    if (!parsed.success) {
      badRequest(
        res,
        "INVALID_INPUT",
        "Check the form. A company number (up to 20 characters), a name (up to 120), the client admin's email and name, and a reason are required.",
      );
      return;
    }
    const input = parsed.data;
    const companyNumber = input.companyNumber.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{0,19}$/.test(companyNumber)) {
      badRequest(res, "INVALID_COMPANY_NUMBER", "A company number uses letters, digits, - and _ only, up to 20 characters.");
      return;
    }
    const email = input.clientAdmin.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      badRequest(res, "INVALID_INPUT", "Enter a valid email address for the client admin.");
      return;
    }
    const temporaryPassword = generateOpaqueToken().slice(0, 16);

    try {
      const result = await withScope(SYSTEM_SCOPE, async (tx) => {
        const [existing] = await tx
          .select({ n: bhiCompanyTable.companyNumber })
          .from(bhiCompanyTable)
          .where(eq(bhiCompanyTable.companyNumber, companyNumber));
        if (existing) throw new OnboardError(409, "COMPANY_EXISTS", `A company with number ${companyNumber} already exists.`);
        const [emailTaken] = await tx.select({ id: adminUsersTable.id }).from(adminUsersTable).where(eq(adminUsersTable.email, email));
        if (emailTaken) throw new OnboardError(409, "EMAIL_IN_USE", "An admin account with that email already exists.");

        const [company] = await tx
          .insert(bhiCompanyTable)
          .values({
            companyNumber,
            companyName: input.companyName.trim(),
            address1: blankToNull(input.address1),
            address2: blankToNull(input.address2),
            city: blankToNull(input.city),
            contactName: blankToNull(input.contactName),
            contactPhone: blankToNull(input.contactPhone),
            contactEmail: blankToNull(input.contactEmail),
            notes: blankToNull(input.notes),
            active: true,
          })
          .returning();
        const [clientAdmin] = await tx
          .insert(adminUsersTable)
          .values({
            email,
            displayName: input.clientAdmin.displayName.trim(),
            role: "ROLE_CLIENT_ADMIN",
            companyScope: companyNumber,
            passwordHash: hashPassword(temporaryPassword),
            mustChangePassword: true,
          })
          .returning();
        await writeAudit(
          {
            actor: admin.user.email,
            actorRole: admin.role,
            action: "COMPANY_ONBOARDED",
            entityType: "COMPANY",
            entityId: companyNumber,
            afterValue: JSON.stringify({
              companyNumber,
              companyName: company!.companyName,
              clientAdmin: clientAdmin!.email,
            }),
            reason: input.reason,
            sourceIp: req.ip ?? null,
            companyCode: companyNumber,
          },
          tx,
        );
        return { company: await companyJson(tx, company!), clientAdmin: clientAdmin! };
      });
      res.status(201).json({
        company: result.company,
        clientAdmin: {
          id: result.clientAdmin.id,
          email: result.clientAdmin.email,
          displayName: result.clientAdmin.displayName,
          role: result.clientAdmin.role,
          roleLabel: ROLE_LABELS.ROLE_CLIENT_ADMIN,
          companyScope: result.clientAdmin.companyScope,
          active: result.clientAdmin.active,
          createdAt: result.clientAdmin.createdAt.toISOString(),
        },
        temporaryPassword,
      });
    } catch (err) {
      if (err instanceof OnboardError) {
        res.status(err.status).json({ error: { code: err.code, message: err.message } });
        return;
      }
      throw err;
    }
  },
);

router.patch(
  "/v1/admin/companies/:companyNumber",
  requireAdmin,
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    if (!writable(admin, res)) return;
    const companyNumber = companyParam(req);
    if (!companyNumber || !inScope(admin, companyNumber)) {
      notFound(res);
      return;
    }
    const isSuper = hasPermission(admin.role, "PLATFORM_MANAGE");
    const isCompanyAdmin = admin.role === "ROLE_CLIENT_ADMIN";
    if (!isSuper && !isCompanyAdmin) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "You do not have permission to perform this action." } });
      return;
    }
    const parsed = UpdateCompanyBody.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, "INVALID_INPUT", "Check the form. A reason of at least 3 characters is required, and each field has a maximum length.");
      return;
    }
    const { reason, ...fields } = parsed.data;
    const changes: Record<string, string | null> = {};
    for (const key of PROFILE_FIELDS) {
      const v = fields[key];
      if (v === undefined) continue;
      if (!isSuper && !CONTACT_FIELDS.has(key)) {
        res.status(403).json({ error: { code: "FORBIDDEN", message: "Only a super admin can change the company's name or notes." } });
        return;
      }
      changes[key] = key === "companyName" ? String(v).trim() : blankToNull(v);
    }
    const result = await withScope(admin.scope, async (tx) => {
      const [company] = await tx.select().from(bhiCompanyTable).where(eq(bhiCompanyTable.companyNumber, companyNumber));
      if (!company) return null;
      if (!company.active) return { inactive: true as const };
      const before: Record<string, unknown> = {};
      for (const k of Object.keys(changes)) before[k] = (company as unknown as Record<string, unknown>)[k];
      const [updated] = Object.keys(changes).length
        ? await tx.update(bhiCompanyTable).set(changes).where(eq(bhiCompanyTable.companyNumber, companyNumber)).returning()
        : [company];
      await writeAudit(
        {
          actor: admin.user.email,
          actorRole: admin.role,
          action: "COMPANY_UPDATED",
          entityType: "COMPANY",
          entityId: companyNumber,
          beforeValue: JSON.stringify(before),
          afterValue: JSON.stringify(changes),
          reason,
          sourceIp: req.ip ?? null,
          companyCode: companyNumber,
        },
        tx,
      );
      return { inactive: false as const, json: await companyJson(tx, updated!) };
    });
    if (!result) {
      notFound(res);
      return;
    }
    if (result.inactive) {
      res.status(409).json({ error: { code: "COMPANY_INACTIVE", message: "This company has been offboarded; reactivate it first." } });
      return;
    }
    res.json(result.json);
  },
);

async function setCompanyActive(req: Request, res: Response, active: boolean): Promise<void> {
  const admin: AdminContext = req.admin!;
  const parsed = (active ? ReactivateCompanyBody : OffboardCompanyBody).safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, "INVALID_INPUT", "A reason of at least 3 characters is required.");
    return;
  }
  const companyNumber = companyParam(req);
  if (!companyNumber) {
    notFound(res);
    return;
  }
  const result = await withScope(SYSTEM_SCOPE, async (tx) => {
    const [company] = await tx.select().from(bhiCompanyTable).where(eq(bhiCompanyTable.companyNumber, companyNumber));
    if (!company) return null;
    if (company.active === active) return { unchanged: true as const };
    const [updated] = await tx
      .update(bhiCompanyTable)
      .set({ active })
      .where(eq(bhiCompanyTable.companyNumber, companyNumber))
      .returning();
    // The company's own users go with it: an offboarded client cannot sign in.
    const users = await tx
      .update(adminUsersTable)
      .set({ active })
      .where(
        and(
          eq(adminUsersTable.companyScope, companyNumber),
          inArray(adminUsersTable.role, ["ROLE_CLIENT_ADMIN", "ROLE_HR_ADMIN"]),
        ),
      )
      .returning({ email: adminUsersTable.email });
    await writeAudit(
      {
        actor: admin.user.email,
        actorRole: admin.role,
        action: active ? "COMPANY_REACTIVATED" : "COMPANY_OFFBOARDED",
        entityType: "COMPANY",
        entityId: companyNumber,
        beforeValue: JSON.stringify({ active: company.active }),
        afterValue: JSON.stringify({ active, users: users.map((u) => u.email) }),
        reason: parsed.data.reason,
        sourceIp: req.ip ?? null,
        companyCode: companyNumber,
      },
      tx,
    );
    return { unchanged: false as const, json: await companyJson(tx, updated!) };
  });
  if (!result) {
    notFound(res);
    return;
  }
  if (result.unchanged) {
    badRequest(res, active ? "ALREADY_ACTIVE" : "ALREADY_INACTIVE", active ? "This company is already active." : "This company is already offboarded.");
    return;
  }
  res.json(result.json);
}

router.post(
  "/v1/admin/companies/:companyNumber/offboard",
  requireAdmin,
  requirePermission("PLATFORM_MANAGE"),
  (req, res) => setCompanyActive(req, res, false),
);

router.post(
  "/v1/admin/companies/:companyNumber/reactivate",
  requireAdmin,
  requirePermission("PLATFORM_MANAGE"),
  (req, res) => setCompanyActive(req, res, true),
);

export default router;
