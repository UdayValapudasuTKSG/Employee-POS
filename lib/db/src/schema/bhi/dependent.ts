// GENERATED from specs/002-per-company-schema/contracts/bhi-schema.sql — do not edit by hand.
// Table "bhi.dependent" of the client's BHI Enrollment Database, shared by every
// company and guarded by row-level security (deploy/db/schema.sql).
// Query it only inside withScope() (lib/db/src/scope.ts).
import { boolean, date, integer, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { bhiSchema } from "./_schema";

export const bhiDependentTable = bhiSchema.table("dependent", {
  dependentId: integer("dependent_id").primaryKey().generatedByDefaultAsIdentity(),
  memberId: integer("member_id").notNull(),
  idType: varchar("id_type", { length: 20 }),
  idNumber: varchar("id_number", { length: 40 }),
  dependentFullName: varchar("dependent_full_name", { length: 120 }).notNull(),
  dateOfBirth: date("date_of_birth", { mode: "string" }),
  sex: varchar("sex", { length: 10 }),
  relationship: varchar("relationship", { length: 30 }).notNull(),
  active: boolean("active").notNull(),
  inactiveDate: date("inactive_date", { mode: "string" }),
  inactiveReason: text("inactive_reason"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().$onUpdate(() => new Date()),
});

export type BhiDependent = typeof bhiDependentTable.$inferSelect;
export type NewBhiDependent = typeof bhiDependentTable.$inferInsert;
