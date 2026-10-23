import { describe, expect, it } from "vitest";
import {
  codeHash,
  currentMonth,
  decryptCode,
  encryptCode,
  formatCode,
  generateDiscountCode,
  maskEmail,
  monthWindow,
  normalizeCode,
  quote,
  quoteMessage,
  storeForKey,
  toCents,
} from "./rules";

const TEN = 1000; // 10% in basis points

describe("discount codes", () => {
  it("are three groups of four Crockford characters", () => {
    for (let i = 0; i < 50; i++) expect(generateDiscountCode()).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){2}[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it("read the same however they are typed", () => {
    expect(normalizeCode("k7pq-3mzx-9tra")).toBe("K7PQ3MZX9TRA");
    expect(normalizeCode(" K7PQ 3MZX 9TRA ")).toBe("K7PQ3MZX9TRA");
    expect(normalizeCode("KOPQ-3MZX-9TRL")).toBe("K0PQ3MZX9TR1");
    expect(codeHash(normalizeCode("k7pq3mzx9tra")!)).toBe(codeHash(normalizeCode("K7PQ-3MZX-9TRA")!));
    expect(formatCode("K7PQ3MZX9TRA")).toBe("K7PQ-3MZX-9TRA");
  });

  it("refuse anything that cannot be a code", () => {
    for (const bad of ["", "K7PQ-3MZX", "K7PQ-3MZX-9TRA-1", "K7PQ-3MZX-9TR!", "K7PQ-3MZX-9TRU"]) expect(normalizeCode(bad)).toBeNull();
  });

  it("round-trip through encryption, and a tampered value fails", () => {
    const secret = "s".repeat(40);
    const enc = encryptCode("K7PQ-3MZX-9TRA", secret);
    expect(enc).not.toContain("K7PQ");
    expect(decryptCode(enc, secret)).toBe("K7PQ-3MZX-9TRA");
    expect(() => decryptCode(enc, "t".repeat(40))).toThrow();
    const [iv, tag, ct] = enc.split(".");
    expect(() => decryptCode([iv, tag, `${ct!.slice(0, -2)}AA`].join("."), secret)).toThrow();
  });
});

describe("storeForKey", () => {
  const keys = { KFC: "k".repeat(30), PIZZA_HUT: "p".repeat(30), STERLING: undefined, BEHARRY: "b".repeat(30) };
  it("names the store a key belongs to", () => {
    expect(storeForKey("k".repeat(30), keys)).toBe("KFC");
    expect(storeForKey("b".repeat(30), keys)).toBe("BEHARRY");
    expect(storeForKey("x".repeat(30), keys)).toBeNull();
    expect(storeForKey("", keys)).toBeNull();
  });
});

describe("quote — the business scenarios", () => {
  it("scenario 1: 15,000 left, 20,000 bill: full 10%, no confirmation", () => {
    const q = quote(2_000_000, TEN, 1_500_000);
    expect(q).toEqual({ billCents: 2_000_000, fullDiscountCents: 200_000, discountCents: 200_000, payableCents: 1_800_000, capApplied: false });
    expect(quoteMessage(q, 10)).toBe("10% off: GYD 2,000.00. Customer pays GYD 18,000.00.");
  });

  it("scenario 2: 800 left, 10,000 bill: 800 off and the cashier is asked", () => {
    const q = quote(1_000_000, TEN, 80_000);
    expect(q).toMatchObject({ fullDiscountCents: 100_000, discountCents: 80_000, payableCents: 920_000, capApplied: true });
    expect(quoteMessage(q, 10)).toContain("Apply GYD 800.00? Customer pays GYD 9,200.00.");
  });

  it("gives nothing when the allowance is used up, and rounds to the cent", () => {
    expect(quote(100_000, TEN, 0).discountCents).toBe(0);
    expect(quote(5, TEN, 1_500_000).discountCents).toBe(1);
  });
});

describe("money", () => {
  it("takes two decimals and no more", () => {
    expect(toCents(1234.56)).toBe(123_456);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(1.005)).toBeNull();
    expect(toCents(Number.NaN)).toBeNull();
  });
});

describe("months, in Guyana time", () => {
  it("run from 00:00 on the 1st, UTC-4", () => {
    const m = monthWindow("2026-12");
    expect(m.start.toISOString()).toBe("2026-12-01T04:00:00.000Z");
    expect(m.end.toISOString()).toBe("2027-01-01T04:00:00.000Z");
  });

  it("still count 23:30 on the 31st as the old month", () => {
    expect(currentMonth(new Date("2026-11-01T03:30:00Z")).month).toBe("2026-10");
  });

  it("refuse a malformed month", () => {
    expect(() => monthWindow("2026-13")).toThrow();
  });
});

describe("maskEmail", () => {
  it("keeps the first letters and the domain ending", () => {
    expect(maskEmail("uday@gmail.com")).toBe("u•••@g••••.com");
  });
});
