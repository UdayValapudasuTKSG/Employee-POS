/**
 * The employees the app starts with. Runs on every start, against any
 * database: whoever is missing is added, nobody already there is touched. So a
 * brand-new database has them from its first start, and an edit in the admin
 * data is never overwritten.
 *
 * SEED_EMPLOYEES=false turns the named employees off; SEED_DEMO_EMPLOYEES=true
 * also adds made-up ones on @example.test for local testing.
 */
import { config } from "./config";
import { pool } from "./db";
import { logger } from "./log";

interface SeedEmployee {
  email: string;
  firstName: string;
  lastName: string;
  employeeNumber?: string;
  company?: string;
}

/** Real inboxes. Names are placeholders: correct them here or in the database. */
export const EMPLOYEES: SeedEmployee[] = [
  { email: "olaiwon@beharrygroup.com", firstName: "Olaiwon", lastName: "Test", employeeNumber: "BEH-0001" },
  { email: "anand@beharrygroup.com", firstName: "Anand", lastName: "Test", employeeNumber: "BEH-0002" },
  { email: "rdatla@beharrygroup.com", firstName: "R.", lastName: "Datla", employeeNumber: "BEH-0003" },
  { email: "udaykumarvalapudasu@gmail.com", firstName: "Uday Kumar", lastName: "Valapudasu", employeeNumber: "BEH-0004" },
];

/** Made-up employees for testing with OTP_DEV_MODE. Their inboxes do not exist. */
const DEMO_EMPLOYEES: SeedEmployee[] = [
  { email: "asha.persaud@example.test", firstName: "Asha", lastName: "Persaud", employeeNumber: "DEMO-01" },
  { email: "devon.singh@example.test", firstName: "Devon", lastName: "Singh", employeeNumber: "DEMO-02" },
  { email: "kamla.ramdass@example.test", firstName: "Kamla", lastName: "Ramdass", employeeNumber: "DEMO-03" },
  { email: "marcus.fernandes@example.test", firstName: "Marcus", lastName: "Fernandes", employeeNumber: "DEMO-04" },
  { email: "nadia.khan@example.test", firstName: "Nadia", lastName: "Khan", employeeNumber: "DEMO-05" },
  { email: "tremaine.lewis@example.test", firstName: "Tremaine", lastName: "Lewis", employeeNumber: "DEMO-06" },
];

export async function seed(): Promise<void> {
  const list = [...(config.seedEmployees ? EMPLOYEES : []), ...(config.seedDemoEmployees ? DEMO_EMPLOYEES : [])];
  const added: string[] = [];
  for (const e of list) {
    const r = await pool.query(
      `INSERT INTO employees (email, first_name, last_name, employee_number, company)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'Edward B. Beharry & Company Ltd'))
       ON CONFLICT (email) DO NOTHING`,
      [e.email.toLowerCase().trim(), e.firstName, e.lastName, e.employeeNumber ?? null, e.company ?? null],
    );
    if (r.rowCount) added.push(e.email);
  }
  if (added.length) logger.info("Seeded employees", { added });
}
