import { describe, expect, it } from "vitest";
import {
  BHI_SIZES,
  DEPENDANT_RELATIONSHIPS,
  ID_TYPES,
  IMPORT_HEADERS_BENEFICIARY,
  IMPORT_HEADERS_CARRIER,
  IMPORT_HEADERS_DEPENDANT,
  IMPORT_HEADERS_LEGACY,
  IMPORT_LAYOUTS,
  beneficiaryMatchKey,
  dependantMatchKey,
  detectLayout,
  mapBeneficiaryRow,
  mapDependantRow,
  mapRow,
  missingColumns,
  normaliseBeneficiaryRelationship,
  normaliseIdType,
  normaliseRelationship,
  normaliseSex,
  parseDelimited,
  parseImportBoolean,
  parseImportDate,
  parseImportMoney,
  parseSharePercent,
  sniffDelimiter,
} from "./memberImport";

/**
 * The Beneficiaries sheet as the carrier actually ships it — note LastName and
 * FirstName appear twice, the first pair being the member's and the second the
 * beneficiary's. Built positionally rather than from a keyed object, because a
 * key cannot express "the second FirstName".
 */
const BENEFICIARY_SHEET_HEADER = [
  "LastName", "FirstName", "CompanyNumber", "MemberIDType", "MemberIDNumber",
  "BeneficiaryIDType", "BeneficiaryIDNumber", "FirstName", "LastName",
  "DateOfBirth", "Sex", "Phone", "Email", "SharePercent", "Active",
  "InactiveDate", "InactiveReason", "Notes",
];

const beneficiaryRow = (over: Record<string, string> = {}): string[] => {
  const cells = [
    "Sampson",              // member LastName
    "Devon",                // member FirstName
    "1001",                 // CompanyNumber
    "NIS",                  // MemberIDType
    "A1234567",             // MemberIDNumber
    "PASSPORT",             // BeneficiaryIDType
    "P-4471209",            // BeneficiaryIDNumber
    "Rohini",               // beneficiary FirstName
    "Persaud",              // beneficiary LastName
    "1979-11-02",           // DateOfBirth
    "Female",               // Sex
    "+592-611-4402",        // Phone
    "rohini@example.test",  // Email
    "60",                   // SharePercent
    "Yes",                  // Active
    "",                     // InactiveDate
    "",                     // InactiveReason
    "",                     // Notes
  ];
  // Overrides key off the header name; the duplicated pairs are addressed as
  // "MemberLastName"/"MemberFirstName" for the first and the plain name for the
  // second, matching how the mapper reads them.
  const positions: Record<string, number> = {
    MemberLastName: 0, MemberFirstName: 1, CompanyNumber: 2, MemberIDType: 3,
    MemberIDNumber: 4, BeneficiaryIDType: 5, BeneficiaryIDNumber: 6,
    FirstName: 7, LastName: 8, DateOfBirth: 9, Sex: 10, Phone: 11, Email: 12,
    SharePercent: 13, Active: 14, InactiveDate: 15, InactiveReason: 16, Notes: 17,
  };
  for (const [key, value] of Object.entries(over)) {
    cells[positions[key]!] = value;
  }
  return cells;
};

const carrierRow = (over: Partial<Record<string, string>> = {}): string[] => {
  const base: Record<string, string> = {
    "CompanyNumber": "1001",
    CompanyName: "Acme Holdings Ltd",
    IDType: "NIS",
    IDNumber: "A1234567",
    LastName: "Sampson",
    FirstName: "Devon",
    MiddleInitials: "R",
    "DateOfBirth": "1988-04-17",
    Sex: "Male",
    // BHI class codes are a single character (BHI_SIZES.classCode).
    ClassCode: "B",
    AddressLine1: "12 Water Street",
    AddressLine2: "Georgetown",
    Phone: "+592-623-0800",
    Email: "devon@example.test",
    EmploymentDate: "2019-06-03",
    PlanDate: "2020-01-01",
    "RateOfPay": "$1,250.75",
    Occupation: "Fitter",
    Active: "Yes",
    InactiveDate: "",
    InactiveReason: "",
    Notes: "",
  };
  return IMPORT_HEADERS_CARRIER.map((h) => over[h] ?? base[h] ?? "");
};

describe("parseDelimited", () => {
  it("keeps commas inside quoted fields", () => {
    const rows = parseDelimited('a,b,c\n"12 Water Street, Lot 3",Georgetown,x');
    expect(rows[1]).toEqual(["12 Water Street, Lot 3", "Georgetown", "x"]);
  });

  it("unescapes doubled quotes", () => {
    const rows = parseDelimited('a\n"He said ""hi"""');
    expect(rows[1]).toEqual(['He said "hi"']);
  });

  it("keeps newlines inside quoted fields", () => {
    const rows = parseDelimited('notes\n"line one\nline two"');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(["line one\nline two"]);
  });

  it("handles CRLF and drops blank rows", () => {
    const rows = parseDelimited("a,b\r\n1,2\r\n\r\n3,4\r\n");
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("strips a UTF-8 BOM from the first cell", () => {
    const rows = parseDelimited("﻿Company Number,CompanyName\n1001,Acme");
    expect(rows[0]![0]).toBe("Company Number");
  });

  it("reads tab-separated files, which is what pasting from Excel produces", () => {
    const rows = parseDelimited("a\tb\tc\n1\t2\t3");
    expect(rows[1]).toEqual(["1", "2", "3"]);
  });

  it("prefers the delimiter that actually separates the header", () => {
    // Commas appear inside the data but tabs are the real separator.
    expect(sniffDelimiter("Company Number\tAddressLine1\tNotes")).toBe("\t");
    expect(sniffDelimiter("employeeNumber,firstName,lastName")).toBe(",");
  });
});

describe("detectLayout", () => {
  it("recognises the 22-column carrier layout", () => {
    expect(detectLayout([...IMPORT_HEADERS_CARRIER])).toBe("CARRIER");
  });

  it("recognises the legacy 8-column layout", () => {
    expect(detectLayout([...IMPORT_HEADERS_LEGACY])).toBe("LEGACY");
  });

  it("ignores case, spacing and column order", () => {
    const shuffled = [...IMPORT_HEADERS_CARRIER].reverse().map((h) => h.toUpperCase());
    expect(detectLayout(shuffled)).toBe("CARRIER");
    expect(detectLayout(["EMPLOYEE_NUMBER", "first name", "LastName", "date of birth",
      "identification id", "email", "phone", "company code"])).toBe("LEGACY");
  });

  it("returns null for an unrelated header", () => {
    expect(detectLayout(["foo", "bar", "baz"])).toBeNull();
  });

  it("reports the columns a partial carrier header is missing", () => {
    const header = [...IMPORT_HEADERS_CARRIER].filter((h) => h !== "Notes" && h !== "Sex");
    expect(detectLayout(header)).toBe("CARRIER");
    expect(missingColumns(header, "CARRIER")).toEqual(["Sex", "Notes"]);
  });
});

describe("parseImportDate", () => {
  it("accepts ISO", () => {
    expect(parseImportDate("1988-04-17")).toBe("1988-04-17");
    expect(parseImportDate("1988-4-7")).toBe("1988-04-07");
  });

  it("accepts US slash dates, and switches to D/M/Y when the first part cannot be a month", () => {
    expect(parseImportDate("4/17/1988")).toBe("1988-04-17");
    expect(parseImportDate("17/4/1988")).toBe("1988-04-17");
  });

  it("accepts named months", () => {
    expect(parseImportDate("17-Apr-1988")).toBe("1988-04-17");
    expect(parseImportDate("3 January 2020")).toBe("2020-01-03");
  });

  it("accepts Excel serial numbers", () => {
    // 44197 is 2021-01-01 in Excel's 1900 date system.
    expect(parseImportDate("44197")).toBe("2021-01-01");
  });

  // Every shape below was taken from a real BHI/EBB carrier workbook, which
  // mixes at least four date formats in one column.
  it("accepts a two-digit year with a named month", () => {
    expect(parseImportDate("28-Jun-00")).toBe("2000-06-28");
    expect(parseImportDate("06-Jun-05")).toBe("2005-06-06");
    // 70 and above reads as 19xx, which is right for a date of birth.
    expect(parseImportDate("15-Mar-88")).toBe("1988-03-15");
  });

  it("reads dash-separated numeric dates day-first", () => {
    expect(parseImportDate("20-03-1961")).toBe("1961-03-20");
    expect(parseImportDate("30-01-1992")).toBe("1992-01-30");
    expect(parseImportDate("18-07-1989")).toBe("1989-07-18");
    // The ambiguous case must follow the same convention as its neighbours in
    // the column, not flip to month-first.
    expect(parseImportDate("04-09-1973")).toBe("1973-09-04");
    expect(parseImportDate("04-09-73")).toBe("1973-09-04");
  });

  it("keeps slashes month-first, which is what Excel en-US writes", () => {
    expect(parseImportDate("4/17/1988")).toBe("1988-04-17");
    expect(parseImportDate("12/01/2021")).toBe("2021-12-01");
    // Separator decides the convention, so the same digits differ by separator.
    expect(parseImportDate("04-09-1973")).not.toBe(parseImportDate("04/09/1973"));
  });

  it("accepts a four-letter month abbreviation", () => {
    expect(parseImportDate("29 Sept 1978")).toBe("1978-09-29");
  });

  // The Dependants sheet is hand-typed, so one column carries all of these.
  it("accepts ordinal suffixes and commas", () => {
    expect(parseImportDate("21st August, 2020")).toBe("2020-08-21");
    expect(parseImportDate("01st November, 1993")).toBe("1993-11-01");
    expect(parseImportDate("26th Nov, 1977")).toBe("1977-11-26");
    expect(parseImportDate("22nd July, 2024")).toBe("2024-07-22");
    expect(parseImportDate("3rd March, 2001")).toBe("2001-03-03");
  });

  it("accepts an ordinal date with no comma", () => {
    expect(parseImportDate("6th January 2020")).toBe("2020-01-06");
    expect(parseImportDate("31st December 2010")).toBe("2010-12-31");
  });

  it("accepts a month name run into the year", () => {
    expect(parseImportDate("8 Oct2015")).toBe("2015-10-08");
    expect(parseImportDate("8Oct 2015")).toBe("2015-10-08");
  });

  it("accepts a space before the ordinal suffix", () => {
    expect(parseImportDate("17 th Feb 1989")).toBe("1989-02-17");
    expect(parseImportDate("15 Th Jan 1980")).toBe("1980-01-15");
    expect(parseImportDate("12 th July 1987")).toBe("1987-07-12");
  });

  it("refuses typos rather than guessing at them", () => {
    // A wrong date of birth is worse than a row the operator has to look at.
    for (const bad of ["29 Aoril 1971", "14t April 1964", "26 THth Jan 1987"]) {
      expect(parseImportDate(bad), bad).toBeNull();
    }
  });

  it("does not let the ordinal strip corrupt a month name", () => {
    // "August" contains "st"; stripping must only apply straight after a digit.
    expect(parseImportDate("21 August 2020")).toBe("2020-08-21");
    expect(parseImportDate("1 August 2020")).toBe("2020-08-01");
  });

  it("does not mistake an ISO date for a dash-separated one", () => {
    expect(parseImportDate("2026-08-02")).toBe("2026-08-02");
  });

  it("rejects impossible and unparseable dates", () => {
    expect(parseImportDate("2026-02-30")).toBeNull();
    expect(parseImportDate("not a date")).toBeNull();
    expect(parseImportDate("")).toBeNull();
  });
});

describe("cell coercion", () => {
  it("reads the Active column in the forms a carrier actually writes", () => {
    for (const v of ["Y", "yes", "TRUE", "1", "Active"]) {
      expect(parseImportBoolean(v, false)).toBe(true);
    }
    for (const v of ["N", "no", "FALSE", "0", "Inactive"]) {
      expect(parseImportBoolean(v, true)).toBe(false);
    }
  });

  it("falls back rather than erroring on a blank or odd Active value", () => {
    expect(parseImportBoolean("", true)).toBe(true);
    expect(parseImportBoolean("¯\\_(ツ)_/¯", true)).toBe(true);
  });

  it("strips currency formatting from Rate Of Pay", () => {
    expect(parseImportMoney("$1,250.75")).toBe("1250.75");
    expect(parseImportMoney("  2000 ")).toBe("2000.00");
    expect(parseImportMoney("-15.5")).toBe("-15.50");
    expect(parseImportMoney("")).toBeNull();
    expect(parseImportMoney("n/a")).toBeNull();
  });

  it("normalises Sex to a single letter", () => {
    expect(normaliseSex("Male")).toBe("M");
    expect(normaliseSex("f")).toBe("F");
    expect(normaliseSex("")).toBeNull();
  });
});

describe("mapRow — carrier layout", () => {
  const header = [...IMPORT_HEADERS_CARRIER];

  it("maps every column onto the BHI member record", () => {
    const outcome = mapRow(header, carrierRow(), "CARRIER");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.record).toEqual({
      companyNumber: "1001",
      idType: "NIS",
      idNumber: "A1234567",
      firstName: "Devon",
      lastName: "Sampson",
      middleInitials: "R",
      dateOfBirth: "1988-04-17",
      sex: "M",
      classCode: "B",
      addressLine1: "12 Water Street",
      addressLine2: "Georgetown",
      // Stored E.164 rather than as written: the importer canonicalises member
      // numbers so a pasted "623-0800" and a carrier's "+592-623-0800" become
      // the same row, and so the SMS gateway never has to guess.
      phone: "+5926230800",
      email: "devon@example.test",
      employmentDate: "2019-06-03",
      planDate: "2020-01-01",
      rateOfPay: "1250.75",
      occupation: "Fitter",
      active: true,
      inactiveDate: null,
      inactiveReason: null,
      notes: null,
    });
  });

  it("no longer carries the pre-BHI identity fields", () => {
    const outcome = mapRow(header, carrierRow(), "CARRIER");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    for (const gone of ["employeeNumber", "identificationId", "companyCode", "companyName"]) {
      expect(outcome.record, gone).not.toHaveProperty(gone);
    }
  });

  it("gives each missing required column its own reason code", () => {
    const cases: [string, string][] = [
      ["CompanyNumber", "MISSING_COMPANY_NUMBER"],
      ["IDType", "MISSING_ID_TYPE"],
      ["IDNumber", "MISSING_ID_NUMBER"],
      ["FirstName", "MISSING_NAME"],
      ["LastName", "MISSING_NAME"],
      ["ClassCode", "MISSING_CLASS"],
    ];
    for (const [col, code] of cases) {
      const outcome = mapRow(header, carrierRow({ [col]: "" }), "CARRIER");
      expect(outcome.ok, `${col} should be required`).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.reasonCodes, col).toEqual([code]);
      expect(outcome.message, col).toContain(col);
      expect(outcome.message, col).toContain("is required");
    }
  });

  it("treats a whitespace-only required value as missing", () => {
    const outcome = mapRow(header, carrierRow({ ClassCode: "   " }), "CARRIER");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reasonCodes).toEqual(["MISSING_CLASS"]);
  });

  it("reports every missing column at once, and one MISSING_NAME for both names", () => {
    const outcome = mapRow(
      header,
      carrierRow({ IDType: "", FirstName: "", LastName: "", ClassCode: "" }),
      "CARRIER",
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reasonCodes).toEqual(["MISSING_ID_TYPE", "MISSING_NAME", "MISSING_CLASS"]);
    expect(outcome.message).toBe("IDType, FirstName and LastName, ClassCode are required.");
    expect(outcome.name).toBeNull();
  });

  it("no longer falls back to CompanyName when Company Number is blank", () => {
    const outcome = mapRow(
      header,
      carrierRow({ "CompanyNumber": "", CompanyName: "EBB" }),
      "CARRIER",
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reasonCodes).toEqual(["MISSING_COMPANY_NUMBER"]);
  });

  it("identifies the failing row by ID number and name", () => {
    const outcome = mapRow(header, carrierRow({ ClassCode: "" }), "CARRIER");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.idNumber).toBe("A1234567");
    expect(outcome.name).toBe("Devon Sampson");
  });

  it("reports a null ID number when the row has none", () => {
    const outcome = mapRow(header, carrierRow({ IDNumber: "" }), "CARRIER");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.idNumber).toBeNull();
  });

  it("upper-cases Company Number, IDType and ClassCode", () => {
    const outcome = mapRow(
      header,
      carrierRow({ "CompanyNumber": "ebb-01", IDType: "nis", ClassCode: "b" }),
      "CARRIER",
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.companyNumber).toBe("EBB-01");
    expect(outcome.record.idType).toBe("NIS");
    expect(outcome.record.classCode).toBe("B");
  });

  it("leaves IDNumber as written", () => {
    const outcome = mapRow(header, carrierRow({ IDNumber: "a1234567" }), "CARRIER");
    expect(outcome.ok && outcome.record.idNumber).toBe("a1234567");
  });

  it("refuses an 81-character LastName rather than truncating it", () => {
    const outcome = mapRow(header, carrierRow({ LastName: "S".repeat(81) }), "CARRIER");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reasonCodes).toEqual(["VALUE_TOO_LONG"]);
    expect(outcome.message).toContain("LastName");
    expect(outcome.message).toContain(String(BHI_SIZES.lastName));
  });

  it("accepts a LastName of exactly the column size", () => {
    const outcome = mapRow(header, carrierRow({ LastName: "S".repeat(80) }), "CARRIER");
    expect(outcome.ok).toBe(true);
  });

  it("refuses a two-character ClassCode", () => {
    const outcome = mapRow(header, carrierRow({ ClassCode: "CL" }), "CARRIER");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reasonCodes).toEqual(["VALUE_TOO_LONG"]);
    expect(outcome.message).toContain("ClassCode");
  });

  it("accepts a blank date of birth, which is optional in the BHI model", () => {
    const outcome = mapRow(header, carrierRow({ "DateOfBirth": "" }), "CARRIER");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.dateOfBirth).toBeNull();
  });

  it("rejects a date of birth that is present but unreadable", () => {
    const outcome = mapRow(header, carrierRow({ "DateOfBirth": "??" }), "CARRIER");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reasonCodes).toEqual(["INVALID_DATE"]);
    expect(outcome.message).toContain("DateOfBirth");
  });

  it("applies the same rule to the other date columns", () => {
    for (const col of ["EmploymentDate", "PlanDate", "InactiveDate"]) {
      const outcome = mapRow(header, carrierRow({ [col]: "not a date" }), "CARRIER");
      expect(outcome.ok, col).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.reasonCodes, col).toEqual(["INVALID_DATE"]);
      expect(outcome.message, col).toContain(col);
    }
  });

  it("rejects a malformed email", () => {
    const outcome = mapRow(header, carrierRow({ Email: "nope" }), "CARRIER");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reasonCodes).toEqual(["INVALID_EMAIL"]);
  });

  it("treats an inactive member as data, not an error", () => {
    const outcome = mapRow(
      header,
      carrierRow({ Active: "N", InactiveDate: "2025-12-31", InactiveReason: "Resigned" }),
      "CARRIER",
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.active).toBe(false);
    expect(outcome.record.inactiveDate).toBe("2025-12-31");
    expect(outcome.record.inactiveReason).toBe("Resigned");
  });

  it("leaves optional columns null rather than empty strings", () => {
    const outcome = mapRow(
      header,
      carrierRow({ MiddleInitials: "", Occupation: "", Phone: "", PlanDate: "" }),
      "CARRIER",
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.middleInitials).toBeNull();
    expect(outcome.record.occupation).toBeNull();
    expect(outcome.record.phone).toBeNull();
    expect(outcome.record.planDate).toBeNull();
  });
});

describe("mapRow — legacy layout is withdrawn", () => {
  const header = [...IMPORT_HEADERS_LEGACY];
  const row = [
    "E1001", "Ada", "Persaud", "1990-02-11", "ID-9", "ada@example.test", "+592-555-0100", "BF",
  ];

  it("is still detected, so the route can refuse it by name", () => {
    expect(detectLayout(header)).toBe("LEGACY");
  });

  it("refuses every LEGACY row, even a well-formed one", () => {
    const outcome = mapRow(header, row, "LEGACY");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("no longer accepted");
    expect(outcome.idNumber).toBeNull();
    expect(outcome.name).toBeNull();
  });

  it("refuses by layout, not by content", () => {
    // A perfectly good carrier row is still refused if the caller says LEGACY.
    expect(mapRow([...IMPORT_HEADERS_CARRIER], carrierRow(), "LEGACY").ok).toBe(false);
  });

  it("is not offered in IMPORT_LAYOUTS", () => {
    expect(IMPORT_LAYOUTS.map((l) => l.layout)).not.toContain("LEGACY");
  });
});

// ---------------------------------------------------------------------------
// The phone guard
// ---------------------------------------------------------------------------

/**
 * The importer used to store whatever the phone column held, which is how a bare
 * ten-digit foreign mobile reached the database and then failed at verification
 * time with the carrier appearing to be at fault. Numbers are now checked on the
 * way in, on the Members layout.
 *
 * Shapes, not real numbers: the fictional 555-01xx range stands in for Guyana and
 * a 9155… number for "somewhere else".
 */
describe("mapRow — member phone must be deliverable", () => {
  const carrierHeader = [...IMPORT_HEADERS_CARRIER];
  const withPhone = (phone: string) => mapRow(carrierHeader, carrierRow({ Phone: phone }), "CARRIER");

  it("canonicalises whatever Guyana form the sheet used", () => {
    for (const written of ["5550100", "592-555-0100", "+592 555 0100", "(592) 555-0100"]) {
      const outcome = withPhone(written);
      expect(outcome.ok, written).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.record.phone).toBe("+5925550100");
    }
  });

  it("rejects a number from another country and says which row to fix", () => {
    const outcome = withPhone("9155501234");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The flag is what the screen counts to raise its dialog; without it these
    // rows would be indistinguishable from a malformed date.
    expect(outcome.invalidPhone).toBe(true);
    expect(outcome.reasonCodes).toEqual(["INVALID_PHONE"]);
    expect(outcome.message).toContain("+592");
    expect(outcome.idNumber).toBe("A1234567");
    expect(outcome.name).toBe("Devon Sampson");
  });

  it("rejects a +592 number of the wrong length", () => {
    for (const wrong of ["+592-1", "+5925550100999"]) {
      const outcome = withPhone(wrong);
      expect(outcome.ok, wrong).toBe(false);
      if (outcome.ok) return;
      expect(outcome.invalidPhone).toBe(true);
      expect(outcome.reasonCodes).toEqual(["INVALID_PHONE"]);
    }
  });

  it("treats an empty cell as no phone rather than an error", () => {
    const outcome = withPhone("");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.phone).toBeNull();
  });

  it("treats the carrier's 'No Phone' text as no phone, not as an error", () => {
    // Several carrier rows really do carry this string. Failing them would break
    // a genuine import over a value that already means absence, and the member
    // is still reachable by email.
    const outcome = withPhone("No Phone");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.phone).toBeNull();
  });

  it("does not flag unrelated failures as phone problems", () => {
    // errorCount minus invalidPhoneCount is what the screen shows as "rows that
    // could not be read", so a bad date must not land in the phone bucket.
    const outcome = mapRow(
      carrierHeader,
      carrierRow({ "DateOfBirth": "not-a-date", Phone: "5550100" }),
      "CARRIER",
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.invalidPhone).toBeUndefined();
    expect(outcome.reasonCodes).toEqual(["INVALID_DATE"]);
  });
});

// ---------------------------------------------------------------------------
// Dependants sheet
// ---------------------------------------------------------------------------

const dependantRow = (over: Partial<Record<string, string>> = {}): string[] => {
  const base: Record<string, string> = {
    CompanyNumber: "1001",
    MemberIDType: "NIS",
    MemberIDNumber: "A1234567",
    DependentIDType: "BIRTH_CERT",
    DependentIDNumber: "BC-99881",
    FirstName: "Uma",
    LastName: "Singh",
    DateOfBirth: "2008-05-25",
    Sex: "Female",
    Relationship: "Daughter",
    Active: "Yes",
    InactiveDate: "",
    InactiveReason: "",
    Notes: "",
  };
  return IMPORT_HEADERS_DEPENDANT.map((h) => over[h] ?? base[h] ?? "");
};

describe("detectLayout — telling the two carrier sheets apart", () => {
  it("recognises the 14-column Dependants sheet", () => {
    expect(detectLayout([...IMPORT_HEADERS_DEPENDANT])).toBe("DEPENDANT");
  });

  it("does not confuse it with the Members sheet, despite the shared columns", () => {
    // CompanyNumber, FirstName, LastName, Sex, Active, InactiveDate,
    // InactiveReason and Notes appear in both, and "DateOfBirth" and
    // "DateOfBirth" normalise to the same key.
    expect(detectLayout([...IMPORT_HEADERS_CARRIER])).toBe("CARRIER");
    expect(detectLayout([...IMPORT_HEADERS_DEPENDANT])).toBe("DEPENDANT");
  });

  it("ignores case and column order on the Dependants sheet", () => {
    const shuffled = [...IMPORT_HEADERS_DEPENDANT].reverse().map((h) => h.toUpperCase());
    expect(detectLayout(shuffled)).toBe("DEPENDANT");
  });

  it("reports missing Dependants columns", () => {
    const header = [...IMPORT_HEADERS_DEPENDANT].filter((h) => h !== "Notes" && h !== "Sex");
    expect(detectLayout(header)).toBe("DEPENDANT");
    expect(missingColumns(header, "DEPENDANT")).toEqual(["Sex", "Notes"]);
  });
});

describe("normaliseRelationship", () => {
  it("maps the words carriers actually write onto the Access list", () => {
    expect(normaliseRelationship("Daughter")).toBe("DAUGHTER");
    expect(normaliseRelationship("Son")).toBe("SON");
    expect(normaliseRelationship("Wife")).toBe("SPOUSE");
    expect(normaliseRelationship("Husband")).toBe("SPOUSE");
    expect(normaliseRelationship("Step-Son")).toBe("SON");
    expect(normaliseRelationship("stepdaughter")).toBe("DAUGHTER");
  });

  it("keeps the canonical values unchanged", () => {
    expect([...DEPENDANT_RELATIONSHIPS]).toEqual(["SPOUSE", "SON", "DAUGHTER", "OTHER"]);
    for (const r of DEPENDANT_RELATIONSHIPS) {
      expect(normaliseRelationship(r)).toBe(r);
    }
  });

  it("sends what the list cannot place to OTHER rather than failing the row", () => {
    // A plain "Child" says neither son nor daughter.
    expect(normaliseRelationship("Child")).toBe("OTHER");
    expect(normaliseRelationship("Child1")).toBe("OTHER");
    expect(normaliseRelationship("Mother")).toBe("OTHER");
    expect(normaliseRelationship("Cousin")).toBe("OTHER");
    expect(normaliseRelationship("")).toBe("OTHER");
  });
});

describe("normaliseIdType", () => {
  it("folds the spellings of the three Access ID types onto one stored form", () => {
    for (const v of ["National ID", "NATIONAL ID", "NationalID", "national_id", "NID", "Nat ID"]) {
      expect(normaliseIdType(v), v).toBe("NATIONAL ID");
    }
    for (const v of ["Passport", "PASSPORT", "PP"]) expect(normaliseIdType(v), v).toBe("PASSPORT");
    for (const v of ["E-ID", "EID", "e id", "E_ID"]) expect(normaliseIdType(v), v).toBe("E-ID");
  });

  it("keeps the stored values as they are", () => {
    for (const v of ID_TYPES) expect(normaliseIdType(v)).toBe(v);
  });

  it("keeps other ID types, upper-cased, as before", () => {
    expect(normaliseIdType(" nis ")).toBe("NIS");
    expect(normaliseIdType("Birth_Cert")).toBe("BIRTH_CERT");
  });
});

describe("mapDependantRow", () => {
  const header = [...IMPORT_HEADERS_DEPENDANT];

  it("maps every column onto the BHI dependant", () => {
    const outcome = mapDependantRow(header, dependantRow());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record).toEqual({
      companyNumber: "1001",
      memberIdType: "NIS",
      memberIdNumber: "A1234567",
      idType: "BIRTH_CERT",
      idNumber: "BC-99881",
      fullName: "Uma Singh",
      dateOfBirth: "2008-05-25",
      sex: "F",
      relationship: "DAUGHTER",
      active: true,
      inactiveDate: null,
      inactiveReason: null,
      notes: null,
    });
  });

  it("joins the sheet's first and last name into one full name", () => {
    const outcome = mapDependantRow(header, dependantRow({ FirstName: "Uma Devi", LastName: "Singh" }));
    expect(outcome.ok && outcome.record.fullName).toBe("Uma Devi Singh");
  });

  it("uses whichever name is present when the other is blank", () => {
    const first = mapDependantRow(header, dependantRow({ LastName: "" }));
    expect(first.ok && first.record.fullName).toBe("Uma");
    const last = mapDependantRow(header, dependantRow({ FirstName: "" }));
    expect(last.ok && last.record.fullName).toBe("Singh");
  });

  it("refuses a full name over 120 characters", () => {
    // 60 + space + 60 = 121.
    const outcome = mapDependantRow(
      header,
      dependantRow({ FirstName: "U".repeat(60), LastName: "S".repeat(60) }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reasonCodes).toEqual(["VALUE_TOO_LONG"]);
    expect(outcome.message).toContain(String(BHI_SIZES.fullName));
  });

  it("accepts a full name of exactly 120 characters", () => {
    const outcome = mapDependantRow(
      header,
      dependantRow({ FirstName: "U".repeat(59), LastName: "S".repeat(60) }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.fullName).toHaveLength(120);
  });

  it("stores the dependant's own ID, not the member's", () => {
    const outcome = mapDependantRow(header, dependantRow());
    expect(outcome.ok && outcome.record.idNumber).toBe("BC-99881");
    expect(outcome.ok && outcome.record.idNumber).not.toBe("A1234567");
  });

  it("requires MemberIDNumber", () => {
    const outcome = mapDependantRow(header, dependantRow({ MemberIDNumber: "" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reasonCodes).toEqual(["MISSING_MEMBER_ID"]);
    expect(outcome.memberIdNumber).toBeNull();
    expect(outcome.name).toBe("Uma Singh");
  });

  it("requires at least one name", () => {
    const outcome = mapDependantRow(header, dependantRow({ FirstName: "", LastName: "" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reasonCodes).toEqual(["MISSING_NAME"]);
    expect(outcome.name).toBeNull();
    expect(outcome.memberIdNumber).toBe("A1234567");
  });

  it("says plainly why a row with no MemberIDNumber cannot be linked", () => {
    const outcome = mapDependantRow(header, dependantRow({ MemberIDNumber: "" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("nothing to link this dependant to");
  });

  it("accepts a blank CompanyNumber and leaves the parent to be found by ID", () => {
    const outcome = mapDependantRow(header, dependantRow({ CompanyNumber: "" }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.companyNumber).toBeNull();
    expect(outcome.record.memberIdNumber).toBe("A1234567");
  });

  it("upper-cases CompanyNumber and the ID types", () => {
    const outcome = mapDependantRow(
      header,
      dependantRow({ CompanyNumber: "ebb", MemberIDType: "nis", DependentIDType: "birth_cert" }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.companyNumber).toBe("EBB");
    expect(outcome.record.memberIdType).toBe("NIS");
    expect(outcome.record.idType).toBe("BIRTH_CERT");
  });

  it('treats "-" as no dependant ID, not as an ID', () => {
    const outcome = mapDependantRow(
      header,
      dependantRow({ DependentIDType: "-", DependentIDNumber: "-" }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.idNumber).toBeNull();
    // The type too — a dependant with no ID must not be stored with an
    // id_type of "-".
    expect(outcome.record.idType).toBeNull();
  });

  it("accepts a blank date of birth, which is optional now", () => {
    const outcome = mapDependantRow(header, dependantRow({ DateOfBirth: "" }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.dateOfBirth).toBeNull();
  });

  it("rejects a date of birth that is present but unreadable", () => {
    const outcome = mapDependantRow(header, dependantRow({ DateOfBirth: "??" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reasonCodes).toEqual(["INVALID_DATE"]);
    expect(outcome.message).toContain("DateOfBirth");
  });

  it("rejects an unreadable InactiveDate", () => {
    const outcome = mapDependantRow(header, dependantRow({ InactiveDate: "soon" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reasonCodes).toEqual(["INVALID_DATE"]);
    expect(outcome.message).toContain("InactiveDate");
  });

  it("allows a dependant with no ID of their own, as newborns have none", () => {
    const outcome = mapDependantRow(
      header,
      dependantRow({ DependentIDType: "", DependentIDNumber: "" }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.idNumber).toBeNull();
    expect(outcome.record.idType).toBeNull();
  });

  it("carries an inactive dependant's date and reason", () => {
    const outcome = mapDependantRow(
      header,
      dependantRow({ Active: "N", InactiveDate: "2025-12-31", InactiveReason: "Aged out" }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.active).toBe(false);
    expect(outcome.record.inactiveDate).toBe("2025-12-31");
    expect(outcome.record.inactiveReason).toBe("Aged out");
  });

  it("accepts the same date formats as the Members sheet", () => {
    const outcome = mapDependantRow(header, dependantRow({ DateOfBirth: "5/25/2008" }));
    expect(outcome.ok && outcome.record.dateOfBirth).toBe("2008-05-25");
  });
});

describe("dependantMatchKey", () => {
  const base = { fullName: "Uma Singh", dateOfBirth: "2008-05-25" };

  it("prefers the dependant's own ID number", () => {
    expect(dependantMatchKey({ ...base, idNumber: "BC-99881" })).toBe("id:bc-99881");
  });

  it("is case and whitespace insensitive on the ID", () => {
    expect(dependantMatchKey({ ...base, idNumber: " BC-99881 " })).toBe(
      dependantMatchKey({ ...base, idNumber: "bc-99881" }),
    );
  });

  it("falls back to full name and date of birth when there is no ID", () => {
    expect(dependantMatchKey({ ...base, idNumber: null })).toBe("name:uma singh|2008-05-25");
  });

  it("collapses case and runs of whitespace in the name", () => {
    expect(dependantMatchKey({ ...base, fullName: "  UMA   Singh ", idNumber: null })).toBe(
      dependantMatchKey({ ...base, idNumber: null }),
    );
  });

  it("keys on name alone when the date of birth is unknown", () => {
    expect(dependantMatchKey({ ...base, dateOfBirth: null, idNumber: null })).toBe("name:uma singh|");
  });

  it("distinguishes two children by name", () => {
    expect(dependantMatchKey({ ...base, fullName: "Uma Singh", idNumber: null })).not.toBe(
      dependantMatchKey({ ...base, fullName: "Uma Devi Singh", idNumber: null }),
    );
  });

  it("treats an ID-bearing and an ID-less row as different", () => {
    // Deliberate. Matching on name while an ID is present would merge two
    // children who happen to share a name and date of birth.
    expect(dependantMatchKey({ ...base, idNumber: "BC-1" })).not.toBe(
      dependantMatchKey({ ...base, idNumber: null }),
    );
  });

  it("is stable across re-imports of the same row", () => {
    const header = [...IMPORT_HEADERS_DEPENDANT];
    const first = mapDependantRow(header, dependantRow({ DependentIDNumber: "" }));
    const second = mapDependantRow(header, dependantRow({ DependentIDNumber: "" }));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(dependantMatchKey(first.record)).toBe(dependantMatchKey(second.record));
  });
});

describe("detectLayout — telling the Beneficiaries sheet from the other two", () => {
  it("recognises the beneficiary layout as the carrier ships it", () => {
    expect(detectLayout(BENEFICIARY_SHEET_HEADER)).toBe("BENEFICIARY");
  });

  it("recognises it from the deduplicated header constant too", () => {
    expect(detectLayout([...IMPORT_HEADERS_BENEFICIARY])).toBe("BENEFICIARY");
  });

  it("does not read a Beneficiaries sheet as Dependants", () => {
    // 11 of the 14 Dependants keys are present in a Beneficiaries sheet, so a
    // plain hit count gets this wrong. The unique columns are what decide it.
    expect(detectLayout(BENEFICIARY_SHEET_HEADER)).not.toBe("DEPENDANT");
  });

  it("does not read a Dependants or Members sheet as Beneficiaries", () => {
    expect(detectLayout([...IMPORT_HEADERS_DEPENDANT])).toBe("DEPENDANT");
    expect(detectLayout([...IMPORT_HEADERS_CARRIER])).toBe("CARRIER");
  });

  it("ignores case and column order", () => {
    const shuffled = [...BENEFICIARY_SHEET_HEADER].reverse().map((h) => h.toUpperCase());
    expect(detectLayout(shuffled)).toBe("BENEFICIARY");
  });

  it("reports the columns a partial beneficiary header is missing", () => {
    const header = BENEFICIARY_SHEET_HEADER.filter((h) => h !== "Sex" && h !== "Notes");
    expect(detectLayout(header)).toBe("BENEFICIARY");
    expect(missingColumns(header, "BENEFICIARY")).toEqual(["Sex", "Notes"]);
  });
});

describe("parseSharePercent", () => {
  it("reads a plain percentage", () => {
    expect(parseSharePercent("60")).toBe(60);
  });

  it("strips a percent sign and thousands commas", () => {
    expect(parseSharePercent("60%")).toBe(60);
    expect(parseSharePercent(" 33.33 % ")).toBe(33.33);
  });

  it("keeps two decimals, so a three-way split survives", () => {
    expect(parseSharePercent("33.33")).toBe(33.33);
    expect(parseSharePercent("33.34")).toBe(33.34);
  });

  it("treats a blank cell as no share stated", () => {
    expect(parseSharePercent("")).toBeNull();
    expect(parseSharePercent("   ")).toBeNull();
  });

  it("rejects anything outside 0-100", () => {
    expect(parseSharePercent("101")).toBeNull();
    expect(parseSharePercent("-5")).toBeNull();
  });

  it("does not infer a fraction from a value below 1", () => {
    // "0.5" means half of one percent. A sheet meaning half the payout writes
    // 50, and guessing the other way would reassign 49.5% of a death benefit.
    expect(parseSharePercent("0.5")).toBe(0.5);
  });

  it("rejects text", () => {
    expect(parseSharePercent("half")).toBeNull();
    expect(parseSharePercent("50/50")).toBeNull();
  });
});

describe("mapBeneficiaryRow", () => {
  const header = BENEFICIARY_SHEET_HEADER;

  it("maps every column onto the BHI beneficiary", () => {
    const outcome = mapBeneficiaryRow(header, beneficiaryRow());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record).toEqual({
      companyNumber: "1001",
      memberIdType: "NIS",
      memberIdNumber: "A1234567",
      memberName: "Devon Sampson",
      idType: "PASSPORT",
      idNumber: "P-4471209",
      fullName: "Rohini Persaud",
      dateOfBirth: "1979-11-02",
      sex: "F",
      // The older carrier sheet has no Relationship column.
      relationship: null,
      phone: "+592-611-4402",
      email: "rohini@example.test",
      sharePercent: 60,
      active: true,
      inactiveDate: null,
      inactiveReason: null,
      notes: null,
    });
  });

  it("takes the SECOND name pair as the beneficiary, not the member's", () => {
    // This is the whole reason the layout needs occurrence-aware lookup.
    const outcome = mapBeneficiaryRow(header, beneficiaryRow());
    expect(outcome.ok && outcome.record.fullName).toBe("Rohini Persaud");
    expect(outcome.ok && outcome.record.memberName).toBe("Devon Sampson");
  });

  it("stores the beneficiary's own ID, not the member's", () => {
    const outcome = mapBeneficiaryRow(header, beneficiaryRow());
    expect(outcome.ok && outcome.record.idNumber).toBe("P-4471209");
    expect(outcome.ok && outcome.record.idNumber).not.toBe("A1234567");
  });

  it("reads a single name pair as the beneficiary's", () => {
    // A file without the member's name columns must still import: the member is
    // found by ID number, never by name, so nothing can be mis-assigned.
    const trimmed = [
      "CompanyNumber", "MemberIDType", "MemberIDNumber", "BeneficiaryIDType",
      "BeneficiaryIDNumber", "FirstName", "LastName", "DateOfBirth", "Sex",
      "Phone", "Email", "SharePercent", "Active", "InactiveDate",
      "InactiveReason", "Notes",
    ];
    const cells = [
      "1001", "NIS", "A1234567", "PASSPORT", "P-4471209", "Rohini", "Persaud",
      "1979-11-02", "F", "", "", "60", "Yes", "", "", "",
    ];
    const outcome = mapBeneficiaryRow(trimmed, cells);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.fullName).toBe("Rohini Persaud");
  });

  it("requires MemberIDNumber", () => {
    const outcome = mapBeneficiaryRow(header, beneficiaryRow({ MemberIDNumber: "" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reasonCodes).toEqual(["MISSING_MEMBER_ID"]);
    expect(outcome.memberIdNumber).toBeNull();
    expect(outcome.name).toBe("Rohini Persaud");
  });

  it("requires at least one beneficiary name", () => {
    const outcome = mapBeneficiaryRow(header, beneficiaryRow({ FirstName: "", LastName: "" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reasonCodes).toEqual(["MISSING_NAME"]);
    expect(outcome.memberIdNumber).toBe("A1234567");
  });

  it("refuses a beneficiary full name over 120 characters", () => {
    const outcome = mapBeneficiaryRow(
      header,
      beneficiaryRow({ FirstName: "R".repeat(60), LastName: "P".repeat(60) }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reasonCodes).toEqual(["VALUE_TOO_LONG"]);
  });

  it("says plainly why a row with no MemberIDNumber cannot be linked", () => {
    const outcome = mapBeneficiaryRow(header, beneficiaryRow({ MemberIDNumber: "" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("nothing to link this beneficiary to");
  });

  it("accepts a blank CompanyNumber and leaves the member to be found by ID", () => {
    const outcome = mapBeneficiaryRow(header, beneficiaryRow({ CompanyNumber: "" }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.companyNumber).toBeNull();
    expect(outcome.record.memberIdNumber).toBe("A1234567");
  });

  it("upper-cases CompanyNumber and the ID types", () => {
    const outcome = mapBeneficiaryRow(
      header,
      beneficiaryRow({ CompanyNumber: "ebb", MemberIDType: "nis", BeneficiaryIDType: "passport" }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.companyNumber).toBe("EBB");
    expect(outcome.record.memberIdType).toBe("NIS");
    expect(outcome.record.idType).toBe("PASSPORT");
  });

  it("accepts a blank date of birth, which adults routinely have", () => {
    const outcome = mapBeneficiaryRow(header, beneficiaryRow({ DateOfBirth: "" }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.dateOfBirth).toBeNull();
  });

  it("rejects a date of birth that is present but unreadable", () => {
    // Different from blank: the file meant to supply one, so dropping it
    // silently would lose data.
    const outcome = mapBeneficiaryRow(header, beneficiaryRow({ DateOfBirth: "??" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reasonCodes).toEqual(["INVALID_DATE"]);
    expect(outcome.message).toContain("DateOfBirth");
  });

  it("rejects an unreadable SharePercent rather than storing nothing", () => {
    const outcome = mapBeneficiaryRow(header, beneficiaryRow({ SharePercent: "most of it" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reasonCodes).toEqual(["INVALID_SHARE"]);
    expect(outcome.message).toContain("SharePercent");
  });

  it("accepts a blank SharePercent as no share stated", () => {
    const outcome = mapBeneficiaryRow(header, beneficiaryRow({ SharePercent: "" }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.sharePercent).toBeNull();
  });

  it('treats "-" as no beneficiary ID, not as an ID', () => {
    const outcome = mapBeneficiaryRow(
      header,
      beneficiaryRow({ BeneficiaryIDType: "-", BeneficiaryIDNumber: "-" }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.idNumber).toBeNull();
    expect(outcome.record.idType).toBeNull();
  });

  it("rejects an invalid email", () => {
    const outcome = mapBeneficiaryRow(header, beneficiaryRow({ Email: "not-an-address" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reasonCodes).toEqual(["INVALID_EMAIL"]);
  });

  it("carries an inactive beneficiary's date and reason", () => {
    const outcome = mapBeneficiaryRow(
      header,
      beneficiaryRow({ Active: "N", InactiveDate: "2025-12-31", InactiveReason: "Deceased" }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.active).toBe(false);
    expect(outcome.record.inactiveDate).toBe("2025-12-31");
    expect(outcome.record.inactiveReason).toBe("Deceased");
  });

  it("accepts the same date formats as the Members sheet", () => {
    const outcome = mapBeneficiaryRow(header, beneficiaryRow({ DateOfBirth: "2/11/1979" }));
    expect(outcome.ok && outcome.record.dateOfBirth).toBe("1979-02-11");
  });
});

describe("beneficiaryMatchKey", () => {
  const base = { fullName: "Rohini Persaud", dateOfBirth: "1979-11-02" };

  it("prefers the beneficiary's own ID number", () => {
    expect(beneficiaryMatchKey({ ...base, idNumber: "P-4471209" })).toBe("id:p-4471209");
  });

  it("falls back to full name and date of birth when there is no ID", () => {
    expect(beneficiaryMatchKey({ ...base, idNumber: null })).toBe(
      "name:rohini persaud|1979-11-02",
    );
  });

  it("matches on name alone when neither an ID nor a date of birth is given", () => {
    // The weakest key the data supports, and still better than inserting a
    // second copy of the same person on every re-import.
    expect(beneficiaryMatchKey({ ...base, dateOfBirth: null, idNumber: null })).toBe(
      "name:rohini persaud|",
    );
  });

  it("is stable across re-imports of the same row", () => {
    const first = mapBeneficiaryRow(BENEFICIARY_SHEET_HEADER, beneficiaryRow());
    const second = mapBeneficiaryRow(BENEFICIARY_SHEET_HEADER, beneficiaryRow());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(beneficiaryMatchKey(first.record)).toBe(beneficiaryMatchKey(second.record));
  });
});

describe("IMPORT_LAYOUTS", () => {
  it("describes every layout the importer accepts, and not the withdrawn one", () => {
    expect(IMPORT_LAYOUTS.map((l) => l.layout).sort()).toEqual([
      "BENEFICIARY",
      "CARRIER",
      "DEPENDANT",
    ]);
  });

  it("advertises the client's three sheets, column for column", () => {
    const columns = (layout: string) => IMPORT_LAYOUTS.find((l) => l.layout === layout)!.columns;
    expect(columns("CARRIER")).toEqual(CLIENT_MEMBERS_HEADER);
    expect(columns("DEPENDANT")).toEqual(CLIENT_DEPENDANTS_HEADER);
    expect(columns("BENEFICIARY")).toEqual(CLIENT_BENEFICIARIES_HEADER);
  });

  it("advertises columns a file with those exact headers would be detected as", () => {
    for (const { layout, columns } of IMPORT_LAYOUTS) {
      expect(detectLayout(columns), `${layout} template must round-trip`).toBe(layout);
    }
  });
});

// The client's sample rows (2026-09-29), exactly as sent: tab-separated, with
// Access-style dates, "Male", "Active" and a thousands separator in RateOfPay.
const CLIENT_MEMBERS_HEADER = [
  "CompanyNumber", "CompanyName", "IDType", "IDNumber", "LastName", "FirstName", "MiddleInitials",
  "DateOfBirth", "Sex", "ClassCode", "AddressLine1", "AddressLine2", "Phone", "Email", "EmploymentDate",
  "PlanDate", "RateOfPay", "Occupation", "Active", "InactiveDate", "InactiveReason", "Notes",
];
const CLIENT_DEPENDANTS_HEADER = [
  "CompanyNumber", "MemberIDType", "MemberIDNumber", "DependentIDType", "DependentIDNumber", "FirstName",
  "LastName", "DateOfBirth", "Sex", "Relationship", "Active", "InactiveDate", "InactiveReason", "Notes",
];
const CLIENT_BENEFICIARIES_HEADER = [
  "CompanyNumber", "MemberIDType", "MemberIDNumber", "BeneficiaryIDType", "BeneficiaryIDNumber", "FirstName",
  "LastName", "DateOfBirth", "Sex", "Relationship", "Phone", "Email", "SharePercent", "Active",
  "InactiveDate", "InactiveReason", "Notes",
];
const tsv = (header: string[], ...rows: string[][]) => [header, ...rows].map((r) => r.join("\t")).join("\n");

describe("the client's sample sheets", () => {
  it("imports the members row", () => {
    const [header, cells] = parseDelimited(tsv(CLIENT_MEMBERS_HEADER, [
      "SYN001", "Rubicon Logistics", "Passport", "SYN-M-0001", "Hanks", "Tom", "", "7-May-1983", "Male", "C",
      "1 Paradox Lane", "Fictional Test District", "000-000-0000", "member0001@example.invalid", "18-Mar-2023",
      "1-Jan-2026", "370,000", "Director of Plot Twists", "Active", "", "",
      "SYNTHETIC TEST DATA. Movie stars. All personal details and family links are invented.",
    ]));
    expect(detectLayout(header!)).toBe("CARRIER");
    expect(missingColumns(header!, "CARRIER")).toEqual([]);
    const outcome = mapRow(header!, cells!, "CARRIER");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record).toMatchObject({
      companyNumber: "SYN001",
      idType: "PASSPORT",
      idNumber: "SYN-M-0001",
      firstName: "Tom",
      lastName: "Hanks",
      dateOfBirth: "1983-05-07",
      sex: "M",
      classCode: "C",
      employmentDate: "2023-03-18",
      planDate: "2026-01-01",
      rateOfPay: "370000.00",
      // 000-000-0000 is the sheet's way of saying no number.
      phone: null,
      active: true,
    });
  });

  it("imports the dependants row", () => {
    const [header, cells] = parseDelimited(tsv(CLIENT_DEPENDANTS_HEADER, [
      "SYN001", "Passport", "SYN-M-0001", "E-ID", "SYN-D-00001", "Otto A", "Hanks", "27-Sep-2015", "Male", "Son",
      "Active", "", "", "SYNTHETIC dependent. Fictional family link.",
    ]));
    expect(detectLayout(header!)).toBe("DEPENDANT");
    expect(missingColumns(header!, "DEPENDANT")).toEqual([]);
    const outcome = mapDependantRow(header!, cells!);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record).toMatchObject({
      companyNumber: "SYN001",
      memberIdType: "PASSPORT",
      memberIdNumber: "SYN-M-0001",
      idType: "E-ID",
      idNumber: "SYN-D-00001",
      fullName: "Otto A Hanks",
      dateOfBirth: "2015-09-27",
      sex: "M",
      relationship: "SON",
      active: true,
    });
  });

  it("imports the beneficiaries row, relationship included", () => {
    const [header, cells] = parseDelimited(tsv(CLIENT_BENEFICIARIES_HEADER, [
      "SYN001", "Passport", "SYN-M-0001", "E-ID", "SYN-B-00001", "Sir Reginald", "Crumplebottom", "28-Feb-1999",
      "Male", "Sibling", "000-000-0000", "beneficiary00001@example.invalid", "60.00", "Active", "", "",
      "SYNTHETIC beneficiary. Fictional nomination.",
    ]));
    expect(detectLayout(header!)).toBe("BENEFICIARY");
    expect(missingColumns(header!, "BENEFICIARY")).toEqual([]);
    const outcome = mapBeneficiaryRow(header!, cells!);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record).toMatchObject({
      companyNumber: "SYN001",
      memberIdType: "PASSPORT",
      memberIdNumber: "SYN-M-0001",
      // One name pair: it is the beneficiary's, and no member name is invented.
      memberName: null,
      idType: "E-ID",
      idNumber: "SYN-B-00001",
      fullName: "Sir Reginald Crumplebottom",
      dateOfBirth: "1999-02-28",
      sex: "M",
      relationship: "SIBLING",
      phone: null,
      sharePercent: 60,
      active: true,
      notes: "SYNTHETIC beneficiary. Fictional nomination.",
    });
  });
});

describe("normaliseBeneficiaryRelationship", () => {
  it("maps the Access list and common words onto it", () => {
    expect(normaliseBeneficiaryRelationship("Sibling")).toBe("SIBLING");
    expect(normaliseBeneficiaryRelationship("Brother")).toBe("SIBLING");
    expect(normaliseBeneficiaryRelationship("Wife")).toBe("SPOUSE");
    expect(normaliseBeneficiaryRelationship("Son")).toBe("CHILD");
    expect(normaliseBeneficiaryRelationship("Mother")).toBe("PARENT");
    expect(normaliseBeneficiaryRelationship("Estate")).toBe("ESTATE");
    expect(normaliseBeneficiaryRelationship("Cousin")).toBe("OTHER");
  });

  it("leaves a blank relationship unrecorded", () => {
    expect(normaliseBeneficiaryRelationship("")).toBeNull();
    expect(normaliseBeneficiaryRelationship("N/A")).toBeNull();
  });
});

describe("older header spellings", () => {
  it("still imports a members sheet headed Company Number / Date Of Birth / Rate Of Pay", () => {
    const header = CLIENT_MEMBERS_HEADER.map((h) =>
      h === "CompanyNumber" ? "Company Number" : h === "DateOfBirth" ? "Date Of Birth" : h === "RateOfPay" ? "Rate Of Pay" : h,
    );
    const cells = CLIENT_MEMBERS_HEADER.map((h) =>
      ({ CompanyNumber: "SYN001", IDType: "National ID", IDNumber: "OLD-1", FirstName: "Old", LastName: "Header",
         DateOfBirth: "7-May-1983", ClassCode: "A", RateOfPay: "1,000" } as Record<string, string>)[h] ?? "",
    );
    expect(detectLayout(header)).toBe("CARRIER");
    expect(missingColumns(header, "CARRIER")).toEqual([]);
    const outcome = mapRow(header, cells, "CARRIER");
    expect(outcome.ok && outcome.record).toMatchObject({
      companyNumber: "SYN001",
      idType: "NATIONAL ID",
      dateOfBirth: "1983-05-07",
      rateOfPay: "1000.00",
    });
  });
});

// ---------------------------------------------------------------------------
// Active and InactiveReason: refused per row, never guessed
// ---------------------------------------------------------------------------

describe("Active column", () => {
  it("refuses a word it does not recognise instead of reading it as Active", () => {
    // "Terminated" read as Active would reactivate a leaver on re-import.
    for (const outcome of [
      mapRow([...IMPORT_HEADERS_CARRIER], carrierRow({ Active: "Terminated" }), "CARRIER"),
      mapDependantRow([...IMPORT_HEADERS_DEPENDANT], dependantRow({ Active: "Terminated" })),
      mapBeneficiaryRow(BENEFICIARY_SHEET_HEADER, beneficiaryRow({ Active: "Terminated" })),
    ]) {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.reasonCodes).toEqual(["INVALID_ACTIVE"]);
      expect(outcome.message).toContain('"Terminated"');
    }
  });

  it("still accepts blank and the yes/no words", () => {
    for (const Active of ["", "Active", "inactive", "Y", "No"]) {
      const outcome = mapRow([...IMPORT_HEADERS_CARRIER], carrierRow({ Active }), "CARRIER");
      expect(outcome.ok, Active).toBe(true);
    }
  });
});

describe("InactiveReason", () => {
  const member = (over: Partial<Record<string, string>>) =>
    mapRow([...IMPORT_HEADERS_CARRIER], carrierRow({ Active: "Inactive", ...over }), "CARRIER");

  it("refuses a 1-2 character reason on an inactive row, before it can stop the batch", () => {
    const outcome = member({ InactiveReason: "RS" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reasonCodes).toEqual(["INVALID_REASON"]);
    expect(outcome.message).toContain("at least 3 characters");
  });

  it("reads NA, a dash and None as no reason", () => {
    for (const InactiveReason of ["NA", "n/a", "-", "None"]) {
      const outcome = member({ InactiveReason });
      expect(outcome.ok, InactiveReason).toBe(true);
      if (!outcome.ok) continue;
      expect(outcome.record.inactiveReason).toBeNull();
    }
  });

  it("keeps a real reason, and ignores a short one on an active row", () => {
    const leaver = member({ InactiveReason: "Resigned" });
    expect(leaver.ok && leaver.record.inactiveReason).toBe("Resigned");
    const active = mapRow([...IMPORT_HEADERS_CARRIER], carrierRow({ Active: "Yes", InactiveReason: "ok" }), "CARRIER");
    expect(active.ok).toBe(true);
  });

  it("applies to dependants and beneficiaries too", () => {
    const dep = mapDependantRow([...IMPORT_HEADERS_DEPENDANT], dependantRow({ Active: "No", InactiveReason: "x" }));
    expect(!dep.ok && dep.reasonCodes).toEqual(["INVALID_REASON"]);
    const ben = mapBeneficiaryRow(BENEFICIARY_SHEET_HEADER, beneficiaryRow({ Active: "No", InactiveReason: "x" }));
    expect(!ben.ok && ben.reasonCodes).toEqual(["INVALID_REASON"]);
  });
});

describe("dependant Relationship left blank", () => {
  it("is null, so an update keeps the relationship on file", () => {
    for (const Relationship of ["", "-", "NA", "None"]) {
      const outcome = mapDependantRow([...IMPORT_HEADERS_DEPENDANT], dependantRow({ Relationship }));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) continue;
      expect(outcome.record.relationship, Relationship).toBeNull();
    }
  });

  it("still maps a word it cannot place to OTHER", () => {
    const outcome = mapDependantRow([...IMPORT_HEADERS_DEPENDANT], dependantRow({ Relationship: "Child" }));
    expect(outcome.ok && outcome.record.relationship).toBe("OTHER");
  });
});
