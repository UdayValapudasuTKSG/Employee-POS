// UI smoke test: starts the API server + frontend dev server + a tiny local
// proxy (frontend at "/", API at "/api" — mirroring the Replit preview proxy),
// then drives a real Chromium browser through:
//   1. Employee OTP flow: landing -> lookup -> verify (OTP) -> confirm -> card
//   2. One admin flow per role: group admin, HR (scoped), support, auditor
// Run: node artifacts/bhi-card-portal/scripts/ui-smoke.mjs
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import {
  buildApiServer,
  startApiServer,
  waitForHttp,
  track,
} from "../../api-server/scripts/validation-lib.mjs";

const PORTAL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const API_PORT = 5741;
const VITE_PORT = 5742;
const PROXY_PORT = 5743;
const ORIGIN = `http://127.0.0.1:${PROXY_PORT}`;
const API = `${ORIGIN}/api`;

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

// --- start servers -----------------------------------------------------------
buildApiServer();
startApiServer(API_PORT);

console.log(`[smoke] starting vite dev server on port ${VITE_PORT}...`);
track(
  spawn("pnpm", ["exec", "vite"], {
    cwd: PORTAL_DIR,
    env: { ...process.env, PORT: String(VITE_PORT), BASE_PATH: "/", NODE_ENV: "development" },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
    // On Windows pnpm is pnpm.cmd, which spawn cannot resolve without a shell.
    shell: process.platform === "win32",
  }),
);

// Tiny reverse proxy: /api/* -> API server, everything else -> vite.
const proxy = http.createServer((req, res) => {
  const target = req.url.startsWith("/api") ? API_PORT : VITE_PORT;
  const upstream = http.request(
    { host: "127.0.0.1", port: target, path: req.url, method: req.method, headers: req.headers },
    (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    res.writeHead(502);
    res.end(`proxy error: ${err.message}`);
  });
  req.pipe(upstream);
});
proxy.on("upgrade", (req, socket) => socket.destroy()); // no HMR websocket needed
proxy.listen(PROXY_PORT, "127.0.0.1");

await waitForHttp(`http://127.0.0.1:${API_PORT}/api/v1/lookup`, { label: "api-server" });
await waitForHttp(`http://127.0.0.1:${VITE_PORT}/`, { label: "vite", timeoutMs: 90000 });
await new Promise((r) => setTimeout(r, 1000)); // allow seeding

// --- find a test member via the API ------------------------------------------
async function api(p, opts = {}) {
  const res = await fetch(`${API}${p}`, {
    method: opts.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// A fresh database is still seeding for a few seconds after the API answers.
let groupLogin;
for (let i = 0; i < 30; i++) {
  groupLogin = await api("/v1/admin/auth/login", {
    method: "POST",
    body: { email: "group.admin@bhi-demo.test", password: "Demo@2026" },
  });
  if (groupLogin.status === 200) break;
  await new Promise((r) => setTimeout(r, 1000));
}
if (groupLogin.status !== 200) throw new Error("could not log in group admin via API");
const groupToken = groupLogin.json.token;

/** Member detail lives under its company: MemberIDs are per company. */
const memberPath = (m) => `/admin/companies/${encodeURIComponent(m.companyNumber)}/members/${m.memberId}`;

/** Age in whole years today; cover (and the card) ends at 65. */
function ageToday(dateOfBirth) {
  const [y, m, d] = dateOfBirth.split("-").map(Number);
  const now = new Date();
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age--;
  return age;
}

// A member whose own email reaches exactly one card: active, with a policy,
// under 65, and not the demo's shared contact (which answers MULTI_COMPANY
// after verification instead of a card).
const members = await api("/v1/admin/members?pageSize=100&active=true", { token: groupToken });
const today = new Date().toISOString().slice(0, 10);
let active = null;
let detail = null;
for (const m of members.json?.items ?? []) {
  if (!m.active || !m.email || m.email === "shared.contact@bhi-demo.test") continue;
  const d = await api(`/v1${memberPath(m)}`, { token: groupToken });
  if (d.status !== 200 || !d.json?.email || !d.json.policy) continue;
  if (d.json.dateOfBirth && ageToday(d.json.dateOfBirth) >= 65) continue;
  if (d.json.policy.expiryDate && d.json.policy.expiryDate < today) continue;
  active = m;
  detail = d;
  break;
}
if (!active) throw new Error("no active member with an email and a policy found");
const memberEmail = detail.json.email;

// --- browser ------------------------------------------------------------------
// Replit provides chromium on PATH; a local checkout normally has Playwright's
// own download instead. Prefer the system one so CI behaviour is unchanged, and
// fall back to Playwright's before giving up.
const WINDOWS_FALLBACKS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

function resolveChromium() {
  // 1. On PATH — how Replit provides it.
  try {
    const which = process.platform === "win32" ? "where chromium" : "which chromium";
    const found = execSync(which, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .split(/\r?\n/)[0]
      .trim();
    if (found && existsSync(found)) return found;
  } catch {
    // Not on PATH — fall through.
  }

  // 2. Playwright's own download. executablePath() returns a path even when the
  //    build was never downloaded, or when the installed build does not match
  //    the playwright-core version, so the existence check is load-bearing.
  try {
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) return bundled;
  } catch {
    // No download for this platform — fall through.
  }

  // 3. A system Chrome or Edge. Both are Chromium, which is all this test needs.
  if (process.platform === "win32") {
    const installed = WINDOWS_FALLBACKS.find((p) => existsSync(p));
    if (installed) return installed;
  }

  throw new Error(
    "No chromium found. Install Chrome or Edge, or run: pnpm --filter @workspace/bhi-card-portal exec playwright install chromium",
  );
}

const browser = await chromium.launch({
  executablePath: resolveChromium(),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.setDefaultTimeout(20000);

try {
  // 1. Employee OTP flow ------------------------------------------------------
  console.log("[smoke] employee OTP flow");
  await page.goto(`${ORIGIN}/`);
  await page.getByTestId("button-find-card").click();
  await page.getByTestId("input-identifier").fill(memberEmail);
  await page.getByTestId("button-continue").click();
  await page.waitForURL(/\/verify\?/);

  const devCode = new URL(page.url()).searchParams.get("dev");
  check("dev code available on verify page", !!devCode && devCode.length === 6, page.url());

  // input-otp renders a (visually hidden) real <input>; type into it directly.
  const otpInput = page.locator('input[data-testid="input-otp"], [data-testid="input-otp"] input').first();
  await otpInput.focus();
  await otpInput.pressSequentially(devCode, { delay: 50 });
  await page.waitForURL(/\/confirm\?/);
  check("verify navigates to confirm", true);
  await page.getByTestId("button-view-card").click();
  await page.waitForURL(/\/card$/);
  await page.locator(`text=${detail.json.policy.policyNumber}`).first().waitFor();
  check("card page shows policy number", true);

  // 2. Admin flows, one per role ---------------------------------------------
  async function adminLogin(email) {
    await ctx.clearCookies();
    await page.goto(`${ORIGIN}/admin/login`);
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.reload();
    await page.getByTestId("input-email").fill(email);
    await page.getByTestId("input-password").fill("Demo@2026");
    await page.getByTestId("button-login").click();
    // Sign-in lands on the first section the role may open (the dashboard, or
    // the audit log for an auditor), so wait only for leaving the login page.
    await page.waitForURL((url) => !url.pathname.endsWith("/admin/login"));
  }

  // Group admin: sees members from multiple companies.
  console.log("[smoke] group admin flow");
  await adminLogin("group.admin@bhi-demo.test");
  await page.goto(`${ORIGIN}/admin/members`);
  await page.locator('[data-testid^="row-member-"]').first().waitFor();
  const groupCompanies = new Set(
    await page.locator('[data-testid^="row-member-"] td:nth-child(3)').allInnerTexts(),
  );
  check("group admin sees members from >1 company", groupCompanies.size > 1, [...groupCompanies].join(", "));

  // HR (Foods): members list scoped to a single company.
  console.log("[smoke] hr (foods) flow");
  await adminLogin("hr.foods@bhi-demo.test");
  await page.goto(`${ORIGIN}/admin/members`);
  await page.locator('[data-testid^="row-member-"]').first().waitFor();
  const hrCompanies = new Set(
    await page.locator('[data-testid^="row-member-"] td:nth-child(3)').allInnerTexts(),
  );
  check("hr.foods scoped to exactly 1 company", hrCompanies.size === 1, [...hrCompanies].join(", "));

  // Support: can open a member detail with masked contact info.
  console.log("[smoke] support flow");
  await adminLogin("support@bhi-demo.test");
  await page.goto(`${ORIGIN}${memberPath(active)}`);
  await page.locator(`text=${detail.json.firstName}`).first().waitFor();
  const supportBody = await page.locator("body").innerText();
  check("support sees masked contact info", supportBody.includes("•"), "expected masked (•) contact");

  // Auditor: cannot see the members list, but can read the audit log.
  console.log("[smoke] auditor flow");
  await adminLogin("auditor@bhi-demo.test");
  await page.goto(`${ORIGIN}/admin/members`);
  await page.waitForTimeout(2000);
  const auditorRows = await page.locator('[data-testid^="row-member-"]').count();
  check("auditor sees no member rows", auditorRows === 0, `saw ${auditorRows} rows`);
  await page.goto(`${ORIGIN}/admin/audit`);
  await page.locator('[data-testid^="row-audit-"]').first().waitFor();
  check("auditor can read audit log", true);
} catch (err) {
  failures++;
  console.error(`  ✗ smoke test error: ${err.message}`);
  try {
    console.error(`    at URL: ${page.url()}`);
  } catch {}
} finally {
  await browser.close().catch(() => {});
  proxy.close();
}

console.log(failures === 0 ? "\nUI smoke: ALL PASSED" : `\nUI smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
