/**
 * The admin lockout invariants, against the real database: someone can always
 * manage admin users, at least one super admin remains, and a company keeps at
 * least one client admin (spec FR-018) — including under concurrent updates.
 *
 * These count accounts across the whole database, so every other active
 * manager is parked (deactivated) for the duration and restored afterwards.
 * Integration suites run one file at a time, so parking cannot disturb another
 * suite.
 */
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { describeDb, makeCompany, useAppRoleGuard } from "./testDb";

type Role = "ROLE_PLATFORM_ADMIN" | "ROLE_CLIENT_ADMIN" | "ROLE_HR_ADMIN" | "ROLE_SUPPORT";

describeDb("applyAdminUserChanges lockout invariants", () => {
  useAppRoleGuard();
  let mod: typeof import("../lib/adminUserUpdate");
  let dbm: typeof import("@workspace/db");
  let orm: typeof import("drizzle-orm");
  let company: string;
  const created: string[] = [];
  let parked: string[] = [];

  async function insertAdmin(role: Role) {
    const scope = { companyScope: role === "ROLE_CLIENT_ADMIN" || role === "ROLE_HR_ADMIN" ? company : null };
    const [row] = await dbm.db
      .insert(dbm.adminUsersTable)
      .values({
        email: `lockout-${randomBytes(5).toString("hex")}@integration.test`,
        displayName: `Test ${role}`,
        passwordHash: "x",
        role,
        ...scope,
      })
      .returning();
    created.push(row!.id);
    return row!;
  }

  async function activeManagers(): Promise<number> {
    const rows = await dbm.db
      .select({ id: dbm.adminUsersTable.id })
      .from(dbm.adminUsersTable)
      .where(
        orm.and(
          orm.inArray(dbm.adminUsersTable.id, created),
          orm.eq(dbm.adminUsersTable.active, true),
          orm.inArray(dbm.adminUsersTable.role, ["ROLE_PLATFORM_ADMIN", "ROLE_CLIENT_ADMIN"]),
        ),
      );
    return rows.length;
  }

  beforeAll(async () => {
    mod = await import("../lib/adminUserUpdate");
    dbm = await import("@workspace/db");
    orm = await import("drizzle-orm");
    company = await makeCompany("Lockout");
    // Park every other active manager: deactivating is a plain column change,
    // so no scope rule is disturbed, and it is exactly undone afterwards.
    const rows = await dbm.db
      .update(dbm.adminUsersTable)
      .set({ active: false })
      .where(
        orm.and(
          orm.eq(dbm.adminUsersTable.active, true),
          orm.inArray(dbm.adminUsersTable.role, ["ROLE_PLATFORM_ADMIN", "ROLE_CLIENT_ADMIN"]),
        ),
      )
      .returning({ id: dbm.adminUsersTable.id });
    parked = rows.map((r) => r.id);
  });

  // Each scenario starts from nobody: the previous one's accounts are retired.
  afterEach(async () => {
    if (created.length) {
      await dbm.db
        .update(dbm.adminUsersTable)
        .set({ active: false })
        .where(orm.inArray(dbm.adminUsersTable.id, created));
    }
  });

  afterAll(async () => {
    if (parked.length) {
      await dbm.db.update(dbm.adminUsersTable).set({ active: true }).where(orm.inArray(dbm.adminUsersTable.id, parked));
    }
  });

  // --- someone can still manage admin users ----------------------------------

  it("rejects deactivating the sole active manager", async () => {
    const only = await insertAdmin("ROLE_PLATFORM_ADMIN");
    await expect(mod.applyAdminUserChanges(only.id, { active: false })).rejects.toBeInstanceOf(mod.LastAdminManagerError);
  });

  it("allows demoting a client admin while a super admin remains", async () => {
    await insertAdmin("ROLE_PLATFORM_ADMIN");
    const client = await insertAdmin("ROLE_CLIENT_ADMIN");
    await insertAdmin("ROLE_CLIENT_ADMIN"); // the company keeps a client admin
    const updated = await mod.applyAdminUserChanges(client.id, { role: "ROLE_HR_ADMIN" });
    expect(updated?.role).toBe("ROLE_HR_ADMIN");
  });

  it("allows updates that do not touch manager status", async () => {
    const only = await insertAdmin("ROLE_PLATFORM_ADMIN");
    const updated = await mod.applyAdminUserChanges(only.id, { displayName: "Renamed" });
    expect(updated?.displayName).toBe("Renamed");
  });

  it("returns null for a missing target", async () => {
    expect(await mod.applyAdminUserChanges("00000000-0000-0000-0000-000000000000", { active: false })).toBeNull();
  });

  it("under concurrent deactivations, exactly one succeeds and one manager survives", async () => {
    const a = await insertAdmin("ROLE_PLATFORM_ADMIN");
    const b = await insertAdmin("ROLE_PLATFORM_ADMIN");
    const results = await Promise.allSettled([
      mod.applyAdminUserChanges(a.id, { active: false }),
      mod.applyAdminUserChanges(b.id, { active: false }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await activeManagers()).toBe(1);
  });

  // --- at least one super admin ---------------------------------------------

  it("rejects deactivating the sole super admin", async () => {
    await insertAdmin("ROLE_CLIENT_ADMIN"); // keeps a manager alive
    const superAdmin = await insertAdmin("ROLE_PLATFORM_ADMIN");
    await expect(mod.applyAdminUserChanges(superAdmin.id, { active: false })).rejects.toBeInstanceOf(
      mod.LastPlatformAdminError,
    );
  });

  it("allows demoting a super admin when another remains", async () => {
    const a = await insertAdmin("ROLE_PLATFORM_ADMIN");
    await insertAdmin("ROLE_PLATFORM_ADMIN");
    const updated = await mod.applyAdminUserChanges(a.id, { role: "ROLE_SUPPORT" });
    expect(updated?.role).toBe("ROLE_SUPPORT");
  });

  // --- a company keeps a client admin (FR-018) --------------------------------

  it("rejects deactivating, demoting or moving a company's last client admin", async () => {
    await insertAdmin("ROLE_PLATFORM_ADMIN");
    const client = await insertAdmin("ROLE_CLIENT_ADMIN");
    const other = await makeCompany("Lockout other");
    for (const changes of [
      { active: false },
      { role: "ROLE_HR_ADMIN" as const },
      { companyScope: other },
    ]) {
      await expect(mod.applyAdminUserChanges(client.id, changes), JSON.stringify(changes)).rejects.toBeInstanceOf(
        mod.LastClientAdminError,
      );
    }
  });

  it("allows it when the company has another active client admin", async () => {
    await insertAdmin("ROLE_PLATFORM_ADMIN");
    const a = await insertAdmin("ROLE_CLIENT_ADMIN");
    await insertAdmin("ROLE_CLIENT_ADMIN");
    const updated = await mod.applyAdminUserChanges(a.id, { active: false });
    expect(updated?.active).toBe(false);
  });

  it("refuses at the database a role with the wrong kind of scope", async () => {
    let code: string | undefined;
    try {
      await dbm.db.insert(dbm.adminUsersTable).values({
        email: `bad-scope-${randomBytes(4).toString("hex")}@integration.test`,
        displayName: "Bad",
        passwordHash: "x",
        role: "ROLE_HR_ADMIN",
        companyScope: null,
      });
    } catch (err) {
      code = ((err as { cause?: { code?: string } }).cause ?? (err as { code?: string })).code;
    }
    expect(code).toBe("23514");
  });

  it("refuses at the database the removed group admin role", async () => {
    let code: string | undefined;
    try {
      await dbm.db.insert(dbm.adminUsersTable).values({
        email: `group-${randomBytes(4).toString("hex")}@integration.test`,
        displayName: "Group",
        passwordHash: "x",
        role: "ROLE_HR_GROUP_ADMIN" as never,
        companyScope: null,
      });
    } catch (err) {
      code = ((err as { cause?: { code?: string } }).cause ?? (err as { code?: string })).code;
    }
    expect(code).toBe("23514");
  });
});
