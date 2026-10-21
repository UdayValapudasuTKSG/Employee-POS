import { describe, expect, it } from "vitest";
import { RATE_BANDS, centsToMoney, tierFor, toCents, validateRateSet } from "./rateBands";

describe("tierFor (FR-022, FR-023)", () => {
  it("puts 0, 1 and 2 dependants in their own tiers and 3 or more in one flat tier", () => {
    expect([0, 1, 2, 3, 7, 25].map((n) => tierFor(n).dependentBand)).toEqual([0, 1, 2, 3, 3, 3]);
    expect(tierFor(0).coverageLabel).toBe("Employee only");
    expect(tierFor(3).coverageBand).toBe("EMP_PLUS_3PLUS");
  });

  it("refuses a count that is not a whole non-negative number", () => {
    expect(() => tierFor(-1)).toThrow();
    expect(() => tierFor(1.5)).toThrow();
  });

  it("keeps the band strings within the BHI column sizes", () => {
    for (const b of RATE_BANDS) {
      expect(b.coverageBand.length).toBeLessThanOrEqual(20);
      expect(b.coverageLabel.length).toBeLessThanOrEqual(80);
    }
  });
});

describe("money", () => {
  it("round-trips amounts through integer cents exactly", () => {
    expect(toCents("1234.5")).toBe(123450);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(centsToMoney(123450)).toBe("1234.50");
    expect(toCents("1.234")).toBeNull();
    expect(toCents("abc")).toBeNull();
  });
});

describe("validateRateSet", () => {
  const set = [
    { dependentBand: 0, totalPremium: "5000", companyPremium: "4000", employeePremium: "1000" },
    { dependentBand: 1, totalPremium: "9000", companyPremium: "7200", employeePremium: "1800" },
    { dependentBand: 2, totalPremium: "12000", companyPremium: "9600", employeePremium: "2400" },
    { dependentBand: 3, totalPremium: "14000", companyPremium: "11200", employeePremium: "2800" },
  ];

  it("accepts a full four-tier set whose shares add up", () => {
    expect(validateRateSet(set)).toEqual([]);
  });

  it("refuses a set with a tier missing or repeated", () => {
    expect(validateRateSet(set.slice(0, 3))).not.toEqual([]);
    expect(validateRateSet([...set.slice(0, 3), { ...set[0]! }])).not.toEqual([]);
  });

  it("refuses a tier whose shares do not add up to the total, to the cent", () => {
    const bad = set.map((t, i) => (i === 2 ? { ...t, employeePremium: "2399.99" } : t));
    expect(validateRateSet(bad).join(" ")).toMatch(/Employee \+ 2 dependents/);
  });
});
