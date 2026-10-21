/**
 * HR review of employee Requests For Modification.
 *
 * Requests point at a BHI member by `member_ref` (and a dependant by
 * `dependent_ref`). Every read joins through bhi.member inside the reviewer's
 * scope, so row-level security hides another company's requests: a
 * company-scoped HR admin reading one gets the same 404 as a request that does
 * not exist, rather than a 403 that would confirm the id exists.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { and, count, desc, eq, inArray, sql, isNotNull } from "drizzle-orm";
import {
  db,
  adminUsersTable,
  bhiCompanyTable,
  bhiDependentTable,
  bhiMemberTable,
  changeRequestsTable,
  withScope,
  type BhiCompany,
  type BhiMember,
} from "@workspace/db";
import { ApproveChangeRequestBody, RejectChangeRequestBody } from "@workspace/api-zod";
import { writeAudit } from "../lib/audit";
import { notFound, pageParams, paramId, scopedBhiMemberById, UUID_RE, writable } from "../lib/adminScope";
import {
  decideApproval,
  formatRelationship,
  reviewerFor,
  subjectName,
  type ReviewerAccount,
  type SubjectSnapshot,
} from "../lib/changeRequest";
import { requireAdmin, requirePermission, type AdminContext } from "../middlewares/adminAuth";

const router: IRouter = Router();

type ChangeRequestRow = typeof changeRequestsTable.$inferSelect;

/** The before/after pairs, for display. Mirrors changeRequest.effectiveChanges. */
function changeList(r: ChangeRequestRow) {
  const out: { field: string; current: string | null; requested: string }[] = [];
  if (r.subjectType === "DEPENDENT") {
    // A dependant has one full-name field; the request stores it in requestedFirstName.
    const requested = [r.requestedFirstName, r.requestedLastName].filter(Boolean).join(" ");
    if (requested) out.push({ field: "fullName", current: r.currentFirstName, requested });
  } else {
    if (r.requestedFirstName) {
      out.push({ field: "firstName", current: r.currentFirstName, requested: r.requestedFirstName });
    }
    if (r.requestedLastName) {
      out.push({ field: "lastName", current: r.currentLastName, requested: r.requestedLastName });
    }
  }
  if (r.requestedDateOfBirth) {
    out.push({ field: "dateOfBirth", current: r.currentDateOfBirth, requested: r.requestedDateOfBirth });
  }
  if (r.requestedRelationship) {
    out.push({
      field: "relationship",
      current: formatRelationship(r.currentRelationship),
      requested: formatRelationship(r.requestedRelationship)!,
    });
  }
  return out;
}

/**
 * Loads a request and enforces scope through the owning member.
 * `null` means "respond 404" — unknown id, malformed id, or out of scope.
 */
async function scopedRequest(admin: AdminContext, id: string) {
  if (!UUID_RE.test(id)) return null;
  const [request] = await db.select().from(changeRequestsTable).where(eq(changeRequestsTable.id, id));
  if (!request) return null;
  const found = await scopedBhiMemberById(admin, request.memberRef);
  if (!found) return null;
  return { request, member: found.member, company: found.company };
}

function detailJson(
  request: ChangeRequestRow,
  member: BhiMember,
  company: BhiCompany,
  document: DocumentMeta | undefined,
) {
  return {
    id: request.id,
    memberId: member.memberId,
    memberName: subjectName(member.firstName, member.lastName),
    companyNumber: company.companyNumber,
    companyName: company.companyName,
    subjectType: request.subjectType,
    subjectName: subjectName(request.currentFirstName, request.currentLastName),
    dependentId: request.dependentRef,
    changes: changeList(request),
    employeeNote: request.employeeNote,
    status: request.status,
    reviewedBy: request.reviewedBy,
    reviewedAt: request.reviewedAt?.toISOString() ?? null,
    reviewNote: request.reviewNote,
    document: document
      ? {
          id: document.id,
          documentType: document.documentType,
          fileName: document.fileName,
          mimeType: document.mimeType,
          byteSize: document.byteSize,
          sha256: document.sha256,
          purged: document.contentPurgedAt != null || !document.hasContent,
        }
      : null,
    createdAt: request.createdAt.toISOString(),
  };
}

/**
 * Document metadata only — never selects `content`, which is up to 5 MB.
 *
 * `hasContent` is computed in the database rather than derived from the absent
 * column: the column is not selected, so testing `document.content == null` on
 * this projection would report every document as gone. `IS NOT NULL` answers
 * the same question server-side and still sends no bytes over the wire.
 */
async function documentMetaFor(requestIds: string[]) {
  if (requestIds.length === 0) return [];
  // The document is part of the request row; its id is the request's.
  const rows = await db
    .select({
      id: changeRequestsTable.id,
      changeRequestId: changeRequestsTable.id,
      documentType: changeRequestsTable.documentType,
      fileName: changeRequestsTable.documentFileName,
      mimeType: changeRequestsTable.documentMimeType,
      byteSize: changeRequestsTable.documentByteSize,
      sha256: changeRequestsTable.documentSha256,
      contentPurgedAt: changeRequestsTable.documentContentPurgedAt,
      hasContent: sql<boolean>`(${changeRequestsTable.documentContent} IS NOT NULL)`,
    })
    .from(changeRequestsTable)
    .where(and(inArray(changeRequestsTable.id, requestIds), isNotNull(changeRequestsTable.documentFileName)));
  // Every request is created with its document, so these are all set.
  return rows.map((r) => ({
    ...r,
    documentType: r.documentType!,
    fileName: r.fileName!,
    mimeType: r.mimeType!,
    byteSize: r.byteSize!,
    sha256: r.sha256!,
  }));
}

/**
 * What detailJson is actually given. Derived from the query rather than from
 * the table, so a column dropped from the projection becomes a type error here
 * instead of a silent `undefined` at runtime.
 */
type DocumentMeta = Awaited<ReturnType<typeof documentMetaFor>>[number];

router.get(
  "/v1/admin/change-requests",
  requireAdmin,
  requirePermission("CHANGE_REQUEST_REVIEW"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const { page, pageSize } = pageParams(req);
    const statusParam = typeof req.query["status"] === "string" ? req.query["status"] : "PENDING";

    const where =
      statusParam !== "ALL"
        ? eq(changeRequestsTable.status, statusParam as "PENDING" | "APPROVED" | "REJECTED")
        : undefined;

    // Joined through bhi.member inside the reviewer's scope: row-level security
    // drops requests of members the reviewer cannot see.
    const { totalItems, rows } = await withScope(admin.scope, async (tx) => {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(changeRequestsTable)
        .innerJoin(bhiMemberTable, eq(bhiMemberTable.memberId, changeRequestsTable.memberRef))
        .where(where);
      const page_ = await tx
        .select({ request: changeRequestsTable, member: bhiMemberTable, company: bhiCompanyTable })
        .from(changeRequestsTable)
        .innerJoin(bhiMemberTable, eq(bhiMemberTable.memberId, changeRequestsTable.memberRef))
        .innerJoin(bhiCompanyTable, eq(bhiCompanyTable.companyNumber, bhiMemberTable.companyNumber))
        .where(where)
        .orderBy(desc(changeRequestsTable.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      return { totalItems: n, rows: page_ };
    });

    const docs = await documentMetaFor(rows.map((r) => r.request.id));
    const hasDoc = new Set(docs.map((d) => d.changeRequestId));

    // Reviewer names for super admins only (see reviewerFor). One query
    // for the reviewers on this page, not one per row.
    const superAdmin = admin.role === "ROLE_PLATFORM_ADMIN";
    const reviewerEmails = superAdmin
      ? [...new Set(rows.map((r) => r.request.reviewedBy).filter((e): e is string => !!e))]
      : [];
    const reviewerAccounts = new Map<string, ReviewerAccount>();
    if (reviewerEmails.length > 0) {
      const accounts = await db
        .select({ email: adminUsersTable.email, displayName: adminUsersTable.displayName, role: adminUsersTable.role })
        .from(adminUsersTable)
        .where(inArray(sql`lower(${adminUsersTable.email})`, reviewerEmails.map((e) => e.toLowerCase())));
      for (const a of accounts) reviewerAccounts.set(a.email.toLowerCase(), a);
    }

    res.json({
      items: rows.map(({ request, member, company }) => ({
        id: request.id,
        memberId: member.memberId,
        memberName: subjectName(member.firstName, member.lastName),
        companyNumber: company.companyNumber,
        companyName: company.companyName,
        subjectType: request.subjectType,
        subjectName: subjectName(request.currentFirstName, request.currentLastName),
        changes: changeList(request),
        status: request.status,
        hasDocument: hasDoc.has(request.id),
        createdAt: request.createdAt.toISOString(),
        reviewedAt: request.reviewedAt?.toISOString() ?? null,
        reviewer: reviewerFor(superAdmin, request.reviewedBy, reviewerAccounts),
      })),
      page,
      pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / pageSize),
    });
  },
);

router.get(
  "/v1/admin/change-requests/:id",
  requireAdmin,
  requirePermission("CHANGE_REQUEST_REVIEW"),
  async (req, res): Promise<void> => {
    const found = await scopedRequest(req.admin!, paramId(req, "id"));
    if (!found) {
      notFound(res);
      return;
    }
    const [document] = await documentMetaFor([found.request.id]);
    res.json(detailJson(found.request, found.member, found.company, document));
  },
);

router.get(
  "/v1/admin/change-requests/:id/document",
  requireAdmin,
  requirePermission("CHANGE_REQUEST_REVIEW"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const found = await scopedRequest(admin, paramId(req, "id"));
    if (!found) {
      notFound(res);
      return;
    }
    const [document] = await db
      .select({
        fileName: changeRequestsTable.documentFileName,
        mimeType: changeRequestsTable.documentMimeType,
        byteSize: changeRequestsTable.documentByteSize,
        sha256: changeRequestsTable.documentSha256,
        content: changeRequestsTable.documentContent,
      })
      .from(changeRequestsTable)
      .where(eq(changeRequestsTable.id, found.request.id));
    if (!document || !document.content) {
      res.status(404).json({
        error: { code: "DOCUMENT_UNAVAILABLE", message: "The supporting document is no longer stored." },
      });
      return;
    }

    // Viewing someone's passport or birth certificate is itself an event worth
    // recording — the whole point of holding it is that it is sensitive.
    await writeAudit({
      actor: admin.user.email,
      actorRole: admin.role,
      action: "CHANGE_REQUEST_DOCUMENT_VIEWED",
      entityType: "CHANGE_REQUEST",
      entityId: found.request.id,
      afterValue: JSON.stringify({ sha256: document.sha256, fileName: document.fileName }),
      sourceIp: req.ip ?? null,
      companyCode: found.company.companyNumber,
    });

    // Defence in depth for a response the browser turns into a Blob.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.json({
      fileName: document.fileName,
      // The type sniffed at upload, never what the uploader claimed.
      mimeType: document.mimeType,
      byteSize: document.byteSize,
      contentBase64: document.content.toString("base64"),
    });
  },
);

/** Shared by approve and reject: both need the same lookups and note handling. */
async function decide(req: Request, res: Response, action: "APPROVE" | "REJECT"): Promise<void> {
  const admin = req.admin!;
  if (!writable(admin, res)) return;
  const schema = action === "APPROVE" ? ApproveChangeRequestBody : RejectChangeRequestBody;
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "INVALID_INPUT", message: "A note of at least 3 characters is required." } });
    return;
  }
  const note = parsed.data.note.trim();

  const found = await scopedRequest(admin, paramId(req, "id"));
  if (!found) {
    notFound(res);
    return;
  }
  const companyNumber = found.company.companyNumber;

  if (action === "REJECT") {
    if (found.request.status !== "PENDING") {
      res.status(400).json({ error: { code: "NOT_PENDING", message: "This request has already been decided." } });
      return;
    }
    const [updated] = await db
      .update(changeRequestsTable)
      .set({ status: "REJECTED", reviewedBy: admin.user.email, reviewedAt: new Date(), reviewNote: note })
      .where(eq(changeRequestsTable.id, found.request.id))
      .returning();
    await writeAudit({
      actor: admin.user.email,
      actorRole: admin.role,
      action: "CHANGE_REQUEST_REJECTED",
      entityType: "CHANGE_REQUEST",
      entityId: found.request.id,
      reason: note,
      sourceIp: req.ip ?? null,
      companyCode: companyNumber,
    });
    const [document] = await documentMetaFor([found.request.id]);
    res.json(detailJson(updated!, found.member, found.company, document));
    return;
  }

  // Approve: apply the change and record it, in one transaction, inside the
  // reviewer's scope so row-level security also guards the write.
  try {
    const { updated, member } = await withScope(admin.scope, async (tx) => {
      // Lock the request first so two admins clicking Approve cannot both
      // apply it — the second re-reads status APPROVED and is rejected.
      const [request] = await tx
        .select()
        .from(changeRequestsTable)
        .where(eq(changeRequestsTable.id, found.request.id))
        .for("update");
      if (!request) throw new DecisionError("NOT_FOUND", "Request not found.");

      let live: SubjectSnapshot;
      if (request.subjectType === "DEPENDENT") {
        const [dependent] = await tx
          .select()
          .from(bhiDependentTable)
          .where(
            and(
              eq(bhiDependentTable.dependentId, request.dependentRef ?? -1),
              eq(bhiDependentTable.memberId, found.member.memberId),
            ),
          )
          .for("update");
        if (!dependent) throw new DecisionError("SUBJECT_GONE", "That dependant no longer exists.");
        live = {
          firstName: dependent.dependentFullName,
          lastName: "",
          dateOfBirth: dependent.dateOfBirth,
          relationship: dependent.relationship,
        };
        const outcome = decideApproval(request, live);
        if (!outcome.ok) throw new DecisionError(outcome.code, outcome.message);
        const changes: Record<string, unknown> = {};
        if (outcome.changes.fullName) changes["dependentFullName"] = outcome.changes.fullName;
        if (outcome.changes.dateOfBirth) changes["dateOfBirth"] = outcome.changes.dateOfBirth;
        if (outcome.changes.relationship) changes["relationship"] = outcome.changes.relationship;
        await tx.update(bhiDependentTable).set(changes).where(eq(bhiDependentTable.dependentId, dependent.dependentId));
        await writeAudit(
          {
            actor: admin.user.email,
            actorRole: admin.role,
            action: "DEPENDENT_UPDATED",
            entityType: "DEPENDENT",
            entityId: String(dependent.dependentId),
            beforeValue: JSON.stringify(live),
            afterValue: JSON.stringify(changes),
            reason: note,
            sourceIp: req.ip ?? null,
            companyCode: companyNumber,
          },
          tx,
        );
      } else {
        const [memberRow] = await tx
          .select()
          .from(bhiMemberTable)
          .where(eq(bhiMemberTable.memberId, found.member.memberId))
          .for("update");
        if (!memberRow) throw new DecisionError("SUBJECT_GONE", "That member no longer exists.");
        live = {
          firstName: memberRow.firstName,
          lastName: memberRow.lastName,
          dateOfBirth: memberRow.dateOfBirth,
          relationship: null,
        };
        const outcome = decideApproval(request, live);
        if (!outcome.ok) throw new DecisionError(outcome.code, outcome.message);
        const { relationship: _ignored, fullName: _alsoIgnored, ...memberChanges } = outcome.changes;
        await tx.update(bhiMemberTable).set(memberChanges).where(eq(bhiMemberTable.memberId, memberRow.memberId));
        await writeAudit(
          {
            actor: admin.user.email,
            actorRole: admin.role,
            action: "MEMBER_UPDATED",
            entityType: "MEMBER",
            entityId: String(memberRow.memberId),
            beforeValue: JSON.stringify(live),
            afterValue: JSON.stringify(memberChanges),
            reason: note,
            sourceIp: req.ip ?? null,
            companyCode: companyNumber,
          },
          tx,
        );
      }

      const [row] = await tx
        .update(changeRequestsTable)
        .set({ status: "APPROVED", reviewedBy: admin.user.email, reviewedAt: new Date(), reviewNote: note })
        .where(eq(changeRequestsTable.id, request.id))
        .returning();

      // Second audit row so the request's own lifecycle is traceable, not just
      // the change it caused.
      await writeAudit(
        {
          actor: admin.user.email,
          actorRole: admin.role,
          action: "CHANGE_REQUEST_APPROVED",
          entityType: "CHANGE_REQUEST",
          entityId: request.id,
          afterValue: JSON.stringify(changeList(request)),
          reason: note,
          sourceIp: req.ip ?? null,
          companyCode: companyNumber,
        },
        tx,
      );

      const [refreshed] = await tx.select().from(bhiMemberTable).where(eq(bhiMemberTable.memberId, found.member.memberId));
      return { updated: row!, member: refreshed ?? found.member };
    });

    const [document] = await documentMetaFor([found.request.id]);
    res.json(detailJson(updated, member, found.company, document));
  } catch (err) {
    if (err instanceof DecisionError) {
      const status = err.code === "NOT_FOUND" ? 404 : 400;
      res.status(status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    throw err;
  }
}

class DecisionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DecisionError";
  }
}

router.post(
  "/v1/admin/change-requests/:id/approve",
  requireAdmin,
  requirePermission("CHANGE_REQUEST_REVIEW"),
  async (req, res): Promise<void> => decide(req, res, "APPROVE"),
);

router.post(
  "/v1/admin/change-requests/:id/reject",
  requireAdmin,
  requirePermission("CHANGE_REQUEST_REVIEW"),
  async (req, res): Promise<void> => decide(req, res, "REJECT"),
);

export default router;
