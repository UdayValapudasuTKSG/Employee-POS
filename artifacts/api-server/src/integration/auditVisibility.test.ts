/**
 * Who sees whose audit entries, on the dashboard's recent activity and the
 * Audit screen:
 *   - the super admin sees every role's entries;
 *   - a client admin sees its company's entries by client admins and HR
 *     administrators, not a super admin's work on the company;
 *   - an HR administrator sees only its own entries.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, makeCompany, makeMember, startApp, useAppRoleGuard } from "./testDb";
import { makeAdmin, signIn, type AdminClient } from "./adminFixtures";

describeDb("audit visibility by role", () => {
  useAppRoleGuard();

  let app: Awaited<ReturnType<typeof startApp>>;
  let hrA: AdminClient, hrB: AdminClient, client: AdminClient, superAdmin: AdminClient;
  let emails: { hrA: string; hrB: string; client: string; superAdmin: string; otherClient: string };

  beforeAll(async () => {
    app = await startApp();
    const company = await makeCompany("Audit Vis");
    const other = await makeCompany("Audit Vis Other");
    const member = (await makeMember({ companyNumber: company, lastName: "Visible" })).memberId;
    emails = {
      hrA: (await makeAdmin("ROLE_HR_ADMIN", { companyScope: company })).email,
      hrB: (await makeAdmin("ROLE_HR_ADMIN", { companyScope: company })).email,
      client: (await makeAdmin("ROLE_CLIENT_ADMIN", { companyScope: company })).email,
      superAdmin: (await makeAdmin("ROLE_PLATFORM_ADMIN")).email,
      otherClient: (await makeAdmin("ROLE_CLIENT_ADMIN", { companyScope: other })).email,
    };
    hrA = await signIn(app.baseUrl, emails.hrA);
    hrB = await signIn(app.baseUrl, emails.hrB);
    client = await signIn(app.baseUrl, emails.client);
    superAdmin = await signIn(app.baseUrl, emails.superAdmin);
    await signIn(app.baseUrl, emails.otherClient);
    const path = `/v1/admin/companies/${company}/members/${member}`;
    await hrA("PATCH", path, { occupation: "Driver", reason: "visibility" });
    await hrB("PATCH", path, { occupation: "Clerk", reason: "visibility" });
    await client("PATCH", path, { occupation: "Porter", reason: "visibility" });
    await superAdmin("PATCH", path, { occupation: "Cook", reason: "visibility" });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  async function actors(who: AdminClient): Promise<{ audit: Set<string>; dashboard: Set<string> }> {
    const audit = await who("GET", "/v1/admin/audit?pageSize=100");
    const dashboard = await who("GET", "/v1/admin/dashboard");
    expect(audit.status).toBe(200);
    expect(dashboard.status).toBe(200);
    return {
      audit: new Set((audit.body["items"] as { actor: string }[]).map((i) => i.actor)),
      dashboard: new Set((dashboard.body["recentAudit"] as { actor: string }[]).map((i) => i.actor)),
    };
  }

  it("shows an HR administrator only its own entries", async () => {
    const seen = await actors(hrA);
    for (const set of [seen.audit, seen.dashboard]) {
      expect([...set]).toEqual([emails.hrA]);
    }
  });

  it("shows a client admin its company's client admin and HR entries, not the super admin's", async () => {
    const { audit } = await actors(client);
    expect(audit).toEqual(new Set([emails.hrA, emails.hrB, emails.client]));
  });

  it("shows the super admin every role's entries", async () => {
    for (const email of Object.values(emails)) {
      const r = await superAdmin("GET", `/v1/admin/audit?actor=${encodeURIComponent(email)}`);
      expect((r.body["items"] as unknown[]).length, email).toBeGreaterThan(0);
    }
  });
});
