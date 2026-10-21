import { describe, expect, it } from "vitest";
import {
  RETIREMENT_AGE,
  ageOn,
  hasReachedRetirementAge,
  localDateString,
  retirementCutoff,
  subtractYears,
} from "./retirement";

describe("subtractYears", () => {
  it("keeps the month and day for an ordinary date", () => {
    expect(subtractYears("2026-08-04", 65)).toBe("1961-08-04");
  });

  it("clamps 29 February to 28 in a non-leap target year, as Postgres does", () => {
    // The sweep asks Postgres the same question with
    // `date - INTERVAL '65 years'`; if this returned "1959-02-29" the two would
    // disagree and the string would be an invalid date besides.
    expect(subtractYears("2024-02-29", 65)).toBe("1959-02-28");
  });

  it("keeps 29 February when the target year is also a leap year", () => {
    expect(subtractYears("2024-02-29", 64)).toBe("1960-02-29");
  });

  it("pads single-digit months and days", () => {
    expect(subtractYears("2026-01-05", 65)).toBe("1961-01-05");
  });
});

describe("hasReachedRetirementAge", () => {
  const asOf = "2026-08-04";

  it("is true on the 65th birthday itself", () => {
    expect(hasReachedRetirementAge("1961-08-04", asOf)).toBe(true);
  });

  it("is false the day before the 65th birthday", () => {
    expect(hasReachedRetirementAge("1961-08-05", asOf)).toBe(false);
  });

  it("is true for anyone older", () => {
    expect(hasReachedRetirementAge("1950-01-01", asOf)).toBe(true);
  });

  it("is false for anyone younger", () => {
    expect(hasReachedRetirementAge("1990-06-15", asOf)).toBe(false);
    expect(hasReachedRetirementAge("1962-08-04", asOf)).toBe(false);
  });

  it("ages a 29 February birthday out on 1 March in a non-leap year", () => {
    // Born 1960-02-29, so the 65th birthday falls in 2025, which is not a leap
    // year. The clamped cutoff puts them out on 1 March rather than never.
    expect(hasReachedRetirementAge("1960-02-29", "2025-02-28")).toBe(false);
    expect(hasReachedRetirementAge("1960-02-29", "2025-03-01")).toBe(true);
  });

  it("tolerates a timestamp-shaped value", () => {
    // Drizzle hands back a plain YYYY-MM-DD for a `date` column, but a value
    // that arrived from elsewhere carrying a time must not read as a later date.
    expect(hasReachedRetirementAge("1961-08-04T00:00:00.000Z", asOf)).toBe(true);
  });
});

describe("retirementCutoff", () => {
  it("is the date of birth of someone turning 65 today", () => {
    expect(retirementCutoff("2026-08-04")).toBe("1961-08-04");
    expect(RETIREMENT_AGE).toBe(65);
  });
});

describe("ageOn", () => {
  it("counts whole years only", () => {
    expect(ageOn("1961-08-04", "2026-08-03")).toBe(64);
    expect(ageOn("1961-08-04", "2026-08-04")).toBe(65);
    expect(ageOn("1961-08-04", "2026-08-05")).toBe(65);
  });

  it("handles a birthday later in the year", () => {
    expect(ageOn("1961-12-31", "2026-08-04")).toBe(64);
  });
});

describe("localDateString", () => {
  it("uses local date parts, not the UTC ones toISOString would give", () => {
    const at = new Date(2026, 7, 4, 23, 30);
    expect(localDateString(at)).toBe("2026-08-04");
  });

  it("pads to two digits", () => {
    expect(localDateString(new Date(2026, 0, 9, 12))).toBe("2026-01-09");
  });
});
