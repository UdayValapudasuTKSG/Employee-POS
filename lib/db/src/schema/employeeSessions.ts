import { boolean, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { bhiSchema } from "./bhi/_schema";
import { bhiMemberTable } from "./bhi/member";

/** A BHI member a lookup matched: company plus bhi.member.member_id. */
export interface LookupMatch {
  companyNumber: string;
  memberId: number;
}

/** The same shape, as kept on a multi-company alert. */
export type MatchedMember = LookupMatch;

/**
 * One employee card lookup, from the code being sent to the card being shown.
 *
 * 1. **Verification.** `/v1/lookup` creates the row: the hashed one-time code,
 *    the masked contact, and every member the contact matched. `status` moves
 *    from PENDING to VERIFIED, EXPIRED or LOCKED.
 * 2. **Card.** A correct code (or a record chosen after it) fills the `card*`
 *    columns: the hashed card token, the member it shows, and its expiry.
 *    `cardRevoked` ends it early (logout, member deactivated).
 * 3. **Alert.** When the contact matched members in more than one company, the
 *    employee is told to contact HR and the `alert*` columns flag the session
 *    for super admins to resolve (spec FR-016). Only the masked
 *    contact is ever kept.
 */
export const employeeSessionsTable = bhiSchema.table("employee_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),

  // --- verification ---------------------------------------------------------
  lookupChannel: text("lookup_channel", { enum: ["EMAIL", "PHONE"] }).notNull(),
  maskedDestination: text("masked_destination").notNull(),
  /** Raw destination (email/phone) so a resend can deliver a new code. */
  destination: text("destination"),
  otpHash: text("otp_hash").notNull(),
  /** The company of the card the session was verified for, once one is chosen. */
  companyCode: text("company_code"),
  /** Every member the lookup matched, across all companies. Empty for a decoy. */
  matchedMembers: jsonb("matched_members").$type<LookupMatch[]>().notNull().default([]),
  /** When the one-time code stops working. */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  resendCount: integer("resend_count").notNull().default(0),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }).notNull().defaultNow(),
  status: text("status", { enum: ["PENDING", "VERIFIED", "EXPIRED", "LOCKED"] })
    .notNull()
    .default("PENDING"),

  // --- card -----------------------------------------------------------------
  cardTokenHash: text("card_token_hash").unique(),
  cardMemberId: integer("card_member_id").references(() => bhiMemberTable.memberId),
  cardIssuedAt: timestamp("card_issued_at", { withTimezone: true }),
  cardExpiresAt: timestamp("card_expires_at", { withTimezone: true }),
  cardRevoked: boolean("card_revoked").notNull().default(false),

  // --- multi-company alert --------------------------------------------------
  alertStatus: text("alert_status", { enum: ["OPEN", "RESOLVED"] }),
  alertMatches: jsonb("alert_matches").$type<MatchedMember[]>(),
  alertRaisedAt: timestamp("alert_raised_at", { withTimezone: true }),
  alertResolvedBy: text("alert_resolved_by"),
  alertResolutionNote: text("alert_resolution_note"),
  alertResolvedAt: timestamp("alert_resolved_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type EmployeeSession = typeof employeeSessionsTable.$inferSelect;
