/**
 * The Policies sheet: one row per member, carrying the policy details printed
 * on the member's card (bhi.policy_memberships). Super admin only, like the
 * single-policy form, and imported separately from the members workbook.
 *
 * A row names its member the way a Dependants row does — MemberIDNumber, with
 * CompanyNumber and MemberIDType to tell apart two members sharing a number —
 * and replaces that member's policy, so every policy field is required except
 * ExpiryDate, which is blank for open-ended cover.
 */
import { cellByName, normaliseIdType, normaliseKey, parseImportDate } from "./memberImport";

export const IMPORT_HEADERS_POLICY = [
  "CompanyNumber",
  "MemberIDType",
  "MemberIDNumber",
  "InsurerName",
  "PlanName",
  "Policyholder",
  "PolicyNumber",
  "GroupNumber",
  "MemberNumber",
  "CertificateNumber",
  "EffectiveDate",
  "ExpiryDate",
] as const;

export const POLICY_IMPORT_LAYOUT = {
  label: "Policies",
  columns: [...IMPORT_HEADERS_POLICY],
  description:
    "One row per member. MemberIDNumber is the member's IDNumber; fill in CompanyNumber and MemberIDType too " +
    "when the same number could belong to more than one member. Every policy field is required except " +
    "ExpiryDate — leave it blank for open-ended cover. A member who already has a policy gets it replaced.",
};

/** The policy fields, in the order they are reported missing. */
const REQUIRED_FIELDS = [
  "InsurerName",
  "PlanName",
  "Policyholder",
  "PolicyNumber",
  "GroupNumber",
  "MemberNumber",
  "CertificateNumber",
  "EffectiveDate",
] as const;

/** Long enough for any real policy value; longer is a misplaced column, not data. */
export const POLICY_FIELD_MAX = 200;

export type PolicyReasonCode =
  | "MISSING_MEMBER_ID"
  | "MISSING_POLICY_FIELD"
  | "INVALID_DATE"
  | "VALUE_TOO_LONG";

export interface PolicyImportRecord {
  /** The member's company, when the sheet gives one. */
  companyNumber: string | null;
  /** The member's ID type, when the sheet gives one. */
  memberIdType: string | null;
  memberIdNumber: string;
  insurerName: string;
  planName: string;
  policyholder: string;
  policyNumber: string;
  groupNumber: string;
  memberNumber: string;
  certificateNumber: string;
  effectiveDate: string;
  /** Null for open-ended cover. */
  expiryDate: string | null;
}

export type PolicyRowOutcome =
  | { ok: true; record: PolicyImportRecord }
  | { ok: false; message: string; reasonCodes: PolicyReasonCode[]; memberIdNumber: string | null };

const POLICY_KEYS = IMPORT_HEADERS_POLICY.map(normaliseKey);

/** True when the header row is the Policies layout: it carries the columns only a policy has. */
export function isPolicyHeader(header: string[]): boolean {
  const keys = new Set(header.map(normaliseKey));
  return ["policynumber", "certificatenumber", "membernumber"].every((k) => keys.has(k));
}

/** The Policies columns the header row lacks. */
export function missingPolicyColumns(header: string[]): string[] {
  const keys = new Set(header.map(normaliseKey));
  return IMPORT_HEADERS_POLICY.filter((_, i) => !keys.has(POLICY_KEYS[i]!));
}

/** A lone dash or n/a means the sheet gives no value. */
function optional(raw: string): string | null {
  const t = raw.trim();
  if (t === "" || t === "-" || t === "--" || /^n\/?a$/i.test(t)) return null;
  return t;
}

export function mapPolicyRow(header: string[], cells: string[]): PolicyRowOutcome {
  const get = (name: string) => cellByName(header, cells, name);
  const memberIdNumber = get("MemberIDNumber");
  const fail = (message: string, reasonCodes: PolicyReasonCode[]): PolicyRowOutcome => ({
    ok: false,
    message,
    reasonCodes,
    memberIdNumber: memberIdNumber || null,
  });

  if (!memberIdNumber) {
    return fail(
      "MemberIDNumber is blank, so there is no member to give this policy to. Fill it in with the member's IDNumber.",
      ["MISSING_MEMBER_ID"],
    );
  }
  const missing = REQUIRED_FIELDS.filter((f) => get(f) === "");
  if (missing.length > 0) {
    return fail(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required.`, ["MISSING_POLICY_FIELD"]);
  }
  const tooLong = REQUIRED_FIELDS.find((f) => get(f).length > POLICY_FIELD_MAX);
  if (tooLong) {
    return fail(`${tooLong} is ${get(tooLong).length} characters; the most allowed is ${POLICY_FIELD_MAX}.`, ["VALUE_TOO_LONG"]);
  }

  const effectiveDate = parseImportDate(get("EffectiveDate"));
  if (!effectiveDate) {
    return fail(`EffectiveDate "${get("EffectiveDate")}" is not a date the importer recognises.`, ["INVALID_DATE"]);
  }
  const rawExpiry = optional(get("ExpiryDate"));
  const expiryDate = rawExpiry === null ? null : parseImportDate(rawExpiry);
  if (rawExpiry !== null && !expiryDate) {
    return fail(`ExpiryDate "${rawExpiry}" is not a date the importer recognises.`, ["INVALID_DATE"]);
  }
  if (expiryDate && expiryDate < effectiveDate) {
    return fail(`ExpiryDate ${expiryDate} is before EffectiveDate ${effectiveDate}.`, ["INVALID_DATE"]);
  }

  const memberIdType = optional(get("MemberIDType"));
  return {
    ok: true,
    record: {
      companyNumber: optional(get("CompanyNumber"))?.toUpperCase() ?? null,
      memberIdType: memberIdType ? normaliseIdType(memberIdType) : null,
      memberIdNumber,
      insurerName: get("InsurerName"),
      planName: get("PlanName"),
      policyholder: get("Policyholder"),
      policyNumber: get("PolicyNumber"),
      groupNumber: get("GroupNumber"),
      memberNumber: get("MemberNumber"),
      certificateNumber: get("CertificateNumber"),
      effectiveDate,
      expiryDate,
    },
  };
}
