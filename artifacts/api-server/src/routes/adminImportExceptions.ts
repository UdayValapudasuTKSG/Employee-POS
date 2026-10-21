/**
 * HR's fix list: the records bulk import or the legacy migration held back
 * for one company (spec FR-041, FR-042; contracts/admin-api.md, Import).
 *
 * The raw snapshot (`raw_row_summary`) is never returned: it can carry a whole
 * family's details, and the list only needs to say who is held and why. HR
 * fixes a record by uploading a corrected row, which resolves it — or, when it
 * was fixed another way or is no longer needed, marks it resolved by hand with
 * a note (POST …/resolve).
 */
import { Router, type IRouter, type Request } from "express";
import { and, desc, eq, type SQL } from "drizzle-orm";
import {
  bhiCompanyTable,
  bhiImportExceptionTable,
  importBatchTable,
  importExceptionResolutionsTable,
  withScope,
  type ScopedTx,
} from "@workspace/db";
import { ResolveImportExceptionBody } from "@workspace/api-zod";
import { companyParam, inScope, intParam, notFound, writable } from "../lib/adminScope";
import { writeAudit } from "../lib/audit";
import { ExceptionNotOpenError, resolveManually } from "../lib/importBatch";
import { requireAdmin, requirePermission } from "../middlewares/adminAuth";

const router: IRouter = Router();

router.get(
  "/v1/admin/companies/:companyNumber/import-exceptions",
  requireAdmin,
  requirePermission("MEMBER_READ_SCOPED"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const companyNumber = companyParam(req);
    if (!companyNumber || !inScope(admin, companyNumber)) {
      notFound(res);
      return;
    }
    const wanted = typeof req.query["status"] === "string" ? req.query["status"].toUpperCase() : null;
    if (wanted && wanted !== "OPEN" && wanted !== "RESOLVED") {
      res.status(400).json({ error: { code: "INVALID_INPUT", message: "status must be OPEN or RESOLVED." } });
      return;
    }

    const result = await withScope(admin.scope, async (tx) => {
      const [company] = await tx
        .select({ companyNumber: bhiCompanyTable.companyNumber })
        .from(bhiCompanyTable)
        .where(eq(bhiCompanyTable.companyNumber, companyNumber));
      if (!company) return null;
      return exceptionRows(tx, companyNumber);
    });
    if (!result) {
      notFound(res);
      return;
    }

    const all = result.map(itemJson);
    res.json({
      companyNumber,
      openCount: all.filter((e) => e.status === "OPEN").length,
      resolvedCount: all.filter((e) => e.status === "RESOLVED").length,
      exceptions: wanted ? all.filter((e) => e.status === wanted) : all,
    });
  },
);

router.post(
  "/v1/admin/companies/:companyNumber/import-exceptions/:exceptionId/resolve",
  requireAdmin,
  requirePermission("MEMBER_IMPORT"),
  async (req: Request, res): Promise<void> => {
    const admin = req.admin!;
    if (!writable(admin, res)) return;
    const companyNumber = companyParam(req);
    const exceptionId = intParam(req, "exceptionId");
    if (!companyNumber || !inScope(admin, companyNumber) || !exceptionId) {
      notFound(res);
      return;
    }
    const parsed = ResolveImportExceptionBody.safeParse(req.body);
    if (!parsed.success || parsed.data.note.trim().length < 3) {
      res.status(400).json({ error: { code: "INVALID_INPUT", message: "Say why this record no longer needs an import (at least 3 characters)." } });
      return;
    }
    const note = parsed.data.note.trim();
    try {
      const row = await withScope(admin.scope, async (tx) => {
        await resolveManually(tx, { companyNumber, exceptionId, resolvedBy: admin.user.email, note });
        await writeAudit(
          {
            actor: admin.user.email,
            actorRole: admin.role,
            action: "IMPORT_EXCEPTION_RESOLVED",
            entityType: "IMPORT_EXCEPTION",
            entityId: String(exceptionId),
            reason: note,
            sourceIp: req.ip ?? null,
            companyCode: companyNumber,
          },
          tx,
        );
        const [one] = await exceptionRows(tx, companyNumber, eq(bhiImportExceptionTable.exceptionId, exceptionId));
        return one!;
      });
      res.json(itemJson(row));
    } catch (err) {
      if (err instanceof ExceptionNotOpenError) {
        if (err.code === "NOT_FOUND") notFound(res);
        else res.status(400).json({ error: { code: "ALREADY_RESOLVED", message: err.message } });
        return;
      }
      throw err;
    }
  },
);

/** The company's held records, newest first, with how each was resolved; `extra` narrows them. */
function exceptionRows(tx: ScopedTx, companyNumber: string, extra?: SQL) {
  return tx
    .select({
      exceptionId: bhiImportExceptionTable.exceptionId,
      entityType: bhiImportExceptionTable.entityType,
      personName: bhiImportExceptionTable.personName,
      memberIdentifier: bhiImportExceptionTable.memberIdentifier,
      reasonCodes: bhiImportExceptionTable.reasonCodes,
      reason: bhiImportExceptionTable.reason,
      requiredAction: bhiImportExceptionTable.requiredAction,
      sourceFile: bhiImportExceptionTable.sourceFile,
      sheetName: bhiImportExceptionTable.sheetName,
      excelRow: bhiImportExceptionTable.excelRow,
      createdAt: bhiImportExceptionTable.createdAt,
      source: importBatchTable.kind,
      originalFileName: importBatchTable.originalFileName,
      resolvedAt: importExceptionResolutionsTable.resolvedAt,
      resolvedBy: importExceptionResolutionsTable.resolvedBy,
      resolvedMemberId: importExceptionResolutionsTable.memberId,
      resolutionMethod: importExceptionResolutionsTable.method,
      resolutionNote: importExceptionResolutionsTable.note,
    })
    .from(bhiImportExceptionTable)
    .innerJoin(importBatchTable, eq(importBatchTable.sourceFile, bhiImportExceptionTable.sourceFile))
    .leftJoin(
      importExceptionResolutionsTable,
      eq(importExceptionResolutionsTable.exceptionId, bhiImportExceptionTable.exceptionId),
    )
    .where(and(eq(importBatchTable.companyNumber, companyNumber), extra))
    .orderBy(desc(bhiImportExceptionTable.exceptionId));
}

/** One held record as the API returns it — the snapshot itself is never sent. */
function itemJson(e: Awaited<ReturnType<typeof exceptionRows>>[number]) {
  return {
    exceptionId: e.exceptionId,
    entityType: e.entityType,
    personName: e.personName,
    memberIdentifier: e.memberIdentifier,
    reasonCodes: (e.reasonCodes ?? "").split(",").map((c) => c.trim()).filter(Boolean),
    reason: e.reason,
    requiredAction: e.requiredAction,
    source: e.source,
    sourceFile: e.sourceFile,
    originalFileName: e.originalFileName,
    sheetName: e.sheetName,
    excelRow: e.excelRow,
    createdAt: e.createdAt?.toISOString() ?? null,
    status: e.resolvedAt ? ("RESOLVED" as const) : ("OPEN" as const),
    resolvedAt: e.resolvedAt?.toISOString() ?? null,
    resolvedBy: e.resolvedBy,
    resolvedMemberId: e.resolvedMemberId,
    resolutionMethod: e.resolvedAt ? e.resolutionMethod : null,
    resolutionNote: e.resolutionNote,
  };
}

export default router;
