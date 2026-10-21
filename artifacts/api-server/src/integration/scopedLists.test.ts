/**
 * Every list filtered by a scope's company list answers for company-scoped
 * admins. Raw SQL that took the list as a JS array once expanded it into a row,
 * ($1, $2), which cannot be cast to text[], and these lists failed with 500 for
 * every scoped admin.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, makeCompany, startApp, useAppRoleGuard } from "./testDb";
import { makeAdmin, signIn, type AdminClient } from "./adminFixtures";

describeDb("scope-filtered lists", () => {
  useAppRoleGuard();
  let app: Awaited<ReturnType<typeof startApp>>;
  let hr: AdminClient;
  let client: AdminClient;
  let superAdmin: AdminClient;

  beforeAll(async () => {
    app = await startApp();
    const a = await makeCompany("Scoped A");
    hr = await signIn(app.baseUrl, (await makeAdmin("ROLE_HR_ADMIN", { companyScope: a })).email);
    client = await signIn(app.baseUrl, (await makeAdmin("ROLE_CLIENT_ADMIN", { companyScope: a })).email);
    superAdmin = await signIn(app.baseUrl, (await makeAdmin("ROLE_PLATFORM_ADMIN")).email);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  for (const path of ["/v1/admin/dashboard", "/v1/admin/verifications", "/v1/admin/audit"]) {
    it(`${path} answers 200 for a company-scoped admin`, async () => {
      expect((await hr("GET", path)).status).toBe(200);
      expect((await client("GET", path)).status).toBe(200);
    });
  }

  it("lookup alerts answer 200 for the super admin, with every status, and 403 for company admins", async () => {
    for (const status of ["OPEN", "RESOLVED", "ALL"]) {
      const r = await superAdmin("GET", `/v1/admin/lookup-alerts?status=${status}`);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
    }
    expect((await client("GET", "/v1/admin/lookup-alerts")).status).toBe(403);
    expect((await hr("GET", "/v1/admin/lookup-alerts")).status).toBe(403);
  });
});
