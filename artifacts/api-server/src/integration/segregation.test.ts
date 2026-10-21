/**
 * SC-003, FR-010 to FR-015: each client's data is kept apart through the API.
 *
 *   - A company-scoped user (HR administrator, client admin) reaches only its
 *     own company; another company's record answers exactly like one that does
 *     not exist.
 *   - The super admin reaches every company.
 *   - Support and auditor read but never change.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, makeCompany, makeMember, startApp, useAppRoleGuard } from "./testDb";
import { makeAdmin, signIn, type AdminClient } from "./adminFixtures";

describeDb("segregation through the admin API (SC-003)", () => {
  useAppRoleGuard();

  let app: Awaited<ReturnType<typeof startApp>>;
  let BF: string, BA: string, ST: string;
  let bfMember: number, baMember: number, stMember: number;
  let hrBF: AdminClient, clientST: AdminClient, superAdmin: AdminClient;
  let support: AdminClient, auditor: AdminClient;

  beforeAll(async () => {
    app = await startApp();
    BF = await makeCompany("Seg BF");
    BA = await makeCompany("Seg BA");
    ST = await makeCompany("Seg Sterling");
    bfMember = (await makeMember({ companyNumber: BF, lastName: "Bee-Eff" })).memberId;
    baMember = (await makeMember({ companyNumber: BA, lastName: "Bee-Ay" })).memberId;
    stMember = (await makeMember({ companyNumber: ST, lastName: "Sterling" })).memberId;
    hrBF = await signIn(app.baseUrl, (await makeAdmin("ROLE_HR_ADMIN", { companyScope: BF })).email);
    clientST = await signIn(app.baseUrl, (await makeAdmin("ROLE_CLIENT_ADMIN", { companyScope: ST })).email);
    superAdmin = await signIn(app.baseUrl, (await makeAdmin("ROLE_PLATFORM_ADMIN")).email);
    support = await signIn(app.baseUrl, (await makeAdmin("ROLE_SUPPORT")).email);
    auditor = await signIn(app.baseUrl, (await makeAdmin("ROLE_AUDITOR")).email);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("answers another company's member exactly like a member that does not exist", async () => {
    const other = await hrBF("GET", `/v1/admin/companies/${BA}/members/${baMember}`);
    const missing = await hrBF("GET", `/v1/admin/companies/${BF}/members/999999999`);
    const noCompany = await hrBF("GET", `/v1/admin/companies/NOPE/members/${bfMember}`);
    expect(other.status).toBe(404);
    expect(other.body).toEqual(missing.body);
    expect(noCompany.body).toEqual(missing.body);
    // The owner can read it.
    expect((await hrBF("GET", `/v1/admin/companies/${BF}/members/${bfMember}`)).status).toBe(200);
  });

  it("lists only the caller's own company for a company-scoped user", async () => {
    const hr = await hrBF("GET", "/v1/admin/members?pageSize=100");
    const hrRows = hr.body["items"] as { companyNumber: string }[];
    expect(hrRows.length).toBeGreaterThan(0);
    expect(new Set(hrRows.map((r) => r.companyNumber))).toEqual(new Set([BF]));
    // Asking for another company by filter still returns nothing.
    const asked = await hrBF("GET", `/v1/admin/members?company=${BA}`);
    expect(asked.body["items"]).toEqual([]);
    const cl = await clientST("GET", "/v1/admin/members?pageSize=100");
    expect(new Set((cl.body["items"] as { companyNumber: string }[]).map((r) => r.companyNumber))).toEqual(new Set([ST]));
  });

  it("lists only its own company for a client admin, and nothing of another client", async () => {
    const companies = (await clientST("GET", "/v1/admin/companies")).body as unknown as { companyNumber: string }[];
    expect(companies.map((c) => c.companyNumber)).toEqual([ST]);
    expect((await clientST("GET", `/v1/admin/companies/${BF}/members/${bfMember}`)).status).toBe(404);
  });

  it("lets the super admin reach every company", async () => {
    for (const company of [BF, BA, ST]) {
      const r = await superAdmin("GET", `/v1/admin/members?company=${company}`);
      expect((r.body["items"] as unknown[]).length, company).toBe(1);
    }
  });

  it("refuses every write to another company, whichever route it comes through", async () => {
    const reason = "integration test";
    const attempts = [
      hrBF("PATCH", `/v1/admin/companies/${BA}/members/${baMember}`, { occupation: "x", reason }),
      hrBF("POST", `/v1/admin/companies/${BA}/members/${baMember}/deactivate`, { reason }),
      hrBF("POST", `/v1/admin/companies/${BA}/members/${baMember}/policy`, {
        policyholder: "x", policyNumber: "x", groupNumber: "x", memberNumber: "x", certificateNumber: "x",
        planName: "x", insurerName: "x", effectiveDate: "2026-01-01", expiryDate: null, reason,
      }),
      hrBF("POST", `/v1/admin/companies/${BA}/members/${baMember}/beneficiaries`, { fullName: "X Y", reason }),
      hrBF("POST", `/v1/admin/companies/${BA}/members`, {
        idType: "NATIONAL ID", idNumber: `SEG-${Date.now()}`, firstName: "In", lastName: "Truder", classCode: "A", reason,
      }),
      clientST("PATCH", `/v1/admin/companies/${BF}/members/${bfMember}`, { occupation: "x", reason }),
    ];
    for (const r of await Promise.all(attempts)) expect(r.status).toBe(404);
  });

  it("lets support and the auditor read but never change anything", async () => {
    const reason = "integration test";
    for (const client of [support, auditor]) {
      const writes = await Promise.all([
        client("PATCH", `/v1/admin/companies/${BF}/members/${bfMember}`, { occupation: "x", reason }),
        client("POST", `/v1/admin/companies/${BF}/members/${bfMember}/deactivate`, { reason }),
        client("POST", `/v1/admin/companies/${BF}/members`, {
          idType: "NATIONAL ID", idNumber: `RO-${Date.now()}`, firstName: "Read", lastName: "Only", classCode: "A", reason,
        }),
      ]);
      for (const w of writes) expect(w.status).toBe(403);
    }
    // Support may read members of any company.
    expect((await support("GET", `/v1/admin/companies/${ST}/members/${stMember}`)).status).toBe(200);
  });

  it("shows a company-scoped user only its own company's audit rows", async () => {
    await hrBF("PATCH", `/v1/admin/companies/${BF}/members/${bfMember}`, { occupation: "Driver", reason: "audit check" });
    const audit = await hrBF("GET", "/v1/admin/audit?pageSize=100");
    expect(audit.status).toBe(200);
    const items = audit.body["items"] as { entityId: string | null }[];
    expect(items.some((i) => i.entityId === String(bfMember))).toBe(true);
    expect(items.some((i) => i.entityId === String(stMember))).toBe(false);
  });

  it("deactivates and reactivates with a reason, and records it in the status history", async () => {
    const off = await hrBF("POST", `/v1/admin/companies/${BF}/members/${bfMember}/deactivate`, { reason: "Left the company" });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ active: false, inactiveReason: "Left the company" });
    expect((await hrBF("POST", `/v1/admin/companies/${BF}/members/${bfMember}/deactivate`, { reason: "again" })).status).toBe(400);
    const on = await hrBF("POST", `/v1/admin/companies/${BF}/members/${bfMember}/reactivate`, { reason: "Rehired" });
    expect(on.body).toMatchObject({ active: true, inactiveReason: null });
    const db = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const history = await db.withScope(db.SYSTEM_SCOPE, (tx) =>
      tx.select().from(db.bhiEnrollmentStatusHistoryTable).where(eq(db.bhiEnrollmentStatusHistoryTable.memberId, bfMember)),
    );
    expect(history.map((h) => [h.oldActive, h.newActive])).toEqual([
      [true, false],
      [false, true],
    ]);
  });
});
