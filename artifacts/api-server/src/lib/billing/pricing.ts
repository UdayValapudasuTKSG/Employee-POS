/**
 * Pricing a member for a month: pure rules, no database (research R11, R12).
 *
 * - The bill for month M reflects the state at T, 00:00 on the 1st of M in
 *   Guyana (UTC−4).
 * - The tier is min(active dependants, 3): every dependant costs the same, and
 *   more than two is a flat rate.
 * - The rate is the company's own for the class and tier with the latest
 *   effective date on or before date(T), else the standard rate chosen the same
 *   way. Inactive rates never count.
 * - The split is the rate's own company and employee amounts, unless the
 *   company has an active billing rule in force at date(T): then the company
 *   pays round(total × CompanySharePercent / 100, 2) and the employee the
 *   rest — which is total × EmployeeSharePercent / 100 to the cent, because a
 *   rule's two shares always total 100 (checked on entry and by the database,
 *   migration 007). Taking the employee's part as the remainder means the two
 *   amounts can never drift a cent from the total through rounding.
 */
import { monthFirstDay, monthStartUtc } from "../guyanaTime";
import { centsToMoney, toCents } from "../rateBands";

export { tierFor } from "../rateBands";

/** T for month "YYYY-MM": 00:00 on its 1st, Guyana time, as a UTC instant. */
export function monthStart(month: string): Date {
  return monthStartUtc(month);
}

/** date(T) for month "YYYY-MM": its 1st, YYYY-MM-DD. */
export function monthDate(month: string): string {
  return monthFirstDay(month);
}

export interface RateRow {
  premiumRateId: number;
  companyNumber: string | null;
  classCode: string;
  dependentBand: number;
  coverageBand: string;
  coverageLabel: string;
  totalPremium: string;
  companyPremium: string;
  employeePremium: string;
  effectiveDate: string;
  active: boolean;
}

export interface BillingRuleRow {
  companySharePercent: string;
  employeeSharePercent: string;
  effectiveDate: string;
  active: boolean;
}

const latest = <T extends { effectiveDate: string }>(rows: T[], tieBreak: (a: T, b: T) => number) =>
  [...rows].sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : a.effectiveDate > b.effectiveDate ? -1 : tieBreak(a, b)))[0] ?? null;

/** The rate for a class and tier on `asOf` (YYYY-MM-DD): company first, then standard; null if neither. */
export function chooseRate(
  rates: RateRow[],
  q: { companyNumber: string; classCode: string; band: number; asOf: string },
): (RateRow & { source: "COMPANY" | "STANDARD" }) | null {
  const candidates = rates.filter(
    (r) => r.active && r.classCode === q.classCode && r.dependentBand === q.band && r.effectiveDate <= q.asOf,
  );
  const newestFirst = (a: RateRow, b: RateRow) => b.premiumRateId - a.premiumRateId;
  const company = latest(candidates.filter((r) => r.companyNumber === q.companyNumber), newestFirst);
  if (company) return { ...company, source: "COMPANY" };
  const standard = latest(candidates.filter((r) => r.companyNumber === null), newestFirst);
  return standard ? { ...standard, source: "STANDARD" } : null;
}

/** The billing rule in force on `asOf`, or null. */
export function chooseRule<T extends BillingRuleRow>(rules: T[], asOf: string): T | null {
  return latest(rules.filter((r) => r.active && r.effectiveDate <= asOf), () => 0);
}

/** Company and employee premiums for a rate, under a billing rule or the rate's own split. */
export function split(
  rate: Pick<RateRow, "totalPremium" | "companyPremium" | "employeePremium">,
  rule: Pick<BillingRuleRow, "companySharePercent" | "employeeSharePercent"> | null,
): { totalPremium: string; companyPremium: string; employeePremium: string } {
  const total = toCents(rate.totalPremium);
  if (total == null) throw new Error(`Not an amount: ${rate.totalPremium}`);
  if (!rule) {
    return { totalPremium: centsToMoney(total), companyPremium: centsToMoney(toCents(rate.companyPremium)!), employeePremium: centsToMoney(toCents(rate.employeePremium)!) };
  }
  const share = toCents(rule.companySharePercent); // hundredths of a percent
  const employeeShare = toCents(rule.employeeSharePercent);
  if (share == null) throw new Error(`Not a share: ${rule.companySharePercent}`);
  if (employeeShare == null) throw new Error(`Not a share: ${rule.employeeSharePercent}`);
  if (share + employeeShare !== 10_000) {
    throw new Error(`A billing rule's shares must total 100: ${rule.companySharePercent} + ${rule.employeeSharePercent}`);
  }
  // total cents × share / 10000, rounded half away from zero, in integers.
  const company = Math.round((total * share) / 10_000);
  return { totalPremium: centsToMoney(total), companyPremium: centsToMoney(company), employeePremium: centsToMoney(total - company) };
}
