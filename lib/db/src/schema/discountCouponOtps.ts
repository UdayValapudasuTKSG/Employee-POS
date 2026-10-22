import { uuid, text, timestamp, integer } from "drizzle-orm/pg-core";
import { bhiSchema } from "./bhi/_schema";
import { bhiMemberTable } from "./bhi/member";
import { discountCouponsTable } from "./discountCoupons";

/**
 * A one-time code the member must enter before a coupon is generated.
 *
 * Generating a coupon is a step up from viewing the card: it creates something
 * worth money at a till, so it asks again for proof that the person holding
 * the session controls the member's email or phone. One row per code sent.
 * PENDING until it is used (USED, with the coupon it produced), replaced by a
 * newer request (SUPERSEDED), or entered wrongly too often (LOCKED). Past
 * expires_at a PENDING row is simply expired.
 *
 * As with sign-in codes, only the sha256 of the code is stored.
 */
export const discountCouponOtpsTable = bhiSchema.table("discount_coupon_otps", {
  id: uuid("id").primaryKey().defaultRandom(),
  memberRef: integer("member_ref")
    .notNull()
    .references(() => bhiMemberTable.memberId),
  /** The coupon this code is for: a code for KFC cannot produce a Pizza Hut coupon. */
  brand: text("brand", { enum: ["KFC", "PIZZA_HUT"] }).notNull(),
  otpHash: text("otp_hash").notNull(),
  channel: text("channel", { enum: ["EMAIL", "PHONE"] }).notNull(),
  maskedDestination: text("masked_destination").notNull(),
  attempts: integer("attempts").notNull().default(0),
  status: text("status", { enum: ["PENDING", "USED", "SUPERSEDED", "LOCKED"] })
    .notNull()
    .default("PENDING"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  couponId: uuid("coupon_id").references(() => discountCouponsTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type DiscountCouponOtp = typeof discountCouponOtpsTable.$inferSelect;
