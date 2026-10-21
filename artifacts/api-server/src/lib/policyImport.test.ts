import { describe, expect, it } from "vitest";
import { IMPORT_HEADERS_POLICY, isPolicyHeader, mapPolicyRow, missingPolicyColumns } from "./policyImport";
import { detectLayout } from "./memberImport";

const header = [...IMPORT_HEADERS_POLICY];

const policyRow = (over: Partial<Record<(typeof IMPORT_HEADERS_POLICY)[number], string>> = {}): string[] => {
  const base: Record<string, string> = {
    CompanyNumber: "syn001",
    MemberIDType: "National ID",
    MemberIDNumber: "SYN-M-3101",
    InsurerName: "North American Life Insurance Co. Ltd.",
    PlanName: "Group Medical",
    Policyholder: "Rubicon Logistics",
    PolicyNumber: "GM-1001",
    GroupNumber: "G-77",
    MemberNumber: "M-3101",
    CertificateNumber: "C-3101",
    EffectiveDate: "1-Jan-2026",
    ExpiryDate: "31-Dec-2026",
  };
  return header.map((h) => over[h] ?? base[h] ?? "");
};

describe("Policies layout", () => {
  it("is recognised from its own columns, whatever the case or spacing", () => {
    expect(isPolicyHeader(header)).toBe(true);
    expect(isPolicyHeader(header.map((h) => h.toUpperCase().replace(/([a-z])([A-Z])/g, "$1 $2")))).toBe(true);
  });

  it("is never mistaken for a members, dependants or beneficiaries sheet", () => {
    expect(detectLayout(header)).toBeNull();
  });

  it("lists the columns a partial header lacks", () => {
    expect(missingPolicyColumns(header.filter((h) => h !== "ExpiryDate" && h !== "GroupNumber"))).toEqual([
      "GroupNumber",
      "ExpiryDate",
    ]);
  });
});

describe("mapPolicyRow", () => {
  it("maps a full row, normalising the company, ID type and dates", () => {
    const outcome = mapPolicyRow(header, policyRow());
    expect(outcome).toEqual({
      ok: true,
      record: {
        companyNumber: "SYN001",
        memberIdType: "NATIONAL ID",
        memberIdNumber: "SYN-M-3101",
        insurerName: "North American Life Insurance Co. Ltd.",
        planName: "Group Medical",
        policyholder: "Rubicon Logistics",
        policyNumber: "GM-1001",
        groupNumber: "G-77",
        memberNumber: "M-3101",
        certificateNumber: "C-3101",
        effectiveDate: "2026-01-01",
        expiryDate: "2026-12-31",
      },
    });
  });

  it("reads a blank or dash ExpiryDate as open-ended cover", () => {
    for (const ExpiryDate of ["", "-", "N/A"]) {
      const outcome = mapPolicyRow(header, policyRow({ ExpiryDate }));
      expect(outcome.ok && outcome.record.expiryDate, ExpiryDate).toBeNull();
    }
  });

  it("leaves CompanyNumber and MemberIDType optional", () => {
    const outcome = mapPolicyRow(header, policyRow({ CompanyNumber: "", MemberIDType: "-" }));
    expect(outcome.ok && [outcome.record.companyNumber, outcome.record.memberIdType]).toEqual([null, null]);
  });

  it("needs the member's ID number", () => {
    const outcome = mapPolicyRow(header, policyRow({ MemberIDNumber: "" }));
    expect(!outcome.ok && outcome.reasonCodes).toEqual(["MISSING_MEMBER_ID"]);
  });

  it("names every missing policy field at once", () => {
    const outcome = mapPolicyRow(header, policyRow({ PolicyNumber: "", CertificateNumber: " " }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reasonCodes).toEqual(["MISSING_POLICY_FIELD"]);
    expect(outcome.message).toBe("PolicyNumber, CertificateNumber are required.");
  });

  it("rejects unreadable dates, and an expiry before the effective date", () => {
    const bad = mapPolicyRow(header, policyRow({ EffectiveDate: "soon" }));
    expect(!bad.ok && bad.reasonCodes).toEqual(["INVALID_DATE"]);
    const badExpiry = mapPolicyRow(header, policyRow({ ExpiryDate: "whenever" }));
    expect(!badExpiry.ok && badExpiry.message).toContain("ExpiryDate");
    const backwards = mapPolicyRow(header, policyRow({ EffectiveDate: "2026-06-01", ExpiryDate: "2026-01-01" }));
    expect(!backwards.ok && backwards.message).toBe("ExpiryDate 2026-01-01 is before EffectiveDate 2026-06-01.");
  });

  it("refuses a value too long to be a policy field", () => {
    const outcome = mapPolicyRow(header, policyRow({ PlanName: "x".repeat(201) }));
    expect(!outcome.ok && outcome.reasonCodes).toEqual(["VALUE_TOO_LONG"]);
  });
});
