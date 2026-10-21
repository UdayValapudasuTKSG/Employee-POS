import { and, eq, inArray } from "drizzle-orm";
import { db, adminUsersTable, type AdminUser } from "@workspace/db";
import { rolesWithPermission } from "./rbac";
import {
  wouldRemoveLastAdminManager,
  wouldRemoveLastClientAdmin,
  wouldRemoveLastPlatformAdmin,
} from "./lastAdmin";

/** Thrown when an update would leave nobody able to administer admin users. */
export class LastAdminManagerError extends Error {
  constructor() {
    super(
      "This is the last active account that can manage admin users. Promote or activate another administrator before demoting or deactivating this account.",
    );
    this.name = "LastAdminManagerError";
  }
}

/** Thrown when an update would remove the last active super admin. */
export class LastPlatformAdminError extends Error {
  constructor() {
    super(
      "This is the last active super admin. Make another account a super admin before demoting or deactivating this one.",
    );
    this.name = "LastPlatformAdminError";
  }
}

/** Thrown when an update would leave a company without an active client admin. */
export class LastClientAdminError extends Error {
  constructor(companyNumber: string) {
    super(
      `This is the last active client admin of ${companyNumber}. Make another of its users a client admin before demoting, moving or deactivating this one.`,
    );
    this.name = "LastClientAdminError";
  }
}

/** Roles that can administer admin users. Derived, so adding a role cannot drift. */
const MANAGER_ROLES = rolesWithPermission("ADMIN_USER_MANAGE");

/**
 * Applies changes to an admin user atomically, enforcing the lockout
 * invariants inside a single transaction:
 *   - someone can still manage admin users;
 *   - at least one super admin remains;
 *   - the target's company keeps at least one active client admin.
 *
 * Every active account that can manage admin users is locked FOR UPDATE before
 * counting, which serializes concurrent demotions/deactivations: whichever
 * transaction commits second re-reads the surviving set and is rejected if it
 * would break an invariant. The super admin and client admin counts come from
 * the same locked row set, so they are serialized identically.
 */
export async function applyAdminUserChanges(
  targetId: string,
  changes: Partial<typeof adminUsersTable.$inferInsert>,
): Promise<AdminUser | null> {
  return db.transaction(async (tx) => {
    // One locked read serving every count.
    const activeManagers = await tx
      .select({ id: adminUsersTable.id, role: adminUsersTable.role, companyScope: adminUsersTable.companyScope })
      .from(adminUsersTable)
      .where(and(inArray(adminUsersTable.role, MANAGER_ROLES), eq(adminUsersTable.active, true)))
      .for("update");
    const activePlatformAdmins = activeManagers.filter((a) => a.role === "ROLE_PLATFORM_ADMIN");

    const [target] = await tx
      .select()
      .from(adminUsersTable)
      .where(eq(adminUsersTable.id, targetId))
      .for("update");
    if (!target) return null;

    if (wouldRemoveLastAdminManager(target, changes, activeManagers.length, MANAGER_ROLES)) {
      throw new LastAdminManagerError();
    }
    if (wouldRemoveLastPlatformAdmin(target, changes, activePlatformAdmins.length)) {
      throw new LastPlatformAdminError();
    }
    const clientAdminsOfCompany = activeManagers.filter(
      (a) => a.role === "ROLE_CLIENT_ADMIN" && a.companyScope === target.companyScope,
    ).length;
    if (wouldRemoveLastClientAdmin(target, changes, clientAdminsOfCompany)) {
      throw new LastClientAdminError(target.companyScope!);
    }

    const [updated] = await tx
      .update(adminUsersTable)
      .set(changes)
      .where(eq(adminUsersTable.id, target.id))
      .returning();
    return updated ?? null;
  });
}
