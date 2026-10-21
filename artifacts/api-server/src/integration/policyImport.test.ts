/**
 * Bulk policy import: super admin only, previewed, confirmed before it replaces
 * a policy on file, and audited like the single-policy form.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, makeCompany, makeMember, startApp, useAppRoleGuard } from "./testDb";
import { makeAdmin, signIn, type AdminClient } from "./adminFixtures";

const HEADER = [
  "CompanyNumber", "MemberIDType", "MemberIDNumber", "InsurerName", "PlanName", "Policyholder",
  "PolicyNumber", "GroupNumber", "MemberNumber", "CertificateNumber", "EffectiveDate", "ExpiryDate",
];

describeDb("bulk policy import", () => {
  useAppRoleGuard();
  let app: Awaited<ReturnType<typeof startApp>>;
  let superAdmin: AdminClient;
  let hr: AdminClient;
  let client: AdminClient;
  let company: string;
  let withPolicy: { memberId: number; idNumber: string };
  let without: { memberId: number; idNumber: string };

  const row = (idNumber: string, policyNumber: string, over: Partial<Record<string, string>> = {}) =>
    HEADER.map((h) => over[h] ?? ({
      CompanyNumber: company, MemberIDType: "National ID", MemberIDNumber: idNumber,
      InsurerName: "NALICO", PlanName: "Group Medical", Policyholder: "Policy Test Co",
      PolicyNumber: policyNumber, GroupNumber: "G-1", MemberNumber: `M-${idNumber}`,
      CertificateNumber: `C-${idNumber}`, EffectiveDate: "2026-01-01", ExpiryDate: "",
    } as Record<string, string>)[h]!);
  const upload = (as: AdminClient, rows: string[][], dryRun: boolean, confirmUpdates = false) =>
    as("POST", "/v1/admin/import/policies", {
      sheets: [{ name: "Policies", rows: [HEADER, ...rows] }],
      dryRun,
      confirmUpdates,
      fileName: "policies.xlsx",
    });
  const policyOf = async (memberId: number) =>
    (await superAdmin("GET", `/v1/admin/companies/${company}/members/${memberId}`)).body["policy"] as Record<string, unknown> | null;

  beforeAll(async () => {
    app = await startApp();
    company = await makeCompany("Policy Test Co");
    withPolicy = await makeMember({ companyNumber: company, firstName: "Has", lastName: "Policy" });
    without = await makeMember({ companyNumber: company, firstName: "No", lastName: "Policy" });
    superAdmin = await signIn(app.baseUrl, (await makeAdmin("ROLE_PLATFORM_ADMIN")).email);
    hr = await signIn(app.baseUrl, (await makeAdmin("ROLE_HR_ADMIN", { companyScope: company })).email);
    client = await signIn(app.baseUrl, (await makeAdmin("ROLE_CLIENT_ADMIN", { companyScope: company })).email);
    const seeded = await superAdmin("POST", `/v1/admin/companies/${company}/members/${withPolicy.memberId}/policy`, {
      policyholder: "Policy Test Co", policyNumber: "OLD-1", groupNumber: "G-1", memberNumber: "M-old",
      certificateNumber: "C-old", planName: "Group Medical", insurerName: "NALICO",
      effectiveDate: "2025-01-01", expiryDate: "2025-12-31", reason: "integration test",
    });
    expect(seeded.status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it("is refused to everyone but the super admin", async () => {
    for (const as of [hr, client]) {
      expect((await upload(as, [row(without.idNumber, "P-1")], true)).status).toBe(403);
      expect((await as("GET", "/v1/admin/import/policies/layout")).status).toBe(403);
    }
    const layout = await superAdmin("GET", "/v1/admin/import/policies/layout");
    expect(layout.body["columns"]).toEqual(HEADER);
  });

  it("previews new, replacing and unusable rows without writing anything", async () => {
    const r = await upload(superAdmin, [
      row(without.idNumber, "NEW-1"),
      row(withPolicy.idNumber, "NEW-2"),
      row("NOBODY-123", "NEW-3"),
      row(without.idNumber, "NEW-4"),
      row(without.idNumber, "", { PolicyNumber: "" }),
    ], true);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ okCount: 1, warnCount: 1, errorCount: 3, existingCount: 1, committedCount: 0 });
    const rows = r.body["rows"] as { rowNumber: number; status: string; reasonCodes: string[]; changedFields: string[]; memberName: string }[];
    expect(rows[0]).toMatchObject({ status: "OK", memberName: "No Policy" });
    expect(rows[1]).toMatchObject({ status: "WARN" });
    expect(rows[1]!.changedFields).toEqual(expect.arrayContaining(["PolicyNumber", "EffectiveDate", "ExpiryDate"]));
    expect(rows[2]!.reasonCodes).toEqual(["MEMBER_NOT_FOUND"]);
    expect(rows[3]!.reasonCodes).toEqual(["DUPLICATE_IN_FILE"]);
    expect(rows[4]!.reasonCodes).toEqual(["MISSING_POLICY_FIELD"]);
    expect(await policyOf(without.memberId)).toBeNull();
  });

  it("will not replace a policy on file without an explicit yes", async () => {
    const r = await upload(superAdmin, [row(withPolicy.idNumber, "NEW-2")], false);
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe("UPDATES_NOT_CONFIRMED");
    expect((await policyOf(withPolicy.memberId))?.["policyNumber"]).toBe("OLD-1");
  });

  it("adds and replaces policies when confirmed, and audits each one", async () => {
    const r = await upload(superAdmin, [row(without.idNumber, "NEW-1"), row(withPolicy.idNumber, "NEW-2")], false, true);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ committedCount: 2, companies: [{ companyNumber: company, saved: true, created: 1, updated: 1 }] });
    expect(await policyOf(without.memberId)).toMatchObject({ policyNumber: "NEW-1", effectiveDate: "2026-01-01", expiryDate: null });
    expect(await policyOf(withPolicy.memberId)).toMatchObject({ policyNumber: "NEW-2", expiryDate: null });

    const audit = await superAdmin("GET", `/v1/admin/audit?entityId=${without.memberId}`);
    const actions = (audit.body["items"] as { action: string }[]).map((a) => a.action);
    expect(actions).toContain("POLICY_CREATED");
  });

  it("points a Policies sheet uploaded to the members import at the Policies tab", async () => {
    const r = await superAdmin("POST", "/v1/admin/import", {
      sheets: [{ name: "Policies", rows: [HEADER, row(without.idNumber, "X")] }],
      dryRun: true,
    });
    expect(r.status).toBe(400);
    expect(r.body.error?.message).toMatch(/Policies tab/);
  });
});
