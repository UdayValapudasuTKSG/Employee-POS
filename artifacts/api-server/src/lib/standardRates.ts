/**
 * The standard rate card: the rates every company pays unless it has its own
 * (spec FR-022 to FR-024).
 *
 * Read from deploy/db/seed/premium_rates_standard.csv by load-standard-rates,
 * and embedded below for the demo seed and the tests, which have no repository
 * checkout at run time. standardRates.test.ts keeps the two identical.
 */
// Types only at load: the parsing here is used without a database (unit tests).
import type { ScopedTx } from "@workspace/db";
import { bandByNumber, validateRateSet, type RateTierInput } from "./rateBands";

/** The marker line that says the file still holds placeholder values. */
export const TEST_VALUES_MARKER = "TEST VALUES";

export interface RateSet {
  classCode: string;
  effectiveDate: string;
  tiers: (RateTierInput & { dependentBand: 0 | 1 | 2 | 3 })[];
}

export interface ParsedRateCard {
  sets: RateSet[];
  /** True when a comment line carries TEST_VALUES_MARKER. */
  testValues: boolean;
}

const HEADER = ["class_code", "dependent_band", "total_premium", "company_premium", "employee_premium", "effective_date"];

/**
 * Parses the CSV into one set per class and effective date, each validated as
 * a complete four-tier set. Throws with every problem found.
 */
export function parseRateCard(text: string): ParsedRateCard {
  const lines = text.replace(/\r/g, "").split("\n");
  const testValues = lines.some((l) => l.startsWith("#") && l.includes(TEST_VALUES_MARKER));
  const rows = lines.filter((l) => l.trim() !== "" && !l.startsWith("#"));
  const header = rows.shift()?.split(",").map((h) => h.trim().toLowerCase());
  if (!header || header.join(",") !== HEADER.join(",")) {
    throw new Error(`The rate card's header must be: ${HEADER.join(",")}`);
  }
  const problems: string[] = [];
  const byKey = new Map<string, RateSet>();
  rows.forEach((line, i) => {
    const cells = line.split(",").map((c) => c.trim());
    if (cells.length !== HEADER.length) {
      problems.push(`Line ${i + 2}: expected ${HEADER.length} columns.`);
      return;
    }
    const [classCode, band, total, company, employee, effectiveDate] = cells as [string, string, string, string, string, string];
    if (!/^[A-Z0-9]$/.test(classCode.toUpperCase())) problems.push(`Line ${i + 2}: "${classCode}" is not a class code.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) problems.push(`Line ${i + 2}: "${effectiveDate}" is not a YYYY-MM-DD date.`);
    const key = `${classCode.toUpperCase()}|${effectiveDate}`;
    const set = byKey.get(key) ?? { classCode: classCode.toUpperCase(), effectiveDate, tiers: [] };
    set.tiers.push({
      dependentBand: Number(band) as 0 | 1 | 2 | 3,
      totalPremium: total,
      companyPremium: company,
      employeePremium: employee,
    });
    byKey.set(key, set);
  });
  for (const set of byKey.values()) {
    for (const p of validateRateSet(set.tiers)) problems.push(`Class ${set.classCode} from ${set.effectiveDate}: ${p}`);
  }
  if (problems.length) throw new Error(problems.join("\n"));
  return { sets: [...byKey.values()], testValues };
}

/**
 * Inserts standard rate sets, skipping any tier already present (the unique
 * key is company, class, band and effective date). Needs the all-companies
 * write scope. Returns how many rows were inserted and skipped.
 */
export async function insertStandardRates(
  tx: ScopedTx,
  sets: RateSet[],
  notes = "Standard rate card",
): Promise<{ inserted: number; skipped: number }> {
  const { bhiPremiumRatesTable } = await import("@workspace/db");
  let inserted = 0;
  let skipped = 0;
  for (const set of sets) {
    for (const t of set.tiers) {
      const band = bandByNumber(t.dependentBand)!;
      const rows = await tx
        .insert(bhiPremiumRatesTable)
        .values({
          companyNumber: null,
          classCode: set.classCode,
          coverageBand: band.coverageBand,
          coverageLabel: band.coverageLabel,
          dependentBand: band.dependentBand,
          totalPremium: String(t.totalPremium),
          companyPremium: String(t.companyPremium),
          employeePremium: String(t.employeePremium),
          effectiveDate: set.effectiveDate,
          active: true,
          notes,
        })
        .onConflictDoNothing()
        .returning({ id: bhiPremiumRatesTable.premiumRateId });
      if (rows.length) inserted++;
      else skipped++;
    }
  }
  return { inserted, skipped };
}

/**
 * The placeholder card from premium_rates_standard.csv, for the demo seed and
 * the tests. NOT the client's rates.
 */
export const DEMO_STANDARD_RATES_CSV = `# ${TEST_VALUES_MARKER} - demo and test only
class_code,dependent_band,total_premium,company_premium,employee_premium,effective_date
A,0,5000.00,4000.00,1000.00,2026-10-01
A,1,9000.00,7200.00,1800.00,2026-10-01
A,2,12000.00,9600.00,2400.00,2026-10-01
A,3,14000.00,11200.00,2800.00,2026-10-01
B,0,4000.00,3200.00,800.00,2026-10-01
B,1,7000.00,5600.00,1400.00,2026-10-01
B,2,9500.00,7600.00,1900.00,2026-10-01
B,3,11000.00,8800.00,2200.00,2026-10-01
C,0,3000.00,2400.00,600.00,2026-10-01
C,1,5500.00,4400.00,1100.00,2026-10-01
C,2,7500.00,6000.00,1500.00,2026-10-01
C,3,9000.00,7200.00,1800.00,2026-10-01
`;
