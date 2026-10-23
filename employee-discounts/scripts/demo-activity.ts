/**
 * Sample activity for trying the admin dashboard. LOCAL TESTING ONLY.
 *
 *   npx tsx --env-file=.env scripts/demo-activity.ts           add six months of sample use
 *   npx tsx --env-file=.env scripts/demo-activity.ts --remove  take every bit of it out again
 *
 * Touches only made-up employees on @example.test: it adds 30 of them, and
 * codes, redemptions and sign-ins for them, every row recognisable (employee
 * numbers DEMO-…, POS references DEMO-…, session hashes demo-…). Real
 * employees and their codes are never read or written. Refuses to run with
 * NODE_ENV=production.
 */
import { randomBytes } from "node:crypto";
import { config } from "../server/config";
import { pool } from "../server/db";
import { STORES, currentMonth, monthWindow, type Store } from "../server/rules";

if (config.isProduction) {
  console.error("Refusing to add sample data with NODE_ENV=production.");
  process.exit(1);
}

// Deterministic, so two runs give the same picture.
let seed = 20261023;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const between = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T>(xs: readonly T[], weights: number[]): T => {
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rnd() * total;
  for (let i = 0; i < xs.length; i++) if ((r -= weights[i]!) <= 0) return xs[i]!;
  return xs[xs.length - 1]!;
};

const FIRST = ["Aaliyah", "Brandon", "Chandra", "Deon", "Esther", "Faizal", "Gail", "Hemraj", "Indira", "Jamal", "Kezia", "Lionel", "Marissa", "Nikhil", "Odessa", "Pradeep", "Quincy", "Rena", "Shawn", "Tara", "Usha", "Vernon", "Wendy", "Xavier", "Yasmin", "Zane", "Alicia", "Bharat", "Cleon", "Davina"];
const LAST = ["Persaud", "Singh", "Ramdass", "Fernandes", "Khan", "Lewis", "Benjamin", "Mohamed", "Narine", "Thomas"];

/** Bill ranges (GYD) and how often each store sees staff. */
const STORE_MIX: Record<Store, { weight: number; bill: [number, number] }> = {
  KFC: { weight: 40, bill: [1500, 9000] },
  PIZZA_HUT: { weight: 30, bill: [3000, 14000] },
  STERLING: { weight: 15, bill: [800, 6000] },
  BEHARRY: { weight: 15, bill: [2000, 25000] },
};
/** Busy at lunch and after work, in Guyana hours. */
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const HOUR_WEIGHT = HOURS.map((h) => (h < 8 || h > 21 ? 0 : h >= 11 && h <= 13 ? 8 : h >= 17 && h <= 19 ? 7 : 2));

async function remove(): Promise<void> {
  const demo = "SELECT id FROM employees WHERE email LIKE '%@example.test' AND employee_number LIKE 'DEMO-%'";
  const c = await pool.query(`DELETE FROM discount_codes WHERE pos_reference LIKE 'DEMO-%' OR (employee_id IN (${demo}) AND code_enc = 'demo')`);
  const s = await pool.query(`DELETE FROM sessions WHERE token_hash LIKE 'demo-%'`);
  const e = await pool.query(
    `DELETE FROM employees WHERE email LIKE 'demo.%@example.test' AND employee_number LIKE 'DEMO-%'
       AND NOT EXISTS (SELECT 1 FROM discount_codes d WHERE d.employee_id = employees.id)
       AND NOT EXISTS (SELECT 1 FROM sessions x WHERE x.employee_id = employees.id)
       AND NOT EXISTS (SELECT 1 FROM otp_challenges o WHERE o.employee_id = employees.id)`,
  );
  console.log(`Removed ${c.rowCount} sample codes, ${s.rowCount} sample sign-ins and ${e.rowCount} sample employees.`);
}

async function add(): Promise<void> {
  const existing = await pool.query("SELECT count(*)::int AS n FROM discount_codes WHERE pos_reference LIKE 'DEMO-%'");
  if (existing.rows[0].n > 0) {
    console.log("Sample activity is already there. Run with --remove first to start again.");
    return;
  }
  // 30 made-up employees, three of them deactivated.
  for (let i = 0; i < 30; i++) {
    const first = FIRST[i]!;
    const last = LAST[i % LAST.length]!;
    await pool.query(
      `INSERT INTO employees (email, first_name, last_name, employee_number, active) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (email) DO NOTHING`,
      [`demo.${first.toLowerCase()}.${last.toLowerCase()}@example.test`, first, last, `DEMO-${String(i + 101)}`, i < 27],
    );
  }
  const emps = (await pool.query<{ id: number; active: boolean }>("SELECT id, active FROM employees WHERE email LIKE 'demo.%@example.test'")).rows;
  const cap = config.discount.monthlyCapCents;
  const now = Date.now();
  let ref = 0;
  let codes = 0;

  for (let back = 5; back >= 0; back--) {
    const cur = currentMonth();
    const [y, m] = cur.month.split("-").map(Number) as [number, number];
    const d = new Date(Date.UTC(y, m - 1 - back, 1));
    const month = monthWindow(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
    const end = Math.min(month.end.getTime(), now - 60_000);
    // More staff use it as word gets round.
    const reach = 0.45 + (5 - back) * 0.08;

    for (const e of emps) {
      if (!e.active && back < 2) continue;
      if (rnd() > reach) continue;
      // Sign-ins this month.
      await pool.query(
        "INSERT INTO sessions (employee_id, token_hash, created_at, expires_at, revoked_at) VALUES ($1, $2, $3, $3::timestamptz + interval '8 hours', $3::timestamptz + interval '1 hour')",
        [e.id, `demo-${randomBytes(16).toString("hex")}`, new Date(month.start.getTime() + rnd() * (end - month.start.getTime()))],
      );
      let used = 0;
      const visits = between(1, back === 0 ? 4 : 7);
      const times = Array.from({ length: visits }, () => {
        const day = new Date(month.start.getTime() + rnd() * (end - month.start.getTime()));
        const hour = pick(HOURS, HOUR_WEIGHT);
        // Set the Guyana hour (UTC-4) on that day.
        const t = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour + 4, between(0, 59)));
        return Math.min(Math.max(t.getTime(), month.start.getTime() + 60_000), end);
      }).sort((a, b) => a - b);

      for (const at of times) {
        const store = pick(STORES, STORES.map((s) => STORE_MIX[s].weight));
        const billCents = between(STORE_MIX[store].bill[0] / 10, STORE_MIX[store].bill[1] / 10) * 1000;
        const full = Math.round(billCents * 0.1);
        const left = cap - used;
        const created = new Date(at - between(2, 25) * 60_000);
        codes++;
        // About one code in eight is never used.
        if (rnd() < 0.12 || left <= 0) {
          await pool.query(
            `INSERT INTO discount_codes (employee_id, code_hash, code_enc, status, expires_at, created_at)
             VALUES ($1, $2, 'demo', $3, $4::timestamptz + interval '30 minutes', $4)`,
            [e.id, `demo-${randomBytes(16).toString("hex")}`, rnd() < 0.5 ? "EXPIRED" : "REPLACED", created],
          );
          continue;
        }
        const disc = Math.min(full, left);
        const voided = rnd() < 0.03;
        if (!voided) used += disc;
        await pool.query(
          `INSERT INTO discount_codes (employee_id, code_hash, code_enc, discount_percent, status, expires_at, created_at, store, store_location,
                                       pos_reference, redeemed_at, bill_amount, full_discount_amount, discount_amount, voided_at, void_reason)
           VALUES ($1, $2, 'demo', 10, $3, $4::timestamptz + interval '30 minutes', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            e.id, `demo-${randomBytes(16).toString("hex")}`, voided ? "VOIDED" : "REDEEMED", created, store,
            pick(["Camp St", "Vlissengen Rd", "Sheriff St", "Diamond", "Providence"], [3, 2, 2, 1, 1]),
            `DEMO-${++ref}`, new Date(at), (billCents / 100).toFixed(2), (full / 100).toFixed(2), (disc / 100).toFixed(2),
            voided ? new Date(at + 3600_000) : null, voided ? "Order cancelled (sample)" : null,
          ],
        );
      }
    }
  }
  console.log(`Added 30 sample employees, ${codes} sample codes (${ref} used) over six months.`);
}

(process.argv.includes("--remove") ? remove() : add())
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
