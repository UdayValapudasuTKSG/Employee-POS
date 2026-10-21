import { uuid, text, date, timestamp, integer } from "drizzle-orm/pg-core";
import { bhiSchema, bytea } from "./bhi/_schema";
import { bhiMemberTable } from "./bhi/member";
import { bhiDependentTable } from "./bhi/dependent";

/**
 * An employee-raised Request For Modification (RFM).
 *
 * Raised from the card screen after the member has passed OTP, so the requester
 * is always the authenticated member. The subject is either the member
 * themselves or one of their own dependants.
 *
 * Current values are snapshotted at submit time for two reasons: HR sees a real
 * before/after rather than having to look it up, and approval can detect that
 * the record drifted between submission and review and refuse to apply a stale
 * change.
 *
 * Requested columns are nullable — only the fields actually being changed are
 * set. At least one must be present; that invariant lives in the zod body
 * schema and in changeRequest.ts, not in the database.
 */
export const changeRequestsTable = bhiSchema.table("change_requests", {
  id: uuid("id").primaryKey().defaultRandom(),

  /** The member who raised it (bhi.member). Always the authenticated card-session holder. */
  memberRef: integer("member_ref").references(() => bhiMemberTable.memberId),

  subjectType: text("subject_type", { enum: ["MEMBER", "DEPENDENT"] }).notNull(),
  /** Set only when subjectType is DEPENDENT. Must belong to memberRef. */
  dependentRef: integer("dependent_ref").references(() => bhiDependentTable.dependentId),

  // Snapshot of the subject at submit time. A BHI dependant has one full-name
  // field; its snapshot keeps the whole name in currentFirstName and an empty
  // currentLastName (lib/changeRequest.ts).
  currentFirstName: text("current_first_name").notNull(),
  currentLastName: text("current_last_name").notNull(),
  // Nullable: DateOfBirth is optional in the BHI model.
  currentDateOfBirth: date("current_date_of_birth", { mode: "string" }),
  /** Null for a MEMBER subject — members have no relationship. */
  currentRelationship: text("current_relationship"),

  // Only the fields being changed.
  requestedFirstName: text("requested_first_name"),
  requestedLastName: text("requested_last_name"),
  requestedDateOfBirth: date("requested_date_of_birth", { mode: "string" }),
  requestedRelationship: text("requested_relationship", {
    // The Access list; requests stored before it may hold older values.
    enum: ["SPOUSE", "SON", "DAUGHTER", "OTHER"],
  }),

  employeeNote: text("employee_note"),

  status: text("status", { enum: ["PENDING", "APPROVED", "REJECTED"] })
    .notNull()
    .default("PENDING"),

  /** Admin email, matching activity_log.actor. */
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  /** The reviewer's mandatory note; reused verbatim as the audit reason. */
  reviewNote: text("review_note"),

  // createdAt is the submission time — no separate submittedAt column.
  // --- the supporting document (at most one per request) ---------------------
  // The proof attached to the request: a driver's licence, birth certificate or
  // other Guyana-recognised document. All null when none was attached.
  /** What the employee says it is. Drives nothing; HR reads it. */
  documentType: text("document_type", {
    enum: ["NATIONAL_ID", "DRIVERS_LICENCE", "PASSPORT", "BIRTH_CERTIFICATE", "MARRIAGE_CERTIFICATE", "OTHER"],
  }),
  /** Sanitised: no path separators, no control characters. */
  documentFileName: text("document_file_name"),
  /**
   * SNIFFED from the file's magic bytes, never the type the browser declared.
   * The download's type derives from this, which is what stops a renamed .svg
   * being rendered as an image.
   */
  documentMimeType: text("document_mime_type", { enum: ["application/pdf", "image/jpeg", "image/png"] }),
  documentByteSize: integer("document_byte_size"),
  documentSha256: text("document_sha256"),
  /**
   * Nullable so a future retention job can purge the file (up to 5 MB) and keep
   * the metadata and sha256 for the compliance trail. No purge job exists yet.
   */
  documentContent: bytea("document_content"),
  documentContentPurgedAt: timestamp("document_content_purged_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ChangeRequest = typeof changeRequestsTable.$inferSelect;
