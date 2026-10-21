/**
 * load-standard-rates: loads the standard rate card into bhi.premium_rates
 * (spec FR-022 to FR-024).
 *
 *   node dist/load-standard-rates.mjs [path/to/premium_rates_standard.csv]
 *   pnpm --filter @workspace/api-server run load:standard-rates
 *
 * Defaults to deploy/db/seed/premium_rates_standard.csv. Every class's four
 * tiers are validated first (all four present, company + employee = total);
 * nothing is written if any set is wrong. Rows already present — same class,
 * tier and effective date — are skipped, so it is safe to run again.
 *
 * Connects like the API, from the POSTGRES_* settings (its own login): rates are ordinary rows,
 * written in the all-companies scope row-level security allows. In production it
 * refuses a file that still carries the TEST VALUES marker: those are
 * placeholders, not the client's rates. Prints counts only.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

async function main(): Promise<void> {
  // Without an argument: the repository's card, from the repo root, from
  // artifacts/api-server (where pnpm runs package scripts), or from the
  // deploy/ folder (db/seed/...).
  const candidates = process.argv[2]
    ? [process.argv[2]]
    : ["deploy/db/seed/premium_rates_standard.csv", "../../deploy/db/seed/premium_rates_standard.csv", "db/seed/premium_rates_standard.csv"];
  const file = path.resolve(candidates.find((c) => existsSync(c)) ?? candidates[0]!);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    console.error(`Cannot read ${file}. Pass the rate card's path as the first argument.`);
    process.exit(2);
  }
  const { databaseConfigProblem } = await import("@workspace/db/connection");
  const problem = databaseConfigProblem();
  if (problem) {
    console.error(problem);
    process.exit(2);
  }
  const { parseRateCard, insertStandardRates } = await import("../lib/standardRates");
  let card: ReturnType<typeof parseRateCard>;
  try {
    card = parseRateCard(text);
  } catch (err) {
    console.error(`The rate card is not valid; nothing was loaded.\n${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (card.testValues && process.env["NODE_ENV"] === "production") {
    console.error("This file still carries the TEST VALUES marker. Replace it with the client's rate card before loading it in production.");
    process.exit(1);
  }
  if (card.testValues) console.warn("Loading TEST VALUES — placeholders, not the client's rates.");

  const { SYSTEM_SCOPE, pool, withScope } = await import("@workspace/db");
  try {
    const result = await withScope(SYSTEM_SCOPE, (tx) =>
      insertStandardRates(tx, card.sets, card.testValues ? "TEST VALUES — standard rate card" : "Standard rate card"),
    );
    console.log(
      `Classes: ${new Set(card.sets.map((s) => s.classCode)).size}, rate sets: ${card.sets.length}. ` +
        `Rows inserted: ${result.inserted}, already present: ${result.skipped}.`,
    );
  } catch (err) {
    const { errorSummary } = await import("../lib/bhiErrors");
    console.error(`Loading failed and was rolled back: ${errorSummary(err)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
