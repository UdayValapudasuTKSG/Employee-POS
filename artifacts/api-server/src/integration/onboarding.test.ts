/**
 * FR-017, FR-019, SC-002: a super admin onboards a client company and its one
 * client admin, all-or-nothing and without a code release; offboarding
 * deactivates the company and its users but keeps every record.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { describeDb, makeMember, startApp, useAppRoleGuard } from "./testDb";
import { makeAdmin, signIn, TEST_PASSWORD, type AdminClient } from "./adminFixtures";

describeDb("onboarding and offboarding (FR-017, FR-019)", () => {
  useAppRoleGuard();
  let app: Awaited<ReturnType<typeof startApp>>;
  let superAdmin: AdminClient;
  const number = () => `ON${randomBytes(3).toString("hex").toUpperCase()}`;

  beforeAll(async () => {
    app = await startApp();
    superAdmin = await signIn(app.baseUrl, (await makeAdmin("ROLE_PLATFORM_ADMIN")).email);
  });

  afterAll(async () => {
    await app?.close();
  });

  const onboard = (companyNumber: string, email: string) =>
    superAdmin("POST", "/v1/admin/companies", {
      companyNumber,
      companyName: "Sterling Test",
      contactEmail: "office@st.test",
      clientAdmin: { email, displayName: "ST Admin" },
      reason: "integration onboarding",
    });

  it("creates the company and one client admin with a temporary password, in seconds", async () => {
    const companyNumber = number();
    const email = `client-${randomBytes(4).toString("hex")}@st.test`;
    const started = Date.now();
    const r = await onboard(companyNumber, email);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      company: { companyNumber, companyName: "Sterling Test", active: true, activeMembers: 0 },
      clientAdmin: { email, role: "ROLE_CLIENT_ADMIN", roleLabel: "Client admin", companyScope: companyNumber },
    });
    const temp = r.body["temporaryPassword"] as string;
    expect(temp.length).toBeGreaterThanOrEqual(12);
    // The client admin can sign in with it and reaches only its own company.
    const login = await fetch(`${app.baseUrl}/v1/admin/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: temp }),
    });
    const body = (await login.json()) as { token: string; mustChangePassword: boolean };
    expect(body.mustChangePassword).toBe(true);
    const companies = (await (
      await fetch(`${app.baseUrl}/v1/admin/companies`, { headers: { authorization: `Bearer ${body.token}` } })
    ).json()) as { companyNumber: string }[];
    expect(companies.map((c) => c.companyNumber)).toEqual([companyNumber]);
  });

  it("refuses a duplicate company number and creates nothing else", async () => {
    const companyNumber = number();
    expect((await onboard(companyNumber, `a-${randomBytes(4).toString("hex")}@st.test`)).status).toBe(201);
    const secondEmail = `b-${randomBytes(4).toString("hex")}@st.test`;
    const again = await onboard(companyNumber, secondEmail);
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("COMPANY_EXISTS");
    const db = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    expect(await db.db.select().from(db.adminUsersTable).where(eq(db.adminUsersTable.email, secondEmail))).toEqual([]);
  });

  it("rolls the whole onboarding back when the client admin cannot be created", async () => {
    const taken = (await makeAdmin("ROLE_SUPPORT")).email;
    const companyNumber = number();
    const r = await onboard(companyNumber, taken);
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe("EMAIL_IN_USE");
    const db = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const rows = await db.withScope(db.SYSTEM_SCOPE, (tx) =>
      tx.select().from(db.bhiCompanyTable).where(eq(db.bhiCompanyTable.companyNumber, companyNumber)),
    );
    expect(rows).toEqual([]);
  });

  it("offboards: company and users inactive, records kept and readable, writes refused", async () => {
    const companyNumber = number();
    const email = `off-${randomBytes(4).toString("hex")}@st.test`;
    const created = await onboard(companyNumber, email);
    const temp = created.body["temporaryPassword"] as string;
    const { memberId } = await makeMember({ companyNumber, email: `m-${randomBytes(4).toString("hex")}@st.test` });

    const off = await superAdmin("POST", `/v1/admin/companies/${companyNumber}/offboard`, { reason: "Contract ended" });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ active: false, activeMembers: 1 });

    const login = await fetch(`${app.baseUrl}/v1/admin/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: temp }),
    });
    expect(login.status).toBe(401);

    // Still readable to the super admin; changes refused.
    expect((await superAdmin("GET", `/v1/admin/companies/${companyNumber}/members/${memberId}`)).status).toBe(200);
    const write = await superAdmin("PATCH", `/v1/admin/companies/${companyNumber}/members/${memberId}`, {
      occupation: "x",
      reason: "should fail",
    });
    expect(write.status).toBe(409);
    expect(write.body.error?.code).toBe("COMPANY_INACTIVE");

    const back = await superAdmin("POST", `/v1/admin/companies/${companyNumber}/reactivate`, { reason: "Renewed" });
    expect(back.body).toMatchObject({ active: true });
  });

  it("is a super admin action only", async () => {
    const hr = await signIn(app.baseUrl, (await makeAdmin("ROLE_SUPPORT")).email);
    const r = await hr("POST", "/v1/admin/companies", {
      companyNumber: number(),
      companyName: "Nope",
      clientAdmin: { email: "x@y.test", displayName: "X" },
      reason: "should fail",
    });
    expect(r.status).toBe(403);
  });

  // Keeps the password constant visibly used, so fixtures stay in one place.
  it("uses the shared fixture password", () => {
    expect(TEST_PASSWORD.length).toBeGreaterThan(8);
  });
});
