// Parsing and validation for the bulk member import.
//
// Three header layouts are accepted, each detected from the header row, and
// mapped onto the client's BHI tables (bhi.member, bhi.dependent,
// bhi.beneficiary):
//
//   CARRIER     — the 22-column Members sheet (the client's members table).
//   DEPENDANT   — the 14-column Dependants sheet (the dependants table).
//   BENEFICIARY — the 17-column Beneficiaries sheet (the beneficiaries table).
//
// Column names are matched ignoring case, spaces and punctuation, so the
// client's "CompanyNumber" and an older sheet's "Company Number" are one column.
//
// LEGACY — the original 8 columns — is still DETECTED, only so the route can
// refuse it by name (LAYOUT_WITHDRAWN): it carries no ID type or class, which
// the BHI model requires, so every one of its rows would be an exception.
//
// Members are matched on IDType + IDNumber, the BHI unique key; both child
// sheets find their member by MemberIDNumber (and MemberIDType when given).
// A row missing a BHI-required value, or with a value too long for its column,
// is not loaded: it is recorded as an import exception for HR to fix
// (specs/002-per-company-schema, FR-042).
//
// Everything here is pure: the route does the database work, this module only
// turns a sheet into validated records so it can be unit-tested without a DB.

import { normalizeMemberPhone, phoneDigits } from "./phone";

export const IMPORT_HEADERS_LEGACY = [
  "employeeNumber",
  "firstName",
  "lastName",
  "dateOfBirth",
  "identificationId",
  "email",
  "phone",
  "companyCode",
] as const;

export const IMPORT_HEADERS_CARRIER = [
  "CompanyNumber",
  "CompanyName",
  "IDType",
  "IDNumber",
  "LastName",
  "FirstName",
  "MiddleInitials",
  "DateOfBirth",
  "Sex",
  "ClassCode",
  "AddressLine1",
  "AddressLine2",
  "Phone",
  "Email",
  "EmploymentDate",
  "PlanDate",
  "RateOfPay",
  "Occupation",
  "Active",
  "InactiveDate",
  "InactiveReason",
  "Notes",
] as const;

/**
 * The carrier Dependants sheet.
 *
 * MemberIDType/MemberIDNumber identify the PARENT member and are not stored on
 * the dependant; DependentIDType/DependentIDNumber are the dependant's own
 * identification and are.
 */
export const IMPORT_HEADERS_DEPENDANT = [
  "CompanyNumber",
  "MemberIDType",
  "MemberIDNumber",
  "DependentIDType",
  "DependentIDNumber",
  "FirstName",
  "LastName",
  "DateOfBirth",
  "Sex",
  "Relationship",
  "Active",
  "InactiveDate",
  "InactiveReason",
  "Notes",
] as const;

/**
 * The Beneficiaries sheet — the client's beneficiaries table:
 *
 *   CompanyNumber, MemberIDType, MemberIDNumber, BeneficiaryIDType,
 *   BeneficiaryIDNumber, FirstName, LastName, DateOfBirth, Sex, Relationship,
 *   Phone, Email, SharePercent, Active, InactiveDate, InactiveReason, Notes
 *
 * FirstName/LastName are the beneficiary's. The member is found on
 * CompanyNumber + MemberIDNumber (and MemberIDType).
 *
 * An older carrier sheet is still read: it has no Relationship column, and
 * LastName and FirstName appear TWICE, the two pairs meaning different people,
 * laid out as two blocks:
 *
 *   [LastName, FirstName, CompanyNumber, MemberIDType, MemberIDNumber]
 *       the MEMBER this beneficiary belongs to
 *   [BeneficiaryIDType, BeneficiaryIDNumber, FirstName, LastName, DateOfBirth,
 *    Sex, Phone, Email, SharePercent, Active, InactiveDate, InactiveReason, Notes]
 *       the BENEFICIARY themselves
 *
 * So the FIRST name pair is the member's and the SECOND is the beneficiary's,
 * which is why this layout needs occurrence-aware column lookup rather than the
 * plain first-match index the other layouts use.
 *
 * The member's name is never used to find the member — that is done on
 * CompanyNumber + MemberIDNumber alone — so if a file ships only one name pair
 * it is read as the beneficiary's and nothing is mis-assigned.
 *
 * Relationship is optional: a blank cell, or a sheet without the column,
 * leaves the beneficiary's relationship unrecorded (or, on re-import, as HR
 * left it).
 */
export const IMPORT_HEADERS_BENEFICIARY = [
  "LastName",
  "FirstName",
  "CompanyNumber",
  "MemberIDType",
  "MemberIDNumber",
  "BeneficiaryIDType",
  "BeneficiaryIDNumber",
  "DateOfBirth",
  "Sex",
  "Relationship",
  "Phone",
  "Email",
  "SharePercent",
  "Active",
  "InactiveDate",
  "InactiveReason",
  "Notes",
] as const;

export type ImportLayout = "LEGACY" | "CARRIER" | "DEPENDANT" | "BENEFICIARY";

/** Layouts that describe rows hanging off a member, rather than members. */
export const CHILD_LAYOUTS = ["DEPENDANT", "BENEFICIARY"] as const;

/**
 * The layouts, described once, so the admin screen can render the accepted
 * columns instead of keeping its own copy that drifts out of step.
 *
 * `columns` is what a template download and the on-screen hint show; it is the
 * full sheet including the duplicated beneficiary name pair, which
 * IMPORT_HEADERS_BENEFICIARY cannot express as a set of unique keys.
 */
export const IMPORT_LAYOUTS: {
  layout: ImportLayout;
  label: string;
  columns: string[];
  description: string;
}[] = [
  {
    layout: "CARRIER",
    label: "Members",
    columns: [...IMPORT_HEADERS_CARRIER],
    description:
      "Required: CompanyNumber (a company already onboarded), IDType (National ID, Passport or E-ID), IDNumber, FirstName, LastName, DateOfBirth and ClassCode (a class whose standard rates are set). Phone must be a +592 number, or left blank. A member is matched on IDType + IDNumber, so importing the same person again updates them instead of adding a copy.",
  },
  {
    layout: "DEPENDANT",
    label: "Dependants",
    columns: [...IMPORT_HEADERS_DEPENDANT],
    description:
      "Each row is linked to its member by CompanyNumber + MemberIDType + MemberIDNumber — the member's own IDType and IDNumber from the Members sheet. Required: MemberIDNumber, FirstName and LastName. Relationship is Spouse, Son, Daughter or Other. Every active dependant counts toward the member's premium tier; Active = No takes them off the card and the tier.",
  },
  {
    layout: "BENEFICIARY",
    label: "Beneficiaries",
    columns: [
      "CompanyNumber",
      "MemberIDType",
      "MemberIDNumber",
      "BeneficiaryIDType",
      "BeneficiaryIDNumber",
      "FirstName",
      "LastName",
      "DateOfBirth",
      "Sex",
      "Relationship",
      "Phone",
      "Email",
      "SharePercent",
      "Active",
      "InactiveDate",
      "InactiveReason",
      "Notes",
    ],
    description:
      "Each row is linked to its member by CompanyNumber + MemberIDType + MemberIDNumber. FirstName and LastName are the beneficiary's own. Relationship is Spouse, Child, Parent, Sibling, Estate or Other. SharePercent is 0-100, and a member's shares should add up to 100.",
  },
];

/** The Access database's DependentRelationship list (openapi DependentRelationship). */
export const DEPENDANT_RELATIONSHIPS = ["SPOUSE", "SON", "DAUGHTER", "OTHER"] as const;

export type DependantRelationship = (typeof DEPENDANT_RELATIONSHIPS)[number];

/**
 * Maps whatever the sheet says into the Access list. Carriers write
 * "Wife"/"Husband" as often as "Spouse", and a step-child is still a son or
 * daughter on the card. Anything else — including a plain "Child", which the
 * list cannot place as son or daughter — becomes OTHER rather than failing the
 * row: the name and date of birth are the parts that matter on the card.
 */
export function normaliseRelationship(raw: string): DependantRelationship {
  const v = raw.trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (["SPOUSE", "WIFE", "HUSBAND", "PARTNER"].includes(v)) return "SPOUSE";
  if (["SON", "STEPSON"].includes(v)) return "SON";
  if (["DAUGHTER", "STEPDAUGHTER"].includes(v)) return "DAUGHTER";
  return "OTHER";
}

/** A Relationship cell that says nothing: blank, "-", "NA" or "None". */
function blankRelationship(raw: string): boolean {
  return ["", "NA", "NONE"].includes(raw.trim().toUpperCase().replace(/[^A-Z]/g, ""));
}

/** The Access database's BeneficiaryRelationship list (openapi BeneficiaryCreate). */
export const BENEFICIARY_RELATIONSHIPS = ["SPOUSE", "CHILD", "PARENT", "SIBLING", "ESTATE", "OTHER"] as const;

export type BeneficiaryRelationship = (typeof BENEFICIARY_RELATIONSHIPS)[number];

/**
 * Maps a beneficiary's Relationship cell onto the Access list. Blank stays
 * null (not recorded); a word the list has no place for becomes OTHER.
 */
export function normaliseBeneficiaryRelationship(raw: string): BeneficiaryRelationship | null {
  const v = raw.trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (v === "" || ["NA", "NONE"].includes(v)) return null;
  if (["SPOUSE", "WIFE", "HUSBAND", "PARTNER"].includes(v)) return "SPOUSE";
  if (["CHILD", "SON", "DAUGHTER", "STEPSON", "STEPDAUGHTER", "STEPCHILD"].includes(v)) return "CHILD";
  if (["PARENT", "FATHER", "MOTHER", "DAD", "MOM", "MUM", "STEPFATHER", "STEPMOTHER"].includes(v)) return "PARENT";
  if (["SIBLING", "BROTHER", "SISTER", "STEPBROTHER", "STEPSISTER", "HALFBROTHER", "HALFSISTER"].includes(v)) {
    return "SIBLING";
  }
  if (["ESTATE", "THEESTATE"].includes(v)) return "ESTATE";
  return "OTHER";
}

/** The Access database's IDType list, as stored (openapi IdType). */
export const ID_TYPES = ["NATIONAL ID", "PASSPORT", "E-ID"] as const;

/**
 * Upper-cases an ID type and folds the common spellings of the three Access
 * values onto one stored form ("National ID", "NationalID" and "NID" are all
 * NATIONAL ID). Members are matched on ID type + number, so one spelling per
 * type keeps a re-import from missing its member. Other values are kept,
 * upper-cased, as before.
 */
export function normaliseIdType(raw: string): string {
  const upper = raw.trim().toUpperCase();
  const v = upper.replace(/[^A-Z]/g, "");
  if (["NATIONALID", "NATIONALIDCARD", "NATID", "NID"].includes(v)) return "NATIONAL ID";
  if (["PASSPORT", "PP"].includes(v)) return "PASSPORT";
  if (["EID", "EIDCARD"].includes(v)) return "E-ID";
  return upper;
}

/**
 * Why a row cannot be loaded, as codes stored in bhi.import_exception
 * (reason_codes) so HR's fix list can group and explain them (spec FR-042).
 */
export type ImportReasonCode =
  | "MISSING_COMPANY_NUMBER"
  | "MISSING_ID_TYPE"
  | "MISSING_ID_NUMBER"
  | "MISSING_NAME"
  | "MISSING_CLASS"
  | "MISSING_MEMBER_ID"
  | "VALUE_TOO_LONG"
  | "INVALID_DATE"
  | "INVALID_EMAIL"
  | "INVALID_PHONE"
  | "INVALID_SHARE"
  | "INVALID_ACTIVE"
  | "INVALID_REASON";

/** A dependant row mapped onto bhi.dependent, before its member is resolved. */
export interface DependantImportRecord {
  /** The parent member's company. Null when the sheet leaves CompanyNumber blank. */
  companyNumber: string | null;
  /** The parent member's ID type, when the sheet gives one. */
  memberIdType: string | null;
  /** The parent member's ID number. Always present. */
  memberIdNumber: string;
  idType: string | null;
  idNumber: string | null;
  /** DependentFullName: the sheet's first and last name joined. */
  fullName: string;
  dateOfBirth: string | null;
  sex: string | null;
  /** Null when the sheet leaves it blank: a new dependant gets OTHER, an existing one keeps its value. */
  relationship: DependantRelationship | null;
  active: boolean;
  inactiveDate: string | null;
  inactiveReason: string | null;
  notes: string | null;
}

/** A beneficiary row mapped onto bhi.beneficiary, before its member is resolved. */
export interface BeneficiaryImportRecord {
  companyNumber: string | null;
  memberIdType: string | null;
  memberIdNumber: string;
  /** The member's name as an older sheet states it. Display only — never used to match. */
  memberName: string | null;
  idType: string | null;
  idNumber: string | null;
  /** BeneficiaryFullName: the beneficiary's first and last name joined. */
  fullName: string;
  dateOfBirth: string | null;
  sex: string | null;
  /** One of BENEFICIARY_RELATIONSHIPS, or null when the sheet gives none. */
  relationship: BeneficiaryRelationship | null;
  phone: string | null;
  email: string | null;
  /** SharePercent, 0-100 with two decimals. Null when the sheet is silent. */
  sharePercent: number | null;
  active: boolean;
  inactiveDate: string | null;
  inactiveReason: string | null;
  notes: string | null;
}

/** A Members row mapped onto bhi.member, before the company is checked. */
export interface MemberImportRecord {
  companyNumber: string;
  idType: string;
  idNumber: string;
  firstName: string;
  lastName: string;
  middleInitials: string | null;
  /** Optional in the BHI model. */
  dateOfBirth: string | null;
  sex: string | null;
  classCode: string;
  addressLine1: string | null;
  addressLine2: string | null;
  phone: string | null;
  email: string | null;
  employmentDate: string | null;
  planDate: string | null;
  rateOfPay: string | null;
  occupation: string | null;
  active: boolean;
  inactiveDate: string | null;
  inactiveReason: string | null;
  notes: string | null;
}


// ---------------------------------------------------------------------------
// Delimited text
// ---------------------------------------------------------------------------

/**
 * Pick the delimiter from the header line. Carrier exports are frequently
 * tab-separated (a straight copy out of Excel), and address and notes columns
 * routinely contain commas, so guessing wrong corrupts every row.
 */
export function sniffDelimiter(headerLine: string): string {
  const counts = [
    [",", 0],
    ["\t", 0],
    [";", 0],
    ["|", 0],
  ] as [string, number][];

  let inQuotes = false;
  for (let i = 0; i < headerLine.length; i++) {
    const ch = headerLine[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    const hit = counts.find(([d]) => d === ch);
    if (hit) hit[1]++;
  }

  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ",";
}

/**
 * RFC 4180 parser: honours quoted fields, "" escapes, embedded delimiters and
 * embedded newlines. The previous implementation split on "," which silently
 * mangled any address containing a comma.
 */
export function parseDelimited(text: string, delimiter?: string): string[][] {
  // Strip a UTF-8 BOM — Excel writes one and it corrupts the first header cell.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstBreak = src.search(/\r?\n/);
  const delim =
    delimiter ?? sniffDelimiter(firstBreak === -1 ? src : src.slice(0, firstBreak));

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldWasQuoted = false;

  const endField = () => {
    // Unquoted fields get trimmed; quoted ones are taken literally, since the
    // author quoted them precisely to preserve their contents.
    row.push(fieldWasQuoted ? field : field.trim());
    field = "";
    fieldWasQuoted = false;
  };
  const endRow = () => {
    endField();
    // Drop rows that are entirely empty — trailing newlines, spacer rows.
    if (row.some((c) => c !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      fieldWasQuoted = true;
    } else if (ch === delim) {
      endField();
    } else if (ch === "\r") {
      if (src[i + 1] === "\n") i++;
      endRow();
    } else if (ch === "\n") {
      endRow();
    } else {
      field += ch;
    }
  }

  if (field !== "" || row.length > 0) endRow();
  return rows;
}

// ---------------------------------------------------------------------------
// Header detection
// ---------------------------------------------------------------------------

/** "Date Of Birth", "dateOfBirth" and "DATE_OF_BIRTH" all collapse to the same key. */
export function normaliseKey(header: string): string {
  return header.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

const LEGACY_KEYS = IMPORT_HEADERS_LEGACY.map(normaliseKey);
const CARRIER_KEYS = IMPORT_HEADERS_CARRIER.map(normaliseKey);
const DEPENDANT_KEYS = IMPORT_HEADERS_DEPENDANT.map(normaliseKey);
const BENEFICIARY_KEYS = IMPORT_HEADERS_BENEFICIARY.map(normaliseKey);

/**
 * Identify the layout by how many of each set's columns are present. Matching
 * on keys rather than exact position means a file with the columns reordered,
 * re-cased, or carrying extra trailing columns still imports.
 *
 * The three carrier sheets overlap heavily — CompanyNumber, FirstName,
 * LastName, DateOfBirth, Sex, Active, InactiveDate, InactiveReason and Notes
 * appear in all of them, and "Date Of Birth"/"DateOfBirth" normalise to the
 * same key. A plain hit count therefore reads a Beneficiaries sheet as a
 * Dependants sheet (11 of its 14 keys match). So the decision is made on the
 * columns unique to each layout first, and only falls back to hit counts.
 */
const UNIQUE_KEYS: Record<ImportLayout, string[]> = {
  BENEFICIARY: ["beneficiaryidtype", "beneficiaryidnumber", "sharepercent"],
  DEPENDANT: ["dependentidtype", "dependentidnumber", "relationship"],
  CARRIER: ["companyname", "classcode", "rateofpay", "occupation", "plandate"],
  LEGACY: ["employeenumber", "identificationid", "companycode"],
};

export function detectLayout(header: string[]): ImportLayout | null {
  const keys = new Set(header.map(normaliseKey).filter((k) => k !== ""));
  const hits: Record<ImportLayout, number> = {
    LEGACY: LEGACY_KEYS.filter((k) => keys.has(k)).length,
    CARRIER: CARRIER_KEYS.filter((k) => keys.has(k)).length,
    DEPENDANT: DEPENDANT_KEYS.filter((k) => keys.has(k)).length,
    BENEFICIARY: BENEFICIARY_KEYS.filter((k) => keys.has(k)).length,
  };
  const unique = (layout: ImportLayout): number =>
    UNIQUE_KEYS[layout].filter((k) => keys.has(k)).length;

  // Minimum evidence before a layout is claimed at all. Below this the sheet is
  // some other spreadsheet that happens to have a Notes column.
  const MIN_HITS: Record<ImportLayout, number> = {
    BENEFICIARY: 6,
    DEPENDANT: 6,
    CARRIER: 8,
    LEGACY: 6,
  };

  // Child sheets are considered first: their unique columns are decisive, and a
  // Beneficiaries or Dependants sheet also scores well against CARRIER.
  const ranked: ImportLayout[] = ["BENEFICIARY", "DEPENDANT", "CARRIER", "LEGACY"];
  const eligible = ranked.filter((l) => hits[l] >= MIN_HITS[l]);

  const best = eligible.reduce<ImportLayout | null>((winner, layout) => {
    if (!winner) return layout;
    const byUnique = unique(layout) - unique(winner);
    if (byUnique !== 0) return byUnique > 0 ? layout : winner;
    // Same distinguishing evidence: prefer the layout matching more columns,
    // and on a tie keep the earlier (more specific) entry in `ranked`.
    return hits[layout] > hits[winner] ? layout : winner;
  }, null);

  // A layout with no unique columns present is not identified — that is the
  // "foo, bar, baz" case, and also a sheet too stripped down to act on.
  if (best && unique(best) === 0) return null;
  return best;
}

/**
 * Every index each expected column appears at, in header order.
 *
 * A list rather than a single index because the Beneficiaries sheet repeats
 * FirstName and LastName, once for the member and once for the beneficiary.
 */
function columnIndexAll(
  header: string[],
  expected: readonly string[],
): Map<string, number[]> {
  const byKey = new Map<string, number[]>();
  header.forEach((h, i) => {
    const k = normaliseKey(h);
    if (k === "") return;
    const list = byKey.get(k);
    if (list) list.push(i);
    else byKey.set(k, [i]);
  });
  const out = new Map<string, number[]>();
  for (const name of expected) {
    const idx = byKey.get(normaliseKey(name));
    if (idx !== undefined) out.set(name, idx);
  }
  return out;
}

/** Map each expected column to its FIRST index in the actual header row. */
function columnIndex(header: string[], expected: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const [name, indices] of columnIndexAll(header, expected)) {
    out.set(name, indices[0]!);
  }
  return out;
}

/** One column's trimmed value by its template name, or "" when the sheet lacks it. */
export function cellByName(header: string[], cells: string[], name: string): string {
  const key = normaliseKey(name);
  const i = header.findIndex((h) => normaliseKey(h) === key);
  return i < 0 ? "" : (cells[i] ?? "").trim();
}

/**
 * The row keyed by its header, non-blank cells only — what an exception
 * snapshot keeps of a row that could not be mapped. A repeated header (the
 * Beneficiaries sheet's second name pair) gets a " (2)" suffix.
 */
export function rowAsRecord(header: string[], cells: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  header.forEach((h, i) => {
    const value = (cells[i] ?? "").trim();
    const name = h.trim();
    if (!name || value === "") return;
    let key = name;
    for (let n = 2; key in out; n++) key = `${name} (${n})`;
    out[key] = value;
  });
  return out;
}

function headersFor(layout: ImportLayout): readonly string[] {
  if (layout === "CARRIER") return IMPORT_HEADERS_CARRIER;
  if (layout === "DEPENDANT") return IMPORT_HEADERS_DEPENDANT;
  if (layout === "BENEFICIARY") return IMPORT_HEADERS_BENEFICIARY;
  return IMPORT_HEADERS_LEGACY;
}

/**
 * Columns a sheet may leave out without the whole file being refused. The
 * beneficiaries' Relationship is new in the client's format; an older carrier
 * sheet without it still imports, with the relationship unrecorded.
 */
const OPTIONAL_COLUMNS: Partial<Record<ImportLayout, readonly string[]>> = {
  BENEFICIARY: ["Relationship"],
};

export function missingColumns(header: string[], layout: ImportLayout): string[] {
  const expected = headersFor(layout);
  const found = columnIndex(header, expected);
  const optional = OPTIONAL_COLUMNS[layout] ?? [];
  return expected.filter((name) => !found.has(name) && !optional.includes(name));
}

// ---------------------------------------------------------------------------
// Cell coercion
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Rejects 2026-02-30 and friends, which Date would silently roll forward.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Tidies the human variation out of a hand-typed date before parsing.
 *
 * Carrier sheets are filled in by people, so one column arrives as
 * "21st August, 2020", "26th Nov, 1977", "6th January 2020" and "8 Oct2015".
 * Stripping the ordinal suffix and the comma, and separating a month name that
 * has run into the year, leaves shapes the parsers below already understand.
 */
function tidyDateText(v: string): string {
  return v
    // "21st" -> "21", and "17 th" -> "17", but only straight after digits so it
    // cannot eat the "st" in August. A repeated suffix ("26 THth") is left
    // alone: that is a typo, not a format, and guessing at typos risks
    // recording the wrong date of birth.
    .replace(/(\d)\s*(st|nd|rd|th)\b/gi, "$1")
    .replace(/,/g, " ")
    // "Oct2015" -> "Oct 2015"; also "8Oct" -> "8 Oct".
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Accepts ISO, Excel serials, named months (including two-digit years and
 * ordinal suffixes), day-first dash dates and month-first slash dates.
 * Returns null when the value cannot be read as a date; the caller decides
 * whether that is an error (date of birth) or simply absent (plan date).
 */
export function parseImportDate(raw: string): string | null {
  const v = tidyDateText(String(raw ?? "").trim());
  if (v === "") return null;

  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  if (isoMatch) return iso(+isoMatch[1]!, +isoMatch[2]!, +isoMatch[3]!);

  // Excel serial day count. 1900-01-01 is serial 1, and Excel wrongly treats
  // 1900 as a leap year, hence the 25569 offset against the Unix epoch.
  if (/^\d{4,5}$/.test(v)) {
    const serial = Number(v);
    if (serial >= 1 && serial <= 60000) {
      const ms = (serial - 25569) * 86400000;
      const dt = new Date(ms);
      return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
  }

  // 31-Jan-2026 / 31 Jan 2026 / 29 Sept 1978, and the two-digit-year form the
  // carrier's member sheet actually uses: 28-Jun-00.
  const named = /^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{2}|\d{4})$/.exec(v);
  if (named) {
    const m = MONTHS[named[2]!.slice(0, 3).toLowerCase()];
    if (m) return iso(expandYear(+named[3]!), m, +named[1]!);
  }

  // Dash-separated numerics are day-first.
  //
  // The separator decides, because the two conventions travel with it. Excel in
  // en-US writes slashes month-first; a dash-separated numeric date is the
  // day-first form used in Guyana. The carrier's own file settles it: of its
  // dash dates, 20-03-1961, 30-01-1992 and 18-07-1989 all have a first part
  // above 12, so that column cannot be month-first. Reading 04-09-1973 as
  // 9 April instead of 4 September would silently corrupt a date of birth.
  //
  // ISO is matched above, so a leading four-digit year never reaches here.
  const dashed = /^(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})$/.exec(v);
  if (dashed) {
    return iso(expandYear(+dashed[3]!), +dashed[2]!, +dashed[1]!);
  }

  // Slash or dot separated. Month-first, unless the first part cannot be a
  // month, in which case it must be day-first.
  const parts = /^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2}|\d{4})$/.exec(v);
  if (parts) {
    const a = +parts[1]!;
    const b = +parts[2]!;
    const y = expandYear(+parts[3]!);
    return a > 12 ? iso(y, b, a) : iso(y, a, b);
  }

  return null;
}

/**
 * Expands a two-digit year. The pivot at 70 means 00-69 are 2000s and 70-99 are
 * 1900s, which is right for both a date of birth and an employment date in this
 * data set: the file's oldest members are 1930s-1960s births written as 4-digit
 * years, while the two-digit form only appears for 2000s births.
 */
function expandYear(y: number): number {
  if (y >= 100) return y;
  return y + (y >= 70 ? 1900 : 2000);
}

const TRUE_VALUES = new Set(["y", "yes", "true", "t", "1", "active", "a"]);
const FALSE_VALUES = new Set(["n", "no", "false", "f", "0", "inactive", "i"]);

/** Unrecognised or blank values fall back to `fallback` rather than erroring. */
export function parseImportBoolean(raw: string, fallback: boolean): boolean {
  const v = raw.trim().toLowerCase();
  if (v === "") return fallback;
  if (TRUE_VALUES.has(v)) return true;
  if (FALSE_VALUES.has(v)) return false;
  return fallback;
}

/**
 * Why an Active cell cannot be read, or null when it can. A word outside the
 * yes/no lists is refused rather than falling back to Active: "Terminated" read
 * as Active would reactivate a leaver on re-import.
 */
function activeProblem(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (v === "" || TRUE_VALUES.has(v) || FALSE_VALUES.has(v)) return null;
  return `Active "${raw.trim()}" is not recognised. Write Active or Inactive (Yes or No also work).`;
}

/**
 * An InactiveReason cell. "NA", "-" and "None" mean no reason, so the importer
 * records its own. On an inactive row a shorter reason is refused here, per
 * row: deactivating needs at least 3 characters, and failing that at commit
 * would stop the whole company's batch.
 */
function importInactiveReason(
  raw: string,
  active: boolean,
): { ok: true; value: string | null } | { ok: false; reason: string } {
  const t = placeholderToNull(raw);
  if (t === null || /^none$/i.test(t)) return { ok: true, value: null };
  if (!active && t.length < 3) {
    return {
      ok: false,
      reason: `InactiveReason "${t}" is too short. Write at least 3 characters (for example "Resigned"), or leave it blank.`,
    };
  }
  return { ok: true, value: t };
}

/**
 * The Active and InactiveReason cells of any sheet, checked together because a
 * reason only has to be long enough when the row is inactive.
 */
function importStatus(
  rawActive: string,
  rawReason: string,
): { ok: true; active: boolean; inactiveReason: string | null } | { ok: false; message: string; code: ImportReasonCode } {
  const problem = activeProblem(rawActive);
  if (problem) return { ok: false, message: problem, code: "INVALID_ACTIVE" };
  const active = parseImportBoolean(rawActive, true);
  const reason = importInactiveReason(rawReason, active);
  if (!reason.ok) return { ok: false, message: reason.reason, code: "INVALID_REASON" };
  return { ok: true, active, inactiveReason: reason.value };
}

/** Strips currency symbols, thousands separators and stray spaces. */
export function parseImportMoney(raw: string): string | null {
  const v = raw.replace(/[^0-9.\-]/g, "");
  if (v === "" || v === "-" || v === ".") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2);
}

/**
 * The Beneficiaries sheet's SharePercent, as a 0-100 percentage.
 *
 * Accepts "50", "50%", "33.33" and "1,00" style thousands noise. A fraction is
 * NOT inferred from a value below 1: "0.5" is read as half of one percent,
 * because a sheet that means half the payout writes 50. Guessing the other way
 * would quietly reassign 49.5% of a death benefit.
 *
 * Returns null for a blank or unreadable cell, and for anything outside 0-100 —
 * the caller reports that as a row error rather than storing a nonsense share.
 */
export function parseSharePercent(raw: string): number | null {
  const v = String(raw ?? "")
    .replace(/%/g, "")
    .replace(/,/g, "")
    .trim();
  if (v === "") return null;
  if (!/^-?\d*\.?\d+$/.test(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  // Two decimals, matching numeric(5,2) — so what is validated is what is stored.
  return Math.round(n * 100) / 100;
}

export function normaliseSex(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (v === "") return null;
  if (v.startsWith("m")) return "M";
  if (v.startsWith("f")) return "F";
  return raw.trim().slice(0, 16).toUpperCase();
}

const blankToNull = (v: string | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

/** BHI column sizes (spec Key Entities) the importer checks before writing. */
export const BHI_SIZES = {
  companyNumber: 20,
  idType: 20,
  idNumber: 40,
  firstName: 80,
  lastName: 80,
  middleInitials: 20,
  sex: 10,
  classCode: 1,
  addressLine1: 150,
  addressLine2: 150,
  phone: 50,
  email: 100,
  occupation: 100,
  fullName: 120,
  relationship: 30,
} as const;

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

/** A row that cannot be loaded: why, in words and as codes. */
export interface RowFailure {
  ok: false;
  message: string;
  reasonCodes: ImportReasonCode[];
  idNumber: string | null;
  name: string | null;
  /**
   * Set when the ONLY thing wrong is the phone number. The screen counts these
   * separately and raises a dialog naming the rows, because "row 47's number is
   * Indian" is a fix made in the spreadsheet, whereas a malformed date is
   * usually a broken file.
   */
  invalidPhone?: boolean;
}

export type RowOutcome = { ok: true; record: MemberImportRecord } | RowFailure;

/**
 * A member's phone, or the reason it cannot be stored.
 *
 * Delegates to the same normaliser the admin form uses, so a number typed into
 * the form and a number in a file are judged identically. A cell with no digits
 * at all — the carrier file writes the literal text "No Phone" — means "no
 * number", not an error: the member is still reachable by email.
 */
function importPhone(raw: string): { ok: true; value: string | null } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  // All zeros ("000-000-0000") is how a sheet writes "no number": no phone
  // rather than a number that can never receive a code.
  if (trimmed === "" || /^0*$/.test(phoneDigits(trimmed))) return { ok: true, value: null };
  const result = normalizeMemberPhone(trimmed);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, value: result.value };
}

/** The first text field over its BHI size, as a failure message, or null. */
function tooLong(fields: [label: string, value: string | null, max: number][]): string | null {
  for (const [label, value, max] of fields) {
    if (value != null && value.length > max) {
      return `${label} is ${value.length} characters; the most allowed is ${max}.`;
    }
  }
  return null;
}

/**
 * Maps one row of the carrier Members sheet onto a BHI member.
 *
 * Every column the BHI model requires must be present — Company Number,
 * IDType, IDNumber, LastName, FirstName and ClassCode (Active defaults to yes)
 * — and every value must fit its column. A row that fails is not loaded: the
 * route records it in bhi.import_exception for HR to correct and upload again
 * (spec FR-042). Nothing is filled with a placeholder or truncated.
 *
 * The LEGACY 8-column layout is withdrawn: it carries no ID type or class, so
 * every one of its rows would fail here. The route refuses it outright.
 */
export function mapRow(header: string[], cells: string[], layout: ImportLayout): RowOutcome {
  if (layout !== "CARRIER") {
    return {
      ok: false,
      message: "This sheet layout is no longer accepted. Use the carrier Members layout.",
      reasonCodes: [],
      idNumber: null,
      name: null,
    };
  }
  const index = columnIndex(header, IMPORT_HEADERS_CARRIER);
  const get = (name: string): string => {
    const i = index.get(name);
    return i === undefined ? "" : (cells[i] ?? "").trim();
  };

  const companyNumber = get("CompanyNumber").toUpperCase();
  const idType = normaliseIdType(get("IDType"));
  const idNumber = get("IDNumber");
  const firstName = get("FirstName");
  const lastName = get("LastName");
  const classCode = get("ClassCode").toUpperCase();
  const name = [firstName, lastName].filter(Boolean).join(" ") || null;
  const fail = (message: string, reasonCodes: ImportReasonCode[], invalidPhone?: boolean): RowFailure => ({
    ok: false,
    message,
    reasonCodes,
    idNumber: idNumber || null,
    name,
    ...(invalidPhone ? { invalidPhone } : {}),
  });

  const missing: [ImportReasonCode, string][] = [];
  if (!companyNumber) missing.push(["MISSING_COMPANY_NUMBER", "CompanyNumber"]);
  if (!idType) missing.push(["MISSING_ID_TYPE", "IDType"]);
  if (!idNumber) missing.push(["MISSING_ID_NUMBER", "IDNumber"]);
  if (!firstName || !lastName) missing.push(["MISSING_NAME", !firstName && !lastName ? "FirstName and LastName" : !firstName ? "FirstName" : "LastName"]);
  if (!classCode) missing.push(["MISSING_CLASS", "ClassCode"]);
  if (missing.length) {
    return fail(
      `${missing.map((m) => m[1]).join(", ")} ${missing.length === 1 ? "is" : "are"} required.`,
      [...new Set(missing.map((m) => m[0]))],
    );
  }

  const status = importStatus(get("Active"), get("InactiveReason"));
  if (!status.ok) return fail(status.message, [status.code]);

  const email = blankToNull(get("Email"));
  const record: MemberImportRecord = {
    companyNumber,
    idType,
    idNumber,
    firstName,
    lastName,
    middleInitials: blankToNull(get("MiddleInitials")),
    dateOfBirth: null,
    sex: normaliseSex(get("Sex")),
    classCode,
    addressLine1: blankToNull(get("AddressLine1")),
    addressLine2: blankToNull(get("AddressLine2")),
    phone: null,
    email,
    employmentDate: null,
    planDate: null,
    rateOfPay: parseImportMoney(get("RateOfPay")),
    occupation: blankToNull(get("Occupation")),
    active: status.active,
    inactiveDate: null,
    inactiveReason: status.inactiveReason,
    notes: blankToNull(get("Notes")),
  };

  const long = tooLong([
    ["CompanyNumber", companyNumber, BHI_SIZES.companyNumber],
    ["IDType", idType, BHI_SIZES.idType],
    ["IDNumber", idNumber, BHI_SIZES.idNumber],
    ["FirstName", firstName, BHI_SIZES.firstName],
    ["LastName", lastName, BHI_SIZES.lastName],
    ["MiddleInitials", record.middleInitials, BHI_SIZES.middleInitials],
    ["Sex", record.sex, BHI_SIZES.sex],
    ["ClassCode", classCode, BHI_SIZES.classCode],
    ["AddressLine1", record.addressLine1, BHI_SIZES.addressLine1],
    ["AddressLine2", record.addressLine2, BHI_SIZES.addressLine2],
    ["Email", email, BHI_SIZES.email],
    ["Occupation", record.occupation, BHI_SIZES.occupation],
  ]);
  if (long) return fail(long, ["VALUE_TOO_LONG"]);

  // Dates: blank is fine (all optional in the BHI model); present but unreadable
  // is an error, because silently dropping it would lose data the file supplied.
  for (const [column, key] of [
    ["DateOfBirth", "dateOfBirth"],
    ["EmploymentDate", "employmentDate"],
    ["PlanDate", "planDate"],
    ["InactiveDate", "inactiveDate"],
  ] as const) {
    const raw = get(column);
    if (raw === "") continue;
    const parsed = parseImportDate(raw);
    if (!parsed) return fail(`${column} "${raw}" is not a date the importer recognises.`, ["INVALID_DATE"]);
    record[key] = parsed;
  }

  if (email && !email.includes("@")) return fail("Email is not a valid address.", ["INVALID_EMAIL"]);

  const phone = importPhone(get("Phone"));
  if (!phone.ok) return fail(phone.reason, ["INVALID_PHONE"], true);
  if (phone.value && phone.value.length > BHI_SIZES.phone) {
    return fail(`Phone is too long; the most allowed is ${BHI_SIZES.phone} characters.`, ["VALUE_TOO_LONG"]);
  }
  record.phone = phone.value;

  return { ok: true, record };
}

// ---------------------------------------------------------------------------
// Dependant rows
// ---------------------------------------------------------------------------

export interface ChildRowFailure {
  ok: false;
  message: string;
  reasonCodes: ImportReasonCode[];
  name: string | null;
  memberIdNumber: string | null;
}

export type DependantRowOutcome = { ok: true; record: DependantImportRecord } | ChildRowFailure;

/**
 * Maps one row of the carrier Dependants sheet onto a BHI dependant.
 *
 * The parent member is identified by MemberIDNumber (with MemberIDType and
 * CompanyNumber when the sheet gives them); resolving that to a member is the
 * route's job. The BHI model keeps one DependentFullName, so the sheet's first
 * and last name are joined into it.
 */
export function mapDependantRow(header: string[], cells: string[]): DependantRowOutcome {
  const index = columnIndex(header, IMPORT_HEADERS_DEPENDANT);
  const get = (name: string): string => {
    const i = index.get(name);
    return i === undefined ? "" : (cells[i] ?? "").trim();
  };

  const memberIdNumber = get("MemberIDNumber");
  const fullName = [get("FirstName"), get("LastName")].filter(Boolean).join(" ");
  const fail = (message: string, reasonCodes: ImportReasonCode[]): ChildRowFailure => ({
    ok: false,
    message,
    reasonCodes,
    name: fullName || null,
    memberIdNumber: memberIdNumber || null,
  });

  if (!memberIdNumber) {
    return fail(
      "MemberIDNumber is blank, so there is nothing to link this dependant to. Fill it in with the member's ID number.",
      ["MISSING_MEMBER_ID"],
    );
  }
  if (!fullName) return fail("FirstName or LastName is required.", ["MISSING_NAME"]);
  const status = importStatus(get("Active"), get("InactiveReason"));
  if (!status.ok) return fail(status.message, [status.code]);
  const rawDepIdType = placeholderToNull(get("DependentIDType"));
  const idType = rawDepIdType ? normaliseIdType(rawDepIdType) : null;
  const idNumber = placeholderToNull(get("DependentIDNumber"));
  const sex = normaliseSex(get("Sex"));
  const long = tooLong([
    ["CompanyNumber", blankToNull(get("CompanyNumber")), BHI_SIZES.companyNumber],
    ["MemberIDType", placeholderToNull(get("MemberIDType")), BHI_SIZES.idType],
    ["MemberIDNumber", memberIdNumber, BHI_SIZES.idNumber],
    ["The dependant's full name", fullName, BHI_SIZES.fullName],
    ["DependentIDType", idType, BHI_SIZES.idType],
    ["DependentIDNumber", idNumber, BHI_SIZES.idNumber],
    ["Sex", sex, BHI_SIZES.sex],
  ]);
  if (long) return fail(long, ["VALUE_TOO_LONG"]);

  const rawDob = get("DateOfBirth");
  const dateOfBirth = rawDob === "" ? null : parseImportDate(rawDob);
  if (rawDob !== "" && !dateOfBirth) {
    return fail(`DateOfBirth "${rawDob}" is not a date the importer recognises.`, ["INVALID_DATE"]);
  }
  const rawInactive = get("InactiveDate");
  const inactiveDate = rawInactive === "" ? null : parseImportDate(rawInactive);
  if (rawInactive !== "" && !inactiveDate) {
    return fail(`InactiveDate "${rawInactive}" is not a date the importer recognises.`, ["INVALID_DATE"]);
  }

  return {
    ok: true,
    record: {
      companyNumber: blankToNull(get("CompanyNumber"))?.toUpperCase() ?? null,
      memberIdType: (() => {
        const t = placeholderToNull(get("MemberIDType"));
        return t ? normaliseIdType(t) : null;
      })(),
      memberIdNumber,
      // "-" is how this carrier writes "none", and it must not become an ID.
      idType,
      idNumber,
      fullName,
      dateOfBirth,
      sex,
      // Blank is null, not OTHER, so re-importing a dependant whose sheet
      // leaves Relationship empty never overwrites the one on file.
      relationship: blankRelationship(get("Relationship")) ? null : normaliseRelationship(get("Relationship")),
      active: status.active,
      inactiveDate,
      inactiveReason: status.inactiveReason,
      notes: blankToNull(get("Notes")),
    },
  };
}

// ---------------------------------------------------------------------------
// Beneficiary rows
// ---------------------------------------------------------------------------

export type BeneficiaryRowOutcome = { ok: true; record: BeneficiaryImportRecord } | ChildRowFailure;

/**
 * Maps one row of the carrier Beneficiaries sheet onto a BHI beneficiary.
 *
 * The member is identified the same way as for dependants. The duplicated name
 * columns are read positionally — see IMPORT_HEADERS_BENEFICIARY — and the
 * beneficiary's pair is joined into BeneficiaryFullName.
 */
export function mapBeneficiaryRow(header: string[], cells: string[]): BeneficiaryRowOutcome {
  const index = columnIndexAll(header, IMPORT_HEADERS_BENEFICIARY);
  /**
   * `occurrence` picks between repeated columns: 0 is the member's name pair,
   * 1 the beneficiary's. When a file ships only one pair it is the
   * beneficiary's, so the lookup falls back to the single column present.
   */
  const get = (name: string, occurrence = 0): string => {
    const list = index.get(name);
    if (!list || list.length === 0) return "";
    const i = list[Math.min(occurrence, list.length - 1)]!;
    return (cells[i] ?? "").trim();
  };

  const memberIdNumber = get("MemberIDNumber");
  const twoNamePairs = (index.get("FirstName")?.length ?? 0) > 1 || (index.get("LastName")?.length ?? 0) > 1;
  const memberName = twoNamePairs
    ? [get("FirstName", 0), get("LastName", 0)].filter(Boolean).join(" ") || null
    : null;
  const fullName = [get("FirstName", 1), get("LastName", 1)].filter(Boolean).join(" ");
  const fail = (message: string, reasonCodes: ImportReasonCode[]): ChildRowFailure => ({
    ok: false,
    message,
    reasonCodes,
    name: fullName || null,
    memberIdNumber: memberIdNumber || null,
  });

  if (!memberIdNumber) {
    return fail(
      "MemberIDNumber is blank, so there is nothing to link this beneficiary to. Fill it in with the member's ID number.",
      ["MISSING_MEMBER_ID"],
    );
  }
  if (!fullName) return fail("FirstName or LastName is required.", ["MISSING_NAME"]);
  const status = importStatus(get("Active"), get("InactiveReason"));
  if (!status.ok) return fail(status.message, [status.code]);

  const rawBenIdType = placeholderToNull(get("BeneficiaryIDType"));
  const idType = rawBenIdType ? normaliseIdType(rawBenIdType) : null;
  const idNumber = placeholderToNull(get("BeneficiaryIDNumber"));
  const sex = normaliseSex(get("Sex"));
  // Stored as given (a beneficiary may live abroad), except an all-zero
  // placeholder, which means no number.
  const rawPhone = blankToNull(get("Phone"));
  const phone = rawPhone && /^0*$/.test(phoneDigits(rawPhone)) ? null : rawPhone;
  const email = blankToNull(get("Email"));
  const long = tooLong([
    ["CompanyNumber", blankToNull(get("CompanyNumber")), BHI_SIZES.companyNumber],
    ["MemberIDType", placeholderToNull(get("MemberIDType")), BHI_SIZES.idType],
    ["MemberIDNumber", memberIdNumber, BHI_SIZES.idNumber],
    ["The beneficiary's full name", fullName, BHI_SIZES.fullName],
    ["BeneficiaryIDType", idType, BHI_SIZES.idType],
    ["BeneficiaryIDNumber", idNumber, BHI_SIZES.idNumber],
    ["Sex", sex, BHI_SIZES.sex],
    ["Phone", phone, BHI_SIZES.phone],
    ["Email", email, BHI_SIZES.email],
  ]);
  if (long) return fail(long, ["VALUE_TOO_LONG"]);

  // Unlike a member's, a missing date of birth is routine here (an adult
  // beneficiary) — but a value present and unreadable is still an error.
  const rawDob = get("DateOfBirth");
  const dateOfBirth = rawDob === "" ? null : parseImportDate(rawDob);
  if (rawDob !== "" && !dateOfBirth) {
    return fail(`DateOfBirth "${rawDob}" is not a date the importer recognises.`, ["INVALID_DATE"]);
  }
  const rawShare = get("SharePercent");
  const sharePercent = parseSharePercent(rawShare);
  if (rawShare.trim() !== "" && sharePercent === null) {
    return fail(`SharePercent "${rawShare}" is not a percentage between 0 and 100.`, ["INVALID_SHARE"]);
  }
  if (email && !email.includes("@")) return fail("Email is not a valid address.", ["INVALID_EMAIL"]);
  const rawInactive = get("InactiveDate");
  const inactiveDate = rawInactive === "" ? null : parseImportDate(rawInactive);
  if (rawInactive !== "" && !inactiveDate) {
    return fail(`InactiveDate "${rawInactive}" is not a date the importer recognises.`, ["INVALID_DATE"]);
  }

  return {
    ok: true,
    record: {
      companyNumber: blankToNull(get("CompanyNumber"))?.toUpperCase() ?? null,
      memberIdType: (() => {
        const t = placeholderToNull(get("MemberIDType"));
        return t ? normaliseIdType(t) : null;
      })(),
      memberIdNumber,
      memberName,
      // "-" is how this carrier writes "none", on both the type and the number.
      idType,
      idNumber,
      fullName,
      dateOfBirth,
      sex,
      relationship: normaliseBeneficiaryRelationship(get("Relationship")),
      phone,
      email,
      sharePercent,
      active: status.active,
      inactiveDate,
      inactiveReason: status.inactiveReason,
      notes: blankToNull(get("Notes")),
    },
  };
}

/** Blank, or a lone dash / n-a style placeholder, all mean "no value". */
function placeholderToNull(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  if (t === "" || t === "-" || t === "--") return null;
  if (/^n\/?a$/i.test(t)) return null;
  return t;
}

/**
 * The key used to decide whether a dependant already exists on a member.
 *
 * Prefers the dependant's own ID number, which is what the carrier intends as
 * the identifier. Newborns frequently have no ID yet, so it falls back to full
 * name plus date of birth rather than inserting a duplicate on every import.
 */
export function dependantMatchKey(record: { idNumber: string | null; fullName: string; dateOfBirth: string | null }): string {
  if (record.idNumber) return `id:${record.idNumber.trim().toLowerCase()}`;
  return `name:${record.fullName.trim().toLowerCase().replace(/\s+/g, " ")}|${record.dateOfBirth ?? ""}`;
}

/** The same rule for beneficiaries: own ID number, else full name plus date of birth. */
export function beneficiaryMatchKey(record: { idNumber: string | null; fullName: string; dateOfBirth: string | null }): string {
  if (record.idNumber) return `id:${record.idNumber.trim().toLowerCase()}`;
  return `name:${record.fullName.trim().toLowerCase().replace(/\s+/g, " ")}|${record.dateOfBirth ?? ""}`;
}
