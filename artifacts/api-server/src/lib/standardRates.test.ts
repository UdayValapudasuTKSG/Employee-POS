import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_STANDARD_RATES_CSV, parseRateCard } from "./standardRates";

const repoCsv = path.resolve(__dirname, "../../../../deploy/db/seed/premium_rates_standard.csv");

describe("parseRateCard", () => {
  it("reads the repository's card as three complete classes of test values", () => {
    const card = parseRateCard(readFileSync(repoCsv, "utf8"));
    expect(card.testValues).toBe(true);
    expect(card.sets.map((s) => s.classCode).sort()).toEqual(["A", "B", "C"]);
    for (const s of card.sets) expect(s.tiers).toHaveLength(4);
  });

  it("embeds the same values the repository file holds", () => {
    const strip = (t: string) => parseRateCard(t).sets;
    expect(strip(DEMO_STANDARD_RATES_CSV)).toEqual(strip(readFileSync(repoCsv, "utf8")));
  });

  it("refuses a class with three tiers, and shares that do not add up", () => {
    const header = "class_code,dependent_band,total_premium,company_premium,employee_premium,effective_date";
    expect(() =>
      parseRateCard(`${header}\nD,0,10,5,5,2026-10-01\nD,1,10,5,5,2026-10-01\nD,2,10,5,5,2026-10-01\n`),
    ).toThrow(/four tiers/);
    expect(() =>
      parseRateCard(`${header}\nD,0,10,5,4,2026-10-01\nD,1,10,5,5,2026-10-01\nD,2,10,5,5,2026-10-01\nD,3,10,5,5,2026-10-01\n`),
    ).toThrow(/must equal the total/);
  });

  it("is not test values without the marker", () => {
    const card = parseRateCard(DEMO_STANDARD_RATES_CSV.replace(/^#.*\n/, ""));
    expect(card.testValues).toBe(false);
  });

  it("refuses a wrong header", () => {
    expect(() => parseRateCard("class,band\nA,0\n")).toThrow(/header/);
  });
});
