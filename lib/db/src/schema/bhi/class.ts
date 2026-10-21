// GENERATED from specs/002-per-company-schema/contracts/bhi-schema.sql — do not edit by hand.
// Table "bhi.class" of the client's BHI Enrollment Database, shared by every
// company and guarded by row-level security (deploy/db/schema.sql).
// Query it only inside withScope() (lib/db/src/scope.ts).
import { boolean, integer, varchar } from "drizzle-orm/pg-core";
import { bhiSchema } from "./_schema";

export const bhiClassTable = bhiSchema.table("class", {
  classCode: varchar("class_code", { length: 1 }).primaryKey(),
  className: varchar("class_name", { length: 50 }).notNull(),
  description: varchar("description", { length: 255 }),
  active: boolean("active").notNull(),
  sortOrder: integer("sort_order"),
});

export type BhiClass = typeof bhiClassTable.$inferSelect;
export type NewBhiClass = typeof bhiClassTable.$inferInsert;
