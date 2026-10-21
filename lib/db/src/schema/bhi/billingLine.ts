// GENERATED from specs/002-per-company-schema/contracts/bhi-schema.sql — do not edit by hand.
// Table "bhi.billing_line" of the client's BHI Enrollment Database, shared by every
// company and guarded by row-level security (deploy/db/schema.sql).
// Query it only inside withScope() (lib/db/src/scope.ts).
import { date, integer, numeric, timestamp, varchar } from "drizzle-orm/pg-core";
import { bhiSchema } from "./_schema";

export const bhiBillingLineTable = bhiSchema.table("billing_line", {
  billingLineId: integer("billing_line_id").primaryKey().generatedByDefaultAsIdentity(),
  billingRunId: integer("billing_run_id").notNull(),
  memberId: integer("member_id").notNull(),
  idType: varchar("id_type", { length: 20 }).notNull(),
  idNumber: varchar("id_number", { length: 40 }).notNull(),
  memberName: varchar("member_name", { length: 180 }).notNull(),
  companyNumber: varchar("company_number", { length: 20 }).notNull(),
  classCode: varchar("class_code", { length: 1 }).notNull(),
  activeDependentCount: integer("active_dependent_count").notNull(),
  coverageBand: varchar("coverage_band", { length: 20 }).notNull(),
  coverageLabel: varchar("coverage_label", { length: 80 }).notNull(),
  totalPremium: numeric("total_premium", { precision: 15, scale: 2 }).notNull(),
  companyPremium: numeric("company_premium", { precision: 15, scale: 2 }).notNull(),
  employeePremium: numeric("employee_premium", { precision: 15, scale: 2 }).notNull(),
  rateEffectiveDate: date("rate_effective_date", { mode: "string" }).notNull(),
  premiumRateId: integer("premium_rate_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export type BhiBillingLine = typeof bhiBillingLineTable.$inferSelect;
export type NewBhiBillingLine = typeof bhiBillingLineTable.$inferInsert;
