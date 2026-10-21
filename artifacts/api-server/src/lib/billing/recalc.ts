/**
 * Keeps DRAFT bills in step with the data (spec FR-033): called after a write
 * that can move a bill, it recalculates the affected companies' drafts
 * (runs.ts recalculateDrafts — a draft is replaced only when it would change).
 *
 * It runs after the write has committed and never fails the request: the
 * change stands, and a recalculation that fails is logged, leaving the draft
 * for a super admin to regenerate from Billing.
 */
import type { Request } from "express";
import type { AdminContext } from "../../middlewares/adminAuth";
import { recalculateDrafts } from "./runs";

export async function recalcDraftBills(
  req: Request,
  admin: AdminContext | { user: { email: string }; role: string },
  companies: "ALL" | string[],
  cause: string,
): Promise<void> {
  const results = await recalculateDrafts(companies, {
    email: admin.user.email,
    role: admin.role,
    sourceIp: req.ip ?? null,
    cause,
  });
  for (const r of results) {
    if (r.status === "FAILED") req.log?.warn({ companyNumber: r.companyNumber, message: r.message }, "draft bill recalculation failed");
  }
}
