/**
 * Import batches and the exceptions held under them (spec FR-009, FR-041,
 * FR-042; research R17).
 *
 * Every bulk import is one `import_batch` per company. The ten BHI import tables have no company column, so the
 * batch is how row-level security traces an exception back to its company:
 * an exception's `source_file` is its batch's.
 *
 * A row that cannot be loaded is held in bhi.import_exception with a JSON
 * snapshot of the person and their family in `raw_row_summary`. When HR
 * uploads a corrected row, the importer finds the open exception
 * (`matchOpenException` for a member, new or already on file;
 * `matchOpenChildException` for a dependant or beneficiary), loads the row,
 * restores any family held with a member and records the fix in
 * `import_exception_resolutions` (`resolveException`,
 * `resolveChildException`). An exception fixed some other way is marked
 * resolved by hand, with a note (`resolveManually`).
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  bhiBeneficiaryTable,
  bhiDependentTable,
  bhiImportExceptionTable,
  importBatchTable,
  importExceptionResolutionsTable,
  type BhiImportException,
  type ImportBatch,
  type ScopedTx,
} from "@workspace/db";
import { normaliseIdType, type ImportReasonCode } from "./memberImport";

/**
 * BULK_IMPORT for every new batch. LEGACY_MIGRATION marks batches written by the
 * one-off move from the pre-BHI tables; their held records can still be fixed
 * through bulk import like any other.
 */
export type BatchKind = "BULK_IMPORT" | "LEGACY_MIGRATION";

/** A held dependant, as stored in an exception snapshot. */
export interface SnapshotDependent {
  idType: string | null;
  idNumber: string | null;
  fullName: string;
  dateOfBirth: string | null;
  sex: string | null;
  relationship: string;
  active: boolean;
  inactiveDate: string | null;
  inactiveReason: string | null;
  notes: string | null;
}

/** A held beneficiary, as stored in an exception snapshot. */
export interface SnapshotBeneficiary {
  idType: string | null;
  idNumber: string | null;
  fullName: string;
  dateOfBirth: string | null;
  sex: string | null;
  relationship: string | null;
  phone: string | null;
  email: string | null;
  sharePercent: number | null;
  active: boolean;
  inactiveDate: string | null;
  inactiveReason: string | null;
  notes: string | null;
}

/**
 * What `raw_row_summary` holds. `member` is whatever the source said about the
 * person — the cells of an uploaded row keyed by column —
 * with `idType`, `idNumber`, `firstName` and `lastName` when known, because
 * those are what a corrected row is matched on.
 */
export interface ExceptionSnapshot {
  version: 1;
  member: Record<string, unknown> & {
    idType?: string | null;
    idNumber?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  };
  dependents: SnapshotDependent[];
  beneficiaries: SnapshotBeneficiary[];
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

function yyyymmdd(at: Date): string {
  return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1, 2)}${pad(at.getUTCDate(), 2)}`;
}

/** The file extension to put on a generated source_file, from the uploaded name. */
function extensionOf(fileName: string | null | undefined): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(fileName ?? "");
  return match ? match[1]!.toLowerCase() : "csv";
}

/**
 * Opens a batch for one company. `source_file` is generated —
 * `<company>-<yyyymmdd>-<ordinal>.<ext>` — so it is unique platform-wide
 * whatever the uploaded file was called; the real name is kept in
 * `original_file_name`.
 */
export async function createBatch(
  tx: ScopedTx,
  input: {
    companyNumber: string;
    originalFileName?: string | null;
    createdBy: string;
    at?: Date;
  },
): Promise<ImportBatch> {
  const result = await tx.execute(sql`SELECT nextval('bhi.import_batch_ordinal_seq')::int AS n`);
  const ordinal = Number((result.rows[0] as { n: number | string }).n);
  const sourceFile = `${input.companyNumber}-${yyyymmdd(input.at ?? new Date())}-${pad(ordinal, 4)}.${extensionOf(input.originalFileName)}`;
  const [batch] = await tx
    .insert(importBatchTable)
    .values({
      companyNumber: input.companyNumber,
      kind: "BULK_IMPORT",
      sourceOrdinal: ordinal,
      sourceFile,
      originalFileName: input.originalFileName ?? null,
      createdBy: input.createdBy,
    })
    .returning();
  return batch!;
}

export interface ExceptionInput {
  entityType: "MEMBER" | "DEPENDENT" | "BENEFICIARY";
  personName: string | null;
  /** The ID number HR will put in the corrected row. */
  memberIdentifier: string | null;
  reasonCodes: (ImportReasonCode | string)[];
  reason: string;
  requiredAction: string;
  snapshot: ExceptionSnapshot;
  sheetName?: string | null;
  excelRow?: number | null;
}

/** Holds one record under the batch. Values are clipped to their BHI sizes. */
export async function recordException(
  tx: ScopedTx,
  batch: ImportBatch,
  input: ExceptionInput,
): Promise<BhiImportException> {
  const [row] = await tx
    .insert(bhiImportExceptionTable)
    .values({
      sourceAlias: batch.kind,
      sourceFile: batch.sourceFile,
      sheetName: input.sheetName?.slice(0, 100) ?? null,
      excelRow: input.excelRow ?? null,
      entityType: input.entityType,
      personName: input.personName?.slice(0, 255) ?? null,
      memberIdentifier: input.memberIdentifier?.slice(0, 100) ?? null,
      reasonCodes: [...new Set(input.reasonCodes)].join(","),
      reason: input.reason,
      requiredAction: input.requiredAction,
      rawRowSummary: JSON.stringify(input.snapshot),
    })
    .returning();
  return row!;
}

export function parseSnapshot(raw: string | null): ExceptionSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ExceptionSnapshot>;
    if (!parsed || typeof parsed !== "object" || !parsed.member) return null;
    return {
      version: 1,
      member: parsed.member,
      dependents: Array.isArray(parsed.dependents) ? parsed.dependents : [],
      beneficiaries: Array.isArray(parsed.beneficiaries) ? parsed.beneficiaries : [],
    };
  } catch {
    return null;
  }
}

const nameKey = (first: unknown, last: unknown) =>
  `${String(first ?? "")} ${String(last ?? "")}`.trim().toLowerCase().replace(/\s+/g, " ");

export interface OpenMemberException {
  exception: BhiImportException;
  snapshot: ExceptionSnapshot;
  batchKind: BatchKind;
}

/**
 * The open member exceptions of one company, indexed by ID number for the
 * importer. Loaded once per company rather than per row.
 */
export async function openMemberExceptions(
  tx: ScopedTx,
  companyNumber: string,
): Promise<Map<string, OpenMemberException[]>> {
  const rows = await tx
    .select({ exception: bhiImportExceptionTable, kind: importBatchTable.kind })
    .from(bhiImportExceptionTable)
    .innerJoin(importBatchTable, eq(importBatchTable.sourceFile, bhiImportExceptionTable.sourceFile))
    .leftJoin(
      importExceptionResolutionsTable,
      eq(importExceptionResolutionsTable.exceptionId, bhiImportExceptionTable.exceptionId),
    )
    .where(
      and(
        eq(importBatchTable.companyNumber, companyNumber),
        eq(bhiImportExceptionTable.entityType, "MEMBER"),
        isNull(importExceptionResolutionsTable.exceptionId),
      ),
    );
  const byId = new Map<string, OpenMemberException[]>();
  for (const { exception, kind } of rows) {
    const key = exception.memberIdentifier?.trim().toLowerCase();
    if (!key) continue;
    const snapshot = parseSnapshot(exception.rawRowSummary) ?? {
      version: 1 as const,
      member: {},
      dependents: [],
      beneficiaries: [],
    };
    const list = byId.get(key) ?? [];
    list.push({ exception, snapshot, batchKind: kind });
    byId.set(key, list);
  }
  return byId;
}

/**
 * The open exception a loaded member row fixes, if any: same ID number, and
 * the same ID type when the exception knows one — otherwise the same name,
 * which is how a legacy member held for having no ID type is recognised. ID
 * types are compared after folding their spellings (normaliseIdType), since a
 * held row keeps the type as the sheet wrote it.
 */
export function matchOpenException(
  index: Map<string, OpenMemberException[]>,
  row: { idType: string; idNumber: string; firstName: string; lastName: string },
): OpenMemberException | null {
  const candidates = index.get(row.idNumber.trim().toLowerCase()) ?? [];
  for (const c of candidates) {
    const heldType = normaliseIdType((c.snapshot.member.idType ?? "").toString());
    if (heldType) {
      if (heldType === normaliseIdType(row.idType)) return c;
    } else if (nameKey(c.snapshot.member.firstName, c.snapshot.member.lastName) === nameKey(row.firstName, row.lastName)) {
      return c;
    }
  }
  return null;
}

export interface ResolveResult {
  exceptionId: number;
  restoredDependents: number;
  restoredBeneficiaries: number;
}

/**
 * Marks the exception fixed by `memberId` and restores the family it held.
 * Dependants and beneficiaries are restored only when the upload did not
 * supply its own for this member — the file is then the newer word.
 */
export async function resolveException(
  tx: ScopedTx,
  open: OpenMemberException,
  input: {
    memberId: number;
    resolvedBy: string;
    fileSuppliesDependents: boolean;
    fileSuppliesBeneficiaries: boolean;
  },
): Promise<ResolveResult> {
  const { exception, snapshot } = open;
  await tx.insert(importExceptionResolutionsTable).values({
    exceptionId: exception.exceptionId,
    resolvedBy: input.resolvedBy,
    memberId: input.memberId,
  });

  // The member may already be on file (an update resolved the exception), with
  // family HR entered meanwhile: those are not restored a second time.
  const onFileDependents = await tx
    .select({ name: bhiDependentTable.dependentFullName, dob: bhiDependentTable.dateOfBirth, idNumber: bhiDependentTable.idNumber })
    .from(bhiDependentTable)
    .where(eq(bhiDependentTable.memberId, input.memberId));
  const dependents = snapshot.dependents.filter((d) => !onFile(onFileDependents, d));
  const onFileBeneficiaries = await tx
    .select({ name: bhiBeneficiaryTable.beneficiaryFullName, dob: bhiBeneficiaryTable.dateOfBirth, idNumber: bhiBeneficiaryTable.idNumber })
    .from(bhiBeneficiaryTable)
    .where(eq(bhiBeneficiaryTable.memberId, input.memberId));
  const beneficiaries = snapshot.beneficiaries.filter((b) => !onFile(onFileBeneficiaries, b));

  let restoredDependents = 0;
  if (!input.fileSuppliesDependents && dependents.length > 0) {
    await tx.insert(bhiDependentTable).values(
      dependents.map((d) => ({
        memberId: input.memberId,
        idType: d.idType,
        idNumber: d.idNumber,
        dependentFullName: d.fullName.slice(0, 120),
        dateOfBirth: d.dateOfBirth,
        sex: d.sex,
        relationship: (d.relationship || "OTHER").slice(0, 30),
        active: d.active,
        inactiveDate: d.active ? null : d.inactiveDate,
        inactiveReason: d.active ? null : d.inactiveReason,
        notes: d.notes,
      })),
    );
    restoredDependents = dependents.length;
  }

  let restoredBeneficiaries = 0;
  if (!input.fileSuppliesBeneficiaries && beneficiaries.length > 0) {
    await tx.insert(bhiBeneficiaryTable).values(
      beneficiaries.map((b) => ({
        memberId: input.memberId,
        idType: b.idType,
        idNumber: b.idNumber,
        beneficiaryFullName: b.fullName.slice(0, 120),
        dateOfBirth: b.dateOfBirth,
        sex: b.sex,
        relationship: b.relationship,
        phone: b.phone,
        email: b.email,
        sharePercent: b.sharePercent == null ? null : String(b.sharePercent),
        active: b.active,
        inactiveDate: b.active ? null : b.inactiveDate,
        inactiveReason: b.active ? null : b.inactiveReason,
        notes: b.notes,
      })),
    );
    restoredBeneficiaries = beneficiaries.length;
  }

  return { exceptionId: exception.exceptionId, restoredDependents, restoredBeneficiaries };
}

/** Is this held person already among the member's family on file? Same ID number, else same name and date of birth. */
function onFile(
  existing: { name: string; dob: string | null; idNumber: string | null }[],
  held: { fullName: string; dateOfBirth: string | null; idNumber: string | null },
): boolean {
  const heldId = held.idNumber?.trim().toLowerCase();
  const heldName = nameKey(held.fullName, "");
  return existing.some((e) =>
    heldId && e.idNumber ? e.idNumber.trim().toLowerCase() === heldId : nameKey(e.name, "") === heldName && (e.dob ?? null) === (held.dateOfBirth ?? null),
  );
}

// ---------------------------------------------------------------------------
// Dependant and beneficiary exceptions
// ---------------------------------------------------------------------------

export type ChildEntity = "DEPENDENT" | "BENEFICIARY";

export interface OpenChildException {
  exception: BhiImportException;
  snapshot: ExceptionSnapshot;
  entityType: ChildEntity;
}

const childKey = (entityType: ChildEntity, memberIdNumber: string) => `${entityType}|${memberIdNumber.trim().toLowerCase()}`;

/**
 * The open dependant and beneficiary exceptions of one company, indexed by
 * kind and the member's ID number (the exception's member_identifier).
 */
export async function openChildExceptions(tx: ScopedTx, companyNumber: string): Promise<Map<string, OpenChildException[]>> {
  const rows = await tx
    .select({ exception: bhiImportExceptionTable })
    .from(bhiImportExceptionTable)
    .innerJoin(importBatchTable, eq(importBatchTable.sourceFile, bhiImportExceptionTable.sourceFile))
    .leftJoin(
      importExceptionResolutionsTable,
      eq(importExceptionResolutionsTable.exceptionId, bhiImportExceptionTable.exceptionId),
    )
    .where(
      and(
        eq(importBatchTable.companyNumber, companyNumber),
        inArray(bhiImportExceptionTable.entityType, ["DEPENDENT", "BENEFICIARY"]),
        isNull(importExceptionResolutionsTable.exceptionId),
      ),
    );
  const index = new Map<string, OpenChildException[]>();
  for (const { exception } of rows) {
    const memberId = exception.memberIdentifier?.trim();
    if (!memberId) continue;
    const entityType = exception.entityType as ChildEntity;
    const snapshot = parseSnapshot(exception.rawRowSummary) ?? { version: 1 as const, member: {}, dependents: [], beneficiaries: [] };
    const key = childKey(entityType, memberId);
    index.set(key, [...(index.get(key) ?? []), { exception, snapshot, entityType }]);
  }
  return index;
}

/**
 * The open exception a loaded dependant or beneficiary row fixes, if any: the
 * same member (ID number) and the same person — by their own ID number when
 * both have one, otherwise by name. Name alone is enough because a held row
 * that failed to map (a bad date, say) keeps nothing else to compare.
 */
export function matchOpenChildException(
  index: Map<string, OpenChildException[]>,
  entityType: ChildEntity,
  row: { memberIdNumber: string; fullName: string; idNumber: string | null },
): OpenChildException | null {
  const candidates = index.get(childKey(entityType, row.memberIdNumber)) ?? [];
  const rowId = row.idNumber?.trim().toLowerCase();
  const rowName = nameKey(row.fullName, "");
  for (const c of candidates) {
    const held = entityType === "DEPENDENT" ? c.snapshot.dependents[0] : c.snapshot.beneficiaries[0];
    const heldId = held?.idNumber?.trim().toLowerCase();
    if (rowId && heldId) {
      if (rowId === heldId) return c;
      continue;
    }
    if (nameKey(c.exception.personName ?? held?.fullName ?? "", "") === rowName) return c;
  }
  return null;
}

/** Marks a dependant or beneficiary exception fixed: the corrected row itself was just written. */
export async function resolveChildException(
  tx: ScopedTx,
  open: OpenChildException,
  input: { memberId: number; resolvedBy: string },
): Promise<void> {
  await tx.insert(importExceptionResolutionsTable).values({
    exceptionId: open.exception.exceptionId,
    resolvedBy: input.resolvedBy,
    memberId: input.memberId,
    method: "IMPORT",
  });
}

export class ExceptionNotOpenError extends Error {
  constructor(readonly code: "NOT_FOUND" | "ALREADY_RESOLVED") {
    super(code === "NOT_FOUND" ? "Import exception not found." : "This exception has already been resolved.");
  }
}

/**
 * Marks an exception resolved by hand — the record was fixed another way, or
 * is no longer needed. Nothing is loaded or restored; the note says why.
 * Throws ExceptionNotOpenError when it is not an open exception of the company.
 */
export async function resolveManually(
  tx: ScopedTx,
  input: { companyNumber: string; exceptionId: number; resolvedBy: string; note: string },
): Promise<void> {
  const [row] = await tx
    .select({ id: bhiImportExceptionTable.exceptionId, resolvedAt: importExceptionResolutionsTable.resolvedAt })
    .from(bhiImportExceptionTable)
    .innerJoin(importBatchTable, eq(importBatchTable.sourceFile, bhiImportExceptionTable.sourceFile))
    .leftJoin(
      importExceptionResolutionsTable,
      eq(importExceptionResolutionsTable.exceptionId, bhiImportExceptionTable.exceptionId),
    )
    .where(and(eq(bhiImportExceptionTable.exceptionId, input.exceptionId), eq(importBatchTable.companyNumber, input.companyNumber)));
  if (!row) throw new ExceptionNotOpenError("NOT_FOUND");
  if (row.resolvedAt) throw new ExceptionNotOpenError("ALREADY_RESOLVED");
  await tx.insert(importExceptionResolutionsTable).values({
    exceptionId: input.exceptionId,
    resolvedBy: input.resolvedBy,
    memberId: null,
    method: "MANUAL",
    note: input.note,
  });
}
