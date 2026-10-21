/**
 * POST /v1/admin/companies/{companyNumber}/members/{memberId}/dependents:
 * adding a dependant to an existing member. It starts active, is audited, and
 * obeys the same scope, read-only and offboarding rules as every member write.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, makeCompany, makeMember, startApp, useAppRoleGuard } from "./testDb";
import { makeAdmin, signIn, type AdminClient } from "./adminFixtures";

describeDb("adding a dependant to an existing member", () => {
  useAppRoleGuard();
  let app: Awaited<ReturnType<typeof startApp>>;
  let A: string, B: string;
  let memberA: number;
  let hrA: AdminClient, hrB: AdminClient, support: AdminClient, superAdmin: AdminClient;
  const path = (company: string, memberId: number) => `/v1/admin/companies/${company}/members/${memberId}/dependents`;
  const body = { fullName: "Ravi Persaud", relationship: "SON", dateOfBirth: "2019-04-02", sex: "M", reason: "New son" };

  beforeAll(async () => {
    app = await startApp();
    A = await makeCompany("Dep A");
    B = await makeCompany("Dep B");
    memberA = (await makeMember({ companyNumber: A, lastName: "Persaud" })).memberId;
    hrA = await signIn(app.baseUrl, (await makeAdmin("ROLE_HR_ADMIN", { companyScope: A })).email);
    hrB = await signIn(app.baseUrl, (await makeAdmin("ROLE_HR_ADMIN", { companyScope: B })).email);
    support = await signIn(app.baseUrl, (await makeAdmin("ROLE_SUPPORT")).email);
    superAdmin = await signIn(app.baseUrl, (await makeAdmin("ROLE_PLATFORM_ADMIN")).email);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it("adds an active dependant and returns the member detail", async () => {
    const r = await hrA("POST", path(A, memberA), body);
    expect(r.status).toBe(200);
    const deps = r.body["dependents"] as { fullName: string; relationship: string; active: boolean; dateOfBirth: string | null }[];
    expect(deps).toContainEqual(expect.objectContaining({ fullName: "Ravi Persaud", relationship: "SON", active: true, dateOfBirth: "2019-04-02" }));
    const audit = await superAdmin("GET", "/v1/admin/audit?action=DEPENDENT_ADDED&pageSize=20");
    expect((audit.body["items"] as { reason: string | null }[]).some((i) => i.reason === "New son")).toBe(true);
  });

  it("requires a name, a relationship and a reason", async () => {
    for (const bad of [{ ...body, fullName: "" }, { ...body, relationship: undefined }, { ...body, reason: "x" }]) {
      const r = await hrA("POST", path(A, memberA), bad);
      expect(r.status).toBe(400);
      expect(r.body.error?.code).toBe("INVALID_INPUT");
    }
    const badDate = await hrA("POST", path(A, memberA), { ...body, dateOfBirth: "not a date" });
    expect(badDate.status).toBe(400);
    expect(badDate.body.error?.message).toMatch(/^Date of birth "not a date"/);
  });

  it("answers another company's member as not found", async () => {
    expect((await hrB("POST", path(A, memberA), body)).status).toBe(404);
    expect((await hrA("POST", path(B, memberA), body)).status).toBe(404);
  });

  it("refuses read-only roles", async () => {
    expect((await support("POST", path(A, memberA), body)).status).toBe(403);
  });

  it("refuses an offboarded company", async () => {
    const C = await makeCompany("Dep C");
    const memberC = (await makeMember({ companyNumber: C })).memberId;
    const { withScope, SYSTEM_SCOPE, bhiCompanyTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    await withScope(SYSTEM_SCOPE, (tx) => tx.update(bhiCompanyTable).set({ active: false }).where(eq(bhiCompanyTable.companyNumber, C)));
    const r = await superAdmin("POST", path(C, memberC), body);
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe("COMPANY_INACTIVE");
  });
});
