// GENERATED from specs/002-per-company-schema/contracts/bhi-schema.sql — do not edit by hand.
// Table "bhi.member" of the client's BHI Enrollment Database, shared by every
// company and guarded by row-level security (deploy/db/schema.sql).
// Query it only inside withScope() (lib/db/src/scope.ts).
import { boolean, date, integer, numeric, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { bhiSchema } from "./_schema";

export const bhiMemberTable = bhiSchema.table("member", {
  memberId: integer("member_id").primaryKey().generatedByDefaultAsIdentity(),
  idType: varchar("id_type", { length: 20 }).notNull(),
  idNumber: varchar("id_number", { length: 40 }).notNull(),
  companyNumber: varchar("company_number", { length: 20 }).notNull(),
  lastName: varchar("last_name", { length: 80 }).notNull(),
  firstName: varchar("first_name", { length: 80 }).notNull(),
  middleInitials: varchar("middle_initials", { length: 20 }),
  dateOfBirth: date("date_of_birth", { mode: "string" }),
  sex: varchar("sex", { length: 10 }),
  classCode: varchar("class_code", { length: 1 }).notNull(),
  addressLine1: varchar("address_line1", { length: 150 }),
  addressLine2: varchar("address_line2", { length: 150 }),
  phone: varchar("phone", { length: 50 }),
  email: varchar("email", { length: 100 }),
  employmentDate: date("employment_date", { mode: "string" }),
  planDate: date("plan_date", { mode: "string" }),
  rateOfPay: numeric("rate_of_pay", { precision: 15, scale: 2 }),
  occupation: varchar("occupation", { length: 100 }),
  active: boolean("active").notNull(),
  inactiveDate: date("inactive_date", { mode: "string" }),
  inactiveReason: text("inactive_reason"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().$onUpdate(() => new Date()),
});

export type BhiMember = typeof bhiMemberTable.$inferSelect;
export type NewBhiMember = typeof bhiMemberTable.$inferInsert;
