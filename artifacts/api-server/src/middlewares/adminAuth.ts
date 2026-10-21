import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  adminUsersTable,
  bhiCompanyTable,
  withScope,
  type AdminUser,
  type Scope,
} from "@workspace/db";
import { verifyToken } from "../lib/auth";
import {
  hasPermission,
  isReadOnlyRole,
  scopeKindForRole,
  type AdminRole,
  type Permission,
} from "../lib/rbac";
import { writeAudit } from "../lib/audit";

export interface AdminContext {
  user: AdminUser;
  role: AdminRole;
  /**
   * The companies this admin reaches, and whether it may write. Every query on
   * the shared bhi tables runs inside withScope(admin.scope, …), so row-level
   * security enforces the same thing in the database (research R4).
   */
  scope: Scope;
}

declare global {
  namespace Express {
    interface Request {
      admin?: AdminContext;
    }
  }
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7);
}

/** Read-only, every company: used only to look up an admin's own scope. */
const SCOPE_LOOKUP: Scope = { all: true, readOnly: true };

/**
 * The companies an admin reaches (spec FR-010 to FR-014, research R8), or null
 * when the account cannot be given any scope and must not sign in: an HR
 * administrator or client admin without a company, or whose company is not an
 * active company.
 */
export async function resolveScope(user: AdminUser): Promise<Scope | null> {
  const role = user.role as AdminRole;
  const readOnly = isReadOnlyRole(role);
  switch (scopeKindForRole(role)) {
    case "ALL":
      return { all: true, readOnly };
    case "COMPANY": {
      const code = user.companyScope;
      if (!code) return null;
      const [company] = await withScope(SCOPE_LOOKUP, (tx) =>
        tx
          .select({ active: bhiCompanyTable.active })
          .from(bhiCompanyTable)
          .where(eq(bhiCompanyTable.companyNumber, code)),
      );
      if (!company?.active) return null;
      return { all: false, companies: [code], readOnly };
    }
  }
}

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = bearer(req);
  const payload = token ? verifyToken(token) : null;
  if (!payload || payload["kind"] !== "admin" || typeof payload["sub"] !== "string") {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } });
    return;
  }
  const [user] = await db
    .select()
    .from(adminUsersTable)
    .where(eq(adminUsersTable.id, payload["sub"]));
  if (!user || !user.active) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } });
    return;
  }
  const scope = await resolveScope(user);
  if (!scope) {
    // Same answer as a bad token: an account that has lost its company
    // (offboarded, or misconfigured) simply cannot sign in.
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } });
    return;
  }
  req.admin = {
    user,
    role: user.role as AdminRole,
    scope,
  };
  next();
}

/** Permission gate. Denials are audited as ACCESS_DENIED rows. */
export function requirePermission(permission: Permission) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const admin = req.admin;
    if (!admin) {
      res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } });
      return;
    }
    if (!hasPermission(admin.role, permission)) {
      await writeAudit({
        actor: admin.user.email,
        actorRole: admin.role,
        action: "ACCESS_DENIED",
        entityType: "PERMISSION",
        entityId: permission,
        sourceIp: req.ip ?? null,
        companyCode: admin.user.companyScope ?? null,
      });
      req.log.warn({ permission, role: admin.role }, "Access denied");
      res.status(403).json({
        error: {
          code: "FORBIDDEN",
          message: "You do not have permission to perform this action.",
        },
      });
      return;
    }
    next();
  };
}
