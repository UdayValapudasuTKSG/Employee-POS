/**
 * Bulk import of member policies (the Policies sheet; lib/policyImport.ts).
 *
 * Super admin only, like the single-policy form: POLICY_MANAGE gates both
 * routes. Kept apart from the members import, which client admins and HR use,
 * so a policy can never ride in on a workbook its uploader may not change.
 *
 * Same shape as that import: a dry run previews every row, a member who already
 * has a policy is replaced only with confirmUpdates, error rows are skipped
 * (fixed in the sheet and uploaded again — there is no fix list for policies),
 * and the commit runs one transaction per company, so a failed write leaves
 * that company as it was. Every policy written is audited as POLICY_CREATED or
 * POLICY_UPDATED, exactly as the form audits it.
 */
import { Router, type IRouter } from "express";
import { eq, inArray, sql } from "drizzle-orm";
import {
  bhiCompanyTable,
  bhiMemberTable,
  policyMembershipsTable,
  withScope,
  type PolicyMembership,
} from "@workspace/db";
import { ImportPoliciesBody } from "@workspace/api-zod";
import { writeAudit } from "../lib/audit";
import { writable } from "../lib/adminScope";
import { classifyBhiError } from "../lib/bhiErrors";
import { parseDelimited } from "../lib/memberImport";
import {
  IMPORT_HEADERS_POLICY,
  POLICY_IMPORT_LAYOUT,
  isPolicyHeader,
  mapPolicyRow,
  missingPolicyColumns,
  type PolicyImportRecord,
} from "../lib/policyImport";
import { requireAdmin, requirePermission } from "../middlewares/adminAuth";

const router: IRouter = Router();

/** Postgres caps a statement at 65535 bind parameters; stay well clear. */
const CHUNK = 500;

/** The policy columns, keyed by the sheet column a change is reported under. */
const POLICY_FIELDS = {
  InsurerName: "insurerName",
  PlanName: "planName",
  Policyholder: "policyholder",
  PolicyNumber: "policyNumber",
  GroupNumber: "groupNumber",
  MemberNumber: "memberNumber",
  CertificateNumber: "certificateNumber",
  EffectiveDate: "effectiveDate",
  ExpiryDate: "expiryDate",
} as const;

type PolicyValues = Pick<PolicyImportRecord, (typeof POLICY_FIELDS)[keyof typeof POLICY_FIELDS]>;

const valuesOf = (r: PolicyImportRecord): PolicyValues => ({
  insurerName: r.insurerName,
  planName: r.planName,
  policyholder: r.policyholder,
  policyNumber: r.policyNumber,
  groupNumber: r.groupNumber,
  memberNumber: r.memberNumber,
  certificateNumber: r.certificateNumber,
  effectiveDate: r.effectiveDate,
  expiryDate: r.expiryDate,
});

interface PolicyRow {
  sheet: string;
  rowNumber: number;
  status: "OK" | "WARN" | "ERROR";
  message: string;
  reasonCodes: string[];
  companyNumber: string | null;
  memberIdNumber: string | null;
  memberName: string | null;
  policyNumber: string | null;
  existingRecord: boolean;
  changedFields: string[];
  record?: PolicyImportRecord;
  memberId?: number;
  existing?: PolicyMembership;
}

function fail(row: PolicyRow, message: string, codes: string[]): void {
  row.status = "ERROR";
  row.message = message;
  row.reasonCodes = codes;
}

router.get(
  "/v1/admin/import/policies/layout",
  requireAdmin,
  requirePermission("POLICY_MANAGE"),
  (_req, res): void => {
    res.json(POLICY_IMPORT_LAYOUT);
  },
);

router.post(
  "/v1/admin/import/policies",
  requireAdmin,
  requirePermission("POLICY_MANAGE"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    if (!writable(admin, res)) return;
    const parsed = ImportPoliciesBody.safeParse(req.body);
    const invalid = () =>
      res.status(400).json({ error: { code: "INVALID_INPUT", message: "Upload a file or paste CSV text to import." } });
    if (!parsed.success) {
      invalid();
      return;
    }
    const { dryRun } = parsed.data;
    const fileName = parsed.data.fileName?.trim() || null;

    // ---- Sheets --------------------------------------------------------------
    let inputSheets: { name: string; matrix: string[][] }[];
    if (parsed.data.sheets && parsed.data.sheets.length > 0) {
      inputSheets = parsed.data.sheets.map((s) => ({
        name: s.name || "Sheet",
        matrix: s.rows.map((r) => r.map((c) => (c ?? "").toString())).filter((r) => r.some((c) => c.trim() !== "")),
      }));
    } else if (parsed.data.csvText && parsed.data.csvText.trim() !== "") {
      inputSheets = [{ name: "Pasted", matrix: parseDelimited(parsed.data.csvText) }];
    } else {
      invalid();
      return;
    }
    const withData = inputSheets.filter((s) => s.matrix.length >= 2);
    if (withData.length === 0) {
      res.status(400).json({ error: { code: "EMPTY_CSV", message: "The file needs a header row and at least one data row." } });
      return;
    }
    // A workbook may also carry the members sheets; only the Policies sheets are read here.
    const policySheets = withData.filter((s) => isPolicyHeader(s.matrix[0]!));
    if (policySheets.length === 0) {
      res.status(400).json({
        error: {
          code: "BAD_HEADER",
          message: `No sheet is in the Policies layout. Expected these columns: ${IMPORT_HEADERS_POLICY.join(", ")}.`,
        },
      });
      return;
    }
    for (const sheet of policySheets) {
      const missing = missingPolicyColumns(sheet.matrix[0]!);
      if (missing.length > 0) {
        res.status(400).json({
          error: { code: "BAD_HEADER", message: `Sheet "${sheet.name}" is missing these columns: ${missing.join(", ")}.` },
        });
        return;
      }
    }

    // ---- Map rows (no database) ----------------------------------------------
    const rows: PolicyRow[] = [];
    for (const sheet of policySheets) {
      const header = sheet.matrix[0]!;
      for (let i = 1; i < sheet.matrix.length; i++) {
        const row: PolicyRow = {
          sheet: sheet.name,
          rowNumber: i + 1,
          status: "OK",
          message: "",
          reasonCodes: [],
          companyNumber: null,
          memberIdNumber: null,
          memberName: null,
          policyNumber: null,
          existingRecord: false,
          changedFields: [],
        };
        rows.push(row);
        const outcome = mapPolicyRow(header, sheet.matrix[i]!);
        if (!outcome.ok) {
          row.memberIdNumber = outcome.memberIdNumber;
          fail(row, outcome.message, outcome.reasonCodes);
          continue;
        }
        row.record = outcome.record;
        row.companyNumber = outcome.record.companyNumber;
        row.memberIdNumber = outcome.record.memberIdNumber;
        row.policyNumber = outcome.record.policyNumber;
      }
    }

    // ---- Find the members and their policies --------------------------------
    const idKey = (v: string) => v.trim().toLowerCase();
    const wanted = [...new Set(rows.filter((r) => r.record).map((r) => idKey(r.record!.memberIdNumber)))];
    const onFile = await withScope(admin.scope, async (tx) => {
      const members: {
        memberId: number;
        companyNumber: string;
        idType: string;
        idNumber: string;
        firstName: string;
        lastName: string;
        active: boolean;
        companyName: string;
        companyActive: boolean;
      }[] = [];
      for (let i = 0; i < wanted.length; i += CHUNK) {
        members.push(
          ...(await tx
            .select({
              memberId: bhiMemberTable.memberId,
              companyNumber: bhiMemberTable.companyNumber,
              idType: bhiMemberTable.idType,
              idNumber: bhiMemberTable.idNumber,
              firstName: bhiMemberTable.firstName,
              lastName: bhiMemberTable.lastName,
              active: bhiMemberTable.active,
              companyName: bhiCompanyTable.companyName,
              companyActive: bhiCompanyTable.active,
            })
            .from(bhiMemberTable)
            .innerJoin(bhiCompanyTable, eq(bhiCompanyTable.companyNumber, bhiMemberTable.companyNumber))
            .where(inArray(sql`lower(btrim(${bhiMemberTable.idNumber}))`, wanted.slice(i, i + CHUNK)))),
        );
      }
      const policies: PolicyMembership[] = [];
      const memberIds = members.map((m) => m.memberId);
      for (let i = 0; i < memberIds.length; i += CHUNK) {
        policies.push(
          ...(await tx
            .select()
            .from(policyMembershipsTable)
            .where(inArray(policyMembershipsTable.memberRef, memberIds.slice(i, i + CHUNK)))),
        );
      }
      return { members, policies };
    });
    const membersById = new Map<string, typeof onFile.members>();
    for (const m of onFile.members) {
      const list = membersById.get(idKey(m.idNumber)) ?? [];
      list.push(m);
      membersById.set(idKey(m.idNumber), list);
    }
    // The single-policy form keeps one policy per member; the same here.
    const policyOf = new Map<number, PolicyMembership>();
    for (const p of onFile.policies) if (p.memberRef != null && !policyOf.has(p.memberRef)) policyOf.set(p.memberRef, p);

    // ---- Row decisions -------------------------------------------------------
    const firstRowOfMember = new Map<number, PolicyRow>();
    for (const row of rows) {
      if (row.status === "ERROR" || !row.record) continue;
      const r = row.record;
      const candidates = (membersById.get(idKey(r.memberIdNumber)) ?? []).filter(
        (m) => (!r.companyNumber || m.companyNumber === r.companyNumber) && (!r.memberIdType || m.idType === r.memberIdType),
      );
      if (candidates.length === 0) {
        fail(
          row,
          `No member has ID number "${r.memberIdNumber}"${r.companyNumber ? ` in company ${r.companyNumber}` : ""}. ` +
            "Import the member first, then the policy.",
          ["MEMBER_NOT_FOUND"],
        );
        continue;
      }
      if (candidates.length > 1) {
        fail(
          row,
          `ID number "${r.memberIdNumber}" matches ${candidates.length} members. Fill in CompanyNumber and MemberIDType to say which one.`,
          ["AMBIGUOUS_MEMBER"],
        );
        continue;
      }
      const member = candidates[0]!;
      row.companyNumber = member.companyNumber;
      row.memberName = `${member.firstName} ${member.lastName}`;
      row.memberId = member.memberId;
      if (!member.companyActive) {
        fail(row, `${member.companyName} has been offboarded; its records can no longer be changed.`, ["COMPANY_INACTIVE"]);
        continue;
      }
      const first = firstRowOfMember.get(member.memberId);
      if (first) {
        fail(row, `Duplicate of row ${first.rowNumber} — the same member appears twice in this file.`, ["DUPLICATE_IN_FILE"]);
        continue;
      }
      firstRowOfMember.set(member.memberId, row);

      const inactiveNote = member.active ? "" : " The member is inactive, so the card stays unavailable until they are reactivated.";
      const existing = policyOf.get(member.memberId);
      if (!existing) {
        row.message = `A policy will be added.${inactiveNote}`;
        continue;
      }
      row.existing = existing;
      row.existingRecord = true;
      row.status = "WARN";
      const next = valuesOf(r);
      row.changedFields = Object.entries(POLICY_FIELDS)
        .filter(([, key]) => (existing[key] ?? null) !== (next[key] ?? null))
        .map(([column]) => column);
      row.message =
        (row.changedFields.length
          ? `Already has a policy — this row will replace it (${row.changedFields.join(", ")}).`
          : "Already has this policy; nothing would change.") + inactiveNote;
    }

    // Replacing a policy already on file needs an explicit yes, so re-uploading
    // an old file cannot quietly overwrite current cover.
    const existingRows = rows.filter((r) => r.existingRecord && r.status !== "ERROR");
    if (!dryRun && existingRows.length > 0 && parsed.data.confirmUpdates !== true) {
      res.status(409).json({
        error: {
          code: "UPDATES_NOT_CONFIRMED",
          message: `${existingRows.length} member${existingRows.length === 1 ? " already has a policy" : "s already have a policy"} that this file would replace. Preview the file, review them, and confirm the update to commit.`,
        },
        existingCount: existingRows.length,
      });
      return;
    }

    // ---- Commit, one transaction per company ---------------------------------
    const companies: { companyNumber: string; saved: boolean; created: number; updated: number; message: string | null }[] = [];
    let committedCount = 0;
    if (!dryRun) {
      const reason = `Bulk policy import${fileName ? ` (${fileName})` : ""}`;
      const writes = rows.filter((r) => r.status !== "ERROR" && r.memberId && (!r.existing || r.changedFields.length > 0));
      const companyNumbers = [...new Set(writes.map((r) => r.companyNumber!))].sort();
      for (const companyNumber of companyNumbers) {
        const inCompany = writes.filter((r) => r.companyNumber === companyNumber);
        try {
          const tally = await withScope(admin.scope, async (tx) => {
            const counts = { created: 0, updated: 0 };
            for (const row of inCompany) {
              const values = valuesOf(row.record!);
              if (row.existing) {
                await tx.update(policyMembershipsTable).set(values).where(eq(policyMembershipsTable.id, row.existing.id));
                counts.updated++;
              } else {
                await tx.insert(policyMembershipsTable).values({ memberRef: row.memberId!, ...values });
                counts.created++;
              }
              await writeAudit(
                {
                  actor: admin.user.email,
                  actorRole: admin.role,
                  action: row.existing ? "POLICY_UPDATED" : "POLICY_CREATED",
                  entityType: "POLICY",
                  entityId: String(row.memberId),
                  beforeValue: row.existing ? JSON.stringify(row.existing) : null,
                  afterValue: JSON.stringify(values),
                  reason,
                  sourceIp: req.ip ?? null,
                  companyCode: companyNumber,
                },
                tx,
              );
            }
            await writeAudit(
              {
                actor: admin.user.email,
                actorRole: admin.role,
                action: "POLICIES_IMPORTED",
                entityType: "IMPORT",
                entityId: fileName,
                afterValue: JSON.stringify({ originalFileName: fileName, ...counts }),
                sourceIp: req.ip ?? null,
                companyCode: companyNumber,
              },
              tx,
            );
            return counts;
          });
          committedCount += tally.created + tally.updated;
          companies.push({ companyNumber, saved: true, ...tally, message: null });
        } catch (err) {
          const answer = classifyBhiError(err);
          const why = answer?.message ?? "A write failed.";
          req.log?.warn({ companyNumber, code: answer?.code ?? "WRITE_FAILED" }, "policy import commit failed for company");
          companies.push({ companyNumber, saved: false, created: 0, updated: 0, message: `Nothing for ${companyNumber} was saved: ${why}` });
          for (const row of inCompany) fail(row, `Not saved — ${why}`, [answer?.code ?? "WRITE_FAILED"]);
        }
      }
    }

    // ---- Response ------------------------------------------------------------
    res.json({
      dryRun,
      totalRows: rows.length,
      okCount: rows.filter((r) => r.status === "OK").length,
      warnCount: rows.filter((r) => r.status === "WARN").length,
      errorCount: rows.filter((r) => r.status === "ERROR").length,
      existingCount: existingRows.length,
      committedCount,
      companies,
      rows: rows.map((r) => ({
        sheet: r.sheet,
        rowNumber: r.rowNumber,
        status: r.status,
        message: r.message,
        reasonCodes: r.reasonCodes,
        companyNumber: r.companyNumber,
        memberIdNumber: r.memberIdNumber,
        memberName: r.memberName,
        policyNumber: r.policyNumber,
        existingRecord: r.existingRecord,
        changedFields: r.changedFields,
      })),
    });
  },
);

export default router;
