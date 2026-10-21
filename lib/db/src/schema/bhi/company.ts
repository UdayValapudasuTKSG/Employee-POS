// GENERATED from specs/002-per-company-schema/contracts/bhi-schema.sql — do not edit by hand.
// Table "bhi.company" of the client's BHI Enrollment Database, shared by every
// company and guarded by row-level security (deploy/db/schema.sql).
// Query it only inside withScope() (lib/db/src/scope.ts).
import { boolean, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { bhiSchema } from "./_schema";

export const bhiCompanyTable = bhiSchema.table("company", {
  companyNumber: varchar("company_number", { length: 20 }).primaryKey(),
  companyName: varchar("company_name", { length: 120 }).notNull(),
  address1: varchar("address1", { length: 120 }),
  address2: varchar("address2", { length: 120 }),
  city: varchar("city", { length: 80 }),
  contactName: varchar("contact_name", { length: 100 }),
  contactPhone: varchar("contact_phone", { length: 50 }),
  contactEmail: varchar("contact_email", { length: 100 }),
  active: boolean("active").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().$onUpdate(() => new Date()),
});

export type BhiCompany = typeof bhiCompanyTable.$inferSelect;
export type NewBhiCompany = typeof bhiCompanyTable.$inferInsert;
