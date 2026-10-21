// GENERATED from specs/002-per-company-schema/contracts/bhi-schema.sql — do not edit by hand.
// Table "bhi.billing_run" of the client's BHI Enrollment Database, shared by every
// company and guarded by row-level security (deploy/db/schema.sql).
// Query it only inside withScope() (lib/db/src/scope.ts).
import { date, integer, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { bhiSchema } from "./_schema";

export const bhiBillingRunTable = bhiSchema.table("billing_run", {
  billingRunId: integer("billing_run_id").primaryKey().generatedByDefaultAsIdentity(),
  companyNumber: varchar("company_number", { length: 20 }).notNull(),
  billingMonth: date("billing_month", { mode: "string" }).notNull(),
  billingDate: date("billing_date", { mode: "string" }).notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }),
  generatedBy: varchar("generated_by", { length: 80 }),
  status: varchar("status", { length: 20 }),
  notes: text("notes"),
});

export type BhiBillingRun = typeof bhiBillingRunTable.$inferSelect;
export type NewBhiBillingRun = typeof bhiBillingRunTable.$inferInsert;
