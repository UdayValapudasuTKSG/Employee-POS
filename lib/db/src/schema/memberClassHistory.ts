import { bigint, integer, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { bhiSchema } from "./bhi/_schema";
import { bhiMemberTable } from "./bhi/member";
import { bhiClassTable } from "./bhi/class";
import { bhiBillingRunTable } from "./bhi/billingRun";

/**
 * Every class assignment of a member, with when it was recorded.
 *
 * bhi.member keeps only the current class, but the bill for a month uses the
 * class as it stood at 00:00 on the 1st (spec FR-029, research R11). One row is
 * written when a member is created and one on every class change.
 */
export const memberClassHistoryTable = bhiSchema.table("member_class_history", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  memberId: integer("member_id")
    .notNull()
    .references(() => bhiMemberTable.memberId),
  classCode: varchar("class_code", { length: 1 })
    .notNull()
    .references(() => bhiClassTable.classCode),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  recordedBy: text("recorded_by").notNull(),
});

/**
 * Members a billing run could not price. BillingLine requires every premium
 * column, so an unpriced member is recorded here instead, and the run cannot be
 * finalised until none remain (spec FR-034).
 */
export const billingRunIssuesTable = bhiSchema.table("billing_run_issues", {
  billingRunId: integer("billing_run_id")
    .notNull()
    .references(() => bhiBillingRunTable.billingRunId),
  memberId: integer("member_id")
    .notNull()
    .references(() => bhiMemberTable.memberId),
  reason: text("reason", { enum: ["NO_RATE", "CLASS_RETIRED_NO_RATE"] }).notNull(),
});
