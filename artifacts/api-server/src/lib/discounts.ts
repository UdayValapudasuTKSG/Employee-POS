/**
 * Employee discounts: the rules, as configuration and pure functions.
 *
 * A member generates a single-use coupon for one partner brand; that brand's
 * POS redeems it against a bill. The discount is DISCOUNT_PERCENT of the bill,
 * but never more than what is left of the member's monthly allowance —
 * DISCOUNT_MONTHLY_CAP_GYD of discount per calendar month (Guyana time), shared
 * across every brand. Only redeemed coupons count; a voided redemption gives
 * its discount back.
 *
 * Side-effect free, like constants.ts: no database, no SESSION_SECRET. The
 * routes (routes/discounts.ts) do the reading and writing.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { guyanaToday, monthStartUtc } from "./guyanaTime";

export const DISCOUNT_BRANDS = ["KFC", "PIZZA_HUT"] as const;
export type DiscountBrand = (typeof DISCOUNT_BRANDS)[number];

export const BRAND_NAMES: Record<DiscountBrand, string> = {
  KFC: "KFC",
  PIZZA_HUT: "Pizza Hut",
};

/** Each brand's POS authenticates with its own key. */
const POS_KEY_ENV: Record<DiscountBrand, string> = {
  KFC: "POS_API_KEY_KFC",
  PIZZA_HUT: "POS_API_KEY_PIZZA_HUT",
};

/** A shorter POS key is ignored rather than trusted. */
export const MIN_POS_KEY_LENGTH = 24;

export interface DiscountConfig {
  /** In basis points: 10% is 1000. Integer arithmetic throughout. */
  percentBp: number;
  /** The monthly allowance, in GYD cents. */
  monthlyCapCents: number;
  couponTtlMinutes: number;
}

function numberEnv(name: string, fallback: number, ok: (n: number) => boolean): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && ok(n) ? n : fallback;
}

/** Read per call, so a restart is all a change needs. An invalid value falls back to the default. */
export function discountConfig(): DiscountConfig {
  const percent = numberEnv("DISCOUNT_PERCENT", 10, (n) => n > 0 && n <= 100);
  const cap = numberEnv("DISCOUNT_MONTHLY_CAP_GYD", 15_000, (n) => n >= 0);
  const ttl = numberEnv("DISCOUNT_COUPON_TTL_MINUTES", 30, (n) => n >= 1 && n <= 24 * 60);
  return {
    percentBp: Math.round(percent * 100),
    monthlyCapCents: Math.round(cap * 100),
    couponTtlMinutes: Math.round(ttl),
  };
}

// ---------------------------------------------------------------------------
// Coupon codes
// ---------------------------------------------------------------------------

/**
 * Crockford base32: no I, L, O or U, so a code read aloud or typed from the
 * screen survives. 12 characters is 60 bits — ample for a code that is
 * single-use, expires in minutes, and is only accepted from a keyed POS.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 12;

/** A new code, grouped for reading: K7PQ-3MZX-9TRA. */
export function generateCouponCode(): string {
  // 32 divides 256, so masking a byte to 5 bits is uniform.
  const chars = [...randomBytes(CODE_LENGTH)].map((b) => ALPHABET[b & 31]);
  return [0, 4, 8].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

/**
 * The canonical form of a scanned or typed code, or null when it cannot be
 * one. Case, spaces and hyphens are ignored, and the letters Crockford leaves
 * out are read as the digits they resemble.
 */
export function normalizeCouponCode(raw: string): string | null {
  const s = raw
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return s.length === CODE_LENGTH && [...s].every((c) => ALPHABET.includes(c)) ? s : null;
}

/** What is stored: the sha256 of the canonical code. */
export function couponCodeHash(canonical: string): string {
  return createHash("sha256").update(`coupon:${canonical}`).digest("hex");
}

// ---------------------------------------------------------------------------
// POS keys
// ---------------------------------------------------------------------------

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** The brand a POS key belongs to, or null. Compared in constant time. */
export function brandForPosKey(key: string): DiscountBrand | null {
  const given = digest(key);
  let found: DiscountBrand | null = null;
  for (const brand of DISCOUNT_BRANDS) {
    const configured = process.env[POS_KEY_ENV[brand]]?.trim();
    if (!configured || configured.length < MIN_POS_KEY_LENGTH) continue;
    // Every configured key is compared, so the time taken says nothing about which matched.
    if (timingSafeEqual(given, digest(configured))) found = brand;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Money — GYD, held as integer cents
// ---------------------------------------------------------------------------

/** An amount in GYD as integer cents, or null when it has more than two decimals. */
export function toCents(amount: number): number | null {
  if (!Number.isFinite(amount)) return null;
  const cents = Math.round(amount * 100);
  return Math.abs(amount * 100 - cents) < 1e-6 ? cents : null;
}

export function fromCents(cents: number): number {
  return cents / 100;
}

/** A numeric column's string ("1500.00") as cents. */
export function centsFromNumeric(value: string | null): number {
  return value == null ? 0 : Math.round(Number(value) * 100);
}

export interface Quote {
  billCents: number;
  /** What the percentage alone would give. */
  fullDiscountCents: number;
  /** What is actually given: the full discount, or less when the allowance cannot cover it. */
  discountCents: number;
  payableCents: number;
  /** True when the remaining allowance, not the percentage, set the discount. */
  capApplied: boolean;
}

/** The discount on a bill: the percentage, rounded to the cent, capped by what is left this month. */
export function quoteDiscount(billCents: number, percentBp: number, remainingCents: number): Quote {
  const byPercent = Math.round((billCents * percentBp) / 10_000);
  const remaining = Math.max(0, remainingCents);
  const discountCents = Math.min(byPercent, remaining);
  return {
    billCents,
    fullDiscountCents: byPercent,
    discountCents,
    payableCents: billCents - discountCents,
    capApplied: byPercent > remaining,
  };
}

const GYD = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** GYD cents for a cashier to read: "GYD 1,000.00". */
export function formatGyd(cents: number): string {
  return `GYD ${GYD.format(cents / 100)}`;
}

/**
 * What the till shows the cashier. When the allowance cannot cover the full
 * percentage, it says so and asks before applying the smaller amount — the
 * redeem call then needs confirmPartialDiscount.
 */
export function quoteMessage(q: Quote, percent: number): string {
  if (!q.capApplied) {
    return `${percent}% off: ${formatGyd(q.discountCents)}. Customer pays ${formatGyd(q.payableCents)}.`;
  }
  return (
    `This employee has only ${formatGyd(q.discountCents)} of discount left this month ` +
    `(${percent}% would be ${formatGyd(q.fullDiscountCents)}). Apply ${formatGyd(q.discountCents)}? ` +
    `Customer pays ${formatGyd(q.payableCents)}.`
  );
}

// ---------------------------------------------------------------------------
// The allowance month
// ---------------------------------------------------------------------------

export interface AllowanceMonth {
  /** YYYY-MM, Guyana time. */
  month: string;
  /** 00:00 Guyana time on the 1st, inclusive. */
  start: Date;
  /** 00:00 Guyana time on the next 1st, exclusive. */
  end: Date;
}

/** A YYYY-MM month in Guyana time, as the instants it runs between. Throws on a malformed month. */
export function monthWindow(month: string): AllowanceMonth {
  const start = monthStartUtc(month);
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { month, start, end: monthStartUtc(next) };
}

/** The calendar month, in Guyana, that `now` falls in. */
export function allowanceMonth(now: Date = new Date()): AllowanceMonth {
  return monthWindow(guyanaToday(now).slice(0, 7));
}
