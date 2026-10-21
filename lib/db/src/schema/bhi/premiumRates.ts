// GENERATED from specs/002-per-company-schema/contracts/bhi-schema.sql — do not edit by hand.
// Table "bhi.premium_rates" of the client's BHI Enrollment Database, shared by every
// company and guarded by row-level security (deploy/db/schema.sql).
// Query it only inside withScope() (lib/db/src/scope.ts).
import { boolean, date, integer, numeric, smallint, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { bhiSchema } from "./_schema";

export const bhiPremiumRatesTable = bhiSchema.table("premium_rates", {
  premiumRateId: integer("premium_rate_id").primaryKey().generatedByDefaultAsIdentity(),
  companyNumber: varchar("company_number", { length: 20 }),
  classCode: varchar("class_code", { length: 1 }).notNull(),
  coverageBand: varchar("coverage_band", { length: 20 }).notNull(),
  coverageLabel: varchar("coverage_label", { length: 80 }).notNull(),
  dependentBand: smallint("dependent_band").notNull(),
  totalPremium: numeric("total_premium", { precision: 15, scale: 2 }).notNull(),
  companyPremium: numeric("company_premium", { precision: 15, scale: 2 }).notNull(),
  employeePremium: numeric("employee_premium", { precision: 15, scale: 2 }).notNull(),
  effectiveDate: date("effective_date", { mode: "string" }).notNull(),
  active: boolean("active").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export type BhiPremiumRates = typeof bhiPremiumRatesTable.$inferSelect;
export type NewBhiPremiumRates = typeof bhiPremiumRatesTable.$inferInsert;
