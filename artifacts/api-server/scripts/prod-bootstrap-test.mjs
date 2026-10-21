// Deployment smoke test: a fresh production database must NOT get demo
// accounts or demo data. Without ADMIN_EMAIL/ADMIN_PASSWORD there is no usable
// admin login; with them, exactly one bootstrapped super admin can sign in, and
// that super admin can take the documented fresh-production provisioning path
// (onboard a company, price a class, import a member) to a member the employee
// lookup finds.
//
// Requires, on the same PostgreSQL server:
//   DATABASE_URL      a role that may CREATE DATABASE (and CREATE ROLE, if
//                     bhi_app does not exist yet). A scratch database
//                     "bhi_smoke" is dropped and recreated, and deploy/db/schema.sql
//                     plus every deploy/db/migrations file are applied as this
//                     role, which then owns the tables (as bhi_user does).
//   BHI_APP_PASSWORD  the password of the API's own login, bhi_app. The API is
//                     started as bhi_app because in production it refuses a role
//                     that bypasses row-level security. Created when missing.
// Plus a built dist (node ./build.mjs) and psql on PATH.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "../dist/index.mjs");
const root = path.resolve(here, "../../..");

const adminUrl = process.env.DATABASE_URL;
const appPassword = process.env.BHI_APP_PASSWORD;
if (!adminUrl || !appPassword) {
  console.error("Set DATABASE_URL (a role that can create databases) and BHI_APP_PASSWORD (the bhi_app login).");
  process.exit(2);
}

const smokeAdminUrl = (() => {
  const u = new URL(adminUrl);
  u.pathname = "/bhi_smoke";
  return u.toString();
})();
const smokeAppUrl = (() => {
  const u = new URL(smokeAdminUrl);
  u.username = "bhi_app";
  u.password = appPassword;
  return u.toString();
})();

/** Runs psql without a shell, so it works the same on Linux and Windows. */
function psql(url, args, input) {
  try {
    return execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", url, ...args], {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    throw new Error(`psql failed: ${err.stderr || err.message}`);
  }
}

/**
 * One value from the scratch database. The bhi tables FORCE row-level security,
 * which applies to their owner too, so the all-companies scope is set first
 * (as migration 015 does); a superuser skips it either way.
 */
function sql(q) {
  return psql(smokeAdminUrl, ["-t", "-A", "-c", "SET bhi.all = 'on'", "-c", q]);
}

// --- Reset the scratch database and load the packaged schema + migrations ---
psql(adminUrl, ["-c", "DROP DATABASE IF EXISTS bhi_smoke WITH (FORCE)", "-c", "CREATE DATABASE bhi_smoke"]);
// Migration 013 grants bhi_app its rights and stops if the role is missing.
psql(
  adminUrl,
  ["-v", `app_pw=${appPassword}`],
  "SELECT format('CREATE ROLE bhi_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', :'app_pw')\n" +
    " WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bhi_app')\\gexec\n",
);
psql(adminUrl, ["-c", "GRANT CONNECT ON DATABASE bhi_smoke TO bhi_app"]);
psql(smokeAdminUrl, ["-f", path.join(root, "deploy/db/schema.sql")]);
const migrationsDir = path.join(root, "deploy/db/migrations");
for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
  psql(smokeAdminUrl, ["-f", path.join(migrationsDir, f)]);
}

let pass = 0, fail = 0;
function check(name, ok, extra = "") {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

async function bootAndWait(port, extraEnv) {
  const child = spawn(process.execPath, [dist], {
    env: {
      ...process.env,
      DATABASE_URL: smokeAppUrl,
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      OTP_DEV_MODE: "false",
      DEMO_SEED: "false",
      SESSION_SECRET: "prod-bootstrap-test-secret",
      ADMIN_EMAIL: "",
      ADMIN_PASSWORD: "",
      // No OTP delivery provider: phase 3 relies on delivery failing.
      SMTP_HOST: "",
      SMS_WEBHOOK_URL: "",
      ...extraEnv,
    },
    stdio: "ignore",
  });
  let exited = null;
  child.on("exit", (code) => { exited = code; });
  for (let i = 0; i < 30; i++) {
    if (exited !== null) throw new Error(`server exited with code ${exited} (is bhi_app's password right?)`);
    try { await fetch(`http://127.0.0.1:${port}/api/healthz`); return child; }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  child.kill();
  throw new Error("server did not start");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The delivery failure the API logs against a session after answering (routes/employee.ts deliverLater). */
async function deliveryFailure(verificationId, waitMs = 5000) {
  if (!UUID_RE.test(verificationId ?? "")) return null;
  const key = createHash("sha256").update(verificationId).digest("hex").slice(0, 16);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const code = sql(
      `SELECT coalesce(error_code, '') FROM bhi.activity_log WHERE kind = 'EVENT' AND actor = '${key}' ` +
        "AND action = 'OTP_DELIVERY' AND result = 'FAILED' LIMIT 1",
    );
    if (code !== "" || Date.now() > deadline) return code || null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

function matchedCompanies(verificationId) {
  if (!UUID_RE.test(verificationId ?? "")) return null;
  const v = sql(
    "SELECT coalesce(string_agg(e->>'companyNumber', ','), '') FROM bhi.employee_sessions s, " +
      `jsonb_array_elements(s.matched_members) e WHERE s.id = '${verificationId}'`,
  );
  return v === "" ? [] : v.split(",");
}

// --- Phase 1: no ADMIN_EMAIL → zero accounts, no demo data -----------------
let child = await bootAndWait(3975, {});
try {
  await new Promise((r) => setTimeout(r, 1000)); // let seeding settle
  check("no admin accounts on fresh prod DB", sql("SELECT count(*) FROM admin_users") === "0");
  check("no demo companies seeded", sql("SELECT count(*) FROM bhi.company") === "0");
  check("no demo members seeded", sql("SELECT count(*) FROM bhi.member") === "0");
  // The demo seed also loads the demo rate card; a production database starts
  // with none, so no class can be given to a member until one is priced.
  check("no standard rates on fresh prod DB", sql("SELECT count(*) FROM bhi.premium_rates") === "0");
  const login = await fetch("http://127.0.0.1:3975/api/v1/admin/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "group.admin@bhi-demo.test", password: "Demo@2026" }),
  });
  check("demo credentials rejected", login.status === 401 || login.status === 400, `got ${login.status}`);
} finally { child.kill(); }

// --- Phase 2: ADMIN_EMAIL/PASSWORD set → single bootstrapped super admin ----
child = await bootAndWait(3974, { ADMIN_EMAIL: "ops@example.com", ADMIN_PASSWORD: "Str0ng!Pass" });
try {
  await new Promise((r) => setTimeout(r, 1000));
  check("exactly one bootstrapped admin", sql("SELECT count(*) FROM admin_users") === "1");
  check("bootstrapped admin is a super admin", sql("SELECT role FROM admin_users") === "ROLE_PLATFORM_ADMIN");
  const login = await fetch("http://127.0.0.1:3974/api/v1/admin/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ops@example.com", password: "Str0ng!Pass" }),
  });
  check("bootstrapped admin can sign in", login.status === 200, `got ${login.status}`);
} finally { child.kill(); }

// --- Phase 3: documented fresh-production provisioning flow ----------------
// The super admin onboards a company (which also issues its client admin),
// posts a standard rate set for the class the member will carry, and imports
// the member with the carrier Members layout. The employee lookup then finds
// the member. The lookup answers 200 CODE_SENT whether or not anyone matched,
// so "found" is read from the session's matched members and from the delivery
// failure the API logs afterwards: only a real match ever reaches a provider,
// and none is configured here.
child = await bootAndWait(3973, { ADMIN_EMAIL: "ops@example.com", ADMIN_PASSWORD: "Str0ng!Pass" });
try {
  await new Promise((r) => setTimeout(r, 1000));
  const B = "http://127.0.0.1:3973/api";
  const loginRes = await fetch(`${B}/v1/admin/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ops@example.com", password: "Str0ng!Pass" }),
  });
  const loginJson = await loginRes.json().catch(() => ({}));
  const authHeader = { "content-type": "application/json", authorization: `Bearer ${loginJson.token}` };
  const post = async (p, body) => {
    const r = await fetch(`${B}${p}`, { method: "POST", headers: authHeader, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  // 1. Onboard the company. Companies are no longer created by an import.
  const onboard = await post("/v1/admin/companies", {
    companyNumber: "ACME",
    companyName: "Acme Holdings Ltd",
    clientAdmin: { email: "client.admin@acme.example", displayName: "Acme Client Admin" },
    reason: "Production bootstrap smoke test",
  });
  check("super admin onboards a company", onboard.status === 201 && onboard.json.company?.companyNumber === "ACME",
    `got ${onboard.status} ${JSON.stringify(onboard.json)}`);
  check("onboarding issues the company's client admin",
    onboard.json.clientAdmin?.role === "ROLE_CLIENT_ADMIN" && !!onboard.json.temporaryPassword,
    JSON.stringify(onboard.json.clientAdmin ?? null));

  const header = [
    "Company Number", "CompanyName", "IDType", "IDNumber", "LastName", "FirstName", "MiddleInitials",
    "Date Of Birth", "Sex", "ClassCode", "AddressLine1", "AddressLine2", "Phone", "Email", "EmploymentDate",
    "PlanDate", "Rate Of Pay", "Occupation", "Active", "InactiveDate", "InactiveReason", "Notes",
  ];
  const row = {
    "Company Number": "ACME", CompanyName: "Acme Holdings Ltd", IDType: "NATIONAL_ID", IDNumber: "ID12345",
    LastName: "Member", FirstName: "Test", "Date Of Birth": "1990-01-15", Sex: "M", ClassCode: "A",
    Phone: "+5926000001", Email: "test.member@example.com",
  };
  const csv = [header.join(","), header.map((h) => row[h] ?? "").join(",")].join("\n");

  // 2. Before class A is priced, the import refuses to assign it.
  const early = await post("/v1/admin/import", { csvText: csv, dryRun: true });
  check("class without standard rates is refused (UNKNOWN_CLASS)",
    early.status === 200 && early.json.rows?.[0]?.status === "ERROR" && early.json.rows[0].reasonCodes?.includes("UNKNOWN_CLASS"),
    `got ${early.status} ${JSON.stringify(early.json.rows ?? early.json)}`);

  // 3. Price class A on the standard card: all four tiers, company + employee = total.
  const rates = await post("/v1/admin/rates", {
    classCode: "A",
    effectiveDate: `${new Date().getUTCFullYear()}-01-01`,
    tiers: [
      { dependentBand: 0, totalPremium: "100.00", companyPremium: "60.00", employeePremium: "40.00" },
      { dependentBand: 1, totalPremium: "150.00", companyPremium: "90.00", employeePremium: "60.00" },
      { dependentBand: 2, totalPremium: "200.00", companyPremium: "120.00", employeePremium: "80.00" },
      { dependentBand: 3, totalPremium: "250.00", companyPremium: "150.00", employeePremium: "100.00" },
    ],
    notes: "Smoke test values",
    reason: "Production bootstrap smoke test",
  });
  check("super admin posts a standard rate set", rates.status === 201 && rates.json.rates?.length === 4,
    `got ${rates.status} ${JSON.stringify(rates.json)}`);

  // 4. Import the member.
  const imp = await post("/v1/admin/import", { csvText: csv, dryRun: false });
  check("carrier CSV import commits member",
    imp.status === 200 && imp.json.errorCount === 0 && imp.json.committedCount === 1 && imp.json.rows?.[0]?.status === "OK",
    `got ${imp.status} ${JSON.stringify(imp.json.rows ?? imp.json)}`);
  check("member row exists",
    sql("SELECT count(*) FROM bhi.member WHERE email = 'test.member@example.com' AND company_number = 'ACME'") === "1");

  // 5. The employee lookup finds the imported member.
  const lookup = async (identifier) => {
    const r = await fetch(`${B}/v1/lookup`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier }),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const found = await lookup("test.member@example.com");
  const unknown = await lookup("nobody@example.com");
  check("lookup answers 200 CODE_SENT without a code in production",
    found.status === 200 && found.json.status === "CODE_SENT" && found.json.devCode === null,
    `got ${found.status} ${JSON.stringify(found.json)}`);
  check("unknown identifier is refused with 404 CONTACT_NOT_FOUND",
    unknown.status === 404 && unknown.json.error?.code === "CONTACT_NOT_FOUND" && !unknown.json.verificationId,
    `got ${unknown.status} ${JSON.stringify(unknown.json)}`);
  check("lookup matched the imported member", matchedCompanies(found.json.verificationId)?.join() === "ACME",
    `matched ${JSON.stringify(matchedCompanies(found.json.verificationId))}`);
  const failure = await deliveryFailure(found.json.verificationId);
  check("delivery to the member failed and was logged (no provider)", failure === "DELIVERY_UNAVAILABLE", `got ${failure}`);
} finally { child.kill(); }

console.log(`\nPASS ${pass}  FAIL ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
