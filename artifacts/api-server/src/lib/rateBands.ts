/**
 * The four premium tiers every class has (spec FR-022, client requirement
 * "Each class has four tiers: Employee only, +1, +2, and more than two").
 *
 * A member's tier is set by how many active dependants they have. Every
 * dependant counts the same — spouse, child, newborn or parent — and there is
 * no cap: three or more is one flat tier (FR-023).
 */

export interface RateBand {
  /** premium_rates.dependent_band */
  dependentBand: 0 | 1 | 2 | 3;
  /** premium_rates.coverage_band (Text(20)) */
  coverageBand: string;
  /** premium_rates.coverage_label (Text(80)) */
  coverageLabel: string;
}

/**
 * The client's BHI Enrollment Database PremiumRates codes (migration 006 renamed
 * the portal's first codes, EE / EE+1 / EE+2 / EE+3+, to these).
 */
export const RATE_BANDS: readonly RateBand[] = Object.freeze([
  { dependentBand: 0, coverageBand: "EMP_ONLY", coverageLabel: "Employee only" },
  { dependentBand: 1, coverageBand: "EMP_PLUS_1", coverageLabel: "Employee + 1 dependent" },
  { dependentBand: 2, coverageBand: "EMP_PLUS_2", coverageLabel: "Employee + 2 dependents" },
  { dependentBand: 3, coverageBand: "EMP_PLUS_3PLUS", coverageLabel: "Employee + 3 or more dependents" },
]);

/** The tier for a number of active dependants. */
export function tierFor(activeDependentCount: number): RateBand {
  if (!Number.isInteger(activeDependentCount) || activeDependentCount < 0) {
    throw new Error(`Not a dependant count: ${activeDependentCount}`);
  }
  return RATE_BANDS[Math.min(activeDependentCount, 3)]!;
}

export function bandByNumber(dependentBand: number): RateBand | undefined {
  return RATE_BANDS.find((b) => b.dependentBand === dependentBand);
}

/** Money as integer cents, so totals are exact. Accepts "1234.5", "1234.50", 1234.5. */
export function toCents(value: string | number): number | null {
  const s = typeof value === "number" ? value.toFixed(2) : value.trim();
  if (!/^-?\d{1,13}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return s.startsWith("-") ? -cents : cents;
}

export function centsToMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export interface RateTierInput {
  dependentBand: number;
  totalPremium: string | number;
  companyPremium: string | number;
  employeePremium: string | number;
}

/**
 * A rate is entered as a set of all four tiers for one class (FR-022), and each
 * tier's company and employee shares must add up to its total, to the cent.
 * Returns the problems found, or an empty list.
 */
export function validateRateSet(tiers: RateTierInput[]): string[] {
  const problems: string[] = [];
  const bands = tiers.map((t) => t.dependentBand).sort();
  if (tiers.length !== 4 || bands.join(",") !== "0,1,2,3") {
    problems.push("A rate needs exactly one entry for each of the four tiers: Employee only, +1, +2 and more than two.");
  }
  for (const t of tiers) {
    const label = bandByNumber(t.dependentBand)?.coverageLabel ?? `band ${t.dependentBand}`;
    const total = toCents(t.totalPremium);
    const company = toCents(t.companyPremium);
    const employee = toCents(t.employeePremium);
    if (total == null || company == null || employee == null) {
      problems.push(`${label}: premiums must be amounts with at most two decimals.`);
      continue;
    }
    if (total < 0 || company < 0 || employee < 0) problems.push(`${label}: premiums cannot be negative.`);
    if (company + employee !== total) {
      problems.push(`${label}: company premium plus employee premium must equal the total premium.`);
    }
  }
  return problems;
}
