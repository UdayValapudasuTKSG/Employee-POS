import { uuid, text, date, timestamp, integer } from "drizzle-orm/pg-core";
import { bhiSchema } from "./bhi/_schema";
import { bhiMemberTable } from "./bhi/member";

/**
 * A member's policy. The BHI model has no policy table, so this stays at
 * platform level (spec FR-045) and points at bhi.member by `memberRef`.
 */
export const policyMembershipsTable = bhiSchema.table("policy_memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  memberRef: integer("member_ref").references(() => bhiMemberTable.memberId),
  policyholder: text("policyholder").notNull(),
  policyNumber: text("policy_number").notNull(),
  groupNumber: text("group_number").notNull(),
  memberNumber: text("member_number").notNull(),
  certificateNumber: text("certificate_number").notNull(),
  planName: text("plan_name").notNull(),
  effectiveDate: date("effective_date", { mode: "string" }).notNull(),
  expiryDate: date("expiry_date", { mode: "string" }),
  insurerName: text("insurer_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type PolicyMembership = typeof policyMembershipsTable.$inferSelect;
