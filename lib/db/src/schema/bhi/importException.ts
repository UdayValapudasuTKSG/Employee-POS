// GENERATED from specs/002-per-company-schema/contracts/bhi-schema.sql — do not edit by hand.
// Table "bhi.import_exception" of the client's BHI Enrollment Database, shared by every
// company and guarded by row-level security (deploy/db/schema.sql).
// Query it only inside withScope() (lib/db/src/scope.ts).
import { integer, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { bhiSchema } from "./_schema";

export const bhiImportExceptionTable = bhiSchema.table("import_exception", {
  exceptionId: integer("exception_id").primaryKey().generatedByDefaultAsIdentity(),
  sourceAlias: varchar("source_alias", { length: 255 }),
  sourceFile: varchar("source_file", { length: 255 }),
  sourcePath: text("source_path"),
  sheetName: varchar("sheet_name", { length: 100 }),
  excelRow: integer("excel_row"),
  cellOrRange: varchar("cell_or_range", { length: 255 }),
  entityType: varchar("entity_type", { length: 30 }),
  personName: varchar("person_name", { length: 255 }),
  memberIdentifier: varchar("member_identifier", { length: 100 }),
  reasonCodes: text("reason_codes"),
  reason: text("reason"),
  requiredAction: text("required_action"),
  rawRowSummary: text("raw_row_summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export type BhiImportException = typeof bhiImportExceptionTable.$inferSelect;
export type NewBhiImportException = typeof bhiImportExceptionTable.$inferInsert;
