/**
 * Classes shared by every company (spec FR-021, FR-022, FR-027;
 * contracts/admin-api.md, Classes).
 *
 * A class code is one letter or digit (BHI Class.ClassCode is Text(1)), so at
 * most 36 classes can ever exist. A class is added without a code release; it
 * becomes assignable to members only once all four of its standard tiers are
 * priced (lib/classRules.ts). Classes are retired, never deleted: members who
 * carry a retired class keep it.
 *
 * Reads run in the caller's scope; writes in SYSTEM_SCOPE, the only scope row-
 * level security lets write shared reference data.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { asc, count, eq } from "drizzle-orm";
import { SYSTEM_SCOPE, bhiClassTable, bhiMemberTable, withScope, type BhiClass, type ScopedTx } from "@workspace/db";
import { CreateClassBody, UpdateClassBody } from "@workspace/api-zod";
import { writeAudit } from "../lib/audit";
import { rateCompleteClassCodes } from "../lib/classRules";
import { recalcDraftBills } from "../lib/billing/recalc";
import { paramId } from "../lib/adminScope";
import { requireAdmin, requirePermission, type AdminContext } from "../middlewares/adminAuth";

const router: IRouter = Router();

/** Every code BHI's Text(1) ClassCode can hold. */
export const MAX_CLASS_CODES = 36;
const CLASS_CODE_RE = /^[A-Z0-9]$/;

const error = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } });

function item(c: BhiClass, rateComplete: Set<string>, members: Map<string, number>) {
  return {
    classCode: c.classCode,
    className: c.className,
    description: c.description,
    active: c.active,
    sortOrder: c.sortOrder,
    rateComplete: rateComplete.has(c.classCode),
    memberCount: members.get(c.classCode) ?? 0,
  };
}

async function loadItems(tx: ScopedTx) {
  const classes = await tx.select().from(bhiClassTable).orderBy(asc(bhiClassTable.sortOrder), asc(bhiClassTable.classCode));
  const rateComplete = await rateCompleteClassCodes(tx);
  const counts = await tx
    .select({ classCode: bhiMemberTable.classCode, n: count() })
    .from(bhiMemberTable)
    .groupBy(bhiMemberTable.classCode);
  const members = new Map(counts.map((r) => [r.classCode, r.n]));
  return { classes, rateComplete, members };
}

function audit(req: Request, admin: AdminContext, tx: ScopedTx, action: string, classCode: string, before: unknown, after: unknown, reason: string) {
  return writeAudit(
    {
      actor: admin.user.email,
      actorRole: admin.role,
      action,
      entityType: "CLASS",
      entityId: classCode,
      beforeValue: before === null ? null : JSON.stringify(before),
      afterValue: JSON.stringify(after),
      reason,
      sourceIp: req.ip ?? null,
      companyCode: null,
    },
    tx,
  );
}

router.get("/v1/admin/classes", requireAdmin, async (req, res): Promise<void> => {
  const admin = req.admin!;
  const includeRetired = req.query["includeRetired"] === "true";
  const { classes, rateComplete, members } = await withScope(admin.scope, loadItems);
  res.json({
    classes: classes.filter((c) => includeRetired || c.active).map((c) => item(c, rateComplete, members)),
  });
});

router.post(
  "/v1/admin/classes",
  requireAdmin,
  requirePermission("CLASS_MANAGE"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const parsed = CreateClassBody.safeParse(req.body);
    if (!parsed.success) {
      error(res, 400, "INVALID_INPUT", "A one-character class code, a name of up to 50 characters and a reason of at least 3 characters are required.");
      return;
    }
    const classCode = parsed.data.classCode.trim().toUpperCase();
    if (!CLASS_CODE_RE.test(classCode)) {
      error(res, 400, "INVALID_INPUT", "A class code is one letter or digit (A–Z, 0–9).");
      return;
    }
    const className = parsed.data.className.trim();
    const outcome = await withScope(SYSTEM_SCOPE, async (tx) => {
      const all = await tx.select().from(bhiClassTable);
      // Full first: with every code taken, "that code exists" is true but unhelpful.
      if (all.length >= MAX_CLASS_CODES) return { status: "EXHAUSTED" as const };
      const existing = all.find((c) => c.classCode === classCode);
      if (existing) return { status: "EXISTS" as const, existing };
      const sortOrder = parsed.data.sortOrder ?? Math.max(0, ...all.map((c) => c.sortOrder ?? 0)) + 1;
      const [created] = await tx
        .insert(bhiClassTable)
        .values({ classCode, className, description: parsed.data.description?.trim() || null, active: true, sortOrder })
        .returning();
      await audit(req, admin, tx, "CLASS_CREATED", classCode, null, created, parsed.data.reason);
      const { rateComplete, members } = await loadItems(tx);
      return { status: "OK" as const, body: item(created!, rateComplete, members) };
    });
    if (outcome.status === "EXISTS") {
      const c = outcome.existing;
      error(res, 409, "CLASS_EXISTS", `Class ${c.classCode} already exists: "${c.className}"${c.active ? "" : " (retired — reactivate it instead)"}.`);
      return;
    }
    if (outcome.status === "EXHAUSTED") {
      error(res, 409, "CLASS_CODES_EXHAUSTED", `All ${MAX_CLASS_CODES} class codes (A–Z, 0–9) are in use. Reactivate or rename an existing class.`);
      return;
    }
    res.status(201).json(outcome.body);
  },
);

router.patch(
  "/v1/admin/classes/:classCode",
  requireAdmin,
  requirePermission("CLASS_MANAGE"),
  async (req, res): Promise<void> => {
    const admin = req.admin!;
    const classCode = paramId(req, "classCode").toUpperCase();
    const parsed = UpdateClassBody.safeParse(req.body);
    if (!parsed.success) {
      error(res, 400, "INVALID_INPUT", "Check the fields. A reason of at least 3 characters is required.");
      return;
    }
    const { reason, ...fields } = parsed.data;
    const outcome = await withScope(SYSTEM_SCOPE, async (tx) => {
      const [current] = await tx.select().from(bhiClassTable).where(eq(bhiClassTable.classCode, classCode));
      if (!current) return null;
      const changes: Partial<BhiClass> = {};
      if (fields.className !== undefined && fields.className.trim() !== current.className) changes.className = fields.className.trim();
      if (fields.description !== undefined && (fields.description?.trim() || null) !== current.description) {
        changes.description = fields.description?.trim() || null;
      }
      if (fields.sortOrder !== undefined && fields.sortOrder !== current.sortOrder) changes.sortOrder = fields.sortOrder;
      if (fields.active !== undefined && fields.active !== current.active) changes.active = fields.active;
      let updated = current;
      if (Object.keys(changes).length > 0) {
        [updated] = await tx.update(bhiClassTable).set(changes).where(eq(bhiClassTable.classCode, classCode)).returning();
        const before = Object.fromEntries(Object.keys(changes).map((k) => [k, current[k as keyof BhiClass]]));
        const action = changes.active === false ? "CLASS_RETIRED" : changes.active === true ? "CLASS_REACTIVATED" : "CLASS_UPDATED";
        await audit(req, admin, tx, action, classCode, before, changes, reason);
      }
      const { rateComplete, members } = await loadItems(tx);
      return item(updated!, rateComplete, members);
    });
    if (!outcome) {
      error(res, 404, "NOT_FOUND", `There is no class "${classCode}".`);
      return;
    }
    // Retiring a class changes how its unpriced members are reported.
    await recalcDraftBills(req, admin, "ALL", `Class ${classCode} changed`);
    res.json(outcome);
  },
);

export default router;
