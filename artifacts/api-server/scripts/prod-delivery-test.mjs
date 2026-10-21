// Integration test: the employee lookup in production mode when a verification
// code cannot be delivered — no provider configured, or the SMS webhook down.
//
// What the API does now (specs/002-per-company-schema/contracts/employee-lookup.md):
// /v1/lookup refuses an unknown contact with 404 CONTACT_NOT_FOUND. For a
// match, /v1/lookup and /v1/otp/resend answer 200 CODE_SENT, with the same
// shape and at least LOOKUP_MIN_MS (800 ms), whether or not delivery works. Delivery happens after the response; a failure
// is logged in bhi.activity_log (OTP_DELIVERY / FAILED / DELIVERY_UNAVAILABLE)
// against the session. The old 503 CODE_DELIVERY_UNAVAILABLE is gone, because
// only a real match can reach a provider, so a different answer would reveal
// that the contact is on file. /v1/lookup/select is withdrawn; choosing between
// records happens after /v1/otp/verify.
//
// The session is NOT expired when delivery fails: it stays PENDING until its
// normal expiry. What keeps it unusable is that nobody holds its code — it was
// never delivered, never returned (devCode is null in production), only its hash
// is stored, and a resend replaces the code. The checks below assert exactly
// that, and report the session status without asserting it.
//
// Usage: node scripts/prod-delivery-test.mjs
// Requires a built dist, psql on PATH, and DATABASE_URL pointing at the bhi_app
// role of a database that already holds the demo seed (start the API once in
// development to seed it). bhi_app, because production mode refuses a role
// that bypasses row-level security.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.mjs");
const DB = process.env.DATABASE_URL;
if (!DB) {
  console.error("Set DATABASE_URL (the bhi_app role of a demo-seeded database).");
  process.exit(2);
}

/** Shared phone of five BF members (lib/seed.ts SHARED_PHONE), typed the way a person might. */
const SHARED_PHONE = "+592-555-0123";
const UNKNOWN_EMAIL = "nobody.at.all@example.invalid";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let pass = 0, fail = 0;
function check(name, ok, extra = "") {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}
function info(name, value) {
  console.log(`  --  ${name}: ${value}`);
}

/** One value from the database, in the all-companies scope (the bhi tables are RLS-forced). */
function sql(q) {
  try {
    return execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-d", DB, "-c", "SET bhi.all = 'on'", "-c", q], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    throw new Error(`psql failed: ${err.stderr || err.message}`);
  }
}

const baseEnv = {
  ...process.env,
  HOST: "127.0.0.1",
  NODE_ENV: "production",
  DEMO_SEED: "false",
  LOOKUP_MIN_MS: "800",
  SESSION_SECRET: process.env.SESSION_SECRET || "prod-delivery-test-secret",
};

async function boot(port, env) {
  const child = spawn(process.execPath, [dist], { env: { ...baseEnv, PORT: String(port), ...env }, stdio: "ignore" });
  let exited = null;
  child.on("exit", (code) => { exited = code; });
  for (let i = 0; i < 30; i++) {
    if (exited !== null) throw new Error(`server on ${port} exited with code ${exited} (DATABASE_URL must be the bhi_app role)`);
    try { await fetch(`http://127.0.0.1:${port}/api/healthz`); return child; }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  child.kill();
  throw new Error(`server on ${port} did not start`);
}

function client(port) {
  return async (p, body) => {
    const started = Date.now();
    const r = await fetch(`http://127.0.0.1:${port}/api${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => ({})), ms: Date.now() - started };
  };
}

/** The error code of the delivery failure logged for a session, or null (routes/employee.ts deliverLater). */
async function deliveryFailure(verificationId, waitMs = 5000) {
  if (!UUID_RE.test(verificationId ?? "")) return null;
  const key = createHash("sha256").update(verificationId).digest("hex").slice(0, 16);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const code = sql(
      `SELECT coalesce(error_code, '') FROM bhi.activity_log WHERE kind = 'EVENT' AND actor = '${key}' ` +
        "AND action = 'OTP_DELIVERY' AND result = 'FAILED' ORDER BY timestamp DESC LIMIT 1",
    );
    if (code !== "" || Date.now() > deadline) return code || null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

function session(verificationId) {
  if (!UUID_RE.test(verificationId ?? "")) return null;
  const row = sql(
    `SELECT status || '|' || jsonb_array_length(matched_members) FROM bhi.employee_sessions WHERE id = '${verificationId}'`,
  );
  if (!row) return null;
  const [status, matched] = row.split("|");
  return { status, matched: Number(matched) };
}

/** An email that exactly one card-eligible member has: active, in an active company, under 65. */
const singleEmail = sql(
  "SELECT m.email FROM bhi.member m JOIN bhi.company c ON c.company_number = m.company_number " +
    "WHERE m.active AND c.active AND m.email IS NOT NULL " +
    "AND (m.date_of_birth IS NULL OR m.date_of_birth > current_date - interval '65 years') " +
    "AND (SELECT count(*) FROM bhi.member o WHERE o.email = m.email) = 1 " +
    "ORDER BY m.member_id LIMIT 1",
);
if (!singleEmail) throw new Error("no demo member with a unique email found — is DATABASE_URL the seeded demo database?");


// ---------------------------------------------------------------------------
// Part 1: no OTP delivery provider at all.
const child1 = await boot(3979, { OTP_DEV_MODE: "false", SMTP_HOST: "", SMS_WEBHOOK_URL: "" });
try {
  const api = client(3979);

  const one = await api("/v1/lookup", { identifier: singleEmail });
  check("lookup w/o provider -> 200 CODE_SENT",
    one.status === 200 && one.json.status === "CODE_SENT", `got ${one.status} ${JSON.stringify(one.json)}`);
  check("no code handed back in production (devCode null)", one.json.devCode === null, JSON.stringify(one.json.devCode));
  check("lookup held to the 800 ms floor", one.ms >= 800, `took ${one.ms} ms`);
  const s1 = session(one.json.verificationId);
  check("lookup matched the member", s1?.matched === 1, JSON.stringify(s1));
  check("failed delivery logged as DELIVERY_UNAVAILABLE",
    (await deliveryFailure(one.json.verificationId)) === "DELIVERY_UNAVAILABLE");
  info("session status after failed delivery (not expired by design)", session(one.json.verificationId)?.status);
  const guess = await api("/v1/otp/verify", { verificationId: one.json.verificationId, code: "000000" });
  check("undelivered session does not verify without its code",
    guess.status === 400 && guess.json.error?.code === "CODE_INVALID" && !guess.json.cardToken,
    `got ${guess.status} ${JSON.stringify(guess.json)}`);

  const none = await api("/v1/lookup", { identifier: UNKNOWN_EMAIL });
  check("unknown contact is refused with 404 CONTACT_NOT_FOUND",
    none.status === 404 && none.json.error?.code === "CONTACT_NOT_FOUND" && !none.json.verificationId,
    `got ${none.status} ${JSON.stringify(none.json)}`);
  check("unknown contact also held to the 800 ms floor", none.ms >= 800, `took ${none.ms} ms`);

  const shared = await api("/v1/lookup", { identifier: SHARED_PHONE });
  check("shared phone -> CODE_SENT, no choice before verification",
    shared.status === 200 && shared.json.status === "CODE_SENT" && shared.json.options === null && shared.json.lookupRef === null,
    `got ${shared.status} ${JSON.stringify(shared.json)}`);
  const s3 = session(shared.json.verificationId);
  check("shared phone matched several members", (s3?.matched ?? 0) > 1, JSON.stringify(s3));
  check("failed SMS delivery logged as DELIVERY_UNAVAILABLE",
    (await deliveryFailure(shared.json.verificationId)) === "DELIVERY_UNAVAILABLE");

  const select = await api("/v1/lookup/select", { lookupRef: "x", optionRef: "y" });
  check("/v1/lookup/select is withdrawn (404)", select.status === 404, `got ${select.status}`);
} finally {
  child1.kill();
}

// ---------------------------------------------------------------------------
// Part 2: runtime provider failure (SMS webhook unreachable), and a resend
// against a broken instance.
const child2 = await boot(3978, {
  OTP_DEV_MODE: "false",
  SMTP_HOST: "",
  SMS_WEBHOOK_URL: "http://127.0.0.1:1/unreachable", // connection refused
});
try {
  const api2 = client(3978);

  const sel = await api2("/v1/lookup", { identifier: SHARED_PHONE });
  check("phone lookup with broken webhook -> 200 CODE_SENT",
    sel.status === 200 && sel.json.status === "CODE_SENT" && sel.json.devCode === null, `got ${sel.status} ${JSON.stringify(sel.json)}`);
  check("unreachable webhook logged as DELIVERY_UNAVAILABLE",
    (await deliveryFailure(sel.json.verificationId)) === "DELIVERY_UNAVAILABLE");

  // Resend: create a pending session with a known code on a dev-mode instance,
  // backdate last_sent_at past the cooldown, then resend on the broken one.
  const child3 = await boot(3977, { OTP_DEV_MODE: "true" });
  try {
    const dev = await client(3977)("/v1/lookup", { identifier: singleEmail });
    const vid = dev.json.verificationId;
    const oldCode = dev.json.devCode;
    check("dev-mode instance hands back the code", UUID_RE.test(vid ?? "") && /^\d{6}$/.test(oldCode ?? ""), JSON.stringify(dev.json));
    if (UUID_RE.test(vid ?? "")) {
      sql(`UPDATE bhi.employee_sessions SET last_sent_at = now() - interval '2 minutes' WHERE id = '${vid}'`);
      const resend = await api2("/v1/otp/resend", { verificationId: vid });
      check("resend with no smtp -> 200 CODE_SENT, no code",
        resend.status === 200 && resend.json.status === "CODE_SENT" && resend.json.devCode === null,
        `got ${resend.status} ${JSON.stringify(resend.json)}`);
      check("failed resend delivery logged as DELIVERY_UNAVAILABLE", (await deliveryFailure(vid)) === "DELIVERY_UNAVAILABLE");
      const stale = await api2("/v1/otp/verify", { verificationId: vid, code: oldCode });
      check("resend replaced the code: the earlier code no longer verifies",
        stale.status === 400 && stale.json.error?.code === "CODE_INVALID" && !stale.json.cardToken,
        `got ${stale.status} ${JSON.stringify(stale.json)}`);
      info("session status after failed resend (not expired by design)", session(vid)?.status);
    }
  } finally {
    child3.kill();
  }
} finally {
  child2.kill();
}

console.log(`\nTOTAL PASS ${pass}  FAIL ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
