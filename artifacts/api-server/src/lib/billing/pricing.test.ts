import { describe, expect, it } from "vitest";
import { chooseRate, chooseRule, monthDate, monthStart, split, tierFor, type RateRow } from "./pricing";

const rate = (over: Partial<RateRow>): RateRow => ({
  premiumRateId: 1,
  companyNumber: null,
  classCode: "A",
  dependentBand: 0,
  coverageBand: "EMP_ONLY",
  coverageLabel: "Employee only",
  totalPremium: "5000.00",
  companyPremium: "4000.00",
  employeePremium: "1000.00",
  effectiveDate: "2026-10-01",
  active: true,
  ...over,
});

describe("monthStart", () => {
  it("is 00:00 on the 1st in Guyana, 04:00 UTC", () => {
    expect(monthStart("2026-10").toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(monthDate("2026-10")).toBe("2026-10-01");
    expect(() => monthStart("2026-13")).toThrow();
  });
});

describe("chooseRate", () => {
  const q = { companyNumber: "BF", classCode: "A", band: 0, asOf: "2026-11-01" };

  it("prefers a company rate over the standard rate", () => {
    const chosen = chooseRate([rate({ premiumRateId: 1 }), rate({ premiumRateId: 2, companyNumber: "BF", totalPremium: "6000.00" })], q);
    expect(chosen).toMatchObject({ premiumRateId: 2, source: "COMPANY" });
  });

  it("ignores another company's rate", () => {
    expect(chooseRate([rate({ premiumRateId: 1 }), rate({ premiumRateId: 2, companyNumber: "BA" })], q)).toMatchObject({
      premiumRateId: 1,
      source: "STANDARD",
    });
  });

  it("picks the latest effective date on or before the month, never a later one", () => {
    const rows = [
      rate({ premiumRateId: 1, effectiveDate: "2026-01-01" }),
      rate({ premiumRateId: 2, effectiveDate: "2026-11-01" }),
      rate({ premiumRateId: 3, effectiveDate: "2026-12-01" }),
    ];
    expect(chooseRate(rows, q)?.premiumRateId).toBe(2);
    expect(chooseRate(rows, { ...q, asOf: "2026-10-01" })?.premiumRateId).toBe(1);
  });

  it("ignores inactive rates and other classes and tiers, and returns null when nothing fits", () => {
    const rows = [rate({ active: false }), rate({ premiumRateId: 2, classCode: "B" }), rate({ premiumRateId: 3, dependentBand: 1 })];
    expect(chooseRate(rows, q)).toBeNull();
    expect(chooseRate([], q)).toBeNull();
  });

  it("falls back to the standard rate when the company rate starts later", () => {
    const rows = [rate({ premiumRateId: 1 }), rate({ premiumRateId: 2, companyNumber: "BF", effectiveDate: "2026-12-01" })];
    expect(chooseRate(rows, q)).toMatchObject({ premiumRateId: 1, source: "STANDARD" });
  });
});

describe("split", () => {
  it("uses the rate's own amounts without a rule", () => {
    expect(split(rate({}), null)).toEqual({ totalPremium: "5000.00", companyPremium: "4000.00", employeePremium: "1000.00" });
  });

  it("applies an 80/20 rule, the employee taking the remainder", () => {
    expect(split(rate({}), { companySharePercent: "80", employeeSharePercent: "20" })).toEqual({
      totalPremium: "5000.00",
      companyPremium: "4000.00",
      employeePremium: "1000.00",
    });
    expect(split(rate({ totalPremium: "33333.33" }), { companySharePercent: "80.00", employeeSharePercent: "20.00" })).toEqual({
      totalPremium: "33333.33",
      companyPremium: "26666.66",
      employeePremium: "6666.67",
    });
    expect(split(rate({ totalPremium: "100.01" }), { companySharePercent: "50", employeeSharePercent: "50" })).toEqual({
      totalPremium: "100.01",
      companyPremium: "50.01",
      employeePremium: "50.00",
    });
  });

  it("refuses a rule whose shares do not total 100", () => {
    expect(() => split(rate({}), { companySharePercent: "80", employeeSharePercent: "25" })).toThrow(/total 100/);
  });
});

describe("chooseRule", () => {
  it("takes the latest active rule in force", () => {
    const rules = [
      { companySharePercent: "70", employeeSharePercent: "30", effectiveDate: "2026-01-01", active: true },
      { companySharePercent: "80", employeeSharePercent: "20", effectiveDate: "2026-10-01", active: true },
      { companySharePercent: "90", employeeSharePercent: "10", effectiveDate: "2026-09-01", active: false },
      { companySharePercent: "60", employeeSharePercent: "40", effectiveDate: "2026-12-01", active: true },
    ];
    expect(chooseRule(rules, "2026-11-01")?.companySharePercent).toBe("80");
    expect(chooseRule(rules, "2025-12-01")).toBeNull();
  });
});

describe("tierFor", () => {
  it("caps at three: more than two dependants is a flat rate", () => {
    expect([0, 1, 2, 3, 7].map((n) => tierFor(n).dependentBand)).toEqual([0, 1, 2, 3, 3]);
  });
});
