// GENERATED from specs/002-per-company-schema/contracts/bhi-schema.sql — do not edit by hand.
// Table "bhi.company_billing_rule" of the client's BHI Enrollment Database, shared by every
// company and guarded by row-level security (deploy/db/schema.sql).
// Query it only inside withScope() (lib/db/src/scope.ts).
import { boolean, date, integer, numeric, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { bhiSchema } from "./_schema";

export const bhiCompanyBillingRuleTable = bhiSchema.table("company_billing_rule", {
  companyBillingRuleId: integer("company_billing_rule_id").primaryKey().generatedByDefaultAsIdentity(),
  companyNumber: varchar("company_number", { length: 20 }).notNull(),
  companySharePercent: numeric("company_share_percent").notNull(),
  employeeSharePercent: numeric("employee_share_percent").notNull(),
  effectiveDate: date("effective_date", { mode: "string" }).notNull(),
  active: boolean("active").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export type BhiCompanyBillingRule = typeof bhiCompanyBillingRuleTable.$inferSelect;
export type NewBhiCompanyBillingRule = typeof bhiCompanyBillingRuleTable.$inferInsert;
