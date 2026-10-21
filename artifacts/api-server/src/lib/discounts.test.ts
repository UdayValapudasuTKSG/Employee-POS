import { afterEach, describe, expect, it } from "vitest";
import {
  MIN_POS_KEY_LENGTH,
  allowanceMonth,
  brandForPosKey,
  couponCodeHash,
  discountConfig,
  generateCouponCode,
  monthWindow,
  normalizeCouponCode,
  quoteDiscount,
  quoteMessage,
  toCents,
} from "./discounts";

const ENV_KEYS = [
  "DISCOUNT_PERCENT",
  "DISCOUNT_MONTHLY_CAP_GYD",
  "DISCOUNT_COUPON_TTL_MINUTES",
  "POS_API_KEY_KFC",
  "POS_API_KEY_PIZZA_HUT",
];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("discountConfig", () => {
  it("defaults to 10% with a GYD 15,000 monthly cap", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(discountConfig()).toEqual({ percentBp: 1000, monthlyCapCents: 1_500_000, couponTtlMinutes: 30 });
  });

  it("reads the environment, and ignores a value that makes no sense", () => {
    process.env["DISCOUNT_PERCENT"] = "12.5";
    process.env["DISCOUNT_MONTHLY_CAP_GYD"] = "-1";
    process.env["DISCOUNT_COUPON_TTL_MINUTES"] = "abc";
    expect(discountConfig()).toEqual({ percentBp: 1250, monthlyCapCents: 1_500_000, couponTtlMinutes: 30 });
  });
});

describe("coupon codes", () => {
  it("are three groups of four Crockford characters", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateCouponCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    }
  });

  it("normalise case, separators and look-alike letters to one canonical form", () => {
    expect(normalizeCouponCode("k7pq-3mzx-9tra")).toBe("K7PQ3MZX9TRA");
    expect(normalizeCouponCode(" K7PQ 3MZX 9TRA ")).toBe("K7PQ3MZX9TRA");
    expect(normalizeCouponCode("KOPQ-3MZX-9TRL")).toBe("K0PQ3MZX9TR1");
  });

  it("reject anything that cannot be a code", () => {
    expect(normalizeCouponCode("")).toBeNull();
    expect(normalizeCouponCode("K7PQ-3MZX")).toBeNull();
    expect(normalizeCouponCode("K7PQ-3MZX-9TRA-1")).toBeNull();
    expect(normalizeCouponCode("K7PQ-3MZX-9TR!")).toBeNull();
    expect(normalizeCouponCode("K7PQ-3MZX-9TRU")).toBeNull();
  });

  it("hash the canonical form, so any way of typing a code finds the same coupon", () => {
    expect(couponCodeHash(normalizeCouponCode("k7pq3mzx9tra")!)).toBe(couponCodeHash(normalizeCouponCode("K7PQ-3MZX-9TRA")!));
  });
});

describe("brandForPosKey", () => {
  const kfc = "k".repeat(MIN_POS_KEY_LENGTH);
  const hut = "p".repeat(MIN_POS_KEY_LENGTH);

  it("names the brand whose key it is", () => {
    process.env["POS_API_KEY_KFC"] = kfc;
    process.env["POS_API_KEY_PIZZA_HUT"] = hut;
    expect(brandForPosKey(kfc)).toBe("KFC");
    expect(brandForPosKey(hut)).toBe("PIZZA_HUT");
    expect(brandForPosKey("x".repeat(MIN_POS_KEY_LENGTH))).toBeNull();
  });

  it("trusts no brand whose key is unset or too short", () => {
    delete process.env["POS_API_KEY_KFC"];
    process.env["POS_API_KEY_PIZZA_HUT"] = "short";
    expect(brandForPosKey("")).toBeNull();
    expect(brandForPosKey("short")).toBeNull();
  });
});

describe("toCents", () => {
  it("accepts whole dollars and two decimals", () => {
    expect(toCents(2500)).toBe(250_000);
    expect(toCents(1234.56)).toBe(123_456);
    expect(toCents(0.1 + 0.2)).toBe(30);
  });

  it("refuses more than two decimals and non-numbers", () => {
    expect(toCents(1.005)).toBeNull();
    expect(toCents(Number.NaN)).toBeNull();
    expect(toCents(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("quoteDiscount", () => {
  const TEN_PERCENT = 1000;
  const CAP = 1_500_000;

  it("gives the percentage when the allowance covers it", () => {
    expect(quoteDiscount(250_000, TEN_PERCENT, CAP)).toEqual({
      billCents: 250_000,
      fullDiscountCents: 25_000,
      discountCents: 25_000,
      payableCents: 225_000,
      capApplied: false,
    });
  });

  it("gives only what is left of the allowance", () => {
    // GYD 14,000 already used; a GYD 20,000 bill would earn 2,000 but 1,000 is left.
    expect(quoteDiscount(2_000_000, TEN_PERCENT, CAP - 1_400_000)).toEqual({
      billCents: 2_000_000,
      fullDiscountCents: 200_000,
      discountCents: 100_000,
      payableCents: 1_900_000,
      capApplied: true,
    });
  });

  it("reaches the cap exactly at a GYD 150,000 bill", () => {
    const q = quoteDiscount(15_000_000, TEN_PERCENT, CAP);
    expect(q.discountCents).toBe(CAP);
    expect(q.capApplied).toBe(false);
  });

  it("gives nothing once the allowance is used up", () => {
    expect(quoteDiscount(100_000, TEN_PERCENT, 0).discountCents).toBe(0);
    expect(quoteDiscount(100_000, TEN_PERCENT, -5).discountCents).toBe(0);
  });

  it("rounds to the nearest cent", () => {
    // 10% of GYD 0.05 is half a cent.
    expect(quoteDiscount(5, TEN_PERCENT, CAP).discountCents).toBe(1);
    expect(quoteDiscount(4, TEN_PERCENT, CAP).discountCents).toBe(0);
  });
});

describe("quoteMessage — the business scenarios", () => {
  const TEN_PERCENT = 1000;

  it("scenario 1: GYD 15,000 available, GYD 20,000 bill — full 10%, no confirmation", () => {
    const q = quoteDiscount(2_000_000, TEN_PERCENT, 1_500_000);
    expect(q).toMatchObject({ discountCents: 200_000, payableCents: 1_800_000, capApplied: false });
    expect(quoteMessage(q, 10)).toBe("10% off: GYD 2,000.00. Customer pays GYD 18,000.00.");
  });

  it("scenario 2: GYD 800 available, GYD 10,000 bill — offers 800 and asks first", () => {
    const q = quoteDiscount(1_000_000, TEN_PERCENT, 80_000);
    expect(q).toMatchObject({ fullDiscountCents: 100_000, discountCents: 80_000, payableCents: 920_000, capApplied: true });
    expect(quoteMessage(q, 10)).toBe(
      "This employee has only GYD 800.00 of discount left this month (10% would be GYD 1,000.00). " +
        "Apply GYD 800.00? Customer pays GYD 9,200.00.",
    );
  });
});

describe("allowanceMonth", () => {
  it("is the calendar month in Guyana, from 00:00 on the 1st", () => {
    const m = allowanceMonth(new Date("2026-10-12T15:00:00Z"));
    expect(m.month).toBe("2026-10");
    expect(m.start.toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(m.end.toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });

  it("is still last month at 23:30 on the 31st in Guyana, though already the 1st in UTC", () => {
    expect(allowanceMonth(new Date("2026-11-01T03:30:00Z")).month).toBe("2026-10");
  });

  it("rolls December into January of the next year", () => {
    const m = allowanceMonth(new Date("2026-12-15T12:00:00Z"));
    expect(m.end.toISOString()).toBe("2027-01-01T04:00:00.000Z");
  });
});

describe("monthWindow", () => {
  it("runs from 00:00 Guyana time on the 1st to the next 1st", () => {
    const m = monthWindow("2026-02");
    expect(m.start.toISOString()).toBe("2026-02-01T04:00:00.000Z");
    expect(m.end.toISOString()).toBe("2026-03-01T04:00:00.000Z");
  });

  it("refuses a month that is not YYYY-MM", () => {
    expect(() => monthWindow("2026-13")).toThrow();
    expect(() => monthWindow("2026-1")).toThrow();
  });
});
