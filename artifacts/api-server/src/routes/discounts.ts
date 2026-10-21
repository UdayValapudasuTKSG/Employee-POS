/**
 * Employee discounts: the member's side (generate a coupon, see the allowance)
 * and the partner POS side (check, redeem, void). The rules themselves are in
 * lib/discounts.ts.
 *
 * The member is authenticated by the card session, exactly as for the card and
 * RFMs, but needs no policy on file: the discount is for every eligible
 * employee. A POS is authenticated by its brand's key and only ever sees that
 * brand's coupons.
 *
 * The monthly allowance is enforced at redemption, not at generation: a coupon
 * carries no amount, and the bill is only known at the till. Redemptions for
 * one member are serialised by an advisory lock, so two tills redeeming at the
 * same moment cannot both spend the last of the allowance.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, count, desc, eq, gt, gte, lt, lte, sql, type SQL } from "drizzle-orm";
import { db, discountCouponsTable, type DiscountCoupon } from "@workspace/db";
import {
  GenerateDiscountCouponBody,
  ListDiscountCouponsQueryParams,
  PosCheckCouponBody,
  PosRedeemCouponBody,
  PosVoidCouponBody,
} from "@workspace/api-zod";
import { writeAudit } from "../lib/audit";
import {
  BRAND_NAMES,
  DISCOUNT_BRANDS,
  allowanceMonth,
  brandForPosKey,
  centsFromNumeric,
  couponCodeHash,
  discountConfig,
  fromCents,
  generateCouponCode,
  monthWindow,
  normalizeCouponCode,
  quoteDiscount,
  quoteMessage,
  toCents,
  type AllowanceMonth,
  type DiscountBrand,
  type Quote,
} from "../lib/discounts";
import { memberForSession, memberKey, respondCardUnavailable, sessionMember } from "./employee";

const router: IRouter = Router();

/** How many of a member's coupons the discounts page lists. */
const RECENT_COUPONS = 20;

/** First key of the two-key advisory lock that serialises one member's redemptions. */
const REDEEM_LOCK_NAMESPACE = 7_031;

type Executor = Pick<typeof db, "select">;

/** Discount already given to this member in this allowance month, in cents. */
async function usedCents(executor: Executor, memberRef: number, month: AllowanceMonth): Promise<number> {
  const [row] = await executor
    .select({ total: sql<string | null>`sum(${discountCouponsTable.discountAmount})` })
    .from(discountCouponsTable)
    .where(
      and(
        eq(discountCouponsTable.memberRef, memberRef),
        eq(discountCouponsTable.status, "REDEEMED"),
        gte(discountCouponsTable.redeemedAt, month.start),
        lt(discountCouponsTable.redeemedAt, month.end),
      ),
    );
  return centsFromNumeric(row?.total ?? null);
}

function percentOf(coupon: DiscountCoupon): number {
  return Number(coupon.discountPercent);
}

function ownCouponJson(c: DiscountCoupon, now = new Date()) {
  return {
    id: c.id,
    brand: c.brand,
    // An ACTIVE coupon past its time is reported as expired; the row is never rewritten.
    status: c.status === "ACTIVE" && c.expiresAt <= now ? ("EXPIRED" as const) : c.status,
    discountPercent: percentOf(c),
    createdAt: c.createdAt.toISOString(),
    expiresAt: c.expiresAt.toISOString(),
    redeemedAt: c.redeemedAt?.toISOString() ?? null,
    billAmount: c.billAmount == null ? null : Number(c.billAmount),
    discountAmount: c.discountAmount == null ? null : Number(c.discountAmount),
  };
}

function error(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

// ---------------------------------------------------------------------------
// The member
// ---------------------------------------------------------------------------

router.get("/v1/discounts", async (req, res): Promise<void> => {
  const actor = await sessionMember(req);
  if (!actor) {
    respondCardUnavailable(res, "SESSION");
    return;
  }
  const config = discountConfig();
  const month = allowanceMonth();
  const memberRef = actor.member.memberId;
  const used = await usedCents(db, memberRef, month);
  const coupons = await db
    .select()
    .from(discountCouponsTable)
    .where(eq(discountCouponsTable.memberRef, memberRef))
    .orderBy(desc(discountCouponsTable.createdAt))
    .limit(RECENT_COUPONS);

  res.json({
    discountPercent: config.percentBp / 100,
    currency: "GYD",
    monthlyCap: fromCents(config.monthlyCapCents),
    month: month.month,
    usedThisMonth: fromCents(used),
    remainingThisMonth: fromCents(Math.max(0, config.monthlyCapCents - used)),
    couponTtlMinutes: config.couponTtlMinutes,
    brands: DISCOUNT_BRANDS.map((brand) => ({ brand, name: BRAND_NAMES[brand] })),
    coupons: coupons.map((c) => ownCouponJson(c)),
  });
});

/** Page size when the request names none. */
const DEFAULT_PAGE_SIZE = 20;

router.get("/v1/discounts/coupons", async (req, res): Promise<void> => {
  const parsed = ListDiscountCouponsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    error(res, 400, "INVALID_INPUT", "Unknown brand or status, or a month that is not YYYY-MM.");
    return;
  }
  const actor = await sessionMember(req);
  if (!actor) {
    respondCardUnavailable(res, "SESSION");
    return;
  }
  const { brand, status, month } = parsed.data;
  const page = parsed.data.page ?? 1;
  const pageSize = parsed.data.pageSize ?? DEFAULT_PAGE_SIZE;
  const now = new Date();

  const where: SQL[] = [eq(discountCouponsTable.memberRef, actor.member.memberId)];
  if (brand) where.push(eq(discountCouponsTable.brand, brand));
  // ACTIVE and EXPIRED are one stored status split by the clock, as ownCouponJson reports them.
  if (status === "ACTIVE" || status === "EXPIRED") {
    where.push(eq(discountCouponsTable.status, "ACTIVE"));
    where.push(status === "ACTIVE" ? gt(discountCouponsTable.expiresAt, now) : lte(discountCouponsTable.expiresAt, now));
  } else if (status) {
    where.push(eq(discountCouponsTable.status, status));
  }
  if (month) {
    const { start, end } = monthWindow(month);
    where.push(gte(discountCouponsTable.createdAt, start), lt(discountCouponsTable.createdAt, end));
  }

  const [{ n: totalItems } = { n: 0 }] = await db
    .select({ n: count() })
    .from(discountCouponsTable)
    .where(and(...where));
  const rows = await db
    .select()
    .from(discountCouponsTable)
    .where(and(...where))
    .orderBy(desc(discountCouponsTable.createdAt), desc(discountCouponsTable.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  res.json({
    items: rows.map((c) => ownCouponJson(c, now)),
    page,
    pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / pageSize),
  });
});

router.post("/v1/discounts/coupons", async (req, res): Promise<void> => {
  const parsed = GenerateDiscountCouponBody.safeParse(req.body);
  if (!parsed.success) {
    error(res, 400, "INVALID_INPUT", "Choose KFC or Pizza Hut.");
    return;
  }
  const actor = await sessionMember(req);
  if (!actor) {
    respondCardUnavailable(res, "SESSION");
    return;
  }
  const { member, company } = actor;
  const { brand } = parsed.data;
  const config = discountConfig();
  const remaining = config.monthlyCapCents - (await usedCents(db, member.memberId, allowanceMonth()));
  if (remaining <= 0) {
    error(
      res,
      409,
      "ALLOWANCE_EXHAUSTED",
      "You have used this month's discount allowance. It renews on the 1st.",
    );
    return;
  }

  const code = generateCouponCode();
  const coupon = await db.transaction(async (tx) => {
    // One live coupon per brand: an older one left unused is cancelled, so a
    // screenshot of it cannot be spent alongside the new one.
    await tx
      .update(discountCouponsTable)
      .set({ status: "CANCELLED" })
      .where(
        and(
          eq(discountCouponsTable.memberRef, member.memberId),
          eq(discountCouponsTable.brand, brand),
          eq(discountCouponsTable.status, "ACTIVE"),
        ),
      );
    const [row] = await tx
      .insert(discountCouponsTable)
      .values({
        memberRef: member.memberId,
        companyNumber: company.companyNumber,
        brand,
        codeHash: couponCodeHash(normalizeCouponCode(code)!),
        discountPercent: (config.percentBp / 100).toFixed(2),
        expiresAt: new Date(Date.now() + config.couponTtlMinutes * 60_000),
      })
      .returning();
    await writeAudit(
      {
        actor: memberKey(member),
        actorRole: "ROLE_EMPLOYEE",
        action: "DISCOUNT_COUPON_GENERATED",
        entityType: "DISCOUNT_COUPON",
        entityId: row!.id,
        afterValue: JSON.stringify({ brand, discountPercent: config.percentBp / 100 }),
        sourceIp: req.ip ?? null,
        companyCode: company.companyNumber,
      },
      tx,
    );
    return row!;
  });

  res.json({ code, coupon: ownCouponJson(coupon), remainingThisMonth: fromCents(remaining) });
});

// ---------------------------------------------------------------------------
// The partner POS
// ---------------------------------------------------------------------------

/** The brand whose POS key the request carries, or null (answered with 401). */
function posBrand(req: Request, res: Response): DiscountBrand | null {
  const header = req.headers.authorization;
  const brand = header?.startsWith("Bearer ") ? brandForPosKey(header.slice(7).trim()) : null;
  if (!brand) error(res, 401, "POS_UNAUTHORIZED", "Missing or unknown POS key.");
  return brand;
}

async function findCoupon(rawCode: string): Promise<DiscountCoupon | null> {
  const canonical = normalizeCouponCode(rawCode);
  if (!canonical) return null;
  const [row] = await db
    .select()
    .from(discountCouponsTable)
    .where(eq(discountCouponsTable.codeHash, couponCodeHash(canonical)));
  return row ?? null;
}

interface Refusal {
  status: number;
  code: string;
  message: string;
}

/** Why this coupon cannot be redeemed by this brand now, or null when it can. */
function refusal(coupon: DiscountCoupon, brand: DiscountBrand, now = new Date()): Refusal | null {
  if (coupon.brand !== brand) {
    return { status: 409, code: "COUPON_WRONG_BRAND", message: `This coupon is for ${BRAND_NAMES[coupon.brand]}.` };
  }
  switch (coupon.status) {
    case "REDEEMED":
      return { status: 409, code: "COUPON_ALREADY_REDEEMED", message: "This coupon has already been used." };
    case "VOIDED":
      return {
        status: 409,
        code: "COUPON_VOIDED",
        message: "This coupon's sale was voided. Ask the employee to generate a new coupon.",
      };
    case "CANCELLED":
      return {
        status: 409,
        code: "COUPON_CANCELLED",
        message: "This coupon was replaced by a newer one. Ask the employee to show their latest coupon.",
      };
  }
  if (coupon.expiresAt <= now) {
    return {
      status: 409,
      code: "COUPON_EXPIRED",
      message: "This coupon has expired. Ask the employee to generate a new coupon.",
    };
  }
  return null;
}

const NOT_ELIGIBLE: Refusal = {
  status: 409,
  code: "MEMBER_NOT_ELIGIBLE",
  message: "This employee is no longer eligible for the discount.",
};

const EXHAUSTED: Refusal = {
  status: 409,
  code: "ALLOWANCE_EXHAUSTED",
  message: "This employee has used this month's discount allowance. Charge the full price.",
};

function refuse(res: Response, r: Refusal): void {
  error(res, r.status, r.code, r.message);
}

/** A quote as the till receives it, with the line to show the cashier. */
function quoteJson(q: Quote, percent: number) {
  return {
    billAmount: fromCents(q.billCents),
    fullDiscountAmount: fromCents(q.fullDiscountCents),
    discountAmount: fromCents(q.discountCents),
    amountPayable: fromCents(q.payableCents),
    capApplied: q.capApplied,
    message: quoteMessage(q, percent),
  };
}

function redemptionJson(c: DiscountCoupon, remainingCents: number, capApplied: boolean) {
  const bill = centsFromNumeric(c.billAmount);
  const discount = centsFromNumeric(c.discountAmount);
  return {
    couponId: c.id,
    brand: c.brand,
    discountPercent: percentOf(c),
    billAmount: fromCents(bill),
    fullDiscountAmount: fromCents(Math.round((bill * Math.round(percentOf(c) * 100)) / 10_000)),
    discountAmount: fromCents(discount),
    amountPayable: fromCents(bill - discount),
    capApplied,
    posReference: c.posReference ?? "",
    redeemedAt: c.redeemedAt!.toISOString(),
    remainingAllowance: fromCents(Math.max(0, remainingCents)),
  };
}

/** Rebuilds a redemption already recorded, for a till retrying the same sale. */
async function repeatRedemption(c: DiscountCoupon) {
  const config = discountConfig();
  const used = await usedCents(db, c.memberRef, allowanceMonth());
  const byPercent = Math.round((centsFromNumeric(c.billAmount) * Math.round(percentOf(c) * 100)) / 10_000);
  return redemptionJson(c, config.monthlyCapCents - used, centsFromNumeric(c.discountAmount) < byPercent);
}

router.post("/v1/pos/coupons/check", async (req, res): Promise<void> => {
  const brand = posBrand(req, res);
  if (!brand) return;
  const parsed = PosCheckCouponBody.safeParse(req.body);
  const billCents = parsed.success && parsed.data.billAmount != null ? toCents(parsed.data.billAmount) : null;
  if (!parsed.success || (parsed.data.billAmount != null && billCents == null)) {
    error(res, 400, "INVALID_INPUT", "Send the scanned code, and optionally the bill total in GYD to two decimals.");
    return;
  }
  const coupon = await findCoupon(parsed.data.code);
  if (!coupon) {
    error(res, 404, "COUPON_NOT_FOUND", "This is not a valid employee coupon.");
    return;
  }
  const why = refusal(coupon, brand) ?? (!(await memberForSession(coupon.memberRef)) ? NOT_ELIGIBLE : null);
  if (why) {
    refuse(res, why);
    return;
  }
  const remaining = discountConfig().monthlyCapCents - (await usedCents(db, coupon.memberRef, allowanceMonth()));
  if (remaining <= 0) {
    refuse(res, EXHAUSTED);
    return;
  }
  const quote = billCents == null ? null : quoteDiscount(billCents, Math.round(percentOf(coupon) * 100), remaining);
  res.json({
    couponId: coupon.id,
    brand: coupon.brand,
    discountPercent: percentOf(coupon),
    expiresAt: coupon.expiresAt.toISOString(),
    remainingAllowance: fromCents(remaining),
    quote: quote && quoteJson(quote, percentOf(coupon)),
  });
});

router.post("/v1/pos/coupons/redeem", async (req, res): Promise<void> => {
  const brand = posBrand(req, res);
  if (!brand) return;
  const parsed = PosRedeemCouponBody.safeParse(req.body);
  const billCents = parsed.success ? toCents(parsed.data.billAmount) : null;
  if (!parsed.success || billCents == null) {
    error(res, 400, "INVALID_INPUT", "Send the scanned code, the bill total in GYD to two decimals, and the receipt number.");
    return;
  }
  const posReference = parsed.data.posReference.trim();
  const posStore = parsed.data.posStore?.trim() || null;
  const confirmPartial = parsed.data.confirmPartialDiscount === true;
  const found = await findCoupon(parsed.data.code);
  if (!found) {
    error(res, 404, "COUPON_NOT_FOUND", "This is not a valid employee coupon.");
    return;
  }
  // A retry of a sale already recorded answers with that sale, not an error.
  if (found.brand === brand && found.status === "REDEEMED" && found.posReference === posReference) {
    res.json(await repeatRedemption(found));
    return;
  }
  const why = refusal(found, brand) ?? (!(await memberForSession(found.memberRef)) ? NOT_ELIGIBLE : null);
  if (why) {
    refuse(res, why);
    return;
  }

  const config = discountConfig();
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${REDEEM_LOCK_NAMESPACE}::int, ${found.memberRef}::int)`);
    // Re-read under the lock: another till may have redeemed it meanwhile.
    const [coupon] = await tx
      .select()
      .from(discountCouponsTable)
      .where(eq(discountCouponsTable.id, found.id))
      .for("update");
    if (!coupon) return { refused: { status: 404, code: "COUPON_NOT_FOUND", message: "This is not a valid employee coupon." } };
    if (coupon.status === "REDEEMED" && coupon.posReference === posReference) return { repeat: coupon };
    const now = new Date();
    const lateRefusal = refusal(coupon, brand, now);
    if (lateRefusal) return { refused: lateRefusal };

    const remaining = config.monthlyCapCents - (await usedCents(tx, coupon.memberRef, allowanceMonth(now)));
    if (remaining <= 0) return { refused: EXHAUSTED };
    const quote = quoteDiscount(billCents, Math.round(percentOf(coupon) * 100), remaining);
    // Less than the full percentage is applied only once the cashier has said yes
    // to it. Nothing is written: the coupon stays ACTIVE for the confirmed retry.
    if (quote.capApplied && !confirmPartial) return { unconfirmed: quote, percent: percentOf(coupon) };

    const [redeemed] = await tx
      .update(discountCouponsTable)
      .set({
        status: "REDEEMED",
        redeemedAt: now,
        billAmount: (quote.billCents / 100).toFixed(2),
        discountAmount: (quote.discountCents / 100).toFixed(2),
        posReference,
        posStore,
      })
      .where(and(eq(discountCouponsTable.id, coupon.id), eq(discountCouponsTable.status, "ACTIVE")))
      .returning();
    await writeAudit(
      {
        actor: `pos:${brand}`,
        actorRole: "ROLE_POS",
        action: "DISCOUNT_COUPON_REDEEMED",
        entityType: "DISCOUNT_COUPON",
        entityId: coupon.id,
        afterValue: JSON.stringify({
          billAmount: fromCents(quote.billCents),
          discountAmount: fromCents(quote.discountCents),
          capApplied: quote.capApplied,
          posReference,
          posStore,
        }),
        sourceIp: req.ip ?? null,
        companyCode: coupon.companyNumber,
      },
      tx,
    );
    return { redeemed: redeemed!, remainingAfter: remaining - quote.discountCents, capApplied: quote.capApplied };
  });

  if ("refused" in outcome) {
    refuse(res, outcome.refused!);
    return;
  }
  if ("unconfirmed" in outcome) {
    // The amounts travel beside the error, as an unconfirmed import's count does.
    res.status(409).json({
      error: {
        code: "PARTIAL_DISCOUNT_NOT_CONFIRMED",
        message: quoteMessage(outcome.unconfirmed!, outcome.percent!),
      },
      quote: quoteJson(outcome.unconfirmed!, outcome.percent!),
    });
    return;
  }
  if ("repeat" in outcome) {
    res.json(await repeatRedemption(outcome.repeat!));
    return;
  }
  res.json(redemptionJson(outcome.redeemed, outcome.remainingAfter, outcome.capApplied));
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post("/v1/pos/coupons/:couponId/void", async (req, res): Promise<void> => {
  const brand = posBrand(req, res);
  if (!brand) return;
  const parsed = PosVoidCouponBody.safeParse(req.body);
  if (!parsed.success) {
    error(res, 400, "INVALID_INPUT", "Give a reason for voiding (3 to 500 characters).");
    return;
  }
  const couponId = String(req.params["couponId"] ?? "");
  const notFound = () => error(res, 404, "COUPON_NOT_FOUND", "No redemption with this id for this brand.");
  if (!UUID.test(couponId)) {
    notFound();
    return;
  }
  // Another brand's coupon answers exactly like one that does not exist.
  const [coupon] = await db
    .select()
    .from(discountCouponsTable)
    .where(and(eq(discountCouponsTable.id, couponId), eq(discountCouponsTable.brand, brand)));
  if (!coupon) {
    notFound();
    return;
  }
  const voidedJson = (c: DiscountCoupon) => ({ couponId: c.id, status: "VOIDED" as const, voidedAt: c.voidedAt!.toISOString() });
  if (coupon.status === "VOIDED") {
    res.json(voidedJson(coupon));
    return;
  }
  if (coupon.status !== "REDEEMED") {
    error(res, 409, "COUPON_NOT_REDEEMED", "This coupon was never redeemed, so there is nothing to void.");
    return;
  }
  const reason = parsed.data.reason.trim();
  const voided = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(discountCouponsTable)
      .set({ status: "VOIDED", voidedAt: new Date(), voidReason: reason })
      .where(and(eq(discountCouponsTable.id, coupon.id), eq(discountCouponsTable.status, "REDEEMED")))
      .returning();
    if (!row) return null;
    await writeAudit(
      {
        actor: `pos:${brand}`,
        actorRole: "ROLE_POS",
        action: "DISCOUNT_COUPON_VOIDED",
        entityType: "DISCOUNT_COUPON",
        entityId: coupon.id,
        beforeValue: JSON.stringify({ discountAmount: Number(coupon.discountAmount), posReference: coupon.posReference }),
        reason,
        sourceIp: req.ip ?? null,
        companyCode: coupon.companyNumber,
      },
      tx,
    );
    return row;
  });
  if (!voided) {
    // Voided by a concurrent request between the read and the update.
    const [now] = await db.select().from(discountCouponsTable).where(eq(discountCouponsTable.id, coupon.id));
    res.json(voidedJson(now!));
    return;
  }
  res.json(voidedJson(voided));
});

export default router;
