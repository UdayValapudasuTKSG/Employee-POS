import { sql } from "drizzle-orm";
import { uuid, text, integer, timestamp, varchar } from "drizzle-orm/pg-core";
import { bhiSchema } from "./bhi/_schema";
import { bhiCompanyTable } from "./bhi/company";
import { bhiImportExceptionTable } from "./bhi/importException";
import { bhiMemberTable } from "./bhi/member";

/**
 * One bulk import, for one company (spec FR-009).
 *
 * bhi.import_exception has no company column, so an exception's `source_file`
 * is its batch's, and row-level security (deploy/db/schema.sql) traces the
 * exception to a company through this table. `sourceOrdinal` comes from a
 * sequence and numbers the system-generated `sourceFile`, so both are unique.
 */
export const importBatchTable = bhiSchema.table("import_batch", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyNumber: varchar("company_number", { length: 20 })
    .notNull()
    .references(() => bhiCompanyTable.companyNumber),
  kind: text("kind", { enum: ["BULK_IMPORT", "LEGACY_MIGRATION"] }).notNull(),
  // From the column default, nextval('import_batch_ordinal_seq'): omit on insert.
  sourceOrdinal: integer("source_ordinal")
    .notNull()
    .unique()
    .default(sql`nextval('bhi.import_batch_ordinal_seq')`),
  sourceFile: varchar("source_file", { length: 255 }).notNull().unique(),
  originalFileName: text("original_file_name"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A resolved import exception (spec FR-041). bhi.import_exception may not gain
 * a column, so the resolution lives here. `method` says how (migration 008):
 * IMPORT — a corrected row loaded; MANUAL — HR marked it resolved, with a note.
 */
export const importExceptionResolutionsTable = bhiSchema.table("import_exception_resolutions", {
  exceptionId: integer("exception_id")
    .primaryKey()
    .references(() => bhiImportExceptionTable.exceptionId),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedBy: text("resolved_by").notNull(),
  memberId: integer("member_id").references(() => bhiMemberTable.memberId),
  method: text("method", { enum: ["IMPORT", "MANUAL"] }).notNull().default("IMPORT"),
  note: text("note"),
});

export type ImportBatch = typeof importBatchTable.$inferSelect;
