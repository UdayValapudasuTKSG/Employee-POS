/**
 * FR-013, FR-018, SC-010: client admins manage their own company's users
 * without escalating privilege; every role carries the right kind of scope; a
 * company always keeps a client admin. There is no group admin role: the super
 * admin is the only role above one company that can change anything.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { describeDb, makeCompany, startApp, useAppRoleGuard } from "./testDb";
import { makeAdmin, signIn, type AdminClient } from "./adminFixtures";

describeDb("admin user management (FR-013, FR-018)", () => {
  useAppRoleGuard();
  let app: Awaited<ReturnType<typeof startApp>>;
  let ST: string, BF: string;
  let clientST: AdminClient, superAdmin: AdminClient;
  let clientSTId: string;
  const email = () => `um-${randomBytes(5).toString("hex")}@integration.test`;

  beforeAll(async () => {
    app = await startApp();
    ST = await makeCompany("UM Sterling");
    BF = await makeCompany("UM BF");
    const c = await makeAdmin("ROLE_CLIENT_ADMIN", { companyScope: ST });
    clientSTId = c.id;
    clientST = await signIn(app.baseUrl, c.email);
    superAdmin = await signIn(app.baseUrl, (await makeAdmin("ROLE_PLATFORM_ADMIN")).email);
  });

  afterAll(async () => {
    await app?.close();
  });

  const create = (client: AdminClient, role: string, scope: { companyScope?: string | null }) =>
    client("POST", "/v1/admin/users", {
      email: email(),
      displayName: "New User",
      role,
      companyScope: scope.companyScope ?? null,
    });

  it("lets a client admin create HR administrators and client admins of its own company", async () => {
    const hr = await create(clientST, "ROLE_HR_ADMIN", { companyScope: ST });
    expect(hr.status).toBe(200);
    expect(hr.body).toMatchObject({ user: { role: "ROLE_HR_ADMIN", companyScope: ST, roleLabel: "HR administrator" } });
    expect((await create(clientST, "ROLE_CLIENT_ADMIN", { companyScope: ST })).status).toBe(200);
  });

  it("refuses a client admin any other role, or another company", async () => {
    for (const [role, scope] of [
      ["ROLE_HR_ADMIN", { companyScope: BF }],
      ["ROLE_CLIENT_ADMIN", { companyScope: BF }],
      ["ROLE_PLATFORM_ADMIN", {}],
      ["ROLE_SUPPORT", {}],
      ["ROLE_AUDITOR", {}],
    ] as const) {
      const r = await create(clientST, role, scope);
      expect(r.status, role).toBe(403);
      if (role !== "ROLE_PLATFORM_ADMIN") expect(r.body.error?.code, role).toBe("ROLE_NOT_GRANTABLE");
    }
  });

  it("shows a client admin only its own company's users", async () => {
    const list = (await clientST("GET", "/v1/admin/users")).body as unknown as { companyScope: string | null; id: string }[];
    expect(list.every((u) => u.companyScope === ST || u.id === clientSTId)).toBe(true);
    expect(list.some((u) => "groupScope" in u)).toBe(false);
  });

  it("requires the right kind of scope for each role", async () => {
    const noCompany = await create(superAdmin, "ROLE_HR_ADMIN", {});
    expect(noCompany.body.error?.code).toBe("SCOPE_REQUIRED");
    const extra = await create(superAdmin, "ROLE_SUPPORT", { companyScope: ST });
    expect(extra.body.error?.code).toBe("SCOPE_NOT_ALLOWED");
  });

  it("no longer knows the group admin role or client groups", async () => {
    const r = await create(superAdmin, "ROLE_HR_GROUP_ADMIN", {});
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe("INVALID_INPUT");
    expect((await superAdmin("GET", "/v1/admin/groups")).status).toBe(404);
  });

  it("never leaves a company without a client admin", async () => {
    const company = await makeCompany("UM last admin");
    const only = await makeAdmin("ROLE_CLIENT_ADMIN", { companyScope: company });
    const r = await superAdmin("PATCH", `/v1/admin/users/${only.id}`, { active: false });
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe("LAST_CLIENT_ADMIN");
  });
});
