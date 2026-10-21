/**
 * Bulk import onto the BHI tables (spec User Story 4; FR-041, FR-042;
 * research R17; contracts/admin-api.md, Import).
 *
 * Only the carrier layouts are accepted — Members, Dependants, Beneficiaries.
 * Each row names its company by Company Number, which must be in the admin's
 * scope; companies are created only by onboarding, never by an import.
 *
 * Members are matched by (IDType, IDNumber), which is unique across the whole
 * platform: a row whose ID belongs to another company is refused with
 * ID_ALREADY_REGISTERED. A row missing a BHI-required value, or with one too
 * long for its column, is not loaded. On commit it is held in
 * bhi.import_exception under the upload's import_batch, for HR to fix and upload
 * again; the corrected row then resolves the exception and restores the family
 * held with it (lib/importBatch.ts).
 *
 * The commit runs one transaction per company: a failed write leaves that
 * company exactly as it was. Status changes go through setActive, and class
 * assignments write member_class_history, as for single-record edits.
 */
import { Router, type IRouter } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  bhiBeneficiaryTable,
  bhiClassTable,
  bhiCompanyTable,
  bhiDependentTable,
  bhiMemberTable,
  memberClassHistoryTable,
  withScope,
  type BhiBeneficiary,
  type BhiCompany,
  type BhiDependent,
  type BhiMember,
  type ScopedTx,
} from "@workspace/db";
import { ImportMembersBody } from "@workspace/api-zod";
import { writeAudit } from "../lib/audit";
import { inScope, writable } from "../lib/adminScope";
import {
  IMPORT_HEADERS_BENEFICIARY,
  IMPORT_HEADERS_CARRIER,
  IMPORT_HEADERS_DEPENDANT,
  IMPORT_LAYOUTS,
  beneficiaryMatchKey,
  cellByName,
  dependantMatchKey,
  detectLayout,
  mapBeneficiaryRow,
  mapDependantRow,
  mapRow,
  missingColumns,
  normaliseIdType,
  parseDelimited,
  rowAsRecord,
  type BeneficiaryImportRecord,
  type DependantImportRecord,
  type ImportLayout,
  type MemberImportRecord,
} from "../lib/memberImport";
import {
  createBatch,
  matchOpenChildException,
  matchOpenException,
  openChildExceptions,
  resolveChildException,
  type OpenChildException,
  openMemberExceptions,
  recordException,
  resolveException,
  type OpenMemberException,
  type SnapshotBeneficiary,
  type SnapshotDependent,
} from "../lib/importBatch";
import { isPolicyHeader } from "../lib/policyImport";
import { setActive } from "../lib/statusHistory";
import { rateCompleteClassCodes } from "../lib/classRules";
import { recalcDraftBills } from "../lib/billing/recalc";
import { nextBillingMonthStart } from "../lib/guyanaTime";
import { ID_ALREADY_REGISTERED_MESSAGE, classifyBhiError } from "../lib/bhiErrors";
import { RETIREMENT_AGE, ageOn, hasReachedRetirementAge } from "../lib/retirement";
import { guyanaToday } from "../lib/guyanaTime";
import { requireAdmin, requirePermission, type AdminContext } from "../middlewares/adminAuth";

const router: IRouter = Router();

/** Postgres caps a statement at 65535 bind parameters; stay well clear. */
const CHUNK = 500;

function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

// ID types are folded (NATIONALID and NATIONAL ID are one type), so a member
// stored under another spelling of its type is still found.
const pairKey = (idType: string, idNumber: string) => `${normaliseIdType(idType)}|${idNumber.trim().toLowerCase()}`;
const idKey = (idNumber: string) => idNumber.trim().toLowerCase();

/** What HR should do about each reason, for the fix list. */
const REQUIRED_ACTION: Record<string, string> = {
  MISSING_COMPANY_NUMBER: "Fill in Company Number.",
  MISSING_ID_TYPE: "Fill in IDType.",
  MISSING_ID_NUMBER: "Fill in IDNumber.",
  MISSING_NAME: "Fill in the first and last name.",
  MISSING_CLASS: "Fill in ClassCode.",
  MISSING_DATE_OF_BIRTH: "Fill in DateOfBirth (a new member needs one; cover ends at 65).",
  MISSING_MEMBER_ID: "Fill in MemberIDNumber with the member's ID number.",
  VALUE_TOO_LONG: "Shorten the value named in the reason.",
  INVALID_DATE: "Correct the date (YYYY-MM-DD).",
  INVALID_EMAIL: "Correct the email address.",
  INVALID_PHONE: "Correct the phone number.",
  INVALID_SHARE: "Correct SharePercent (0 to 100).",
  INVALID_ACTIVE: "Write Active or Inactive in the Active column.",
  INVALID_REASON: "Write an InactiveReason of at least 3 characters, or leave it blank.",
  UNKNOWN_CLASS: "Use one of the platform's active classes.",
  MEMBER_NOT_FOUND: "Check MemberIDNumber, or include the member's row in the upload.",
  AMBIGUOUS_MEMBER: "Fill in CompanyNumber and MemberIDType to say which member.",
};

function requiredAction(codes: string[]): string {
  const parts = [...new Set(codes)].map((c) => REQUIRED_ACTION[c]).filter(Boolean);
  return `${parts.join(" ")} Then upload the corrected row again.`.trim();
}

type RowStatus = "OK" | "WARN" | "ERROR";

interface ResultRow {
  sheet: string;
  rowNumber: number;
  status: RowStatus;
  message: string;
  companyNumber: string | null;
  idNumber: string | null;
  name: string | null;
  reasonCodes: string[];
  duplicate: boolean;
  invalidPhone: boolean;
  /** The row matches a record already on file, so it updates it rather than adding one. */
  existingRecord: boolean;
  /** For an existing member: the columns this row would change (none = the row matches the record). */
  changedFields: string[];
  /** Held (or, on a dry run, to be held) in the company's fix list. */
  held: boolean;
  resolvesExceptionId: number | null;
  /** The row's cells, for an exception snapshot. */
  raw: Record<string, string>;
  /** False once the company's commit failed. */
  saved: boolean;
}

interface MemberRow extends ResultRow {
  kind: "MEMBER";
  record?: MemberImportRecord;
  /** The Active cell was filled in, so the file means to set the status. */
  activeGiven: boolean;
  existing?: BhiMember;
  open?: OpenMemberException;
  /** What the held exception keeps of the row: its cells plus the keys a fix is matched on. */
  snapshotMember: Record<string, unknown>;
  /** Rows of this file that belong to this member while it is held. */
  heldDependents: SnapshotDependent[];
  heldBeneficiaries: SnapshotBeneficiary[];
  /** Set during the commit. */
  memberId?: number;
  /** Set when a class change or new member needs the class checked. */
  assignsClass: boolean;
}

/** The member a child row belongs to. */
interface Target {
  key: string;
  companyNumber: string;
  existingMemberId: number | null;
  fileRow: MemberRow | null;
}

interface ChildRow<TRecord> extends ResultRow {
  kind: "DEPENDENT" | "BENEFICIARY";
  record?: TRecord;
  activeGiven: boolean;
  target?: Target;
  existingId?: number;
  /** The held dependant / beneficiary exception this row fixes. */
  openChild?: OpenChildException;
}

type DependantRow = ChildRow<DependantImportRecord>;
type BeneficiaryRow = ChildRow<BeneficiaryImportRecord>;

function baseRow(sheet: string, rowNumber: number, raw: Record<string, string>): Omit<ResultRow, "status" | "message"> {
  return {
    sheet,
    rowNumber,
    companyNumber: null,
    idNumber: null,
    name: null,
    reasonCodes: [],
    duplicate: false,
    invalidPhone: false,
    held: false,
    existingRecord: false,
    changedFields: [],
    resolvesExceptionId: null,
    raw,
    saved: true,
  };
}

function fail(row: ResultRow, message: string, codes: string[], opts: { duplicate?: boolean } = {}): void {
  row.status = "ERROR";
  row.message = message;
  row.reasonCodes = [...new Set([...row.reasonCodes, ...codes])];
  if (opts.duplicate) row.duplicate = true;
}

/** Codes a row can be held for: data HR can correct and upload again. */
const HOLDABLE = new Set([
  "MISSING_COMPANY_NUMBER",
  "MISSING_ID_TYPE",
  "MISSING_ID_NUMBER",
  "MISSING_NAME",
  "MISSING_CLASS",
  "MISSING_DATE_OF_BIRTH",
  "MISSING_MEMBER_ID",
  "VALUE_TOO_LONG",
  "INVALID_DATE",
  "INVALID_EMAIL",
  "INVALID_PHONE",
  "INVALID_SHARE",
  "INVALID_ACTIVE",
  "INVALID_REASON",
  "UNKNOWN_CLASS",
  "MEMBER_NOT_FOUND",
  "AMBIGUOUS_MEMBER",
]);

const toSnapshotDependent = (r: DependantImportRecord): SnapshotDependent => ({
  idType: r.idType,
  idNumber: r.idNumber,
  fullName: r.fullName,
  dateOfBirth: r.dateOfBirth,
  sex: r.sex,
  // A held dependant is restored as a new row, so a blank relationship takes the default.
  relationship: r.relationship ?? "OTHER",
  active: r.active,
  inactiveDate: r.inactiveDate,
  inactiveReason: r.inactiveReason,
  notes: r.notes,
});

const toSnapshotBeneficiary = (r: BeneficiaryImportRecord): SnapshotBeneficiary => ({
  idType: r.idType,
  idNumber: r.idNumber,
  fullName: r.fullName,
  dateOfBirth: r.dateOfBirth,
  sex: r.sex,
  relationship: r.relationship,
  phone: r.phone,
  email: r.email,
  sharePercent: r.sharePercent,
  active: r.active,
  inactiveDate: r.inactiveDate,
  inactiveReason: r.inactiveReason,
  notes: r.notes,
});

/** Only the fields the file actually supplies: a blank cell never erases data already on file. */
function supplied<T extends Record<string, unknown>>(values: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v !== null && v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function memberColumns(r: MemberImportRecord) {
  return {
    firstName: r.firstName,
    lastName: r.lastName,
    middleInitials: r.middleInitials,
    dateOfBirth: r.dateOfBirth,
    sex: r.sex,
    classCode: r.classCode,
    addressLine1: r.addressLine1,
    addressLine2: r.addressLine2,
    phone: r.phone,
    email: r.email,
    employmentDate: r.employmentDate,
    planDate: r.planDate,
    rateOfPay: r.rateOfPay,
    occupation: r.occupation,
    notes: r.notes,
  };
}

function changedFields(current: Record<string, unknown>, next: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) if (current[k] !== v) out[k] = v;
  return out;
}

router.post(
  "/v1/admin/import",
  requireAdmin,
  requirePermission("MEMBER_IMPORT"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    if (!writable(admin, res)) return;
    const parsed = ImportMembersBody.safeParse(req.body);
    const invalid = () =>
      res.status(400).json({ error: { code: "INVALID_INPUT", message: "Paste CSV text or upload a file to import." } });
    if (!parsed.success) {
      invalid();
      return;
    }
    const dryRun = parsed.data.dryRun;
    const fileName = parsed.data.fileName?.trim() || null;

    // ---- Sheets --------------------------------------------------------------
    const cleanMatrix = (rows: string[][]): string[][] =>
      rows.map((r) => r.map((c) => (c ?? "").toString())).filter((r) => r.some((c) => c.trim() !== ""));
    let inputSheets: { name: string; matrix: string[][] }[];
    if (parsed.data.sheets && parsed.data.sheets.length > 0) {
      inputSheets = parsed.data.sheets.map((s) => ({ name: s.name || "Sheet", matrix: cleanMatrix(s.rows) }));
    } else if (parsed.data.rows && parsed.data.rows.length > 0) {
      inputSheets = [{ name: "Sheet1", matrix: cleanMatrix(parsed.data.rows) }];
    } else if (parsed.data.csvText && parsed.data.csvText.trim() !== "") {
      inputSheets = [{ name: "Pasted", matrix: parseDelimited(parsed.data.csvText) }];
    } else {
      invalid();
      return;
    }

    // An empty "Sheet3" in a workbook must not fail the whole import.
    const classified = inputSheets
      .filter((s) => s.matrix.length >= 2)
      .map((s) => ({ ...s, layout: detectLayout(s.matrix[0]!) }));
    if (classified.length === 0) {
      res.status(400).json({
        error: { code: "EMPTY_CSV", message: "The file needs a header row and at least one data row." },
      });
      return;
    }
    // The Import screen has one tab per sheet type and says which it wants, so
    // a full workbook uploaded on the Dependants tab loads only its Dependants
    // sheet. The old members layout is still refused by name on the Members tab.
    const only = parsed.data.layout ?? null;
    const withdrawn = classified.find((s) => s.layout === "LEGACY");
    if (withdrawn && (only === null || only === "CARRIER")) {
      res.status(400).json({
        error: {
          code: "LAYOUT_WITHDRAWN",
          message:
            `Sheet "${withdrawn.name}" uses the old short members layout, which is no longer accepted: ` +
            `it has no ID type or class. Use the carrier Members layout (${IMPORT_HEADERS_CARRIER.join(", ")}).`,
        },
      });
      return;
    }
    const recognised = classified.filter(
      (s): s is typeof s & { layout: Exclude<ImportLayout, "LEGACY"> } =>
        s.layout !== null && s.layout !== "LEGACY" && (only === null || s.layout === only),
    );
    if (only !== null && recognised.length === 0 && classified.some((s) => s.layout !== null && s.layout !== "LEGACY")) {
      const wanted = IMPORT_LAYOUTS.find((l) => l.layout === only)!;
      res.status(400).json({
        error: {
          code: "BAD_HEADER",
          message: `This file has no ${wanted.label} sheet. Expected these columns: ${wanted.columns.join(", ")}. Use the tab for the sheet the file holds.`,
        },
      });
      return;
    }
    if (recognised.length === 0) {
      const policies = classified.find((s) => isPolicyHeader(s.matrix[0]!));
      if (policies) {
        res.status(400).json({
          error: {
            code: "BAD_HEADER",
            message: `Sheet "${policies.name}" is a Policies sheet. A super admin imports policies on the Import page's Policies tab.`,
          },
        });
        return;
      }
      res.status(400).json({
        error: {
          code: "BAD_HEADER",
          message:
            `Unrecognised header row. Expected the Members layout (${IMPORT_HEADERS_CARRIER.join(", ")}), ` +
            `the Dependants layout (${IMPORT_HEADERS_DEPENDANT.join(", ")}), ` +
            `or the Beneficiaries layout (${IMPORT_HEADERS_BENEFICIARY.join(", ")}).`,
        },
      });
      return;
    }
    for (const sheet of recognised) {
      const missing = missingColumns(sheet.matrix[0]!, sheet.layout);
      if (missing.length > 0) {
        res.status(400).json({
          error: { code: "BAD_HEADER", message: `Sheet "${sheet.name}" is missing these columns: ${missing.join(", ")}.` },
        });
        return;
      }
    }
    const memberSheets = recognised.filter((s) => s.layout === "CARRIER");
    const dependantSheets = recognised.filter((s) => s.layout === "DEPENDANT");
    const beneficiarySheets = recognised.filter((s) => s.layout === "BENEFICIARY");

    /** With a single company in scope, a row that forgets its company can still be held under it. */
    const onlyCompany = !admin.scope.all && admin.scope.companies.length === 1 ? admin.scope.companies[0]! : null;
    const today = guyanaToday();

    // ---- Pass 1: map member rows (no database) --------------------------------
    const memberRows: MemberRow[] = [];
    const firstRowOfId = new Map<string, number>();
    for (const sheet of memberSheets) {
      const header = sheet.matrix[0]!;
      for (let i = 1; i < sheet.matrix.length; i++) {
        const cells = sheet.matrix[i]!;
        const raw = rowAsRecord(header, cells);
        const row: MemberRow = {
          ...baseRow(sheet.name, i + 1, raw),
          kind: "MEMBER",
          status: "OK",
          message: "",
          activeGiven: cellByName(header, cells, "Active") !== "",
          snapshotMember: {
            ...raw,
            idType: cellByName(header, cells, "IDType").toUpperCase() || null,
            idNumber: cellByName(header, cells, "IDNumber") || null,
            firstName: cellByName(header, cells, "FirstName") || null,
            lastName: cellByName(header, cells, "LastName") || null,
          },
          heldDependents: [],
          heldBeneficiaries: [],
          assignsClass: false,
        };
        memberRows.push(row);
        const outcome = mapRow(header, cells, "CARRIER");
        if (!outcome.ok) {
          row.companyNumber = cellByName(header, cells, "Company Number").toUpperCase() || onlyCompany;
          row.idNumber = outcome.idNumber;
          row.name = outcome.name;
          row.invalidPhone = outcome.invalidPhone === true;
          fail(row, outcome.message, outcome.reasonCodes);
          continue;
        }
        const r = outcome.record;
        row.record = r;
        row.companyNumber = r.companyNumber;
        row.idNumber = r.idNumber;
        row.name = `${r.firstName} ${r.lastName}`;
        const key = pairKey(r.idType, r.idNumber);
        const first = firstRowOfId.get(key);
        if (first !== undefined) {
          fail(row, `Duplicate of row ${first} — the same IDType and IDNumber appear twice in this file.`, ["DUPLICATE_IN_FILE"], {
            duplicate: true,
          });
          continue;
        }
        firstRowOfId.set(key, row.rowNumber);
      }
    }

    // ---- Pass 1b: map child rows (no database) --------------------------------
    const dependantRows: DependantRow[] = [];
    const beneficiaryRows: BeneficiaryRow[] = [];
    for (const [sheets, kind] of [
      [dependantSheets, "DEPENDENT"],
      [beneficiarySheets, "BENEFICIARY"],
    ] as const) {
      for (const sheet of sheets) {
        const header = sheet.matrix[0]!;
        for (let i = 1; i < sheet.matrix.length; i++) {
          const cells = sheet.matrix[i]!;
          const common = {
            ...baseRow(sheet.name, i + 1, rowAsRecord(header, cells)),
            kind,
            status: "OK" as RowStatus,
            message: "",
            activeGiven: cellByName(header, cells, "Active") !== "",
          };
          const outcome = kind === "DEPENDENT" ? mapDependantRow(header, cells) : mapBeneficiaryRow(header, cells);
          const row = { ...common } as DependantRow & BeneficiaryRow;
          if (!outcome.ok) {
            row.companyNumber = cellByName(header, cells, "CompanyNumber").toUpperCase() || null;
            row.idNumber = outcome.memberIdNumber;
            row.name = outcome.name;
            fail(row, outcome.message, outcome.reasonCodes);
          } else {
            row.record = outcome.record as DependantImportRecord & BeneficiaryImportRecord;
            row.companyNumber = outcome.record.companyNumber;
            row.idNumber = outcome.record.memberIdNumber;
            row.name = outcome.record.fullName;
          }
          if (kind === "DEPENDENT") dependantRows.push(row);
          else beneficiaryRows.push(row);
        }
      }
    }
    const childRows: (DependantRow | BeneficiaryRow)[] = [...dependantRows, ...beneficiaryRows];

    // ---- Company checks ------------------------------------------------------
    for (const row of [...memberRows, ...childRows]) {
      if (row.companyNumber && !inScope(admin, row.companyNumber)) {
        fail(row, `You can't import for company ${row.companyNumber}.`, ["OUT_OF_SCOPE"]);
        row.companyNumber = null;
      }
    }

    // ---- Read what is on file, inside the admin's scope ------------------------
    const wantedIdNumbers = [
      ...new Set(
        [...memberRows.map((r) => r.record?.idNumber), ...childRows.map((r) => r.idNumber)]
          .filter((v): v is string => !!v)
          .map((v) => v.trim()),
      ),
    ];
    const onFile = await withScope(admin.scope, async (tx) => {
      const companies = new Map((await tx.select().from(bhiCompanyTable)).map((c) => [c.companyNumber, c]));
      const classes = new Map((await tx.select().from(bhiClassTable)).map((c) => [c.classCode, c]));
      const members: BhiMember[] = [];
      for (const slice of chunks(wantedIdNumbers)) {
        members.push(...(await tx.select().from(bhiMemberTable).where(inArray(bhiMemberTable.idNumber, slice))));
      }
      const involved = new Set<string>();
      for (const r of [...memberRows, ...childRows]) if (r.companyNumber) involved.add(r.companyNumber);
      for (const m of members) involved.add(m.companyNumber);
      const openByCompany = new Map<string, Map<string, OpenMemberException[]>>();
      const openChildByCompany = new Map<string, Map<string, OpenChildException[]>>();
      for (const c of involved) {
        if (!companies.has(c)) continue;
        openByCompany.set(c, await openMemberExceptions(tx, c));
        openChildByCompany.set(c, await openChildExceptions(tx, c));
      }
      const rateComplete = await rateCompleteClassCodes(tx);
      return { companies, classes, rateComplete, members, openByCompany, openChildByCompany };
    });
    const companyOf = (n: string | null): BhiCompany | undefined => (n ? onFile.companies.get(n) : undefined);
    const inScopeByPair = new Map(onFile.members.map((m) => [pairKey(m.idType, m.idNumber), m]));
    const inScopeById = new Map<string, BhiMember[]>();
    for (const m of onFile.members) {
      const list = inScopeById.get(idKey(m.idNumber)) ?? [];
      list.push(m);
      inScopeById.set(idKey(m.idNumber), list);
    }

    // An ID is unique across the whole platform. Whether it is registered in a
    // company outside the scope is checked with an all-companies read, which
    // reveals only that it exists — the same thing the unique constraint would
    // reveal on insert — and never whose it is (spec FR-007).
    const newPairs = memberRows
      .filter((r) => r.record && r.status !== "ERROR" && !inScopeByPair.has(pairKey(r.record.idType, r.record.idNumber)))
      .map((r) => r.record!);
    const registeredElsewhere = new Set<string>();
    if (newPairs.length > 0) {
      await withScope({ all: true, readOnly: true }, async (tx) => {
        for (const slice of chunks([...new Set(newPairs.map((p) => p.idNumber))])) {
          const found = await tx
            .select({ idType: bhiMemberTable.idType, idNumber: bhiMemberTable.idNumber })
            .from(bhiMemberTable)
            .where(inArray(bhiMemberTable.idNumber, slice));
          for (const f of found) registeredElsewhere.add(pairKey(f.idType, f.idNumber));
        }
      });
    }

    // ---- Member row decisions ------------------------------------------------
    for (const row of memberRows) {
      const company = companyOf(row.companyNumber);
      if (row.companyNumber && !company) {
        fail(row, `Company ${row.companyNumber} is not on the platform. Companies are added by onboarding.`, ["UNKNOWN_COMPANY"]);
      } else if (company && !company.active) {
        fail(row, `${company.companyName} has been offboarded; its records can no longer be changed.`, ["COMPANY_INACTIVE"]);
      }
      if (row.status === "ERROR" || !row.record) continue;
      const r = row.record;
      const existing = inScopeByPair.get(pairKey(r.idType, r.idNumber));
      if (existing && existing.companyNumber !== r.companyNumber) {
        fail(row, `This ID is already registered to a member of ${existing.companyNumber}.`, ["ID_ALREADY_REGISTERED"], {
          duplicate: true,
        });
        continue;
      }
      if (!existing && registeredElsewhere.has(pairKey(r.idType, r.idNumber))) {
        fail(row, ID_ALREADY_REGISTERED_MESSAGE, ["ID_ALREADY_REGISTERED"], { duplicate: true });
        continue;
      }
      row.assignsClass = !existing || existing.classCode !== r.classCode;
      if (row.assignsClass) {
        const cls = onFile.classes.get(r.classCode);
        if (!cls || !cls.active || !onFile.rateComplete.has(cls.classCode)) {
          fail(
            row,
            !cls
              ? `There is no class "${r.classCode}".`
              : !cls.active
                ? `Class ${cls.classCode} (${cls.className}) is retired and cannot be given to a member.`
                : `Class ${cls.classCode} (${cls.className}) has no complete standard rate in force by ${nextBillingMonthStart()}, the first month a member given it now is billed, so it cannot be given to a member yet.`,
            ["UNKNOWN_CLASS"],
          );
          continue;
        }
      }
      if (existing) {
        row.existing = existing;
        row.existingRecord = true;
        row.status = "WARN";
        // Blank cells never overwrite (writeMember uses supplied()), so only
        // filled-in cells that differ are changes.
        row.changedFields = Object.keys(
          changedFields(existing as unknown as Record<string, unknown>, supplied(memberColumns(r))),
        );
        if (row.activeGiven && r.active !== existing.active) row.changedFields.push("active");
        row.message = row.changedFields.length
          ? `Already exists — this row will update the existing member (${row.changedFields.join(", ")}).`
          : "Already exists — this row matches the member on file; nothing would change.";
        const dob = r.dateOfBirth ?? existing.dateOfBirth;
        if (row.activeGiven && r.active && !existing.active && dob && hasReachedRetirementAge(dob, today)) {
          row.message += ` Not reactivated: cover ends at ${RETIREMENT_AGE}.`;
        }
        // A held row for someone already on file (held, say, for a bad date on
        // an update) is fixed by this corrected row as well.
        const openForExisting = matchOpenException(onFile.openByCompany.get(r.companyNumber) ?? new Map(), r);
        if (openForExisting) {
          row.open = openForExisting;
          row.resolvesExceptionId = openForExisting.exception.exceptionId;
          row.message += ` This fixes held record #${openForExisting.exception.exceptionId}.`;
        }
        continue;
      }
      // A new member needs a date of birth: without one the member could never
      // be retired at 65, and would be billed indefinitely.
      if (!r.dateOfBirth) {
        fail(row, "DateOfBirth is required for a new member (cover ends at 65).", ["MISSING_DATE_OF_BIRTH"]);
        continue;
      }
      // Cover ends at 65: adding someone past it would only be undone by the sweep.
      if (r.dateOfBirth && hasReachedRetirementAge(r.dateOfBirth, today)) {
        fail(
          row,
          `Age ${ageOn(r.dateOfBirth, today)} — the plan's cover ends at ${RETIREMENT_AGE}, so this member was not added. ` +
            "Check the date of birth if this is wrong.",
          ["AGED_OUT"],
        );
        continue;
      }
      const open = matchOpenException(onFile.openByCompany.get(r.companyNumber) ?? new Map(), r);
      if (open) {
        row.open = open;
        row.resolvesExceptionId = open.exception.exceptionId;
        row.message = `New member; this fixes held record #${open.exception.exceptionId}.`;
      } else {
        row.message = r.active ? "New member will be created." : "New member will be created as inactive.";
      }
    }

    // ---- Child row decisions -------------------------------------------------
    const loadable = memberRows.filter((r) => r.record && r.status !== "ERROR");
    const heldMembers = memberRows.filter((r) => r.status === "ERROR" && r.reasonCodes.every((c) => HOLDABLE.has(c)));
    const byIdInFile = (rows: MemberRow[], idNumber: string) =>
      rows.filter((r) => r.idNumber && idKey(r.idNumber) === idKey(idNumber));

    const findTarget = (row: DependantRow | BeneficiaryRow): Target[] => {
      const rec = row.record!;
      const matches = new Map<string, Target>();
      const accept = (companyNumber: string, idType: string) =>
        (!rec.companyNumber || rec.companyNumber === companyNumber) &&
        (!rec.memberIdType || rec.memberIdType === normaliseIdType(idType));
      for (const m of byIdInFile(loadable, rec.memberIdNumber)) {
        const r = m.record!;
        if (!accept(r.companyNumber, r.idType)) continue;
        const key = pairKey(r.idType, r.idNumber);
        matches.set(key, { key, companyNumber: r.companyNumber, existingMemberId: m.existing?.memberId ?? null, fileRow: m });
      }
      for (const m of inScopeById.get(idKey(rec.memberIdNumber)) ?? []) {
        if (!accept(m.companyNumber, m.idType)) continue;
        const key = pairKey(m.idType, m.idNumber);
        const known = matches.get(key);
        if (known) {
          // A file row naming the member in another company was refused above.
          if (known.companyNumber === m.companyNumber) continue;
        }
        matches.set(key, { key, companyNumber: m.companyNumber, existingMemberId: m.memberId, fileRow: null });
      }
      return [...matches.values()];
    };

    for (const row of childRows) {
      if (row.status === "ERROR" || !row.record) {
        // Held under the member's company when the member can be told apart.
        if (!row.companyNumber && row.idNumber) {
          const found = inScopeById.get(idKey(row.idNumber)) ?? [];
          row.companyNumber = found.length === 1 ? found[0]!.companyNumber : onlyCompany;
        }
        continue;
      }
      const targets = findTarget(row);
      const what = row.kind === "DEPENDENT" ? "dependant" : "beneficiary";
      if (targets.length > 1) {
        fail(
          row,
          `ID number "${row.record.memberIdNumber}" matches ${targets.length} members. Fill in CompanyNumber and MemberIDType to say which one.`,
          ["AMBIGUOUS_MEMBER"],
        );
        row.companyNumber = row.companyNumber ?? onlyCompany;
        continue;
      }
      if (targets.length === 0) {
        const heldWith = byIdInFile(heldMembers, row.record.memberIdNumber).find(
          (m) => !row.record!.companyNumber || m.companyNumber === row.record!.companyNumber,
        );
        if (heldWith) {
          // Kept in the member's exception, restored when the member's row is fixed.
          if (row.kind === "DEPENDENT") heldWith.heldDependents.push(toSnapshotDependent(row.record as DependantImportRecord));
          else heldWith.heldBeneficiaries.push(toSnapshotBeneficiary(row.record as BeneficiaryImportRecord));
          fail(row, `Held with its member (sheet "${heldWith.sheet}", row ${heldWith.rowNumber}) until that row is fixed.`, ["HELD_WITH_MEMBER"]);
          row.companyNumber = heldWith.companyNumber;
          continue;
        }
        fail(
          row,
          `No member has ID number "${row.record.memberIdNumber}" in your companies. Check the Members sheet contains them.`,
          ["MEMBER_NOT_FOUND"],
        );
        row.companyNumber = row.companyNumber ?? onlyCompany;
        continue;
      }
      const target = targets[0]!;
      const company = companyOf(target.companyNumber);
      if (company && !company.active) {
        fail(row, `${company.companyName} has been offboarded; its records can no longer be changed.`, ["COMPANY_INACTIVE"]);
        continue;
      }
      row.target = target;
      row.companyNumber = target.companyNumber;
      row.message = row.record.active ? `New ${what} will be added.` : `New ${what} will be added as inactive.`;
    }

    // Children already on those members, so a re-import updates rather than duplicates.
    const targetIds = [...new Set(childRows.map((r) => r.target?.existingMemberId).filter((v): v is number => !!v))];
    const existingChildren = targetIds.length
      ? await withScope(admin.scope, async (tx) => {
          const deps: BhiDependent[] = [];
          const bens: BhiBeneficiary[] = [];
          for (const slice of chunks(targetIds)) {
            deps.push(...(await tx.select().from(bhiDependentTable).where(inArray(bhiDependentTable.memberId, slice))));
            bens.push(...(await tx.select().from(bhiBeneficiaryTable).where(inArray(bhiBeneficiaryTable.memberId, slice))));
          }
          return { deps, bens };
        })
      : { deps: [], bens: [] };
    const depKeys = new Map(
      existingChildren.deps.map((d) => [
        `${d.memberId}::${dependantMatchKey({ idNumber: d.idNumber, fullName: d.dependentFullName, dateOfBirth: d.dateOfBirth })}`,
        d,
      ]),
    );
    const benKeys = new Map(
      existingChildren.bens.map((b) => [
        `${b.memberId}::${beneficiaryMatchKey({ idNumber: b.idNumber, fullName: b.beneficiaryFullName, dateOfBirth: b.dateOfBirth })}`,
        b,
      ]),
    );
    const seenChild = new Map<string, number>();
    for (const row of childRows) {
      if (row.status === "ERROR" || !row.target || !row.record) continue;
      const matchKey =
        row.kind === "DEPENDENT"
          ? dependantMatchKey(row.record as DependantImportRecord)
          : beneficiaryMatchKey(row.record as BeneficiaryImportRecord);
      const inFile = `${row.kind}::${row.target.key}::${matchKey}`;
      const first = seenChild.get(inFile);
      if (first !== undefined) {
        fail(row, `Duplicate of row ${first} — the same person appears twice for this member.`, ["DUPLICATE_IN_FILE"], {
          duplicate: true,
        });
        continue;
      }
      seenChild.set(inFile, row.rowNumber);
      if (row.target.existingMemberId) {
        const found =
          row.kind === "DEPENDENT"
            ? depKeys.get(`${row.target.existingMemberId}::${matchKey}`)?.dependentId
            : benKeys.get(`${row.target.existingMemberId}::${matchKey}`)?.beneficiaryId;
        if (found) {
          row.existingId = found;
          row.existingRecord = true;
          row.status = "WARN";
          row.message = `Already on file — this row updates the existing ${row.kind === "DEPENDENT" ? "dependant" : "beneficiary"}.`;
        }
      }
      const rec = row.record as DependantImportRecord | BeneficiaryImportRecord;
      const openChild = matchOpenChildException(onFile.openChildByCompany.get(row.target.companyNumber) ?? new Map(), row.kind, {
        memberIdNumber: rec.memberIdNumber,
        fullName: rec.fullName,
        idNumber: rec.idNumber,
      });
      if (openChild) {
        row.openChild = openChild;
        row.resolvesExceptionId = openChild.exception.exceptionId;
        row.message += ` This fixes held record #${openChild.exception.exceptionId}.`;
      }
    }

    // A member's shares should add up. Flagged, not blocked: the carrier's file
    // is the record of what was signed.
    const shareTotals = new Map<string, number>();
    for (const row of beneficiaryRows) {
      if (row.status === "ERROR" || !row.target || !row.record?.active || row.record.sharePercent == null) continue;
      shareTotals.set(row.target.key, (shareTotals.get(row.target.key) ?? 0) + row.record.sharePercent);
    }
    for (const row of beneficiaryRows) {
      if (row.status === "ERROR" || !row.target) continue;
      const total = shareTotals.get(row.target.key);
      if (total == null || Math.round(total * 100) === 100 * 100) continue;
      row.status = "WARN";
      row.message += ` Shares for this member total ${Math.round(total * 100) / 100}%, not 100% — check the file with the carrier.`;
    }

    // Held rows: holdable reasons, under a company in scope that can take writes.
    for (const row of [...memberRows, ...childRows]) {
      if (row.status !== "ERROR" || row.reasonCodes.includes("HELD_WITH_MEMBER")) continue;
      const company = companyOf(row.companyNumber);
      row.held = !!company && company.active && row.reasonCodes.every((c) => HOLDABLE.has(c));
    }

    const suppliesDependents = new Set(dependantRows.filter((r) => r.status !== "ERROR" && r.target).map((r) => r.target!.key));
    const suppliesBeneficiaries = new Set(beneficiaryRows.filter((r) => r.status !== "ERROR" && r.target).map((r) => r.target!.key));
    const memberKey = (r: MemberRow) => pairKey(r.record!.idType, r.record!.idNumber);

    // ---- Commit, one transaction per company ---------------------------------
    const resolvedExceptions: {
      exceptionId: number;
      companyNumber: string;
      memberId: number;
      personName: string | null;
      restoredDependents: number;
      restoredBeneficiaries: number;
    }[] = [];
    const batches: { companyNumber: string; sourceFile: string | null; saved: boolean; message: string | null }[] = [];
    let committedCount = 0;

    const allRows: ResultRow[] = [...memberRows, ...childRows];
    // Updating records already on file needs an explicit yes (confirmUpdates),
    // so re-uploading last month's file cannot quietly overwrite anyone.
    const existingRows = [...memberRows, ...childRows].filter((r) => r.existingRecord && r.status !== "ERROR");
    if (!dryRun && existingRows.length > 0 && parsed.data.confirmUpdates !== true) {
      res.status(409).json({
        error: {
          code: "UPDATES_NOT_CONFIRMED",
          message: `${existingRows.length} row${existingRows.length === 1 ? "" : "s"} of this file already exist in the system and would be updated. Preview the file, review them, and confirm the update to commit.`,
        },
        existingCount: existingRows.length,
      });
      return;
    }

    const touchedCompanies = [
      ...new Set(
        allRows
          .filter((r) => r.companyNumber && (r.status !== "ERROR" || r.held))
          .map((r) => r.companyNumber!),
      ),
    ].sort();

    if (dryRun) {
      for (const row of memberRows) {
        if (!row.open || row.status === "ERROR") continue;
        resolvedExceptions.push({
          exceptionId: row.open.exception.exceptionId,
          companyNumber: row.companyNumber!,
          memberId: 0,
          personName: row.open.exception.personName,
          restoredDependents: suppliesDependents.has(memberKey(row)) ? 0 : row.open.snapshot.dependents.length,
          restoredBeneficiaries: suppliesBeneficiaries.has(memberKey(row)) ? 0 : row.open.snapshot.beneficiaries.length,
        });
      }
      for (const row of childRows) {
        if (!row.openChild || row.status === "ERROR") continue;
        resolvedExceptions.push({
          exceptionId: row.openChild.exception.exceptionId,
          companyNumber: row.companyNumber!,
          memberId: 0,
          personName: row.openChild.exception.personName,
          restoredDependents: 0,
          restoredBeneficiaries: 0,
        });
      }
    } else {
      for (const companyNumber of touchedCompanies) {
        const inCompany = (r: ResultRow) => r.companyNumber === companyNumber;
        const cMembers = memberRows.filter(inCompany);
        const cChildren = childRows.filter(inCompany);
        const opened: { sourceFile: string | null } = { sourceFile: null };
        try {
          const counts = await withScope(admin.scope, async (tx) => {
            const batch = await createBatch(tx, {
              companyNumber,
              originalFileName: fileName,
              createdBy: admin.user.email,
            });
            opened.sourceFile = batch.sourceFile;
            const tally = { created: 0, updated: 0, dependents: 0, beneficiaries: 0, held: 0, resolved: 0 };

            for (const row of cMembers) {
              if (row.held) {
                await recordException(tx, batch, {
                  entityType: "MEMBER",
                  personName: row.name,
                  memberIdentifier: row.idNumber,
                  reasonCodes: row.reasonCodes,
                  reason: row.message,
                  requiredAction: requiredAction(row.reasonCodes),
                  sheetName: row.sheet,
                  excelRow: row.rowNumber,
                  snapshot: {
                    version: 1,
                    member: row.snapshotMember,
                    dependents: row.heldDependents,
                    beneficiaries: row.heldBeneficiaries,
                  },
                });
                tally.held++;
                continue;
              }
              if (row.status === "ERROR" || !row.record) continue;
              row.memberId = await writeMember(tx, admin, row, today);
              if (row.existing) tally.updated++;
              else tally.created++;
              if (row.open) {
                const result = await resolveException(tx, row.open, {
                  memberId: row.memberId,
                  resolvedBy: admin.user.email,
                  fileSuppliesDependents: suppliesDependents.has(memberKey(row)),
                  fileSuppliesBeneficiaries: suppliesBeneficiaries.has(memberKey(row)),
                });
                resolvedExceptions.push({
                  ...result,
                  companyNumber,
                  memberId: row.memberId,
                  personName: row.open.exception.personName,
                });
                tally.resolved++;
              }
            }

            for (const row of cChildren) {
              if (row.held) {
                await recordException(tx, batch, {
                  entityType: row.kind,
                  personName: row.name,
                  memberIdentifier: row.idNumber,
                  reasonCodes: row.reasonCodes,
                  reason: row.message,
                  requiredAction: requiredAction(row.reasonCodes),
                  sheetName: row.sheet,
                  excelRow: row.rowNumber,
                  snapshot: {
                    version: 1,
                    member: { idNumber: row.idNumber },
                    dependents: row.kind === "DEPENDENT" && row.record ? [toSnapshotDependent(row.record as DependantImportRecord)] : [],
                    beneficiaries:
                      row.kind === "BENEFICIARY" && row.record ? [toSnapshotBeneficiary(row.record as BeneficiaryImportRecord)] : [],
                  },
                });
                tally.held++;
                continue;
              }
              if (row.status === "ERROR" || !row.record || !row.target) continue;
              const memberId = row.target.fileRow?.memberId ?? row.target.existingMemberId;
              if (!memberId) continue;
              if (row.kind === "DEPENDENT") {
                await writeDependant(tx, admin, row as DependantRow, memberId);
                tally.dependents++;
              } else {
                await writeBeneficiary(tx, admin, row as BeneficiaryRow, memberId);
                tally.beneficiaries++;
              }
              if (row.openChild) {
                await resolveChildException(tx, row.openChild, { memberId, resolvedBy: admin.user.email });
                resolvedExceptions.push({
                  exceptionId: row.openChild.exception.exceptionId,
                  companyNumber,
                  memberId,
                  personName: row.openChild.exception.personName,
                  restoredDependents: 0,
                  restoredBeneficiaries: 0,
                });
                tally.resolved++;
              }
            }

            await writeAudit(
              {
                actor: admin.user.email,
                actorRole: admin.role,
                action: "MEMBERS_IMPORTED",
                entityType: "IMPORT",
                entityId: batch.sourceFile,
                afterValue: JSON.stringify({ sourceFile: batch.sourceFile, originalFileName: fileName, ...tally }),
                sourceIp: req.ip ?? null,
                companyCode: companyNumber,
              },
              tx,
            );
            return tally;
          });
          committedCount += counts.created + counts.updated + counts.dependents + counts.beneficiaries;
          batches.push({ companyNumber, sourceFile: opened.sourceFile, saved: true, message: null });
        } catch (err) {
          const answer = classifyBhiError(err);
          const reason = answer?.message ?? "A write failed.";
          // Not the error itself: a failed insert carries the row's personal data in its parameters.
          req.log?.warn({ companyNumber, code: answer?.code ?? "WRITE_FAILED" }, "import commit failed for company");
          batches.push({
            companyNumber,
            sourceFile: null,
            saved: false,
            message: `Nothing for ${companyNumber} was saved: ${reason}`,
          });
          for (const r of [...cMembers, ...cChildren]) {
            r.saved = false;
            r.held = false;
            if (r.status !== "ERROR") fail(r, `Not saved — ${reason}`, [answer?.code ?? "WRITE_FAILED"]);
          }
          // The resolutions of a rolled-back company never happened.
          for (let i = resolvedExceptions.length - 1; i >= 0; i--) {
            if (resolvedExceptions[i]!.companyNumber === companyNumber) resolvedExceptions.splice(i, 1);
          }
        }
      }
    }

    if (!dryRun) {
      const saved = batches.filter((b) => b.saved).map((b) => b.companyNumber);
      await recalcDraftBills(req, admin, saved, "Bulk import");
    }

    // ---- Response ------------------------------------------------------------
    const summarise = (list: ResultRow[]) => ({
      totalRows: list.length,
      okCount: list.filter((r) => r.status === "OK").length,
      warnCount: list.filter((r) => r.status === "WARN").length,
      errorCount: list.filter((r) => r.status === "ERROR").length,
      duplicateCount: list.filter((r) => r.duplicate).length,
      invalidPhoneCount: list.filter((r) => r.invalidPhone).length,
      heldCount: list.filter((r) => r.held).length,
      existingCount: list.filter((r) => r.existingRecord && r.status !== "ERROR").length,
    });
    const serialise = (list: ResultRow[]) =>
      list.map((r) => ({
        rowNumber: r.rowNumber,
        status: r.status,
        message: r.message,
        companyNumber: r.companyNumber,
        idNumber: r.idNumber,
        name: r.name,
        reasonCodes: r.status === "ERROR" ? r.reasonCodes : [],
        duplicate: r.duplicate,
        invalidPhone: r.invalidPhone,
        held: r.held,
        existingRecord: r.existingRecord,
        changedFields: r.changedFields,
        recordType: "kind" in r ? (r as { kind: string }).kind : "MEMBER",
        resolvesExceptionId: r.resolvesExceptionId,
      }));
    const layoutDescription = (layout: string) => IMPORT_LAYOUTS.find((l) => l.layout === layout)?.description ?? "";

    res.json({
      dryRun,
      layout: memberSheets[0]?.layout ?? recognised[0]!.layout,
      ...summarise(allRows),
      committedCount,
      resolvedExceptions,
      batches,
      rows: serialise(allRows),
      sheets: recognised.map((s) => {
        const list = allRows.filter((r) => r.sheet === s.name);
        return {
          name: s.name,
          layout: s.layout,
          ...summarise(list),
          committedCount: dryRun ? 0 : list.filter((r) => r.saved && r.status !== "ERROR").length,
          message: layoutDescription(s.layout),
          rows: serialise(list),
        };
      }),
    });
  },
);

/** Creates or updates one member; returns its id. */
async function writeMember(tx: ScopedTx, admin: AdminContext, row: MemberRow, today: string): Promise<number> {
  const r = row.record!;
  const actor = admin.user.email;
  if (!row.existing) {
    const [member] = await tx
      .insert(bhiMemberTable)
      .values({ ...memberColumns(r), idType: r.idType, idNumber: r.idNumber, companyNumber: r.companyNumber, active: true })
      .returning({ memberId: bhiMemberTable.memberId });
    const memberId = member!.memberId;
    await tx.insert(memberClassHistoryTable).values({ memberId, classCode: r.classCode, recordedBy: actor });
    if (!r.active) {
      await setActive(tx, {
        entityType: "MEMBER",
        id: memberId,
        active: false,
        reason: r.inactiveReason ?? "Inactive in bulk import",
        effectiveDate: r.inactiveDate ?? undefined,
        actor,
      });
    }
    return memberId;
  }

  const existing = row.existing;
  const changes = changedFields(existing as unknown as Record<string, unknown>, supplied(memberColumns(r)));
  if (Object.keys(changes).length > 0) {
    await tx.update(bhiMemberTable).set(changes).where(eq(bhiMemberTable.memberId, existing.memberId));
    if ("classCode" in changes) {
      await tx.insert(memberClassHistoryTable).values({ memberId: existing.memberId, classCode: r.classCode, recordedBy: actor });
    }
  }
  if (row.activeGiven && r.active !== existing.active) {
    const dob = r.dateOfBirth ?? existing.dateOfBirth;
    const agedOut = r.active && dob != null && hasReachedRetirementAge(dob, today);
    if (!agedOut) {
      await setActive(tx, {
        entityType: "MEMBER",
        id: existing.memberId,
        active: r.active,
        reason: r.inactiveReason ?? (r.active ? "Reactivated by bulk import" : "Inactive in bulk import"),
        effectiveDate: r.active ? undefined : (r.inactiveDate ?? undefined),
        actor,
      });
    }
  }
  return existing.memberId;
}

async function writeDependant(tx: ScopedTx, admin: AdminContext, row: DependantRow, memberId: number): Promise<void> {
  const r = row.record!;
  const actor = admin.user.email;
  // A blank Relationship is left out, which supplied() drops, so an update keeps
  // the relationship on file; only a new dependant falls back to OTHER.
  const columns = {
    idType: r.idType,
    idNumber: r.idNumber,
    dependentFullName: r.fullName,
    dateOfBirth: r.dateOfBirth,
    sex: r.sex,
    relationship: r.relationship ?? undefined,
    notes: r.notes,
  };
  let id = row.existingId;
  if (id) {
    await tx.update(bhiDependentTable).set(supplied(columns)).where(eq(bhiDependentTable.dependentId, id));
  } else {
    const [created] = await tx
      .insert(bhiDependentTable)
      .values({ ...columns, relationship: r.relationship ?? "OTHER", memberId, active: true })
      .returning({ id: bhiDependentTable.dependentId });
    id = created!.id;
  }
  if (!row.existingId ? !r.active : row.activeGiven) {
    await setActive(tx, {
      entityType: "DEPENDENT",
      id,
      active: r.active,
      reason: r.inactiveReason ?? (r.active ? "Reactivated by bulk import" : "Inactive in bulk import"),
      effectiveDate: r.active ? undefined : (r.inactiveDate ?? undefined),
      actor,
    });
  }
}

async function writeBeneficiary(tx: ScopedTx, admin: AdminContext, row: BeneficiaryRow, memberId: number): Promise<void> {
  const r = row.record!;
  const actor = admin.user.email;
  // A blank Relationship (or a sheet without the column) is null, which
  // supplied() drops, so an update never clears a value HR entered by hand.
  const columns = {
    idType: r.idType,
    idNumber: r.idNumber,
    beneficiaryFullName: r.fullName,
    dateOfBirth: r.dateOfBirth,
    sex: r.sex,
    relationship: r.relationship,
    phone: r.phone,
    email: r.email,
    sharePercent: r.sharePercent == null ? null : String(r.sharePercent),
    notes: r.notes,
  };
  let id = row.existingId;
  if (id) {
    await tx.update(bhiBeneficiaryTable).set(supplied(columns)).where(eq(bhiBeneficiaryTable.beneficiaryId, id));
  } else {
    const [created] = await tx
      .insert(bhiBeneficiaryTable)
      .values({ ...columns, memberId, active: true })
      .returning({ id: bhiBeneficiaryTable.beneficiaryId });
    id = created!.id;
  }
  if (!row.existingId ? !r.active : row.activeGiven) {
    await setActive(tx, {
      entityType: "BENEFICIARY",
      id,
      active: r.active,
      reason: r.inactiveReason ?? (r.active ? "Reinstated by bulk import" : "Withdrawn in bulk import"),
      effectiveDate: r.active ? undefined : (r.inactiveDate ?? undefined),
      actor,
    });
  }
}

/**
 * The sheet layouts the importer accepts. Served rather than duplicated in the
 * admin screen, so the columns the parser looks for and the columns the screen
 * advertises are the same list.
 */
router.get(
  "/v1/admin/import/layouts",
  requireAdmin,
  requirePermission("MEMBER_IMPORT"),
  async (_req, res): Promise<void> => {
    res.json({
      layouts: IMPORT_LAYOUTS.map((l) => ({
        layout: l.layout,
        label: l.label,
        columns: l.columns,
        description: l.description,
      })),
    });
  },
);

export default router;
