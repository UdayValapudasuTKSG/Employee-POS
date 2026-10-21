/**
 * Lockout invariants for admin user changes. Pure predicates so they can be
 * unit-tested without a database; adminUserUpdate.ts applies them inside the
 * transaction that holds the relevant rows locked.
 *
 * Two separate invariants, because they protect two different things:
 *
 *   1. At least one active account must hold ADMIN_USER_MANAGE, or nobody can
 *      ever administer admin users again.
 *   2. At least one active ROLE_PLATFORM_ADMIN must remain. PLATFORM_MANAGE is
 *      only obtainable from a platform admin, and bootstrapProductionAdmin()
 *      returns early once any admin row exists — so losing the last one is
 *      unrecoverable without direct database access.
 */

import { requiresMfa } from "./rbac";

export interface AdminGuardTarget {
  role: string;
  active: boolean;
}

export interface AdminGuardChanges {
  role?: string;
  active?: boolean;
}

/** True when `changes` take the target out of the given role, or deactivate it. */
function leavesRole(
  target: AdminGuardTarget,
  changes: AdminGuardChanges,
  role: string,
): boolean {
  if (target.role !== role || !target.active) return false;
  const demoted = changes.role !== undefined && changes.role !== role;
  const deactivated = changes.active === false;
  return demoted || deactivated;
}

/**
 * Returns true when applying `changes` would remove the last active account
 * holding ADMIN_USER_MANAGE, given how many such accounts are currently active.
 *
 * `activeManagerCount` must be counted over every role holding the permission
 * (see rolesWithPermission), not just one role literal.
 */
export function wouldRemoveLastAdminManager(
  target: AdminGuardTarget,
  changes: AdminGuardChanges,
  activeManagerCount: number,
  managerRoles: readonly string[],
): boolean {
  if (!managerRoles.includes(target.role) || !target.active) return false;

  const stillManager =
    changes.role !== undefined ? managerRoles.includes(changes.role) : true;
  const deactivated = changes.active === false;
  if (stillManager && !deactivated) return false;

  return activeManagerCount <= 1;
}

/**
 * Returns true when applying `changes` would remove the last active platform
 * administrator.
 */
export function wouldRemoveLastPlatformAdmin(
  target: AdminGuardTarget,
  changes: AdminGuardChanges,
  activePlatformAdminCount: number,
): boolean {
  if (!leavesRole(target, changes, "ROLE_PLATFORM_ADMIN")) return false;
  return activePlatformAdminCount <= 1;
}

export interface ClientAdminGuardTarget extends AdminGuardTarget {
  companyScope: string | null;
}

export interface ClientAdminGuardChanges extends AdminGuardChanges {
  companyScope?: string | null;
}

/**
 * Returns true when applying `changes` would leave a company with no active
 * client admin (spec FR-018): NALICO issues one per client, and without one
 * the company can no longer manage its own users.
 *
 * `activeClientAdminsInCompany` counts active ROLE_CLIENT_ADMIN accounts of the
 * target's own company. Moving the admin to another company counts as leaving.
 */
export function wouldRemoveLastClientAdmin(
  target: ClientAdminGuardTarget,
  changes: ClientAdminGuardChanges,
  activeClientAdminsInCompany: number,
): boolean {
  if (target.role !== "ROLE_CLIENT_ADMIN" || !target.active || !target.companyScope) return false;
  const demoted = changes.role !== undefined && changes.role !== "ROLE_CLIENT_ADMIN";
  const deactivated = changes.active === false;
  const moved = changes.companyScope !== undefined && changes.companyScope !== target.companyScope;
  if (!demoted && !deactivated && !moved) return false;
  return activeClientAdminsInCompany <= 1;
}

/**
 * True when a change moves an account into a role that mandates MFA. The caller
 * uses this to warn: the target's live session is invalidated and they must
 * enrol before they can act again.
 */
export function movesIntoMfaRequiredRole(
  target: AdminGuardTarget,
  changes: AdminGuardChanges,
): boolean {
  if (changes.role === undefined || changes.role === target.role) return false;
  return requiresMfa(changes.role) && !requiresMfa(target.role);
}
