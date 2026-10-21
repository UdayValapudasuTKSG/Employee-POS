import { Router, type IRouter, type Response } from "express";
import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  lte,
} from "drizzle-orm";
import {
  db,
  adminUsersTable,
  activityLogTable,
  employeeSessionsTable,
  bhiCompanyTable,
  withScope,
} from "@workspace/db";
import {
  AdminLoginBody,
  ResetVerificationLockBody,
  CreateAdminUserBody,
  UpdateAdminUserBody,
  ChangeOwnAdminPasswordBody,
} from "@workspace/api-zod";
import {
  verifyPassword,
  hashPassword,
  signToken,
  generateOpaqueToken,
  ADMIN_JWT_TTL_SECONDS,
  OTP_TTL_SECONDS,
} from "../lib/auth";
import {
  permissionsForRole,
  hasPermission,
  buildPermissionMatrix,
  ROLE_LABELS,
  COMPANY_GRANTABLE_ROLES,
  scopeKindForRole,
  type AdminRole,
} from "../lib/rbac";
import {
  applyAdminUserChanges,
  LastClientAdminError,
  LastAdminManagerError,
  LastPlatformAdminError,
} from "../lib/adminUserUpdate";
import { writeAudit } from "../lib/audit";
import {
  UUID_RE,
  auditVisibleTo,
  pageParams,
  paramId,
  sessionCompany,
  verificationsInScope,
} from "../lib/adminScope";
import { requireAdmin, requirePermission, type AdminContext } from "../middlewares/adminAuth";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

router.post("/v1/admin/auth/login", async (req, res): Promise<void> => {
  const parsed = AdminLoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "INVALID_INPUT", message: "Enter your email and password." } });
    return;
  }
  const [user] = await db
    .select()
    .from(adminUsersTable)
    .where(eq(adminUsersTable.email, parsed.data.email.trim().toLowerCase()));
  if (!user || !user.active || !verifyPassword(parsed.data.password, user.passwordHash)) {
    await writeAudit({
      actor: parsed.data.email.trim().toLowerCase(),
      actorRole: "UNKNOWN",
      action: "LOGIN_FAILED",
      entityType: "ADMIN_USER",
      sourceIp: req.ip ?? null,
    });
    res.status(401).json({ error: { code: "LOGIN_FAILED", message: "That email and password combination is not correct." } });
    return;
  }
  await writeAudit({
    actor: user.email,
    actorRole: user.role,
    action: "LOGIN",
    entityType: "ADMIN_USER",
    entityId: user.id,
    sourceIp: req.ip ?? null,
    companyCode: user.companyScope,
  });
  res.json({
    token: signToken({ kind: "admin", sub: user.id }, ADMIN_JWT_TTL_SECONDS),
    role: user.role,
    scope: user.companyScope,
    displayName: user.displayName,
    permissions: permissionsForRole(user.role as never),
    mustChangePassword: user.mustChangePassword,
  });
});

router.get("/v1/admin/me", requireAdmin, async (req, res): Promise<void> => {
  const admin = req.admin!;
  const companyCode = admin.user.companyScope;
  const [scopeCompany] = companyCode
    ? await withScope(admin.scope, (tx) =>
        tx
          .select({ companyName: bhiCompanyTable.companyName })
          .from(bhiCompanyTable)
          .where(eq(bhiCompanyTable.companyNumber, companyCode)),
      )
    : [];
  res.json({
    email: admin.user.email,
    displayName: admin.user.displayName,
    role: admin.role,
    roleLabel: ROLE_LABELS[admin.role],
    scope: companyCode,
    scopeCompanyName: scopeCompany?.companyName ?? null,
    companies: admin.scope.all ? null : admin.scope.companies,
    readOnly: admin.scope.readOnly,
    permissions: permissionsForRole(admin.role),
  });
});

// Dashboard, companies and every member, dependant, beneficiary and policy route
// now live in routes/adminMembers.ts, on the shared BHI tables.

// Bulk import lives in routes/adminImport.ts.

// ---------------------------------------------------------------------------
// Audit, verifications, users, permissions
// ---------------------------------------------------------------------------

function auditEntry(a: typeof activityLogTable.$inferSelect) {
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
  "/v1/admin/audit",
  requireAdmin,
  requirePermission("AUDIT_READ"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const { page, pageSize } = pageParams(req);
    const conditions = [];
    const inScope = auditVisibleTo(admin);
    if (inScope) conditions.push(inScope);
    const entityId = typeof req.query["entityId"] === "string" ? req.query["entityId"].trim() : "";
    const actor = typeof req.query["actor"] === "string" ? req.query["actor"].trim() : "";
    const action = typeof req.query["action"] === "string" ? req.query["action"].trim() : "";
    const from = typeof req.query["from"] === "string" ? req.query["from"].trim() : "";
    const to = typeof req.query["to"] === "string" ? req.query["to"].trim() : "";
    if (entityId) conditions.push(eq(activityLogTable.entityId, entityId));
    if (actor) conditions.push(ilike(activityLogTable.actor, `%${actor}%`));
    if (action) conditions.push(eq(activityLogTable.action, action));
    if (from && !Number.isNaN(Date.parse(from))) {
      conditions.push(gte(activityLogTable.timestamp, new Date(from)));
    }
    if (to && !Number.isNaN(Date.parse(to))) {
      conditions.push(lte(activityLogTable.timestamp, new Date(to)));
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const [{ n: totalItems } = { n: 0 }] = await db
      .select({ n: count() })
      .from(activityLogTable)
      .where(where);
    const items = await db
      .select()
      .from(activityLogTable)
      .where(where)
      .orderBy(desc(activityLogTable.timestamp))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    res.json({
      items: items.map(auditEntry),
      page,
      pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / pageSize),
    });
  },
);

router.get(
  "/v1/admin/verifications",
  requireAdmin,
  requirePermission("VERIFICATION_READ"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const { page, pageSize } = pageParams(req);
    const where = verificationsInScope(admin.scope);
    const [{ n: totalItems } = { n: 0 }] = await db
      .select({ n: count() })
      .from(employeeSessionsTable)
      .where(where);
    const items = await db
      .select()
      .from(employeeSessionsTable)
      .where(where)
      .orderBy(desc(employeeSessionsTable.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    res.json({
      items: items.map((v) => ({
        id: v.id,
        lookupChannel: v.lookupChannel,
        maskedDestination: v.maskedDestination,
        companyCode: sessionCompany(v, admin.scope),
        status: v.status,
        attempts: v.attempts,
        expiresAt: v.expiresAt.toISOString(),
        createdAt: v.createdAt.toISOString(),
      })),
      page,
      pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / pageSize),
    });
  },
);

router.post(
  "/v1/admin/verifications/:id/reset-lock",
  requireAdmin,
  // Deliberately NOT VERIFICATION_READ: the auditor holds that, and an auditor
  // must never mutate. SESSION_MANAGE is the support-desk grant.
  requirePermission("SESSION_MANAGE"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const parsed = ResetVerificationLockBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "INVALID_INPUT", message: "A reason of at least 3 characters is required." },
      });
      return;
    }
    const id = paramId(req, "id");
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Verification not found." } });
      return;
    }
    const [session] = await db
      .select()
      .from(employeeSessionsTable)
      .where(eq(employeeSessionsTable.id, id));
    if (!session) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Verification not found." } });
      return;
    }
    // Cross-scope reads as 404, matching every other admin lookup. Decoy rows
    // match no company, so a scoped admin never sees them.
    const company = sessionCompany(session, admin.scope);
    if (!admin.scope.all && !company) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Verification not found." } });
      return;
    }
    // No writable() check: support is read-only for member data, but
    // SESSION_MANAGE exists so the support desk can clear a lockout. This
    // touches only the verification session, never a bhi table.
    if (session.matchedMembers.length === 0) {
      res.status(400).json({
        error: {
          code: "DECOY_SESSION",
          message:
            "This session is not attached to a member and can never verify. Ask them to start a new lookup.",
        },
      });
      return;
    }
    if (session.status !== "LOCKED") {
      res.status(400).json({
        error: {
          code: "NOT_LOCKED",
          message: `This session is ${session.status.toLowerCase()}, not locked.`,
        },
      });
      return;
    }

    // All four fields are needed to make the row usable again: status clears
    // the 423, attempts restores the three tries, expiresAt stops an immediate
    // CODE_EXPIRED, and resendCount lets the member request a fresh code.
    // otpHash is left alone — the code already delivered still works.
    const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000);
    await db
      .update(employeeSessionsTable)
      .set({ status: "PENDING", attempts: 0, resendCount: 0, expiresAt })
      .where(eq(employeeSessionsTable.id, session.id));

    await writeAudit({
      actor: admin.user.email,
      actorRole: admin.role,
      action: "VERIFICATION_UNLOCKED",
      entityType: "VERIFICATION",
      entityId: session.id,
      beforeValue: JSON.stringify({
        status: session.status,
        attempts: session.attempts,
        resendCount: session.resendCount,
      }),
      afterValue: JSON.stringify({ status: "PENDING", attempts: 0, resendCount: 0 }),
      reason: parsed.data.reason,
      sourceIp: req.ip ?? null,
      companyCode: company ?? session.companyCode,
    });

    res.json({
      id: session.id,
      status: "PENDING",
      attempts: 0,
      expiresAt: expiresAt.toISOString(),
      // No code is re-sent: that would give an admin a button that emails or
      // texts a member on demand. The member can press Resend themselves.
      message:
        "Unlocked. Ask the member to enter the code they already received, or to request a new one.",
    });
  },
);

// ---------------------------------------------------------------------------
// Admin users (spec FR-012 to FR-014, FR-018; research R8)
//
// Super admins manage anyone. A client admin manages only the company-scoped
// roles — client admin and HR administrator — of its own company, so NALICO
// issues one client admin per company and that admin manages the rest. Every
// role carries exactly the scope its kind needs.
// ---------------------------------------------------------------------------

type AdminUserRow = typeof adminUsersTable.$inferSelect;

function adminUserJson(u: AdminUserRow) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    roleLabel: ROLE_LABELS[u.role as AdminRole] ?? u.role,
    companyScope: u.companyScope,
    active: u.active,
    createdAt: u.createdAt.toISOString(),
  };
}

function generateTempPassword(): string {
  // 16 chars, URL-safe alphabet — shown once, meant to be changed.
  return generateOpaqueToken().slice(0, 16);
}

/**
 * May this admin see / act on this user? Super admins: anyone. Others: users
 * of a company in their scope, and themselves.
 */
function userInScope(admin: AdminContext, u: AdminUserRow): boolean {
  if (hasPermission(admin.role, "PLATFORM_MANAGE")) return true;
  if (u.id === admin.user.id) return true;
  return u.companyScope != null && !admin.scope.all && admin.scope.companies.includes(u.companyScope);
}

function refuse(res: Response, status: number, code: string, message: string): false {
  res.status(status).json({ error: { code, message } });
  return false;
}

/**
 * Checks a role and its scope before they are written. Returns true when the
 * caller may proceed; otherwise it has already answered.
 */
async function checkGrant(
  admin: AdminContext,
  role: AdminRole,
  companyScope: string | null,
  res: Response,
): Promise<boolean> {
  const kind = scopeKindForRole(role);
  if (kind === "COMPANY" && !companyScope) {
    return refuse(res, 400, "SCOPE_REQUIRED", `${ROLE_LABELS[role]} accounts belong to one company: choose it.`);
  }
  if (kind !== "COMPANY" && companyScope) {
    return refuse(res, 400, "SCOPE_NOT_ALLOWED", `${ROLE_LABELS[role]} accounts do not take that kind of scope.`);
  }
  const isSuper = hasPermission(admin.role, "PLATFORM_MANAGE");
  if (!isSuper) {
    const reaches = companyScope != null && !admin.scope.all && admin.scope.companies.includes(companyScope);
    if (!COMPANY_GRANTABLE_ROLES.includes(role) || !reaches) {
      return refuse(
        res,
        403,
        "ROLE_NOT_GRANTABLE",
        "You can create client admins and HR administrators for your own company only.",
      );
    }
  }
  if (companyScope) {
    const [company] = await withScope(admin.scope, (tx) =>
      tx
        .select({ active: bhiCompanyTable.active })
        .from(bhiCompanyTable)
        .where(eq(bhiCompanyTable.companyNumber, companyScope)),
    );
    if (!company || !company.active) {
      return refuse(res, 400, "UNKNOWN_COMPANY", `No active company with number "${companyScope}".`);
    }
  }
  return true;
}

/**
 * Guards every path that could hand out, or take over, a super admin account.
 *
 * ADMIN_USER_MANAGE alone is not enough for either side of this: without the
 * check, a client admin could promote a second account, or call reset-password
 * on a super admin and take the account over in one request.
 *
 * Returns true when the caller may proceed; otherwise it has already responded.
 */
function guardPlatformTarget(callerRole: AdminRole, affectedRoles: (string | undefined)[], res: Response): boolean {
  const touchesPlatform = affectedRoles.some((r) => r === "ROLE_PLATFORM_ADMIN");
  if (!touchesPlatform || hasPermission(callerRole, "PLATFORM_MANAGE")) return true;
  res.status(403).json({
    error: { code: "FORBIDDEN", message: "Only a super admin can manage super admin accounts." },
  });
  return false;
}

router.get(
  "/v1/admin/users",
  requireAdmin,
  requirePermission("ADMIN_USER_READ"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const users = await db.select().from(adminUsersTable).orderBy(adminUsersTable.email);
    res.json(users.filter((u) => userInScope(admin, u)).map((u) => adminUserJson(u)));
  },
);

router.post(
  "/v1/admin/users",
  requireAdmin,
  requirePermission("ADMIN_USER_MANAGE"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const parsed = CreateAdminUserBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "INVALID_INPUT", message: "Provide an email, a display name, a role, and its scope." } });
      return;
    }
    const role = parsed.data.role as AdminRole;
    if (!guardPlatformTarget(admin.role, [role], res)) return;
    const email = parsed.data.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: { code: "INVALID_INPUT", message: "Enter a valid email address." } });
      return;
    }
    const companyScope = parsed.data.companyScope?.trim() || null;
    if (!(await checkGrant(admin, role, companyScope, res))) return;
    const [existing] = await db.select().from(adminUsersTable).where(eq(adminUsersTable.email, email));
    if (existing) {
      res.status(400).json({ error: { code: "EMAIL_IN_USE", message: "An admin account with that email already exists." } });
      return;
    }
    const temporaryPassword = generateTempPassword();
    const [created] = await db
      .insert(adminUsersTable)
      .values({
        email,
        displayName: parsed.data.displayName.trim(),
        role,
        companyScope,
        passwordHash: hashPassword(temporaryPassword),
        mustChangePassword: true,
      })
      .returning();
    await writeAudit({
      actor: admin.user.email,
      actorRole: admin.role,
      action: "ADMIN_USER_CREATED",
      entityType: "ADMIN_USER",
      entityId: created!.id,
      afterValue: JSON.stringify({
        email: created!.email,
        displayName: created!.displayName,
        role: created!.role,
        companyScope: created!.companyScope,
      }),
      sourceIp: req.ip ?? null,
      companyCode: created!.companyScope,
    });
    res.json({ user: adminUserJson(created!), temporaryPassword });
  },
);

router.patch(
  "/v1/admin/users/:id",
  requireAdmin,
  requirePermission("ADMIN_USER_MANAGE"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const parsed = UpdateAdminUserBody.safeParse(req.body);
    const id = paramId(req, "id");
    if (!parsed.success) {
      res.status(400).json({ error: { code: "INVALID_INPUT", message: "Check the form and try again." } });
      return;
    }
    const notFoundUser = () => res.status(404).json({ error: { code: "NOT_FOUND", message: "Admin user not found." } });
    if (!UUID_RE.test(id)) {
      notFoundUser();
      return;
    }
    const [target] = await db.select().from(adminUsersTable).where(eq(adminUsersTable.id, id));
    if (!target || !userInScope(admin, target)) {
      notFoundUser();
      return;
    }
    // Guards both directions: acting ON a super admin, and promoting anyone INTO the role.
    if (!guardPlatformTarget(admin.role, [target.role, parsed.data.role], res)) return;
    const isSuper = hasPermission(admin.role, "PLATFORM_MANAGE");
    if (!isSuper && target.id !== admin.user.id && !COMPANY_GRANTABLE_ROLES.includes(target.role as AdminRole)) {
      res.status(403).json({
        error: { code: "ROLE_NOT_GRANTABLE", message: "You can manage client admins and HR administrators only." },
      });
      return;
    }
    const changes: Partial<typeof adminUsersTable.$inferInsert> = {};
    if (parsed.data.displayName !== undefined) changes.displayName = parsed.data.displayName.trim();
    if (parsed.data.role !== undefined) changes.role = parsed.data.role;
    if (parsed.data.companyScope !== undefined) changes.companyScope = parsed.data.companyScope?.trim() || null;
    if (parsed.data.active !== undefined) changes.active = parsed.data.active;

    // Self-lockout guards: you cannot deactivate yourself, and you cannot change
    // your own role or scope at all (blocking every self-change also stops
    // self-promotion, which would bypass the checks below).
    if (target.id === admin.user.id) {
      if (changes.active === false) {
        res.status(400).json({ error: { code: "SELF_LOCKOUT", message: "You cannot deactivate your own account." } });
        return;
      }
      if (
        (changes.role !== undefined && changes.role !== target.role) ||
        (changes.companyScope !== undefined && changes.companyScope !== target.companyScope)
      ) {
        res.status(400).json({ error: { code: "SELF_LOCKOUT", message: "You cannot change your own role or scope. Ask another administrator." } });
        return;
      }
    }
    const roleOrScopeChanges = changes.role !== undefined || changes.companyScope !== undefined;
    if (roleOrScopeChanges) {
      const finalRole = (changes.role ?? target.role) as AdminRole;
      const kind = scopeKindForRole(finalRole);
      // A role change drops the scope the new role cannot hold, unless one is given.
      const finalCompany =
        changes.companyScope !== undefined ? changes.companyScope : kind === "COMPANY" ? target.companyScope : null;
      if (!(await checkGrant(admin, finalRole, finalCompany ?? null, res))) return;
      changes.companyScope = finalCompany ?? null;
    }
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(changes)) {
      if ((target as never as Record<string, unknown>)[key] !== value) {
        before[key] = (target as never as Record<string, unknown>)[key];
        after[key] = value;
      }
    }
    let updated = target;
    if (Object.keys(after).length) {
      try {
        // Atomic update: enforces the lockout invariants inside a transaction
        // with row locks, so concurrent changes cannot break them.
        const result = await applyAdminUserChanges(target.id, changes);
        if (!result) {
          notFoundUser();
          return;
        }
        updated = result;
      } catch (err) {
        if (err instanceof LastAdminManagerError) {
          res.status(400).json({ error: { code: "LAST_ADMIN_MANAGER", message: err.message } });
          return;
        }
        if (err instanceof LastPlatformAdminError) {
          res.status(409).json({ error: { code: "LAST_SUPER_ADMIN", message: err.message } });
          return;
        }
        if (err instanceof LastClientAdminError) {
          res.status(409).json({ error: { code: "LAST_CLIENT_ADMIN", message: err.message } });
          return;
        }
        throw err;
      }
    }
    await writeAudit({
      actor: admin.user.email,
      actorRole: admin.role,
      action:
        changes.active === false
          ? "ADMIN_USER_DEACTIVATED"
          : changes.active === true && !target.active
            ? "ADMIN_USER_REACTIVATED"
            : "ADMIN_USER_UPDATED",
      entityType: "ADMIN_USER",
      entityId: target.id,
      beforeValue: JSON.stringify(before),
      afterValue: JSON.stringify(after),
      sourceIp: req.ip ?? null,
      companyCode: updated.companyScope,
    });
    res.json(adminUserJson(updated));
  },
);

router.post(
  "/v1/admin/users/:id/reset-password",
  requireAdmin,
  requirePermission("ADMIN_USER_MANAGE"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const id = paramId(req, "id");
    const notFoundUser = () => res.status(404).json({ error: { code: "NOT_FOUND", message: "Admin user not found." } });
    if (!UUID_RE.test(id)) {
      notFoundUser();
      return;
    }
    const [target] = await db.select().from(adminUsersTable).where(eq(adminUsersTable.id, id));
    if (!target || !userInScope(admin, target)) {
      notFoundUser();
      return;
    }
    // Without this, ADMIN_USER_MANAGE alone would let a client admin mint a
    // temporary password for a super admin and take the account over.
    if (!guardPlatformTarget(admin.role, [target.role], res)) return;
    if (
      !hasPermission(admin.role, "PLATFORM_MANAGE") &&
      target.id !== admin.user.id &&
      !COMPANY_GRANTABLE_ROLES.includes(target.role as AdminRole)
    ) {
      res.status(403).json({
        error: { code: "ROLE_NOT_GRANTABLE", message: "You can manage client admins and HR administrators only." },
      });
      return;
    }
    const temporaryPassword = generateTempPassword();
    await db
      .update(adminUsersTable)
      .set({ passwordHash: hashPassword(temporaryPassword), mustChangePassword: true })
      .where(eq(adminUsersTable.id, target.id));
    await writeAudit({
      actor: admin.user.email,
      actorRole: admin.role,
      action: "ADMIN_USER_PASSWORD_RESET",
      entityType: "ADMIN_USER",
      entityId: target.id,
      sourceIp: req.ip ?? null,
      companyCode: target.companyScope,
    });
    res.json({ temporaryPassword });
  },
);


router.post(
  "/v1/admin/users/me/password",
  requireAdmin,
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const parsed = ChangeOwnAdminPasswordBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "INVALID_INPUT", message: "The new password must be at least 8 characters." } });
      return;
    }
    if (!verifyPassword(parsed.data.currentPassword, admin.user.passwordHash)) {
      res.status(400).json({ error: { code: "WRONG_PASSWORD", message: "Your current password is not correct." } });
      return;
    }
    await db
      .update(adminUsersTable)
      .set({ passwordHash: hashPassword(parsed.data.newPassword), mustChangePassword: false })
      .where(eq(adminUsersTable.id, admin.user.id));
    await writeAudit({
      actor: admin.user.email,
      actorRole: admin.role,
      action: "ADMIN_PASSWORD_CHANGED",
      entityType: "ADMIN_USER",
      entityId: admin.user.id,
      sourceIp: req.ip ?? null,
      companyCode: admin.user.companyScope,
    });
    res.json({ ok: true });
  },
);

router.get(
  "/v1/admin/permissions",
  requireAdmin,
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const matrix = buildPermissionMatrix(admin.role);
    // The full cross-role matrix is a map of the authorisation model, so it is
    // PLATFORM_MANAGE only. Everyone else still gets their own column — that is
    // the useful part, and hiding it would only puzzle people.
    if (hasPermission(admin.role, "PLATFORM_MANAGE")) {
      res.json(matrix);
      return;
    }
    res.json({
      ...matrix,
      roles: [admin.role],
      rows: matrix.rows.map((row) => ({
        ...row,
        grants: { [admin.role]: row.grants[admin.role] ?? "none" },
      })),
    });
  },
);

export default router;
