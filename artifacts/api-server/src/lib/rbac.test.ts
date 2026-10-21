import { describe, expect, it } from "vitest";
import {
  ADMIN_ROLES,
  COMPANY_GRANTABLE_ROLES,
  MFA_REQUIRED_ROLES,
  PERMISSIONS,
  READ_ONLY_ROLES,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  buildPermissionMatrix,
  hasPermission,
  isReadOnlyRole,
  permissionsForRole,
  requiresMfa,
  rolesWithPermission,
  scopeKindForRole,
  type AdminRole,
  type AnyRole,
  type Permission,
  type ScopeKind,
} from "./rbac";

/**
 * These assertions are driven off ADMIN_ROLES rather than hardcoded role lists.
 * A hardcoded list silently passes when a new role is added — which is exactly
 * how "only one role holds ADMIN_USER_MANAGE" stayed green after the platform
 * admin gained it.
 */
function rolesWithout(permission: Permission): AnyRole[] {
  return [...ADMIN_ROLES, "ROLE_EMPLOYEE" as const].filter(
    (role) => !hasPermission(role, permission),
  );
}

describe("rbac permission matrix", () => {
  it("only maps known permissions in each role", () => {
    for (const perms of Object.values(ROLE_PERMISSIONS)) {
      for (const p of perms) expect(PERMISSIONS).toContain(p);
    }
  });

  it("returns an empty list for unknown roles", () => {
    expect(permissionsForRole("ROLE_NOPE" as AnyRole)).toEqual([]);
  });

  it("keeps the employee role limited to their own card", () => {
    expect(permissionsForRole("ROLE_EMPLOYEE")).toEqual(["CARD_READ_OWN"]);
  });

  it("gives no admin role the employee's own-card grant", () => {
    for (const role of ADMIN_ROLES) {
      expect(hasPermission(role, "CARD_READ_OWN"), role).toBe(false);
    }
  });

  it("builds a matrix row for every permission with a description", () => {
    const matrix = buildPermissionMatrix("ROLE_CLIENT_ADMIN");
    expect(matrix.rows).toHaveLength(PERMISSIONS.length);
    for (const row of matrix.rows) {
      expect(row.description.length, row.permission).toBeGreaterThan(10);
    }
  });

  it("has one matrix column per admin role plus the employee", () => {
    const matrix = buildPermissionMatrix("ROLE_PLATFORM_ADMIN");
    expect(matrix.roles).toEqual([...ADMIN_ROLES, "ROLE_EMPLOYEE"]);
  });
});

describe("admin user management", () => {
  it("is held by the super admin and client admins only", () => {
    // Client admins manage their own company's users (spec FR-018); which
    // users and which roles they may grant is checked against their scope in
    // lib/adminUserUpdate.ts, not by the permission.
    for (const permission of ["ADMIN_USER_MANAGE", "ADMIN_USER_READ"] as Permission[]) {
      expect(rolesWithPermission(permission).sort()).toEqual(
        ["ROLE_PLATFORM_ADMIN", "ROLE_CLIENT_ADMIN"].sort(),
      );
    }
  });

  it("lets client admins grant only company-scoped roles", () => {
    expect([...COMPANY_GRANTABLE_ROLES].sort()).toEqual(["ROLE_CLIENT_ADMIN", "ROLE_HR_ADMIN"].sort());
  });

  it("leaves the platform admin able to manage admin users", () => {
    // PLATFORM_MANAGE deliberately does NOT replace ADMIN_USER_MANAGE — doing so
    // would strip the client admin of the ability to invite HR admins.
    expect(hasPermission("ROLE_CLIENT_ADMIN", "ADMIN_USER_MANAGE")).toBe(true);
    expect(hasPermission("ROLE_PLATFORM_ADMIN", "ADMIN_USER_MANAGE")).toBe(true);
  });
});

describe("ROLE_PLATFORM_ADMIN", () => {
  it("is a strict superset of every other admin role", () => {
    const platform = new Set(permissionsForRole("ROLE_PLATFORM_ADMIN"));
    for (const role of ADMIN_ROLES.filter((r) => r !== "ROLE_PLATFORM_ADMIN")) {
      for (const permission of permissionsForRole(role)) {
        expect(platform.has(permission), `${role} has ${permission}, platform admin does not`)
          .toBe(true);
      }
      expect(platform.size).toBeGreaterThan(permissionsForRole(role).length);
    }
  });

  it("holds PLATFORM_MANAGE alone", () => {
    expect(rolesWithPermission("PLATFORM_MANAGE")).toEqual(["ROLE_PLATFORM_ADMIN"]);
    // The client admin must NOT be able to grant itself the superset role.
    expect(hasPermission("ROLE_CLIENT_ADMIN", "PLATFORM_MANAGE")).toBe(false);
  });

  it("picks up new permissions automatically", () => {
    // The entry is computed from PERMISSIONS, so a permission added later
    // cannot be accidentally withheld from the platform admin.
    for (const permission of PERMISSIONS) {
      if (permission === "CARD_READ_OWN") continue;
      expect(hasPermission("ROLE_PLATFORM_ADMIN", permission), permission).toBe(true);
    }
  });
});

describe("new operational permissions", () => {
  it("keeps the auditor read-only", () => {
    // The auditor holds VERIFICATION_READ, so the lockout reset had to hang off
    // a separate permission or an auditor could mutate a session.
    expect(hasPermission("ROLE_AUDITOR", "VERIFICATION_READ")).toBe(true);
    for (const permission of [
      "SESSION_MANAGE",
      "MEMBER_CREATE",
      "MEMBER_UPDATE",
      "POLICY_MANAGE",
      "CHANGE_REQUEST_REVIEW",
    ] as Permission[]) {
      expect(hasPermission("ROLE_AUDITOR", permission), permission).toBe(false);
    }
  });

  it("lets support clear a lockout but not change member data", () => {
    expect(hasPermission("ROLE_SUPPORT", "SESSION_MANAGE")).toBe(true);
    for (const permission of [
      "MEMBER_CREATE",
      "MEMBER_UPDATE",
      "POLICY_MANAGE",
      "CHANGE_REQUEST_REVIEW",
      "CONTACT_UNMASK",
    ] as Permission[]) {
      expect(hasPermission("ROLE_SUPPORT", permission), permission).toBe(false);
    }
  });

  it("grants the member-mutating permissions to HR roles only", () => {
    for (const permission of [
      "MEMBER_CREATE",
      "MEMBER_DELETE",
      "CHANGE_REQUEST_REVIEW",
    ] as Permission[]) {
      expect(rolesWithPermission(permission).sort(), permission).toEqual(
        ["ROLE_HR_ADMIN", "ROLE_CLIENT_ADMIN", "ROLE_PLATFORM_ADMIN"].sort(),
      );
      expect(rolesWithout(permission)).toContain("ROLE_EMPLOYEE");
    }
  });

  it("grants POLICY_MANAGE to the super admin only", () => {
    // One policy applies to the whole platform, so no company-scoped role may
    // add or edit it.
    expect(rolesWithPermission("POLICY_MANAGE")).toEqual(["ROLE_PLATFORM_ADMIN"]);
    expect(rolesWithout("POLICY_MANAGE")).toContain("ROLE_EMPLOYEE");
  });

  it("separates MEMBER_DELETE from MEMBER_UPDATE and withholds it from read-only roles", () => {
    // Taking a member off the roster ends their cover; editing their phone
    // number does not. Separable risk, separable grant — and neither belongs to
    // the roles that may only read.
    expect(PERMISSIONS).toContain("MEMBER_DELETE");
    for (const role of ["ROLE_SUPPORT", "ROLE_AUDITOR", "ROLE_EMPLOYEE"] as AnyRole[]) {
      expect(hasPermission(role, "MEMBER_DELETE"), role).toBe(false);
    }
  });

  it("no longer grants MEMBER_ARCHIVE to anybody", () => {
    // Archiving was withdrawn as an action: the route, the permission and the
    // button are all gone, leaving MEMBER_DELETE as the only way to take a
    // member off cover. The ARCHIVED status survives for rows that predate the
    // withdrawal, but no role may create another.
    expect(PERMISSIONS).not.toContain("MEMBER_ARCHIVE" as Permission);
    for (const role of [...ADMIN_ROLES, "ROLE_EMPLOYEE" as const]) {
      expect(permissionsForRole(role), role).not.toContain("MEMBER_ARCHIVE" as Permission);
    }
  });

  it("separates MEMBER_CREATE from MEMBER_UPDATE", () => {
    // Creating a member manufactures an identity that can complete OTP and read
    // company data; editing one does not. Separable risk, separable grant.
    expect(PERMISSIONS).toContain("MEMBER_CREATE");
    expect(PERMISSIONS).toContain("MEMBER_UPDATE");
  });
});

describe("MFA helpers", () => {
  it("requires MFA for the super admin alone", () => {
    expect(MFA_REQUIRED_ROLES).toEqual(["ROLE_PLATFORM_ADMIN"]);
    for (const role of MFA_REQUIRED_ROLES) expect(requiresMfa(role)).toBe(true);
    for (const role of ["ROLE_HR_ADMIN", "ROLE_SUPPORT", "ROLE_AUDITOR"] as AdminRole[]) {
      expect(requiresMfa(role), role).toBe(false);
    }
    expect(requiresMfa("ROLE_NOPE")).toBe(false);
  });

  it("keeps the client admin out of the second-factor list", () => {
    expect(requiresMfa("ROLE_CLIENT_ADMIN")).toBe(false);
  });

  it("derives rolesWithPermission from the live grant table", () => {
    for (const role of rolesWithPermission("MEMBER_IMPORT")) {
      expect(permissionsForRole(role)).toContain("MEMBER_IMPORT");
    }
    expect(rolesWithPermission("MEMBER_IMPORT")).not.toContain("ROLE_AUDITOR");
  });
});

describe("shared BHI model: scopes, labels and the new permissions", () => {
  it("maps every admin role to the companies it reaches", () => {
    const expected: Record<AdminRole, ScopeKind> = {
      ROLE_PLATFORM_ADMIN: "ALL",
      ROLE_SUPPORT: "ALL",
      ROLE_AUDITOR: "ALL",
      ROLE_CLIENT_ADMIN: "COMPANY",
      ROLE_HR_ADMIN: "COMPANY",
    };
    for (const role of ADMIN_ROLES) expect(scopeKindForRole(role), role).toBe(expected[role]);
  });

  it("marks exactly support and auditor read-only", () => {
    expect([...READ_ONLY_ROLES].sort()).toEqual(["ROLE_AUDITOR", "ROLE_SUPPORT"]);
    for (const role of READ_ONLY_ROLES) expect(isReadOnlyRole(role)).toBe(true);
    for (const role of ADMIN_ROLES.filter((r) => !READ_ONLY_ROLES.includes(r))) {
      expect(isReadOnlyRole(role), role).toBe(false);
    }
  });

  it("labels every admin role, and the platform admin as Super admin", () => {
    for (const role of ADMIN_ROLES) expect(ROLE_LABELS[role], role).toBeTruthy();
    expect(ROLE_LABELS.ROLE_PLATFORM_ADMIN).toBe("Super admin");
  });

  it("keeps class, rate and billing management with the super admin alone", () => {
    for (const permission of ["CLASS_MANAGE", "RATE_MANAGE", "BILLING_MANAGE"] as Permission[]) {
      expect(rolesWithPermission(permission), permission).toEqual(["ROLE_PLATFORM_ADMIN"]);
    }
  });

  it("lets the scoped admins and the auditor read bills, but not HR or support", () => {
    expect(rolesWithPermission("BILLING_READ").sort()).toEqual(
      ["ROLE_PLATFORM_ADMIN", "ROLE_CLIENT_ADMIN", "ROLE_AUDITOR"].sort(),
    );
  });

  it("has no role between one company and every company", () => {
    // The group admin role was removed (2026-09-29): the super admin is the only
    // role above a company that can change anything.
    expect(ADMIN_ROLES).not.toContain("ROLE_HR_GROUP_ADMIN" as AdminRole);
    for (const role of ADMIN_ROLES) expect(["ALL", "COMPANY"], role).toContain(scopeKindForRole(role));
    const allWritable = ADMIN_ROLES.filter((r) => scopeKindForRole(r) === "ALL" && !isReadOnlyRole(r));
    expect(allWritable).toEqual(["ROLE_PLATFORM_ADMIN"]);
  });

  it("gives the client admin no cross-company permission", () => {
    expect(hasPermission("ROLE_CLIENT_ADMIN", "MEMBER_READ_ALL")).toBe(false);
    expect(hasPermission("ROLE_CLIENT_ADMIN", "PLATFORM_MANAGE")).toBe(false);
  });
});
