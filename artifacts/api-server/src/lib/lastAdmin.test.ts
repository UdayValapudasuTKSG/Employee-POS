import { describe, expect, it } from "vitest";
import {
  movesIntoMfaRequiredRole,
  wouldRemoveLastAdminManager,
  wouldRemoveLastClientAdmin,
  wouldRemoveLastPlatformAdmin,
} from "./lastAdmin";
import { rolesWithPermission } from "./rbac";

const MANAGERS = rolesWithPermission("ADMIN_USER_MANAGE");

const clientAdmin = { role: "ROLE_CLIENT_ADMIN", active: true };
const platformAdmin = { role: "ROLE_PLATFORM_ADMIN", active: true };

const lastManager = (target: typeof clientAdmin, changes: Record<string, unknown>, n: number) =>
  wouldRemoveLastAdminManager(target, changes, n, MANAGERS);

describe("wouldRemoveLastAdminManager", () => {
  it("blocks deactivating the last account that can manage admin users", () => {
    expect(lastManager(clientAdmin, { active: false }, 1)).toBe(true);
  });

  it("blocks demoting the last such account", () => {
    expect(lastManager(clientAdmin, { role: "ROLE_HR_ADMIN" }, 1)).toBe(true);
  });

  it("blocks demotion combined with deactivation", () => {
    expect(lastManager(clientAdmin, { role: "ROLE_SUPPORT", active: false }, 1)).toBe(true);
  });

  it("allows deactivation when another manager remains", () => {
    expect(lastManager(clientAdmin, { active: false }, 2)).toBe(false);
  });

  it("allows demotion when another manager remains", () => {
    expect(lastManager(clientAdmin, { role: "ROLE_HR_ADMIN" }, 2)).toBe(false);
  });

  it("counts the platform admin as a manager", () => {
    // A client admin may be demoted while a platform admin still holds
    // ADMIN_USER_MANAGE — the old role-literal check could not see this.
    expect(lastManager(platformAdmin, { active: false }, 1)).toBe(true);
    expect(lastManager(clientAdmin, { role: "ROLE_SUPPORT" }, 2)).toBe(false);
  });

  it("allows moving between two manager roles even as the only manager", () => {
    // Promoting the last client admin to platform admin keeps a manager, so it
    // must not be blocked.
    expect(lastManager(clientAdmin, { role: "ROLE_PLATFORM_ADMIN" }, 1)).toBe(false);
  });

  it("ignores no-op updates", () => {
    expect(lastManager(clientAdmin, {}, 1)).toBe(false);
    expect(lastManager(clientAdmin, { role: "ROLE_CLIENT_ADMIN" }, 1)).toBe(false);
    expect(lastManager(clientAdmin, { active: true }, 1)).toBe(false);
  });

  it("ignores targets that are not managers", () => {
    expect(lastManager({ role: "ROLE_HR_ADMIN", active: true }, { active: false }, 1)).toBe(
      false,
    );
  });

  it("ignores targets that are already inactive", () => {
    expect(
      lastManager({ role: "ROLE_CLIENT_ADMIN", active: false }, { role: "ROLE_SUPPORT" }, 1),
    ).toBe(false);
  });
});

describe("wouldRemoveLastPlatformAdmin", () => {
  it("blocks deactivating the last platform admin", () => {
    expect(wouldRemoveLastPlatformAdmin(platformAdmin, { active: false }, 1)).toBe(true);
  });

  it("blocks demoting the last platform admin, even to client admin", () => {
    // PLATFORM_MANAGE is only obtainable from a platform admin, so this is
    // unrecoverable without direct database access.
    expect(
      wouldRemoveLastPlatformAdmin(platformAdmin, { role: "ROLE_CLIENT_ADMIN" }, 1),
    ).toBe(true);
  });

  it("allows demotion when another platform admin remains", () => {
    expect(
      wouldRemoveLastPlatformAdmin(platformAdmin, { role: "ROLE_CLIENT_ADMIN" }, 2),
    ).toBe(false);
  });

  it("ignores targets that are not platform admins", () => {
    expect(wouldRemoveLastPlatformAdmin(clientAdmin, { active: false }, 1)).toBe(false);
  });

  it("ignores targets that are already inactive", () => {
    expect(
      wouldRemoveLastPlatformAdmin(
        { role: "ROLE_PLATFORM_ADMIN", active: false },
        { active: false },
        1,
      ),
    ).toBe(false);
  });

  it("ignores no-op updates", () => {
    expect(wouldRemoveLastPlatformAdmin(platformAdmin, {}, 1)).toBe(false);
    expect(
      wouldRemoveLastPlatformAdmin(platformAdmin, { role: "ROLE_PLATFORM_ADMIN" }, 1),
    ).toBe(false);
  });
});

describe("movesIntoMfaRequiredRole", () => {
  it("flags a promotion into a role that mandates MFA", () => {
    expect(
      movesIntoMfaRequiredRole({ role: "ROLE_HR_ADMIN", active: true }, {
        role: "ROLE_PLATFORM_ADMIN",
      }),
    ).toBe(true);
  });

  it("does not flag a super admin that stays one", () => {
    expect(movesIntoMfaRequiredRole(platformAdmin, { role: "ROLE_PLATFORM_ADMIN" })).toBe(false);
  });

  it("does not flag a demotion or a no-op", () => {
    expect(movesIntoMfaRequiredRole(clientAdmin, { role: "ROLE_SUPPORT" })).toBe(false);
    expect(movesIntoMfaRequiredRole(clientAdmin, {})).toBe(false);
    expect(movesIntoMfaRequiredRole(clientAdmin, { role: "ROLE_CLIENT_ADMIN" })).toBe(false);
  });
});

describe("wouldRemoveLastClientAdmin (FR-018)", () => {
  const client = { role: "ROLE_CLIENT_ADMIN", active: true, companyScope: "ST" };

  it("blocks deactivating, demoting or moving the company's last client admin", () => {
    expect(wouldRemoveLastClientAdmin(client, { active: false }, 1)).toBe(true);
    expect(wouldRemoveLastClientAdmin(client, { role: "ROLE_HR_ADMIN" }, 1)).toBe(true);
    expect(wouldRemoveLastClientAdmin(client, { companyScope: "BF" }, 1)).toBe(true);
  });

  it("allows it when another client admin of the company remains", () => {
    expect(wouldRemoveLastClientAdmin(client, { active: false }, 2)).toBe(false);
  });

  it("ignores no-op changes, other roles and inactive targets", () => {
    expect(wouldRemoveLastClientAdmin(client, { displayName: "x" } as never, 1)).toBe(false);
    expect(wouldRemoveLastClientAdmin(client, { companyScope: "ST" }, 1)).toBe(false);
    expect(wouldRemoveLastClientAdmin({ ...client, role: "ROLE_HR_ADMIN" }, { active: false }, 1)).toBe(false);
    expect(wouldRemoveLastClientAdmin({ ...client, active: false }, { active: false }, 1)).toBe(false);
  });
});
