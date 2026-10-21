import { integer, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { bhiSchema } from "./bhi/_schema";

/**
 * Everything that happened, in one append-only table.
 *
 * `kind` separates the two sorts of entry:
 *   - AUDIT: an administrator or a system job changed something, or was
 *     refused. Who, what, before and after, and why. This is the compliance
 *     trail the admin Audit screen shows.
 *   - EVENT: an employee-side step — a lookup, a code sent or verified, a card
 *     emailed. `actor` is an anonymised key, never the email or phone, and
 *     `result`, `errorCode` and `latencyMs` describe the outcome.
 *
 * The API may only insert and read it (deploy/db/migrations/002_roles_grants.sql):
 * nothing rewrites or deletes history.
 */
export const activityLogTable = bhiSchema.table("activity_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind", { enum: ["AUDIT", "EVENT"] }).notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  /** AUDIT: admin email or SYSTEM. EVENT: an anonymised key. */
  actor: text("actor").notNull(),
  /** AUDIT only. */
  actorRole: text("actor_role"),
  /** AUDIT: e.g. MEMBER_UPDATED. EVENT: e.g. LOOKUP, OTP_VERIFY, OTP_DELIVERY. */
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  beforeValue: text("before_value"),
  afterValue: text("after_value"),
  reason: text("reason"),
  sourceIp: text("source_ip"),
  companyCode: text("company_code"),
  /** EVENT only: e.g. CODE_SENT, VERIFIED, FAILED. */
  result: text("result"),
  errorCode: text("error_code"),
  latencyMs: integer("latency_ms"),
});

export type ActivityLogEntry = typeof activityLogTable.$inferSelect;
