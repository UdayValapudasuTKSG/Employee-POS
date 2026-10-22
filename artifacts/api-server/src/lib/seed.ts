/**
 * Demo data for the shared BHI model, and the production first-admin bootstrap.
 *
 * SYNTHETIC DATA ONLY (Constitution: no production data outside production).
 * Seeds when schema "bhi" holds no company and DEMO_SEED allows it:
 *
 *   - the six Beharry companies, plus "Sterling Test" (ST), another client, so
 *     segregation can be shown;
 *   - members in classes A, B and C, with dependants (0–7, so every premium
 *     tier appears), beneficiaries, policies and class history;
 *   - edge cases: five BF members sharing one phone (choose-your-record after
 *     verification), a contact shared between BF and ST (the multi-company
 *     message), inactive members, over-65 members for the age sweep, an
 *     expired policy;
 *   - one login per role, password Demo@2026.
 */
import { count, eq } from "drizzle-orm";
import {
  db,
  adminUsersTable,
  activityLogTable,
  bhiBeneficiaryTable,
  bhiCompanyTable,
  bhiDependentTable,
  bhiMemberTable,
  memberClassHistoryTable,
  policyMembershipsTable,
  withScope,
  SYSTEM_SCOPE,
} from "@workspace/db";
import { hashPassword } from "./auth";
import { logger } from "./logger";
import { RETIREMENT_AGE } from "./retirement";
import { DEMO_STANDARD_RATES_CSV, insertStandardRates, parseRateCard } from "./standardRates";

// Deterministic seeded RNG (mulberry32), so every fresh demo database is the same.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(20260929);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;
const rint = (min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));
const pad = (n: number, width: number): string => n.toString().padStart(width, "0");

const FIRST_NAMES = [
  "Aaron", "Bibi", "Chandra", "Devon", "Esther", "Farouk", "Gita", "Harold",
  "Indira", "Jason", "Kamla", "Leon", "Meena", "Navin", "Onika", "Pooran",
  "Quincy", "Rohini", "Sunil", "Tricia", "Uma", "Vishal", "Wendy", "Xavier",
  "Yolanda", "Zaheer", "Anita", "Brian", "Carmen", "Dinesh",
] as const;
const LAST_NAMES = [
  "Persaud", "Singh", "Ramkissoon", "DeSouza", "Benjamin", "Ali", "Khan",
  "Grant", "Fernandes", "Boodram", "Cummings", "Jagdeo", "Lewis", "Mohamed",
  "Narine", "Ousman", "Pierre", "Rodrigues", "Sampson", "Thomas",
] as const;

// Dates of birth derived from the retirement rule, so ordinary members stay
// inside cover whatever year the demo runs; two are deliberately past it.
const SEED_YEAR = new Date().getFullYear();
const OLDEST_WORKING_BIRTH_YEAR = SEED_YEAR - (RETIREMENT_AGE - 1);
const YOUNGEST_WORKING_BIRTH_YEAR = SEED_YEAR - 24;
const AGED_OUT_DATE_OF_BIRTH = `${SEED_YEAR - (RETIREMENT_AGE + 1)}-03-14`;

const BEHARRY = [
  { code: "BF", name: "Beharry Foods Ltd", memberCount: 30 },
  { code: "BA", name: "Beharry Automotive Ltd", memberCount: 25 },
  { code: "BL", name: "Beharry Logistics Ltd", memberCount: 20 },
  { code: "BR", name: "Beharry Retail Group", memberCount: 18 },
  { code: "BM", name: "Beharry Manufacturing Ltd", memberCount: 15 },
  { code: "BS", name: "Beharry Shipping & Trade", memberCount: 12 },
];
const STERLING = { code: "ST", name: "Sterling Test", memberCount: 10 };

const DEMO_PASSWORD = "Demo@2026";
const SHARED_PHONE = "+5925550123"; // five BF members: choose your record after verification
const CROSS_COMPANY_EMAIL = "shared.contact@bhi-demo.test"; // one BF member and one ST member

/**
 * Named test employees: real people's inboxes on synthetic member records, so
 * they can sign in with a real emailed code and try the card and discounts.
 * Members of Beharry Foods, each with a policy. Unlike the rest of the demo
 * data they are added on every start when missing, so an existing demo
 * database picks them up without a reset. Names are placeholders — change them
 * here or in the admin portal.
 */
const TEST_EMPLOYEES = [
  { email: "olaiwon@beharrygroup.com", firstName: "Olaiwon", lastName: "Test" },
  { email: "anand@beharrygroup.com", firstName: "Anand", lastName: "Test" },
  { email: "rdatla@beharrygroup.com", firstName: "R.", lastName: "Datla" },
  { email: "udaykumarvalapudasu@gmail.com", firstName: "Uday Kumar", lastName: "Valapudasu" },
] as const;
const TEST_EMPLOYEE_COMPANY = "BF";

async function ensureTestEmployees(): Promise<void> {
  const added = await withScope(SYSTEM_SCOPE, async (tx) => {
    const [company] = await tx
      .select({ companyNumber: bhiCompanyTable.companyNumber })
      .from(bhiCompanyTable)
      .where(eq(bhiCompanyTable.companyNumber, TEST_EMPLOYEE_COMPANY));
    if (!company) return [];
    const out: string[] = [];
    for (const [i, t] of TEST_EMPLOYEES.entries()) {
      const [existing] = await tx
        .select({ memberId: bhiMemberTable.memberId })
        .from(bhiMemberTable)
        .where(eq(bhiMemberTable.email, t.email));
      if (existing) continue;
      const n = i + 1;
      const [member] = await tx
        .insert(bhiMemberTable)
        .values({
          companyNumber: TEST_EMPLOYEE_COMPANY,
          idType: "NATIONAL ID",
          idNumber: `SYN-TEST-${pad(n, 4)}`,
          firstName: t.firstName,
          lastName: t.lastName,
          dateOfBirth: `${SEED_YEAR - 35}-06-${pad(10 + n, 2)}`,
          sex: "M",
          classCode: "B",
          email: t.email,
          phone: null,
          occupation: "Manager",
          employmentDate: "2020-01-01",
          planDate: "2026-01-01",
          active: true,
        })
        .returning();
      await tx.insert(memberClassHistoryTable).values({
        memberId: member!.memberId,
        classCode: "B",
        recordedBy: "SEED",
        recordedAt: new Date("2026-01-01T04:00:00Z"),
      });
      await tx.insert(policyMembershipsTable).values({
        memberRef: member!.memberId,
        policyholder: "Edward B. Beharry & Company Ltd",
        policyNumber: `POL-2026-TEST${pad(n, 2)}`,
        groupNumber: `GRP-${TEST_EMPLOYEE_COMPANY}-01`,
        memberNumber: `M-TEST${pad(n, 2)}`,
        certificateNumber: `CERT-${TEST_EMPLOYEE_COMPANY}-TEST${pad(n, 2)}`,
        planName: "Group Health Standard",
        effectiveDate: "2026-01-01",
        expiryDate: "2026-12-31",
        insurerName: "North American Life Insurance Co. Ltd.",
      });
      out.push(t.email);
    }
    return out;
  });
  if (added.length > 0) logger.info({ added }, "Added test employees");
}

/**
 * Demo seeding runs only outside production, or when DEMO_SEED=true is set
 * explicitly. In production without DEMO_SEED, an initial super admin is
 * bootstrapped from ADMIN_EMAIL / ADMIN_PASSWORD instead — no default demo
 * credentials ever reach a production database.
 */
function isDemoSeedEnabled(): boolean {
  if (process.env["DEMO_SEED"] === "true") return true;
  if (process.env["DEMO_SEED"] === "false") return false;
  return process.env["NODE_ENV"] !== "production";
}

async function bootstrapProductionAdmin(): Promise<void> {
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(adminUsersTable);
  if (n > 0) return;
  const email = process.env["ADMIN_EMAIL"];
  const password = process.env["ADMIN_PASSWORD"];
  if (!email || !password) {
    logger.warn(
      "No admin accounts exist and ADMIN_EMAIL/ADMIN_PASSWORD are not set — the admin portal has no usable login. Set them and restart to bootstrap the first administrator.",
    );
    return;
  }
  await db.insert(adminUsersTable).values({
    email: email.toLowerCase(),
    displayName: "Administrator",
    // A super admin: PLATFORM_MANAGE can only be granted by an account that
    // already holds it, and it is what onboards every company.
    role: "ROLE_PLATFORM_ADMIN",
    companyScope: null,
    passwordHash: hashPassword(password),
  });
  logger.info({ email }, "Bootstrapped initial super admin from ADMIN_EMAIL");
}

export async function seedIfEmpty(): Promise<void> {
  if (!isDemoSeedEnabled()) {
    await bootstrapProductionAdmin();
    return;
  }
  // A class can be given to members only once its four standard tiers are
  // priced. The demo carries the placeholder card from
  // deploy/db/seed/premium_rates_standard.csv; loading it again skips what is
  // there, so an older demo database gets it too.
  await withScope(SYSTEM_SCOPE, (tx) =>
    insertStandardRates(tx, parseRateCard(DEMO_STANDARD_RATES_CSV).sets, "TEST VALUES — demo rate card"),
  );
  const [{ n } = { n: 0 }] = await withScope(SYSTEM_SCOPE, (tx) =>
    tx.select({ n: count() }).from(bhiCompanyTable),
  );
  if (n > 0) {
    await ensureTestEmployees();
    await logStartupInfo();
    return;
  }
  logger.info("Seeding BHI demo data (deterministic seed 20260929)...");

  const summary = await withScope(SYSTEM_SCOPE, async (tx) => {
    for (const c of [...BEHARRY, STERLING]) {
      await tx.insert(bhiCompanyTable).values({ companyNumber: c.code, companyName: c.name, active: true });
    }

    let seq = 1000;
    let polSeq = 10_000;
    const members: { memberId: number; companyCode: string }[] = [];
    for (const c of [...BEHARRY, STERLING]) {
      const usedNames = new Set<string>();
      for (let i = 0; i < c.memberCount; i++) {
        seq += rint(1, 3);
        let firstName = pick(FIRST_NAMES);
        let lastName = pick(LAST_NAMES);
        for (let attempt = 0; usedNames.has(`${firstName} ${lastName}`) && attempt < 200; attempt++) {
          firstName = pick(FIRST_NAMES);
          lastName = pick(LAST_NAMES);
        }
        usedNames.add(`${firstName} ${lastName}`);

        const dobYear = rint(OLDEST_WORKING_BIRTH_YEAR, YOUNGEST_WORKING_BIRTH_YEAR);
        const randomDob = `${dobYear}-${pad(rint(1, 12), 2)}-${pad(rint(1, 28), 2)}`;
        const agedOut = (c.code === "BR" && i === 3) || (c.code === "BF" && i === 12);
        const inactive =
          (c.code === "BR" && i < 3) || (c.code === "BM" && i < 2) || (c.code === "BS" && i === 0);
        const sharedPhone = c.code === "BF" && i < 5;
        const crossCompany = (c.code === "BF" && i === 20) || (c.code === "ST" && i === 0);
        const noEmail = c.code === "BA" && i === 3;
        const classCode = pick(["A", "B", "B", "C", "C", "C"] as const);
        const randomPhone = `+5926${pad(rint(10, 99), 2)}${pad(rint(0, 9999), 4)}`;

        const [member] = await tx
          .insert(bhiMemberTable)
          .values({
            companyNumber: c.code,
            idType: "NATIONAL ID",
            idNumber: `SYN-${pad(seq * 7919, 9)}`,
            firstName,
            lastName,
            dateOfBirth: agedOut ? AGED_OUT_DATE_OF_BIRTH : randomDob,
            sex: pick(["M", "F"] as const),
            classCode,
            email: crossCompany
              ? CROSS_COMPANY_EMAIL
              : noEmail
                ? null
                : `${firstName.toLowerCase()}.${lastName.toLowerCase()}${seq}@bhi-demo.test`,
            phone: sharedPhone ? SHARED_PHONE : randomPhone,
            occupation: pick(["Clerk", "Driver", "Supervisor", "Technician", "Manager", "Sales associate"] as const),
            employmentDate: `${rint(2005, 2025)}-${pad(rint(1, 12), 2)}-01`,
            planDate: "2026-01-01",
            active: !inactive,
            inactiveDate: inactive ? "2026-05-15" : null,
            inactiveReason: inactive ? (c.code === "BM" ? "Suspended: pending HR review" : "Left the company") : null,
          })
          .returning();
        await tx.insert(memberClassHistoryTable).values({
          memberId: member!.memberId,
          classCode,
          recordedBy: "SEED",
          recordedAt: new Date("2026-01-01T04:00:00Z"),
        });
        members.push({ memberId: member!.memberId, companyCode: c.code });

        polSeq += rint(1, 4);
        const expiredPolicy = c.code === "BM" && i >= 2 && i < 4;
        await tx.insert(policyMembershipsTable).values({
          memberRef: member!.memberId,
          policyholder: c.code === "ST" ? "Sterling Test Ltd" : "Edward B. Beharry & Company Ltd",
          policyNumber: `POL-2026-${pad(polSeq, 5)}`,
          groupNumber: `GRP-${c.code}-01`,
          memberNumber: `M-${pad(seq, 6)}`,
          certificateNumber: `CERT-${c.code}-${pad(seq, 5)}`,
          planName: pick(["Group Health Standard", "Group Health Plus", "Executive Care"] as const),
          effectiveDate: "2026-01-01",
          expiryDate: expiredPolicy ? "2026-06-30" : "2026-12-31",
          insurerName: "North American Life Insurance Co. Ltd.",
        });

        // 0–4 dependants, and one BF member with 7 so the "more than two" tier shows.
        const depCount = c.code === "BF" && i === 6 ? 7 : rint(0, 4);
        for (let d = 0; d < depCount; d++) {
          // Son or daughter from the ids, not the random stream, so every later
          // generated name (and the demo lookups that use them) stays the same.
          const rel = d === 0 && rng() < 0.5 ? "SPOUSE" : (member!.memberId + d) % 2 === 0 ? "SON" : "DAUGHTER";
          await tx.insert(bhiDependentTable).values({
            memberId: member!.memberId,
            dependentFullName: `${pick(FIRST_NAMES)} ${lastName}`,
            relationship: rel,
            dateOfBirth:
              rel === "SPOUSE"
                ? `${rint(1965, 2000)}-${pad(rint(1, 12), 2)}-${pad(rint(1, 28), 2)}`
                : `${rint(2005, 2025)}-${pad(rint(1, 12), 2)}-${pad(rint(1, 28), 2)}`,
            active: !(c.code === "BR" && i === 5 && d === 0),
            inactiveDate: c.code === "BR" && i === 5 && d === 0 ? "2026-04-01" : null,
            inactiveReason: c.code === "BR" && i === 5 && d === 0 ? "No longer a dependant" : null,
          });
        }

        const benCount = rint(0, 2);
        for (let b = 0; b < benCount; b++) {
          await tx.insert(bhiBeneficiaryTable).values({
            memberId: member!.memberId,
            beneficiaryFullName: `${pick(FIRST_NAMES)} ${lastName}`,
            relationship: b === 0 && rng() < 0.6 ? "SPOUSE" : pick(["CHILD", "PARENT", "SIBLING", "OTHER"] as const),
            sharePercent: benCount === 2 ? (b === 0 ? "60" : "40") : "100",
            active: true,
          });
        }
      }
    }

    const admins = [
      { email: "platform.admin@bhi-demo.test", displayName: "Priya Platform", role: "ROLE_PLATFORM_ADMIN" as const },
      { email: "client.foods@bhi-demo.test", displayName: "Grace Foods Client Admin", role: "ROLE_CLIENT_ADMIN" as const, companyScope: "BF" },
      { email: "hr.foods@bhi-demo.test", displayName: "Hansraj Foods HR", role: "ROLE_HR_ADMIN" as const, companyScope: "BF" },
      { email: "hr.auto@bhi-demo.test", displayName: "Anila Automotive HR", role: "ROLE_HR_ADMIN" as const, companyScope: "BA" },
      { email: "client.admin@st.test", displayName: "Sterling Client Admin", role: "ROLE_CLIENT_ADMIN" as const, companyScope: "ST" },
      { email: "hr@st.test", displayName: "Sterling HR", role: "ROLE_HR_ADMIN" as const, companyScope: "ST" },
      { email: "support@bhi-demo.test", displayName: "Samir Support", role: "ROLE_SUPPORT" as const },
      { email: "auditor@bhi-demo.test", displayName: "Aria Auditor", role: "ROLE_AUDITOR" as const },
    ];
    for (const a of admins) {
      await tx.insert(adminUsersTable).values({
        companyScope: null,
        ...a,
        passwordHash: hashPassword(DEMO_PASSWORD),
      });
    }

    const actions = ["MEMBER_UPDATED", "MEMBER_DEACTIVATED", "MEMBER_REACTIVATED", "DEPENDENT_UPDATED", "LOGIN"];
    for (let i = 0; i < 40; i++) {
      const m = pick(members);
      const action = pick(actions);
      const actor = pick(admins);
      await tx.insert(activityLogTable).values({
        kind: "AUDIT",
        actor: actor.email,
        actorRole: actor.role,
        action,
        entityType: action === "LOGIN" ? "ADMIN_USER" : action.startsWith("DEPENDENT") ? "DEPENDENT" : "MEMBER",
        entityId: String(m.memberId),
        reason: action === "LOGIN" ? null : "Seeded historical entry",
        companyCode: m.companyCode,
        timestamp: new Date(Date.now() - rint(1, 60) * 86_400_000),
      });
    }
    return { members: members.length };
  });

  logger.info(summary, "Seed complete");
  await ensureTestEmployees();
  await logStartupInfo();
}

async function logStartupInfo(): Promise<void> {
  const admins = await db.select().from(adminUsersTable);
  const sample = await withScope(SYSTEM_SCOPE, (tx) =>
    tx.select({ email: bhiMemberTable.email }).from(bhiMemberTable).where(eq(bhiMemberTable.active, true)).limit(1),
  );
  logger.info(
    {
      adminLogins: admins.map((a) => `${a.email} (${a.role})`),
      adminPassword: DEMO_PASSWORD,
      sampleLookups: [
        ...(sample[0]?.email ? [`email: ${sample[0].email}`] : []),
        `shared phone, one company (choose record): ${SHARED_PHONE}`,
        `shared email, two companies (contact HR): ${CROSS_COMPANY_EMAIL}`,
        ...TEST_EMPLOYEES.map((t) => `test employee (real inbox): ${t.email}`),
      ],
    },
    "BHI demo credentials",
  );
}
