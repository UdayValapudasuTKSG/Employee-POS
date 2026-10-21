/**
 * The client's own sample workbook (2026-09-29): its members, dependants and
 * beneficiaries sheets, exactly as sent, imported in one upload. The company
 * number is the test's own; every other cell is the client's.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, ensureStandardRates, makeCompany, startApp, useAppRoleGuard } from "./testDb";
import { makeAdmin, signIn, type AdminClient } from "./adminFixtures";

const MEMBERS = [
  ["CompanyNumber", "CompanyName", "IDType", "IDNumber", "LastName", "FirstName", "MiddleInitials", "DateOfBirth", "Sex", "ClassCode", "AddressLine1", "AddressLine2", "Phone", "Email", "EmploymentDate", "PlanDate", "RateOfPay", "Occupation", "Active", "InactiveDate", "InactiveReason", "Notes"],
  ["SYN001", "Rubicon Logistics", "Passport", "SYN-M-0001", "Hanks", "Tom", "", "7-May-1983", "Male", "C", "1 Paradox Lane", "Fictional Test District", "000-000-0000", "member0001@example.invalid", "18-Mar-2023", "1-Jan-2026", "370,000", "Director of Plot Twists", "Active", "", "", "SYNTHETIC TEST DATA. Movie stars. All personal details and family links are invented."],
];
const DEPENDANTS = [
  ["CompanyNumber", "MemberIDType", "MemberIDNumber", "DependentIDType", "DependentIDNumber", "FirstName", "LastName", "DateOfBirth", "Sex", "Relationship", "Active", "InactiveDate", "InactiveReason", "Notes"],
  ["SYN001", "Passport", "SYN-M-0001", "E-ID", "SYN-D-00001", "Otto A", "Hanks", "27-Sep-2015", "Male", "Son", "Active", "", "", "SYNTHETIC dependent. Fictional family link."],
];
const BENEFICIARIES = [
  ["CompanyNumber", "MemberIDType", "MemberIDNumber", "BeneficiaryIDType", "BeneficiaryIDNumber", "FirstName", "LastName", "DateOfBirth", "Sex", "Relationship", "Phone", "Email", "SharePercent", "Active", "InactiveDate", "InactiveReason", "Notes"],
  ["SYN001", "Passport", "SYN-M-0001", "E-ID", "SYN-B-00001", "Sir Reginald", "Crumplebottom", "28-Feb-1999", "Male", "Sibling", "000-000-0000", "beneficiary00001@example.invalid", "60.00", "Active", "", "", "SYNTHETIC beneficiary. Fictional nomination."],
];

describeDb("the client's sample workbook", () => {
  useAppRoleGuard();
  let app: Awaited<ReturnType<typeof startApp>>;
  let hr: AdminClient;
  let company: string;
  // The client's rows, with SYN001 swapped for this test's company.
  const sheet = (name: string, rows: string[][]) => ({
    name,
    rows: rows.map((r, i) => (i === 0 ? r : [company, ...r.slice(1)])),
  });
  const upload = (dryRun: boolean, confirmUpdates = false) =>
    hr("POST", "/v1/admin/import", {
      sheets: [sheet("members", MEMBERS), sheet("dependants", DEPENDANTS), sheet("beneficiaries", BENEFICIARIES)],
      dryRun,
      confirmUpdates,
      fileName: "client-sample.xlsx",
    });

  beforeAll(async () => {
    app = await startApp();
    await ensureStandardRates();
    company = await makeCompany("Rubicon Logistics");
    hr = await signIn(app.baseUrl, (await makeAdmin("ROLE_HR_ADMIN", { companyScope: company })).email);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it("reads only the tab's own sheet when a layout is given", async () => {
    const all = [sheet("members", MEMBERS), sheet("dependants", DEPENDANTS), sheet("beneficiaries", BENEFICIARIES)];
    const members = await hr("POST", "/v1/admin/import", { sheets: all, dryRun: true, layout: "CARRIER" });
    expect(members.status, JSON.stringify(members.body)).toBe(200);
    expect((members.body["sheets"] as { layout: string }[]).map((s) => s.layout)).toEqual(["CARRIER"]);
    expect(members.body["totalRows"]).toBe(1);

    const wrongTab = await hr("POST", "/v1/admin/import", { sheets: [sheet("members", MEMBERS)], dryRun: true, layout: "DEPENDANT" });
    expect(wrongTab.status).toBe(400);
    expect(wrongTab.body.error?.message).toMatch(/no Dependants sheet/);
  });

  it("previews every row as loadable, holding nothing", async () => {
    const r = await upload(true);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body["heldCount"]).toBe(0);
  });

  it("loads the member, the dependant and the beneficiary as the sheets state them", async () => {
    const r = await upload(false);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body["heldCount"]).toBe(0);

    const list = await hr("GET", `/v1/admin/members?company=${company}&q=SYN-M-0001`);
    const found = (list.body["items"] as { memberId: number }[])[0];
    expect(found).toBeDefined();
    const detail = (await hr("GET", `/v1/admin/companies/${company}/members/${found!.memberId}`)).body;
    expect(detail).toMatchObject({
      idType: "PASSPORT",
      idNumber: "SYN-M-0001",
      firstName: "Tom",
      lastName: "Hanks",
      dateOfBirth: "1983-05-07",
      sex: "M",
      classCode: "C",
      occupation: "Director of Plot Twists",
      phone: null,
      email: "member0001@example.invalid",
      active: true,
    });
    expect(detail["dependents"]).toEqual([
      expect.objectContaining({ fullName: "Otto A Hanks", relationship: "SON", idType: "E-ID", idNumber: "SYN-D-00001", dateOfBirth: "2015-09-27", sex: "M", active: true }),
    ]);
    expect(detail["beneficiaries"]).toEqual([
      expect.objectContaining({ fullName: "Sir Reginald Crumplebottom", relationship: "SIBLING", idType: "E-ID", sharePercent: 60, phone: null, active: true }),
    ]);
  });

  it("flags the records already in the system when the same workbook comes again", async () => {
    const preview = await upload(true);
    expect(preview.status).toBe(200);
    // The member, the dependant and the beneficiary are all on file already.
    expect(preview.body["existingCount"]).toBe(3);
    const rows = preview.body["rows"] as { existingRecord: boolean; recordType: string; changedFields: string[]; message: string }[];
    const member = rows.find((x) => x.recordType === "MEMBER")!;
    expect(member.existingRecord).toBe(true);
    expect(member.changedFields).toEqual([]);
    expect(member.message).toMatch(/Already exists/);
    // Committing them needs an explicit yes.
    const refused = await upload(false);
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe("UPDATES_NOT_CONFIRMED");
  });

  it("updates rather than duplicates when the update is confirmed", async () => {
    const r = await upload(false, true);
    expect(r.status).toBe(200);
    const list = await hr("GET", `/v1/admin/members?company=${company}&pageSize=10`);
    expect(list.body["items"]).toHaveLength(1);
    const detail = (await hr("GET", `/v1/admin/companies/${company}/members/${(list.body["items"] as { memberId: number }[])[0]!.memberId}`)).body;
    expect(detail["dependents"]).toHaveLength(1);
    expect(detail["beneficiaries"]).toHaveLength(1);
  });

  it("keeps a dependant's relationship when a re-import leaves Relationship blank", async () => {
    const blank = DEPENDANTS.map((r, i) => (i === 0 ? r : r.map((c, j) => (DEPENDANTS[0]![j] === "Relationship" ? "" : c))));
    const r = await hr("POST", "/v1/admin/import", {
      sheets: [sheet("dependants", blank)],
      dryRun: false,
      confirmUpdates: true,
      fileName: "dependants-no-relationship.csv",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const list = await hr("GET", `/v1/admin/members?company=${company}&q=SYN-M-0001`);
    const detail = (await hr("GET", `/v1/admin/companies/${company}/members/${(list.body["items"] as { memberId: number }[])[0]!.memberId}`)).body;
    expect(detail["dependents"]).toEqual([expect.objectContaining({ fullName: "Otto A Hanks", relationship: "SON" })]);
  });

  it("holds a leaver with a too-short reason as one row, and still saves the rest", async () => {
    const leaver = (id: string, reason: string) =>
      [company, "Rubicon Logistics", "Passport", id, "Leaver", "Lee", "", "1-Jan-1985", "Male", "C", "", "", "", "", "", "", "", "", "Inactive", "30-Sep-2026", reason, ""];
    const r = await hr("POST", "/v1/admin/import", {
      sheets: [{ name: "members", rows: [MEMBERS[0]!, leaver("SYN-M-0901", "RS"), leaver("SYN-M-0902", "Resigned")] }],
      dryRun: false,
      fileName: "leavers.csv",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rows = r.body["rows"] as { idNumber: string; status: string; reasonCodes: string[] }[];
    expect(rows.find((x) => x.idNumber === "SYN-M-0901")).toMatchObject({ status: "ERROR", reasonCodes: ["INVALID_REASON"] });
    expect(r.body["heldCount"]).toBe(1);
    const saved = await hr("GET", `/v1/admin/members?company=${company}&q=SYN-M-0902`);
    expect(saved.body["items"]).toEqual([expect.objectContaining({ active: false })]);
  });
});
