/**
 * FR-041, FR-042: bulk import holds rows it cannot load in the company's fix
 * list, HR sees only their own company's list, a corrected upload resolves the
 * held record and restores its family, and a failed write leaves the company
 * untouched.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, makeCompany, makeMember, randomIdNumber, startApp, useAppRoleGuard } from "./testDb";
import { makeAdmin, signIn, type AdminClient } from "./adminFixtures";
import { IMPORT_HEADERS_CARRIER, IMPORT_HEADERS_DEPENDANT, IMPORT_HEADERS_LEGACY } from "../lib/memberImport";

type Cells = Record<string, string>;

const sheet = (name: string, header: readonly string[], rows: Cells[]) => ({
  name,
  rows: [[...header], ...rows.map((r) => header.map((h) => r[h] ?? ""))],
});

const memberRow = (companyNumber: string, idNumber: string, extra: Cells = {}): Cells => ({
  "CompanyNumber": companyNumber,
  IDType: "NATIONAL_ID",
  IDNumber: idNumber,
  LastName: "Persaud",
  FirstName: "Asha",
  "DateOfBirth": "1985-04-12",
  ClassCode: "A",
  Email: `${idNumber.toLowerCase()}@import.test`,
  Active: "Yes",
  ...extra,
});

describeDb("import exceptions (FR-041, FR-042)", () => {
  useAppRoleGuard();
  let app: Awaited<ReturnType<typeof startApp>>;
  let hr: AdminClient;
  let companyA: string;
  let companyB: string;

  beforeAll(async () => {
    app = await startApp();
    companyA = await makeCompany("Import A");
    companyB = await makeCompany("Import B");
    hr = await signIn(app.baseUrl, (await makeAdmin("ROLE_HR_ADMIN", { companyScope: companyA })).email);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  const importSheets = (sheets: ReturnType<typeof sheet>[], dryRun: boolean) =>
    hr("POST", "/v1/admin/import", { sheets, dryRun, fileName: "carrier-upload.xlsx" });

  const members = async (companyNumber: string) => {
    const r = await hr("GET", `/v1/admin/members?company=${companyNumber}&pageSize=100`);
    return r;
  };

  it("holds a row with a blank ClassCode under the upload's batch and does not load it", async () => {
    const good = randomIdNumber();
    const blank = randomIdNumber();
    const r = await importSheets(
      [
        sheet("Members", IMPORT_HEADERS_CARRIER, [memberRow(companyA, good), memberRow(companyA, blank, { ClassCode: "" })]),
        sheet("Dependants", IMPORT_HEADERS_DEPENDANT, [
          { CompanyNumber: companyA, MemberIDNumber: blank, FirstName: "Ravi", LastName: "Persaud", Relationship: "Child", DateOfBirth: "2015-06-01" },
        ]),
      ],
      false,
    );
    expect(r.status).toBe(200);
    const rows = r.body["rows"] as { idNumber: string; status: string; held: boolean; reasonCodes: string[] }[];
    const heldRow = rows.find((x) => x.idNumber === blank && x.reasonCodes.includes("MISSING_CLASS"));
    expect(heldRow).toMatchObject({ status: "ERROR", held: true });
    expect(rows.find((x) => x.idNumber === good)?.status).toBe("OK");
    // The dependant travels inside its member's exception, not as a record of its own.
    expect(rows.find((x) => x.reasonCodes.includes("HELD_WITH_MEMBER"))).toBeTruthy();
    expect(r.body["heldCount"]).toBe(1);
    const batches = r.body["batches"] as { companyNumber: string; sourceFile: string; saved: boolean }[];
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ companyNumber: companyA, saved: true });
    expect(batches[0]!.sourceFile).toMatch(new RegExp(`^${companyA}-\\d{8}-\\d{4,}\\.xlsx$`));

    const list = await hr("GET", `/v1/admin/companies/${companyA}/import-exceptions?status=OPEN`);
    expect(list.status).toBe(200);
    const exceptions = list.body["exceptions"] as Record<string, unknown>[];
    const held = exceptions.find((e) => e["memberIdentifier"] === blank);
    expect(held).toMatchObject({
      entityType: "MEMBER",
      personName: "Asha Persaud",
      status: "OPEN",
      source: "BULK_IMPORT",
      sourceFile: batches[0]!.sourceFile,
      originalFileName: "carrier-upload.xlsx",
    });
    expect(held!["reasonCodes"]).toContain("MISSING_CLASS");
    // The snapshot never leaves the server.
    expect(JSON.stringify(list.body)).not.toContain("rawRowSummary");
    expect(JSON.stringify(list.body)).not.toContain("Ravi");

    const listed = await members(companyA);
    const ids = JSON.stringify(listed.body);
    expect(ids).toContain(good);
    expect(ids).not.toContain(blank);
  });

  it("shows HR only their own company's fix list", async () => {
    const other = await hr("GET", `/v1/admin/companies/${companyB}/import-exceptions`);
    expect(other.status).toBe(404);
  });

  it("a corrected row resolves the exception and restores the held dependant", async () => {
    const idNumber = randomIdNumber();
    await importSheets(
      [
        sheet("Members", IMPORT_HEADERS_CARRIER, [memberRow(companyA, idNumber, { ClassCode: "" })]),
        sheet("Dependants", IMPORT_HEADERS_DEPENDANT, [
          { CompanyNumber: companyA, MemberIDNumber: idNumber, FirstName: "Mira", LastName: "Persaud", Relationship: "Child", DateOfBirth: "2016-02-03" },
        ]),
      ],
      false,
    );
    const open = (await hr("GET", `/v1/admin/companies/${companyA}/import-exceptions?status=OPEN`)).body["exceptions"] as {
      exceptionId: number;
      memberIdentifier: string;
    }[];
    const exceptionId = open.find((e) => e.memberIdentifier === idNumber)!.exceptionId;

    const corrected = [sheet("Members", IMPORT_HEADERS_CARRIER, [memberRow(companyA, idNumber, { ClassCode: "B" })])];
    const preview = await importSheets(corrected, true);
    expect(preview.status).toBe(200);
    expect((preview.body["rows"] as { resolvesExceptionId: number | null }[])[0]!.resolvesExceptionId).toBe(exceptionId);
    expect(preview.body["resolvedExceptions"]).toEqual([
      expect.objectContaining({ exceptionId, restoredDependents: 1, restoredBeneficiaries: 0 }),
    ]);

    const commit = await importSheets(corrected, false);
    expect(commit.status).toBe(200);
    const resolved = commit.body["resolvedExceptions"] as { exceptionId: number; memberId: number; restoredDependents: number }[];
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ exceptionId, restoredDependents: 1 });

    const detail = await hr("GET", `/v1/admin/companies/${companyA}/members/${resolved[0]!.memberId}`);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).toContain("Mira Persaud");
    expect(JSON.stringify(detail.body)).toContain('"classCode":"B"');

    const after = (await hr("GET", `/v1/admin/companies/${companyA}/import-exceptions`)).body["exceptions"] as {
      exceptionId: number;
      status: string;
      resolvedMemberId: number | null;
    }[];
    expect(after.find((e) => e.exceptionId === exceptionId)).toMatchObject({
      status: "RESOLVED",
      resolvedMemberId: resolved[0]!.memberId,
    });
  });

  it("rolls the whole company back when any write fails", async () => {
    const fine = randomIdNumber();
    const overflow = randomIdNumber();
    const r = await importSheets(
      [
        sheet("Members", IMPORT_HEADERS_CARRIER, [
          memberRow(companyA, fine),
          // Rate Of Pay is numeric(15,2): this value cannot be stored.
          memberRow(companyA, overflow, { "RateOfPay": "100000000000000000" }),
        ]),
      ],
      false,
    );
    expect(r.status).toBe(200);
    const batches = r.body["batches"] as { saved: boolean; sourceFile: string | null }[];
    expect(batches).toEqual([expect.objectContaining({ saved: false, sourceFile: null })]);
    expect(r.body["committedCount"]).toBe(0);
    const listed = JSON.stringify((await members(companyA)).body);
    expect(listed).not.toContain(fine);
    expect(listed).not.toContain(overflow);
  });

  it("refuses an ID registered to another company without saying whose", async () => {
    const elsewhere = await makeMember({ companyNumber: companyB });
    const r = await importSheets(
      [sheet("Members", IMPORT_HEADERS_CARRIER, [memberRow(companyA, elsewhere.idNumber, { IDType: elsewhere.idType })])],
      true,
    );
    const row = (r.body["rows"] as { status: string; message: string; reasonCodes: string[]; duplicate: boolean }[])[0]!;
    expect(row).toMatchObject({ status: "ERROR", duplicate: true });
    expect(row.reasonCodes).toContain("ID_ALREADY_REGISTERED");
    expect(row.message).not.toContain(companyB);
  });

  it("refuses rows for a company outside the scope", async () => {
    const r = await importSheets([sheet("Members", IMPORT_HEADERS_CARRIER, [memberRow(companyB, randomIdNumber())])], true);
    const row = (r.body["rows"] as { status: string; held: boolean; reasonCodes: string[] }[])[0]!;
    expect(row).toMatchObject({ status: "ERROR", held: false });
    expect(row.reasonCodes).toContain("OUT_OF_SCOPE");
  });

  it("withdraws the old 8-column layout", async () => {
    const r = await importSheets(
      [sheet("Old", IMPORT_HEADERS_LEGACY, [{ employeeNumber: "E1", firstName: "A", lastName: "B", companyCode: companyA }])],
      true,
    );
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe("LAYOUT_WITHDRAWN");
  });
});
