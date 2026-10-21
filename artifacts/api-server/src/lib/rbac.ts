export const PERMISSIONS = [
  "MEMBER_READ_SCOPED",
  "MEMBER_READ_ALL",
  "MEMBER_CREATE",
  "MEMBER_UPDATE",
  "DEPENDENT_UPDATE",
  "BENEFICIARY_MANAGE",
  "POLICY_MANAGE",
  "MEMBER_DELETE",
  "MEMBER_REACTIVATE",
  "MEMBER_IMPORT",
  "CONTACT_UNMASK",
  "AUDIT_READ",
  "VERIFICATION_READ",
  "SESSION_MANAGE",
  "CHANGE_REQUEST_REVIEW",
  "ADMIN_USER_READ",
  "ADMIN_USER_MANAGE",
  "PLATFORM_MANAGE",
  "CLASS_MANAGE",
  "RATE_MANAGE",
  "BILLING_MANAGE",
  "BILLING_READ",
  "CARD_READ_OWN",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Stored role values. They are unchanged from before the shared BHI model, so
 * existing sessions and audit rows stay valid; only the labels changed — see
 * ROLE_LABELS and specs/002-per-company-schema/research.md R8.
 */
export type AdminRole =
  | "ROLE_PLATFORM_ADMIN"
  | "ROLE_CLIENT_ADMIN"
  | "ROLE_HR_ADMIN"
  | "ROLE_SUPPORT"
  | "ROLE_AUDITOR";

export type AnyRole = AdminRole | "ROLE_EMPLOYEE";

/**
 * What an HR administrator may do, within its one company. POLICY_MANAGE is
 * deliberately absent: one policy applies to the whole platform, so only a
 * super admin may add or edit it.
 */
const HR_PERMISSIONS: Permission[] = [
  "MEMBER_READ_SCOPED",
  "MEMBER_CREATE",
  "MEMBER_UPDATE",
  "DEPENDENT_UPDATE",
  "BENEFICIARY_MANAGE",
  "MEMBER_DELETE",
  "MEMBER_REACTIVATE",
  "MEMBER_IMPORT",
  "CONTACT_UNMASK",
  "AUDIT_READ",
  "VERIFICATION_READ",
  "SESSION_MANAGE",
  "CHANGE_REQUEST_REVIEW",
];

/**
 * A client admin: an HR administrator who also manages its own company's users
 * and sees its bills (spec FR-018). NALICO issues one per client at onboarding.
 */
const CLIENT_ADMIN_PERMISSIONS: Permission[] = [
  ...HR_PERMISSIONS,
  "ADMIN_USER_READ",
  "ADMIN_USER_MANAGE",
  "BILLING_READ",
];

export const ROLE_PERMISSIONS: Record<AnyRole, Permission[]> = {
  // Computed rather than listed, so "superset of every admin role" stays true
  // as permissions are added. CARD_READ_OWN is the employee's own-card grant
  // and is meaningless for an admin account.
  ROLE_PLATFORM_ADMIN: PERMISSIONS.filter((p) => p !== "CARD_READ_OWN"),
  ROLE_CLIENT_ADMIN: [...CLIENT_ADMIN_PERMISSIONS],
  ROLE_HR_ADMIN: [...HR_PERMISSIONS],
  ROLE_SUPPORT: [
    "MEMBER_READ_SCOPED",
    "MEMBER_READ_ALL",
    "VERIFICATION_READ",
    // Support fields the "I'm locked out" calls, so it can clear a lockout and
    // revoke a lost device without being able to change member data.
    "SESSION_MANAGE",
  ],
  ROLE_AUDITOR: ["AUDIT_READ", "VERIFICATION_READ", "BILLING_READ"],
  ROLE_EMPLOYEE: ["CARD_READ_OWN"],
};

/** Every admin role, most privileged first. Excludes the employee pseudo-role. */
export const ADMIN_ROLES: AdminRole[] = [
  "ROLE_PLATFORM_ADMIN",
  "ROLE_CLIENT_ADMIN",
  "ROLE_HR_ADMIN",
  "ROLE_SUPPORT",
  "ROLE_AUDITOR",
];

/** What the portal shows for each stored role value (spec FR-012 to FR-014). */
export const ROLE_LABELS: Record<AdminRole, string> = {
  ROLE_PLATFORM_ADMIN: "Super admin",
  ROLE_CLIENT_ADMIN: "Client admin",
  ROLE_HR_ADMIN: "HR administrator",
  ROLE_SUPPORT: "Support",
  ROLE_AUDITOR: "Auditor",
};

/**
 * Which companies a role reaches (research R8):
 *   ALL      every company — super admin, support, auditor
 *   COMPANY  its admin_users.company_scope only — client admin, HR administrator
 *
 * There is no level between the two: the group admin role and client groups
 * were removed on 2026-09-29. Every company has its own client admin.
 */
export type ScopeKind = "ALL" | "COMPANY";

export function scopeKindForRole(role: AdminRole): ScopeKind {
  switch (role) {
    case "ROLE_PLATFORM_ADMIN":
    case "ROLE_SUPPORT":
    case "ROLE_AUDITOR":
      return "ALL";
    case "ROLE_CLIENT_ADMIN":
    case "ROLE_HR_ADMIN":
      return "COMPANY";
  }
}

/** Roles that may read every company but change nothing (spec FR-014). */
export const READ_ONLY_ROLES: AdminRole[] = ["ROLE_SUPPORT", "ROLE_AUDITOR"];

export function isReadOnlyRole(role: string): boolean {
  return (READ_ONLY_ROLES as string[]).includes(role);
}

/**
 * The roles a client admin may grant: company-scoped ones only, in its own
 * company (spec FR-018). Every other role is granted by a super admin alone.
 */
export const COMPANY_GRANTABLE_ROLES: AdminRole[] = ["ROLE_CLIENT_ADMIN", "ROLE_HR_ADMIN"];

/** Which admin roles hold a permission. Derived, so it cannot drift. */
export function rolesWithPermission(permission: Permission): AdminRole[] {
  return ADMIN_ROLES.filter((role) => hasPermission(role, permission));
}

/**
 * Roles that must carry a second factor. These are the accounts that can reach
 * every company's data or grant privilege to others.
 */
export const MFA_REQUIRED_ROLES: AdminRole[] = ["ROLE_PLATFORM_ADMIN"];

export function requiresMfa(role: string): boolean {
  return (MFA_REQUIRED_ROLES as string[]).includes(role);
}

export function permissionsForRole(role: AnyRole): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function hasPermission(role: AnyRole, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  MEMBER_READ_SCOPED: "View member records within the assigned company scope",
  MEMBER_READ_ALL: "View member records across all companies",
  MEMBER_CREATE: "Create a new member record by hand (reason required)",
  MEMBER_UPDATE: "Edit member contact and employment details (reason required)",
  DEPENDENT_UPDATE: "Edit dependent records (reason required)",
  BENEFICIARY_MANAGE: "Add, edit, and remove payout beneficiaries (reason required)",
  POLICY_MANAGE: "Create and edit policy details; super admin only (reason required)",
  MEMBER_DELETE:
    "Remove a member from the members list, revoking card access (reason required). The record is retained for audit and can be restored",
  // Still covers ARCHIVED as well as REMOVED. Archiving was withdrawn as an
  // action, but rows that predate that keep the status, and stranding them with
  // no way back would be the one unrecoverable consequence of the withdrawal.
  MEMBER_REACTIVATE: "Reactivate a removed member, or one archived before archiving was withdrawn (reason required)",
  MEMBER_IMPORT: "Bulk import members from CSV with dry-run preview",
  CONTACT_UNMASK: "See full email addresses and phone numbers",
  AUDIT_READ: "Read the append-only audit trail",
  VERIFICATION_READ: "Read verification session history",
  SESSION_MANAGE:
    "Clear a verification lockout and revoke a member's card sessions (reason required)",
  CHANGE_REQUEST_REVIEW:
    "Review employee-submitted change requests and their supporting documents, and approve or reject them",
  ADMIN_USER_READ: "View the admin user directory",
  ADMIN_USER_MANAGE:
    "Invite, deactivate, and change roles or company scope of admin users",
  PLATFORM_MANAGE:
    "Onboard and offboard companies, view the full permission matrix, and assign or act on super admin accounts",
  CLASS_MANAGE: "Add, rename, retire and reactivate the classes shared by every company (reason required)",
  RATE_MANAGE:
    "Add standard and company-specific premium rates and company billing rules; rates used by a finalised bill cannot be changed",
  BILLING_MANAGE: "Generate, recalculate and finalise monthly billing runs",
  BILLING_READ: "View and export billing runs within the assigned scope",
  CARD_READ_OWN: "Retrieve one's own digital health card after OTP verification",
};

type Grant = "full" | "scoped" | "masked" | "none";

const MATRIX_ROLES: AnyRole[] = [...ADMIN_ROLES, "ROLE_EMPLOYEE"];

function grantFor(role: AnyRole, permission: Permission): Grant {
  if (!hasPermission(role, permission)) return "none";
  // Company-scoped roles hold every grant within their own company only.
  if (role === "ROLE_HR_ADMIN" || role === "ROLE_CLIENT_ADMIN") {
    return "scoped";
  }
  if (role === "ROLE_SUPPORT" && (permission === "MEMBER_READ_SCOPED" || permission === "MEMBER_READ_ALL")) {
    return "masked";
  }
  return "full";
}

export function buildPermissionMatrix(currentRole: AnyRole) {
  return {
    roles: MATRIX_ROLES,
    currentRole,
    currentPermissions: permissionsForRole(currentRole),
    rows: PERMISSIONS.map((permission) => ({
      permission,
      description: PERMISSION_DESCRIPTIONS[permission],
      grants: Object.fromEntries(
        MATRIX_ROLES.map((role) => [role, grantFor(role, permission)]),
      ),
    })),
  };
}
