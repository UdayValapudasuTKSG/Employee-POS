// GENERATED from specs/002-per-company-schema/contracts/bhi-schema.sql — do not edit by hand.
// Table "bhi.enrollment_status_history" of the client's BHI Enrollment Database, shared by every
// company and guarded by row-level security (deploy/db/schema.sql).
// Query it only inside withScope() (lib/db/src/scope.ts).
import { boolean, date, integer, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { bhiSchema } from "./_schema";

export const bhiEnrollmentStatusHistoryTable = bhiSchema.table("enrollment_status_history", {
  statusHistoryId: integer("status_history_id").primaryKey().generatedByDefaultAsIdentity(),
  entityType: varchar("entity_type", { length: 20 }).notNull(),
  entityId: integer("entity_id").notNull(),
  memberId: integer("member_id"),
  companyNumber: varchar("company_number", { length: 20 }),
  personIdentifier: varchar("person_identifier", { length: 100 }),
  personName: varchar("person_name", { length: 180 }).notNull(),
  oldActive: boolean("old_active").notNull(),
  newActive: boolean("new_active").notNull(),
  effectiveDate: date("effective_date", { mode: "string" }).notNull(),
  reason: text("reason").notNull(),
  cascadeApplied: boolean("cascade_applied").notNull(),
  relatedRecordsChanged: integer("related_records_changed"),
  changedAt: timestamp("changed_at", { withTimezone: true }),
  changedBy: varchar("changed_by", { length: 100 }),
  notes: text("notes"),
});

export type BhiEnrollmentStatusHistory = typeof bhiEnrollmentStatusHistoryTable.$inferSelect;
export type NewBhiEnrollmentStatusHistory = typeof bhiEnrollmentStatusHistoryTable.$inferInsert;
