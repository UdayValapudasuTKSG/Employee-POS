/**
 * Multi-company card lookup alerts (spec FR-016).
 *
 * Raised when a verified email or phone number matches members in two or more
 * companies; the employee was told to contact HR and shown no card. Only super
 * admins see and resolve alerts, because an alert names members of more than
 * one company. Company-scoped users see only the member flag
 * (MemberDetail.sharedContactAlert).
 *
 * An alert is not a table of its own: it is the employee session that raised
 * it, flagged by its alert_* columns (schema employeeSessions.ts). Its id is
 * the session's.
 */
import { Router, type IRouter } from "express";
import { and, desc, eq, isNotNull, type SQL } from "drizzle-orm";
import {
  db,
  bhiCompanyTable,
  employeeSessionsTable,
  withScope,
  type EmployeeSession,
  type Scope,
} from "@workspace/db";
import { ResolveLookupAlertBody } from "@workspace/api-zod";
import { writeAudit } from "../lib/audit";
import { UUID_RE, paramId } from "../lib/adminScope";
import { requireAdmin } from "../middlewares/adminAuth";
import type { Request, Response, NextFunction } from "express";

const router: IRouter = Router();

/** Super admins only; everyone else gets the standard 403. */
function requireAlertViewer(req: Request, res: Response, next: NextFunction): void {
  if (req.admin?.role === "ROLE_PLATFORM_ADMIN") {
    next();
    return;
  }
  res.status(403).json({ error: { code: "FORBIDDEN", message: "You do not have permission to perform this action." } });
}

async function companyNames(scope: Scope): Promise<Map<string, string>> {
  const rows = await withScope(scope, (tx) =>
    tx.select({ n: bhiCompanyTable.companyNumber, name: bhiCompanyTable.companyName }).from(bhiCompanyTable),
  );
  return new Map(rows.map((r) => [r.n, r.name]));
}

function alertJson(a: EmployeeSession, names: Map<string, string>) {
  return {
    id: a.id,
    lookupChannel: a.lookupChannel,
    maskedContact: a.maskedDestination,
    matches: (a.alertMatches ?? []).map((m) => ({
      companyNumber: m.companyNumber,
      companyName: names.get(m.companyNumber) ?? m.companyNumber,
      memberId: m.memberId,
    })),
    status: a.alertStatus!,
    resolvedBy: a.alertResolvedBy,
    resolutionNote: a.alertResolutionNote,
    resolvedAt: a.alertResolvedAt?.toISOString() ?? null,
    createdAt: (a.alertRaisedAt ?? a.createdAt).toISOString(),
  };
}

router.get("/v1/admin/lookup-alerts", requireAdmin, requireAlertViewer, async (req, res): Promise<void> => {
  const admin = req.admin!;
  const status = typeof req.query["status"] === "string" ? req.query["status"] : "OPEN";
  const conditions: SQL[] = [isNotNull(employeeSessionsTable.alertStatus)];
  if (status === "OPEN" || status === "RESOLVED") conditions.push(eq(employeeSessionsTable.alertStatus, status));
  const rows = await db
    .select()
    .from(employeeSessionsTable)
    .where(and(...conditions))
    .orderBy(desc(employeeSessionsTable.alertRaisedAt))
    .limit(200);
  const names = await companyNames(admin.scope);
  res.json(rows.map((a) => alertJson(a, names)));
});

router.post(
  "/v1/admin/lookup-alerts/:id/resolve",
  requireAdmin,
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    if (admin.role !== "ROLE_PLATFORM_ADMIN") {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Only a super admin can resolve lookup alerts." } });
      return;
    }
    const parsed = ResolveLookupAlertBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "INVALID_INPUT", message: "A note of at least 3 characters is required." } });
      return;
    }
    const id = paramId(req, "id");
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Alert not found." } });
      return;
    }
    const [existing] = await db
      .select()
      .from(employeeSessionsTable)
      .where(and(eq(employeeSessionsTable.id, id), isNotNull(employeeSessionsTable.alertStatus)));
    if (!existing) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Alert not found." } });
      return;
    }
    if (existing.alertStatus === "RESOLVED") {
      res.status(400).json({ error: { code: "ALREADY_RESOLVED", message: "This alert has already been resolved." } });
      return;
    }
    const note = parsed.data.note.trim();
    const [updated] = await db
      .update(employeeSessionsTable)
      .set({ alertStatus: "RESOLVED", alertResolvedBy: admin.user.email, alertResolutionNote: note, alertResolvedAt: new Date() })
      .where(eq(employeeSessionsTable.id, id))
      .returning();
    await writeAudit({
      actor: admin.user.email,
      actorRole: admin.role,
      action: "LOOKUP_ALERT_RESOLVED",
      entityType: "LOOKUP_ALERT",
      entityId: id,
      reason: note,
      sourceIp: req.ip ?? null,
    });
    res.json(alertJson(updated!, await companyNames(admin.scope)));
  },
);

export default router;
