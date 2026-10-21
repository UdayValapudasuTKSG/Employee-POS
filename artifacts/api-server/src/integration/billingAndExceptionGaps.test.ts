/**
 * The gaps closed on 2026-09-30:
 *
 *   - held dependant / beneficiary rows, and held rows of members already on
 *     file, are resolved by a corrected row; any held record can be marked
 *     resolved by hand, with a note;
 *   - a new member needs a date of birth (import holds the row without one),
 *     and members without one are flagged;
 *   - draft bills recalculate after a change that moves them, and only then;
 *   - a class is assignable only once its rates are in force by the first
 *     month a member given it now is billed;
 *   - a billing rule's shares total 100 in the database;
 *   - bills carry the client's coverage band codes.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, ensureStandardRates, makeCompany, makeMember, randomIdNumber, startApp, useAppRoleGuard } from "./testDb";
import { makeAdmin, signIn, type AdminClient } from "./adminFixtures";
import { IMPORT_HEADERS_CARRIER, IMPORT_HEADERS_DEPENDANT } from "../lib/memberImport";

type Cells = Record<string, string>;
const sheet = (name: string, header: readonly string[], rows: Cells[]) => ({
  name,
  rows: [[...header], ...rows.map((r) => header.map((h) => r[h] ?? ""))],
});
const CODES = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");
const tiers = (base: number) =>
  [0, 1, 2, 3].map((dependentBand) => {
    const total = base + dependentBand * 1000;
    return { dependentBand, totalPremium: total.toFixed(2), companyPremium: (total * 0.75).toFixed(2), employeePremium: (total * 0.25).toFixed(2) };
  });

describeDb("billing and import-exception gaps (2026-09-30)", () => {
  useAppRoleGuard();
  let app: Awaited<ReturnType<typeof startApp>>;
  let company: string;
  let hr: AdminClient, superAdmin: AdminClient, support: AdminClient;
  let nextMonth: string; // YYYY-MM: the first month a change made now reaches

  beforeAll(async () => {
    app = await startApp();
    await ensureStandardRates();
    company = await makeCompany("Gaps company");
    hr = await signIn(app.baseUrl, (await makeAdmin("ROLE_HR_ADMIN", { companyScope: company })).email);
    superAdmin = await signIn(app.baseUrl, (await makeAdmin("ROLE_PLATFORM_ADMIN")).email);
    support = await signIn(app.baseUrl, (await makeAdmin("ROLE_SUPPORT")).email);
    const { nextBillingMonthStart } = await import("../lib/guyanaTime");
    nextMonth = nextBillingMonthStart().slice(0, 7);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  // Confirmed: some of these uploads deliberately update members already on file.
  const importSheets = (sheets: ReturnType<typeof sheet>[]) =>
    hr("POST", "/v1/admin/import", { sheets, dryRun: false, confirmUpdates: true, fileName: "gaps.xlsx" });
  const exceptions = async () =>
    (await hr("GET", `/v1/admin/companies/${company}/import-exceptions`)).body["exceptions"] as {
      exceptionId: number;
      personName: string | null;
      entityType: string;
      status: string;
      reasonCodes: string[];
      resolutionMethod: string | null;
      resolutionNote: string | null;
    }[];
  const memberRow = (idNumber: string, extra: Cells = {}): Cells => ({
    CompanyNumber: company,
    IDType: "National ID",
    IDNumber: idNumber,
    LastName: "Gap",
    FirstName: "Tess",
    DateOfBirth: "1985-04-12",
    ClassCode: "A",
    Email: `${idNumber.toLowerCase()}@gaps.test`,
    Active: "Yes",
    ...extra,
  });

  // ---- Import exceptions --------------------------------------------------

  it("holds a new member with no date of birth, and a corrected row resolves it", async () => {
    const id = randomIdNumber();
    const held = await importSheets([sheet("members", IMPORT_HEADERS_CARRIER, [memberRow(id, { DateOfBirth: "" })])]);
    expect(held.status).toBe(200);
    expect(held.body["heldCount"]).toBe(1);
    const open = (await exceptions()).find((e) => e.status === "OPEN" && e.reasonCodes.includes("MISSING_DATE_OF_BIRTH"));
    expect(open).toBeDefined();

    const fixed = await importSheets([sheet("members", IMPORT_HEADERS_CARRIER, [memberRow(id)])]);
    expect(fixed.body["heldCount"]).toBe(0);
    const after = (await exceptions()).find((e) => e.exceptionId === open!.exceptionId);
    expect(after).toMatchObject({ status: "RESOLVED", resolutionMethod: "IMPORT" });
  });

  it("resolves a held row of a member already on file when a corrected row updates them", async () => {
    const existing = await makeMember({ companyNumber: company, firstName: "Olive", lastName: "Onfile" });
    const row = memberRow(existing.idNumber, { FirstName: "Olive", LastName: "Onfile" });
    const held = await importSheets([sheet("members", IMPORT_HEADERS_CARRIER, [{ ...row, Email: "not-an-email" }])]);
    expect(held.body["heldCount"]).toBe(1);
    const open = (await exceptions()).find((e) => e.status === "OPEN" && e.reasonCodes.includes("INVALID_EMAIL"));
    expect(open).toBeDefined();

    const fixed = await importSheets([sheet("members", IMPORT_HEADERS_CARRIER, [row])]);
    expect(fixed.status).toBe(200);
    expect((await exceptions()).find((e) => e.exceptionId === open!.exceptionId)).toMatchObject({ status: "RESOLVED", resolutionMethod: "IMPORT" });
  });

  it("resolves a held dependant when a corrected dependant row loads", async () => {
    const parent = await makeMember({ companyNumber: company, firstName: "Paula", lastName: "Parent" });
    const dep = (dob: string): Cells => ({
      CompanyNumber: company,
      MemberIDType: "National ID",
      MemberIDNumber: parent.idNumber,
      FirstName: "Dina",
      LastName: "Parent",
      DateOfBirth: dob,
      Sex: "Female",
      Relationship: "Daughter",
      Active: "Active",
    });
    const held = await importSheets([sheet("dependants", IMPORT_HEADERS_DEPENDANT, [dep("not a date")])]);
    expect(held.body["heldCount"]).toBe(1);
    const open = (await exceptions()).find((e) => e.status === "OPEN" && e.entityType === "DEPENDENT" && e.personName === "Dina Parent");
    expect(open).toBeDefined();

    const fixed = await importSheets([sheet("dependants", IMPORT_HEADERS_DEPENDANT, [dep("2014-06-01")])]);
    expect(fixed.body["heldCount"]).toBe(0);
    expect((fixed.body["resolvedExceptions"] as { exceptionId: number }[]).map((r) => r.exceptionId)).toContain(open!.exceptionId);
    expect((await exceptions()).find((e) => e.exceptionId === open!.exceptionId)).toMatchObject({ status: "RESOLVED", resolutionMethod: "IMPORT" });
    const detail = await hr("GET", `/v1/admin/companies/${company}/members/${parent.memberId}`);
    expect(detail.body["dependents"]).toEqual([expect.objectContaining({ fullName: "Dina Parent", relationship: "DAUGHTER", dateOfBirth: "2014-06-01" })]);
  });

  it("marks a held record resolved by hand, with a note, once", async () => {
    await importSheets([sheet("members", IMPORT_HEADERS_CARRIER, [memberRow(randomIdNumber(), { DateOfBirth: "", FirstName: "Manny" })])]);
    const open = (await exceptions()).find((e) => e.status === "OPEN" && e.personName?.startsWith("Manny"));
    expect(open).toBeDefined();
    const path = `/v1/admin/companies/${company}/import-exceptions/${open!.exceptionId}/resolve`;

    expect((await hr("POST", path, { note: "x" })).body.error?.code).toBe("INVALID_INPUT");
    expect((await support("POST", path, { note: "Not needed any more" })).status).toBe(403);
    const ok = await hr("POST", path, { note: "Added by hand on the member's page" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "RESOLVED", resolutionMethod: "MANUAL", resolutionNote: "Added by hand on the member's page" });
    expect((await hr("POST", path, { note: "Again" })).body.error?.code).toBe("ALREADY_RESOLVED");
    expect((await hr("POST", `/v1/admin/companies/${company}/import-exceptions/999999999/resolve`, { note: "Nope" })).status).toBe(404);
  });

  // ---- Date of birth --------------------------------------------------------

  it("requires a date of birth for a new member, keeps it from being cleared, and flags members without one", async () => {
    const body = { idType: "NATIONAL ID", idNumber: randomIdNumber(), firstName: "No", lastName: "Dob", classCode: "A", reason: "test" };
    const refused = await hr("POST", `/v1/admin/companies/${company}/members`, body);
    expect(refused.status).toBe(400);
    expect(refused.body.error?.message).toMatch(/date of birth/i);

    const withDob = await makeMember({ companyNumber: company, firstName: "Has", lastName: "Dob" });
    const cleared = await hr("PATCH", `/v1/admin/companies/${company}/members/${withDob.memberId}`, { dateOfBirth: "", reason: "test" });
    expect(cleared.status).toBe(400);

    const legacy = await makeMember({ companyNumber: company, firstName: "Legacy", lastName: "Nodob", dateOfBirth: null });
    const dash = await hr("GET", "/v1/admin/dashboard");
    expect(dash.body["membersWithoutDateOfBirth"]).toBeGreaterThanOrEqual(1);
    const list = await hr("GET", `/v1/admin/members?company=${company}&missingDateOfBirth=true&pageSize=100`);
    const ids = (list.body["items"] as { memberId: number }[]).map((m) => m.memberId);
    expect(ids).toContain(legacy.memberId);
    expect(ids).not.toContain(withDob.memberId);
  });

  // ---- Billing ----------------------------------------------------------------

  it("recalculates a draft bill when a dependant is added, and keeps it when nothing billable changed", async () => {
    const co = await makeCompany("Recalc company");
    const hrCo = await signIn(app.baseUrl, (await makeAdmin("ROLE_HR_ADMIN", { companyScope: co })).email);
    const m = await makeMember({ companyNumber: co, firstName: "Rita", lastName: "Recalc" });
    const gen = await superAdmin("POST", "/v1/admin/billing/runs", { month: nextMonth, companies: [co] });
    expect(gen.status).toBe(200);
    const first = (gen.body["results"] as { runId: number; status: string }[])[0]!;
    expect(first.status).toBe("DRAFT");
    const draftOf = async () =>
      ((await superAdmin("GET", `/v1/admin/billing/runs?company=${co}&month=${nextMonth}`)).body["runs"] as { billingRunId: number; status: string }[])
        .filter((r) => r.status === "DRAFT");
    const linesOf = async (runId: number) =>
      (await superAdmin("GET", `/v1/admin/billing/runs/${runId}`)).body["lines"] as { coverageBand: string; coverageLabel: string }[];
    expect(await linesOf(first.runId)).toEqual([expect.objectContaining({ coverageBand: "EMP_ONLY", coverageLabel: "Employee only" })]);

    // Not billable: the draft stays as it is.
    await hrCo("PATCH", `/v1/admin/companies/${co}/members/${m.memberId}`, { occupation: "Clerk", reason: "test" });
    expect((await draftOf()).map((r) => r.billingRunId)).toEqual([first.runId]);

    // A new dependant moves the tier: the draft is recalculated.
    const added = await hrCo("POST", `/v1/admin/companies/${co}/members/${m.memberId}/dependents`, { fullName: "Ron Recalc", relationship: "SON", reason: "new son" });
    expect(added.status).toBe(200);
    const drafts = await draftOf();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.billingRunId).not.toBe(first.runId);
    expect(await linesOf(drafts[0]!.billingRunId)).toEqual([expect.objectContaining({ coverageBand: "EMP_PLUS_1", coverageLabel: "Employee + 1 dependent" })]);
    const audit = await superAdmin("GET", "/v1/admin/audit?action=BILLING_RUN_RECALCULATED&pageSize=50");
    expect((audit.body["items"] as { reason: string | null }[]).some((i) => i.reason === "Dependant added")).toBe(true);
  });

  it("does not let a class be given before its rates are in force", async () => {
    const list = await superAdmin("GET", "/v1/admin/classes?includeRetired=true");
    const used = new Set((list.body["classes"] as { classCode: string }[]).map((c) => c.classCode));
    const code = CODES.filter((c) => !used.has(c)).at(-2)!;
    expect((await superAdmin("POST", "/v1/admin/classes", { classCode: code, className: `Later ${code}`, reason: "new" })).status).toBe(201);
    expect((await superAdmin("POST", "/v1/admin/rates", { classCode: code, effectiveDate: "2030-01-01", tiers: tiers(7000), reason: "future card" })).status).toBe(201);

    const give = () =>
      hr("POST", `/v1/admin/companies/${company}/members`, {
        idType: "NATIONAL ID", idNumber: randomIdNumber(), firstName: "Early", lastName: "Bird", dateOfBirth: "1990-01-01", classCode: code, reason: "test",
      });
    const early = await give();
    expect(early.status).toBe(400);
    expect(early.body.error?.code).toBe("CLASS_NOT_ASSIGNABLE");
    const classes = (await superAdmin("GET", "/v1/admin/classes")).body["classes"] as { classCode: string; rateComplete: boolean }[];
    expect(classes.find((c) => c.classCode === code)?.rateComplete).toBe(false);

    expect((await superAdmin("POST", "/v1/admin/rates", { classCode: code, effectiveDate: `${nextMonth}-01`, tiers: tiers(6500), reason: "in force" })).status).toBe(201);
    expect((await give()).status).toBe(200);
  });

  it("holds every billing rule's shares to a total of 100 in the database", async () => {
    const db = await import("@workspace/db");
    let code: string | undefined;
    try {
      await db.withScope(db.SYSTEM_SCOPE, (tx) =>
        tx.insert(db.bhiCompanyBillingRuleTable).values({
          companyNumber: company,
          companySharePercent: "80",
          employeeSharePercent: "25",
          effectiveDate: "2031-01-01",
          active: true,
        }),
      );
    } catch (err) {
      code = ((err as { cause?: { code?: string } }).cause ?? (err as { code?: string })).code;
    }
    expect(code).toBe("23514");
  });
});
