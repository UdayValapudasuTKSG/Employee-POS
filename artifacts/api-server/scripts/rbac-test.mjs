// RBAC acceptance tests for the shared BHI model. Run: node scripts/rbac-test.mjs
//
// Runs against a live API seeded with the demo seed (lib/seed.ts): the six
// Beharry companies (BF BA BL BR BM BS) and Sterling Test (ST), and one login
// per role, password Demo@2026.
//
// Scope per role (middlewares/adminAuth.ts resolveScope):
//   super admin, support, auditor   every company (support and auditor read-only)
//   client admin, HR administrator  their one company
// There is no group admin: the super admin is the only role above one company
// that can change anything.
// A record outside the scope answers 404, never 403; a missing permission
// answers 403 (requirePermission, which also writes an ACCESS_DENIED audit row);
// a read-only scope answers 403 to any write (lib/adminScope.ts writable).
//
// Nothing here changes demo data. Every write is one of:
//   INVALID     the body fails validation (or a rule) before anything is written
//   REFUSED     403/404 for this caller, before anything is written
//   IDEMPOTENT  re-sends a value the record already holds
// and each is labelled below. The only rows the script adds are audit rows:
// LOGIN for each sign-in, ACCESS_DENIED for each 403 from requirePermission,
// and one empty-diff ADMIN_USER_UPDATED for the IDEMPOTENT user edit.
const BASE = process.env.BASE_URL ?? "http://localhost:80/api";

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra = "") {
  if (cond) pass++;
  else {
    fail++;
    failures.push(`${name} ${extra}`);
  }
}

async function api(path, { method = "GET", token, body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

async function login(email) {
  const r = await api("/v1/admin/auth/login", {
    method: "POST",
    body: { email, password: "Demo@2026" },
  });
  if (r.status !== 200) throw new Error(`login failed for ${email}`);
  return r.json;
}

const roles = {
  platform: await login("platform.admin@bhi-demo.test"), // ROLE_PLATFORM_ADMIN, every company
  clientBf: await login("client.foods@bhi-demo.test"), // ROLE_CLIENT_ADMIN, BF
  hrFoods: await login("hr.foods@bhi-demo.test"), // ROLE_HR_ADMIN, BF
  hrAuto: await login("hr.auto@bhi-demo.test"), // ROLE_HR_ADMIN, BA
  clientSt: await login("client.admin@st.test"), // ROLE_CLIENT_ADMIN, ST
  hrSt: await login("hr@st.test"), // ROLE_HR_ADMIN, ST
  support: await login("support@bhi-demo.test"), // ROLE_SUPPORT, every company, read-only
  auditor: await login("auditor@bhi-demo.test"), // ROLE_AUDITOR, every company, read-only
};
const roleOrder = ["platform", "clientBf", "hrFoods", "hrAuto", "clientSt", "hrSt", "support", "auditor"];

const BEHARRY = ["BA", "BF", "BL", "BM", "BR", "BS"];
const ALL_COMPANIES = [...BEHARRY, "ST"];
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

// ---------------------------------------------------------------------------
// Fixtures, read as the super admin: one active member each in BF and ST, and
// the admin directory.
// ---------------------------------------------------------------------------
async function firstActiveMember(company) {
  const r = await api(`/v1/admin/members?company=${company}&active=true&pageSize=5`, { token: roles.platform.token });
  const m = r.json?.items?.[0];
  if (!m) throw new Error(`no active ${company} member visible to the super admin (status ${r.status})`);
  return m;
}
const bfMember = await firstActiveMember("BF");
const stMember = await firstActiveMember("ST");
const bfPath = `/v1/admin/companies/BF/members/${bfMember.memberId}`;
const stPath = `/v1/admin/companies/ST/members/${stMember.memberId}`;

const directory = await api("/v1/admin/users", { token: roles.platform.token });
const userByEmail = (email) => directory.json?.find?.((u) => u.email === email);
const platformUser = directory.json?.find?.((u) => u.role === "ROLE_PLATFORM_ADMIN");
const clientBfUser = userByEmail("client.foods@bhi-demo.test");
const hrFoodsUser = userByEmail("hr.foods@bhi-demo.test");
const clientStUser = userByEmail("client.admin@st.test");
check("platform admin account exists in the directory", !!platformUser);
check("demo admin accounts exist in the directory", !!clientBfUser && !!hrFoodsUser && !!clientStUser);
check("no group admin account is left", !directory.json?.some?.((u) => u.role === "ROLE_HR_GROUP_ADMIN"));

// ---------------------------------------------------------------------------
// Permission and scope matrix: expected result per role per action.
// A case may supply a view that turns the response into the compared value;
// by default it is the status code.
// ---------------------------------------------------------------------------
const reasonBody = { reason: "RBAC test" };
// For list endpoints: 200 with rows, 200 with nothing, or the error status.
const listView = (r) => (r.status !== 200 ? r.status : (r.json?.totalItems ?? r.json?.items?.length ?? 0) > 0 ? "rows" : "empty");

const cases = [
  // [name, fn(token), expected: platform, clientBf, hrFoods, hrAuto, clientSt, hrSt, support, auditor, view?]

  // --- Session and directory ------------------------------------------------
  ["ME", (t) => api("/v1/admin/me", { token: t }), [200, 200, 200, 200, 200, 200, 200, 200]],
  ["PERMISSIONS matrix", (t) => api("/v1/admin/permissions", { token: t }), [200, 200, 200, 200, 200, 200, 200, 200]],
  ["DASHBOARD", (t) => api("/v1/admin/dashboard", { token: t }), [200, 200, 200, 200, 200, 200, 200, 403]],
  ["AUDIT read", (t) => api("/v1/admin/audit", { token: t }), [200, 200, 200, 200, 200, 200, 403, 200]],
  ["VERIFICATIONS read", (t) => api("/v1/admin/verifications", { token: t }), [200, 200, 200, 200, 200, 200, 200, 200]],
  ["CHANGE REQUESTS list", (t) => api("/v1/admin/change-requests?status=ALL", { token: t }), [200, 200, 200, 200, 200, 200, 403, 403]],
  ["CHANGE REQUEST detail (unknown id)", (t) => api(`/v1/admin/change-requests/${ZERO_UUID}`, { token: t }), [404, 404, 404, 404, 404, 404, 403, 403]],
  ["ADMIN USERS read", (t) => api("/v1/admin/users", { token: t }), [200, 200, 403, 403, 200, 403, 403, 403]],
  ["LOOKUP ALERTS read", (t) => api("/v1/admin/lookup-alerts?status=ALL", { token: t }), [200, 403, 403, 403, 403, 403, 403, 403]],

  // --- Companies (client groups were removed: their routes are gone) --------
  ["COMPANIES list", (t) => api("/v1/admin/companies", { token: t }), [200, 200, 200, 200, 200, 200, 200, 200]],
  ["GROUPS list (removed)", (t) => api("/v1/admin/groups", { token: t }), [404, 404, 404, 404, 404, 404, 404, 404]],

  // --- Members: list by company (row-level security empties an out-of-scope company) ---
  ["MEMBER list ?company=BF", (t) => api("/v1/admin/members?company=BF", { token: t }), ["rows", "rows", "rows", "empty", "empty", "empty", "rows", 403], listView],
  ["MEMBER list ?company=ST", (t) => api("/v1/admin/members?company=ST", { token: t }), ["rows", "empty", "empty", "empty", "rows", "rows", "rows", 403], listView],
  ["MEMBER detail (BF)", (t) => api(bfPath, { token: t }), [200, 200, 200, 404, 404, 404, 200, 403]],
  ["MEMBER detail (ST)", (t) => api(stPath, { token: t }), [200, 404, 404, 404, 200, 200, 200, 403]],
  // A real member id under the wrong company is not found, whoever asks.
  ["MEMBER detail (BF id under BA)", (t) => api(`/v1/admin/companies/BA/members/${bfMember.memberId}`, { token: t }), [404, 404, 404, 404, 404, 404, 404, 403]],
  ["IMPORT EXCEPTIONS (BF)", (t) => api("/v1/admin/companies/BF/import-exceptions", { token: t }), [200, 200, 200, 404, 404, 404, 200, 403]],
  ["IMPORT EXCEPTIONS (ST)", (t) => api("/v1/admin/companies/ST/import-exceptions", { token: t }), [200, 404, 404, 404, 200, 200, 200, 403]],
  ["IMPORT layouts", (t) => api("/v1/admin/import/layouts", { token: t }), [200, 200, 200, 200, 200, 200, 403, 403]],

  // --- Classes, rates, billing (reads) --------------------------------------
  ["CLASSES read", (t) => api("/v1/admin/classes", { token: t }), [200, 200, 200, 200, 200, 200, 200, 200]],
  ["RATES read (standard card)", (t) => api("/v1/admin/rates", { token: t }), [200, 200, 200, 200, 200, 200, 200, 200]],
  ["RATES read ?company=BF", (t) => api("/v1/admin/rates?company=BF", { token: t }), [200, 200, 200, 404, 404, 404, 200, 200]],
  ["RATES read ?company=ST", (t) => api("/v1/admin/rates?company=ST", { token: t }), [200, 404, 404, 404, 200, 200, 200, 200]],
  ["RATES history", (t) => api("/v1/admin/rates/history", { token: t }), [200, 403, 403, 403, 403, 403, 403, 403]],
  // RATE_MANAGE or BILLING_READ, then scope.
  ["BILLING RULES read (BF)", (t) => api("/v1/admin/companies/BF/billing-rules", { token: t }), [200, 200, 403, 403, 404, 403, 403, 200]],
  ["BILLING RUNS list", (t) => api("/v1/admin/billing/runs", { token: t }), [200, 200, 403, 403, 200, 403, 403, 200]],
  ["BILLING RUN detail (unknown id)", (t) => api("/v1/admin/billing/runs/999999999", { token: t }), [404, 404, 403, 403, 404, 403, 403, 404]],

  // --- Writes. Every one below is INVALID or REFUSED: nothing is written. ----
  // Company onboarding and offboarding are PLATFORM_MANAGE. INVALID: no body.
  ["COMPANY onboard (INVALID {})", (t) => api("/v1/admin/companies", { method: "POST", token: t, body: {} }), [400, 403, 403, 403, 403, 403, 403, 403]],
  ["COMPANY offboard ST (INVALID, no reason)", (t) => api("/v1/admin/companies/ST/offboard", { method: "POST", token: t, body: {} }), [400, 403, 403, 403, 403, 403, 403, 403]],
  // Company profile edit: read-only 403, out of scope 404, HR 403, then the
  // body (INVALID: no reason) — super admin, and a client admin on its own company.
  ["COMPANY patch BF (INVALID {})", (t) => api("/v1/admin/companies/BF", { method: "PATCH", token: t, body: {} }), [400, 400, 403, 404, 404, 404, 403, 403]],
  ["COMPANY patch ST (INVALID {})", (t) => api("/v1/admin/companies/ST", { method: "PATCH", token: t, body: {} }), [400, 404, 404, 404, 400, 403, 403, 403]],
  ["GROUP create (removed)", (t) => api("/v1/admin/groups", { method: "POST", token: t, body: {} }), [404, 404, 404, 404, 404, 404, 404, 404]],
  ["ADMIN USER create (INVALID {})", (t) => api("/v1/admin/users", { method: "POST", token: t, body: {} }), [400, 400, 403, 403, 400, 403, 403, 403]],

  // Member writes check the permission, then read-only, then the body, so an
  // empty body answers 400 wherever the permission holds. INVALID throughout.
  ["MEMBER update (INVALID {})", (t) => api(bfPath, { method: "PATCH", token: t, body: {} }), [400, 400, 400, 400, 400, 400, 403, 403]],
  // POLICY_MANAGE is super admin only: one policy applies to the whole platform.
  ["POLICY save (INVALID {})", (t) => api(`${bfPath}/policy`, { method: "POST", token: t, body: {} }), [400, 403, 403, 403, 403, 403, 403, 403]],
  ["MEMBER deactivate (INVALID, no reason)", (t) => api(`${bfPath}/deactivate`, { method: "POST", token: t, body: {} }), [400, 400, 400, 400, 400, 400, 403, 403]],
  // Create checks the company's scope before the body: out of scope is 404.
  ["MEMBER create in BF (INVALID {})", (t) => api("/v1/admin/companies/BF/members", { method: "POST", token: t, body: {} }), [400, 400, 400, 404, 404, 404, 403, 403]],
  ["MEMBER create in ST (INVALID {})", (t) => api("/v1/admin/companies/ST/members", { method: "POST", token: t, body: {} }), [400, 404, 404, 404, 400, 400, 403, 403]],
  ["MEMBER import (INVALID {})", (t) => api("/v1/admin/import", { method: "POST", token: t, body: {} }), [400, 400, 400, 400, 400, 400, 403, 403]],
  ["CHANGE REQUEST reject (INVALID, no note)", (t) => api(`/v1/admin/change-requests/${ZERO_UUID}/reject`, { method: "POST", token: t, body: {} }), [400, 400, 400, 400, 400, 400, 403, 403]],
  // SESSION_MANAGE, deliberately not VERIFICATION_READ: the auditor holds that
  // and must never mutate. REFUSED: an unknown id 404s once the permission passes.
  ["VERIFICATION unlock (REFUSED, unknown id)", (t) => api(`/v1/admin/verifications/${ZERO_UUID}/reset-lock`, { method: "POST", token: t, body: reasonBody }), [404, 404, 404, 404, 404, 404, 404, 403]],
  // Super admin only. INVALID: no note.
  ["LOOKUP ALERT resolve (INVALID, no note)", (t) => api(`/v1/admin/lookup-alerts/${ZERO_UUID}/resolve`, { method: "POST", token: t, body: {} }), [400, 403, 403, 403, 403, 403, 403, 403]],

  // CLASS_MANAGE, RATE_MANAGE, BILLING_MANAGE: super admin only. requirePermission
  // runs before validation, so an empty body is 400 for the super admin and 403
  // for everyone else. INVALID: nothing is created.
  ["CLASS create (INVALID {})", (t) => api("/v1/admin/classes", { method: "POST", token: t, body: {} }), [400, 403, 403, 403, 403, 403, 403, 403]],
  ["RATE set create (INVALID {})", (t) => api("/v1/admin/rates", { method: "POST", token: t, body: {} }), [400, 403, 403, 403, 403, 403, 403, 403]],
  ["BILLING RULE create BF (INVALID {})", (t) => api("/v1/admin/companies/BF/billing-rules", { method: "POST", token: t, body: {} }), [400, 403, 403, 403, 403, 403, 403, 403]],
  // No month and no companies, so no run is generated.
  ["BILLING RUN generate (INVALID {})", (t) => api("/v1/admin/billing/runs", { method: "POST", token: t, body: {} }), [400, 403, 403, 403, 403, 403, 403, 403]],
  ["BILLING RUN finalise (INVALID, no reason)", (t) => api("/v1/admin/billing/runs/999999999/finalise", { method: "POST", token: t, body: {} }), [400, 403, 403, 403, 403, 403, 403, 403]],
];

for (const [name, fn, expected, view = (r) => r.status] of cases) {
  for (let i = 0; i < roleOrder.length; i++) {
    const got = view(await fn(roles[roleOrder[i]].token));
    check(`${name} as ${roleOrder[i]}`, got === expected[i], `expected ${expected[i]} got ${got}`);
  }
}

// ---------------------------------------------------------------------------
// What each scope actually contains
// ---------------------------------------------------------------------------
{
  const me = {};
  for (const role of roleOrder) me[role] = (await api("/v1/admin/me", { token: roles[role].token })).json;
  check("super admin /me: label, all companies, writable", me.platform?.roleLabel === "Super admin" && me.platform?.companies === null && me.platform?.readOnly === false, JSON.stringify(me.platform?.companies));
  check("client.foods /me: BF only, client admin", sameSet(me.clientBf?.companies ?? [], ["BF"]) && me.clientBf?.role === "ROLE_CLIENT_ADMIN" && !("groupName" in (me.clientBf ?? {})), JSON.stringify(me.clientBf?.companies));
  check("hr.foods /me: BF only", sameSet(me.hrFoods?.companies ?? [], ["BF"]) && me.hrFoods?.readOnly === false, JSON.stringify(me.hrFoods?.companies));
  check("hr.auto /me: BA only", sameSet(me.hrAuto?.companies ?? [], ["BA"]), JSON.stringify(me.hrAuto?.companies));
  check("client admin /me: ST only", sameSet(me.clientSt?.companies ?? [], ["ST"]) && me.clientSt?.role === "ROLE_CLIENT_ADMIN", JSON.stringify(me.clientSt?.companies));
  check("hr@st /me: ST only", sameSet(me.hrSt?.companies ?? [], ["ST"]), JSON.stringify(me.hrSt?.companies));
  check("support /me: all companies, read-only", me.support?.companies === null && me.support?.readOnly === true);
  check("auditor /me: all companies, read-only", me.auditor?.companies === null && me.auditor?.readOnly === true);
}

{
  const codes = {};
  for (const role of roleOrder) {
    const r = await api("/v1/admin/companies", { token: roles[role].token });
    codes[role] = (r.json ?? []).map((c) => c.companyNumber);
  }
  // All-companies scopes see at least the seven demo companies (more if some were onboarded since).
  for (const role of ["platform", "support", "auditor"]) {
    check(`${role} company list covers every company`, ALL_COMPANIES.every((c) => codes[role].includes(c)), JSON.stringify(codes[role]));
  }
  check("client.foods company list is [BF]", sameSet(codes.clientBf, ["BF"]), JSON.stringify(codes.clientBf));
  check("hr.foods company list is [BF]", sameSet(codes.hrFoods, ["BF"]), JSON.stringify(codes.hrFoods));
  check("hr.auto company list is [BA]", sameSet(codes.hrAuto, ["BA"]), JSON.stringify(codes.hrAuto));
  check("client admin company list is [ST]", sameSet(codes.clientSt, ["ST"]), JSON.stringify(codes.clientSt));
  check("hr@st company list is [ST]", sameSet(codes.hrSt, ["ST"]), JSON.stringify(codes.hrSt));
}

{
  // Unfiltered member lists stay inside the scope.
  const inCompanies = async (role, allowed) => {
    const r = await api("/v1/admin/members?pageSize=100", { token: roles[role].token });
    return r.status === 200 && r.json.items.length > 0 && r.json.items.every((m) => allowed.includes(m.companyNumber));
  };
  check("hr.foods member list scoped to BF", await inCompanies("hrFoods", ["BF"]));
  check("client admin member list scoped to ST", await inCompanies("clientSt", ["ST"]));
  check("client.foods member list scoped to BF", await inCompanies("clientBf", ["BF"]));

  // Masking: support reads every company but never sees full contact details.
  const supList = await api("/v1/admin/members?company=BF", { token: roles.support.token });
  const supM = supList.json?.items?.find((m) => m.email);
  check("support sees masked email", supM && supM.email.includes("•"), supM?.email);
  const cbfList = await api("/v1/admin/members?company=BF", { token: roles.clientBf.token });
  const cbfM = cbfList.json?.items?.find((m) => m.email);
  check("client admin sees full email", cbfM && !cbfM.email.includes("•"), cbfM?.email);
}

{
  // Change requests, billing runs and lookup alerts never leak another scope's rows.
  const crs = async (role) => (await api("/v1/admin/change-requests?status=ALL&pageSize=100", { token: roles[role].token })).json?.items ?? [];
  check("hr.foods change requests are BF only", (await crs("hrFoods")).every((c) => c.companyNumber === "BF"));
  check("client admin change requests are ST only", (await crs("clientSt")).every((c) => c.companyNumber === "ST"));

  const runs = async (role) => (await api("/v1/admin/billing/runs", { token: roles[role].token })).json?.runs ?? [];
  check("client admin billing runs are ST only", (await runs("clientSt")).every((r) => r.companyNumber === "ST"));
  check("client.foods billing runs are BF only", (await runs("clientBf")).every((r) => r.companyNumber === "BF"));
}

// ---------------------------------------------------------------------------
// Member writes across scope. REFUSED: the member is outside the caller's
// scope, so each answers 404 before anything is written. (The same calls from
// an in-scope role would write, so they are deliberately not made.)
// ---------------------------------------------------------------------------
for (const role of ["hrAuto", "clientSt", "hrSt"]) {
  const t = roles[role].token;
  check(`MEMBER update cross-scope (BF) as ${role} -> 404`, (await api(bfPath, { method: "PATCH", token: t, body: { ...reasonBody, notes: "RBAC test" } })).status === 404);
  check(`MEMBER deactivate cross-scope (BF) as ${role} -> 404`, (await api(`${bfPath}/deactivate`, { method: "POST", token: t, body: reasonBody })).status === 404);
}
for (const role of ["clientBf", "hrFoods", "hrAuto"]) {
  const t = roles[role].token;
  check(`MEMBER update cross-scope (ST) as ${role} -> 404`, (await api(stPath, { method: "PATCH", token: t, body: { ...reasonBody, notes: "RBAC test" } })).status === 404);
  check(`BENEFICIARY add cross-scope (ST) as ${role} -> 404`, (await api(`${stPath}/beneficiaries`, { method: "POST", token: t, body: { fullName: "Rbac Test", ...reasonBody } })).status === 404);
}
// Read-only scopes are refused whatever the body.
for (const role of ["support", "auditor"]) {
  const t = roles[role].token;
  check(`MEMBER update with a valid body as ${role} -> 403`, (await api(bfPath, { method: "PATCH", token: t, body: { ...reasonBody, notes: "RBAC test" } })).status === 403);
  check(`COMPANY patch with a valid body as ${role} -> 403`, (await api("/v1/admin/companies/BF", { method: "PATCH", token: t, body: { ...reasonBody, contactName: "RBAC test" } })).status === 403);
}

// Company profile: a client admin edits contact fields only. REFUSED: the name
// and notes are the super admin's, so these 403 before any write.
check(
  "client admin CANNOT rename its company",
  (await api("/v1/admin/companies/BF", { method: "PATCH", token: roles.clientBf.token, body: { ...reasonBody, companyName: "Renamed by RBAC test" } })).status === 403,
);
check(
  "client admin CANNOT edit its company's notes",
  (await api("/v1/admin/companies/ST", { method: "PATCH", token: roles.clientSt.token, body: { ...reasonBody, notes: "RBAC test" } })).status === 403,
);

// The create form refuses a member past retirement age. INVALID: refused
// after validation and before the insert, so nothing is created.
{
  const tooOld = await api("/v1/admin/companies/BF/members", {
    method: "POST",
    token: roles.hrFoods.token,
    body: {
      idType: "NATIONAL ID", idNumber: "SYN-RETIRED-1", firstName: "Elder", lastName: "Retiree",
      dateOfBirth: "1940-01-01", classCode: "A", ...reasonBody,
    },
  });
  check("creating an over-65 member -> 400 RETIREMENT_AGE_REACHED", tooOld.status === 400 && tooOld.json?.error?.code === "RETIREMENT_AGE_REACHED", `got ${tooOld.status} ${tooOld.json?.error?.code}`);
}

// ---------------------------------------------------------------------------
// Admin users: who may grant what (routes/admin.ts checkGrant). Every create
// below is INVALID or REFUSED: the allowed ones reuse an email that already
// exists, so they pass the grant checks and stop at EMAIL_IN_USE.
// ---------------------------------------------------------------------------
{
  const createAs = (role, body) => api("/v1/admin/users", { method: "POST", token: roles[role].token, body: { displayName: "RBAC Test", companyScope: null, ...body } });
  const expectCode = async (name, promise, status, code) => {
    const r = await promise;
    check(name, r.status === status && r.json?.error?.code === code, `expected ${status} ${code} got ${r.status} ${r.json?.error?.code}`);
  };

  // Client admin: client admins and HR administrators of its own company only.
  await expectCode("client admin MAY create HR for ST (stops at EMAIL_IN_USE)", createAs("clientSt", { email: "hr@st.test", role: "ROLE_HR_ADMIN", companyScope: "ST" }), 400, "EMAIL_IN_USE");
  await expectCode("client admin MAY create a client admin for ST (stops at EMAIL_IN_USE)", createAs("clientSt", { email: "client.admin@st.test", role: "ROLE_CLIENT_ADMIN", companyScope: "ST" }), 400, "EMAIL_IN_USE");
  await expectCode("client admin CANNOT create HR for BF", createAs("clientSt", { email: "rbac.hr.bf@test.invalid", role: "ROLE_HR_ADMIN", companyScope: "BF" }), 403, "ROLE_NOT_GRANTABLE");
  await expectCode("client admin CANNOT create support", createAs("clientSt", { email: "rbac.support@test.invalid", role: "ROLE_SUPPORT" }), 403, "ROLE_NOT_GRANTABLE");
  await expectCode("HR role without a company -> SCOPE_REQUIRED", createAs("clientSt", { email: "rbac.noscope@test.invalid", role: "ROLE_HR_ADMIN" }), 400, "SCOPE_REQUIRED");
  await expectCode("support role with a company -> SCOPE_NOT_ALLOWED", createAs("clientSt", { email: "rbac.scoped.support@test.invalid", role: "ROLE_SUPPORT", companyScope: "ST" }), 400, "SCOPE_NOT_ALLOWED");

  // The BF client admin: the same two roles, in BF only — never a sister company.
  await expectCode("BF client admin MAY create HR for BF (stops at EMAIL_IN_USE)", createAs("clientBf", { email: "hr.foods@bhi-demo.test", role: "ROLE_HR_ADMIN", companyScope: "BF" }), 400, "EMAIL_IN_USE");
  await expectCode("BF client admin CANNOT create HR for BA", createAs("clientBf", { email: "rbac.hr.ba@test.invalid", role: "ROLE_HR_ADMIN", companyScope: "BA" }), 403, "ROLE_NOT_GRANTABLE");
  await expectCode("BF client admin CANNOT create an auditor", createAs("clientBf", { email: "rbac.auditor@test.invalid", role: "ROLE_AUDITOR" }), 403, "ROLE_NOT_GRANTABLE");
  await expectCode("BF client admin CANNOT create a super admin", createAs("clientBf", { email: "escalate@test.invalid", role: "ROLE_PLATFORM_ADMIN" }), 403, "FORBIDDEN");

  // The group admin role is gone: not even a super admin can grant it.
  await expectCode("the group admin role is refused (INVALID_INPUT)", createAs("platform", { email: "rbac.group@test.invalid", role: "ROLE_HR_GROUP_ADMIN" }), 400, "INVALID_INPUT");

  // Super admin: any role, any company that exists.
  await expectCode("super admin MAY create HR for ST (stops at EMAIL_IN_USE)", createAs("platform", { email: "hr@st.test", role: "ROLE_HR_ADMIN", companyScope: "ST" }), 400, "EMAIL_IN_USE");
  await expectCode("super admin MAY create support (stops at EMAIL_IN_USE)", createAs("platform", { email: "support@bhi-demo.test", role: "ROLE_SUPPORT" }), 400, "EMAIL_IN_USE");
  await expectCode("super admin CANNOT scope a user to an unknown company", createAs("platform", { email: "rbac.nowhere@test.invalid", role: "ROLE_HR_ADMIN", companyScope: "ZZ-NO-SUCH" }), 400, "UNKNOWN_COMPANY");
  await expectCode("an invalid email is refused", createAs("platform", { email: "not-an-email", role: "ROLE_SUPPORT" }), 400, "INVALID_INPUT");
}

{
  // Directory scope: a user outside the caller's companies is invisible.
  const emails = async (role) => ((await api("/v1/admin/users", { token: roles[role].token })).json ?? []).map((u) => u.email);
  const cbf = await emails("clientBf");
  check("BF client admin directory shows BF users", cbf.includes("hr.foods@bhi-demo.test"), JSON.stringify(cbf));
  check(
    "BF client admin directory hides BA, ST, super admin, support and auditor",
    !["hr.auto@bhi-demo.test", "client.admin@st.test", "hr@st.test", "platform.admin@bhi-demo.test", "support@bhi-demo.test", "auditor@bhi-demo.test"].some((e) => cbf.includes(e)),
    JSON.stringify(cbf),
  );
  const cst = await emails("clientSt");
  check("client admin directory shows ST users only", cst.includes("hr@st.test") && !cst.some((e) => e.endsWith("@bhi-demo.test")), JSON.stringify(cst));
}

// ---------------------------------------------------------------------------
// Super admin accounts: privilege escalation must be impossible from a client
// admin. Without these guards, ADMIN_USER_MANAGE alone is a one-request
// takeover of the superuser account. All REFUSED unless marked IDEMPOTENT.
// ---------------------------------------------------------------------------
if (platformUser && clientBfUser && hrFoodsUser && clientStUser) {
  // A super admin is outside every client admin's directory, so it reads as not found.
  check(
    "client admin CANNOT reset a super admin's password (404)",
    (await api(`/v1/admin/users/${platformUser.id}/reset-password`, { method: "POST", token: roles.clientBf.token })).status === 404,
  );
  check(
    "client admin CANNOT deactivate a super admin (404)",
    (await api(`/v1/admin/users/${platformUser.id}`, { method: "PATCH", token: roles.clientBf.token, body: { active: false } })).status === 404,
  );
  check(
    "client admin CANNOT promote itself to super admin (403)",
    (await api(`/v1/admin/users/${clientBfUser.id}`, { method: "PATCH", token: roles.clientBf.token, body: { role: "ROLE_PLATFORM_ADMIN" } })).status === 403,
  );
  check(
    "BF client admin CANNOT edit an ST user (404)",
    (await api(`/v1/admin/users/${clientStUser.id}`, { method: "PATCH", token: roles.clientBf.token, body: { displayName: clientStUser.displayName } })).status === 404,
  );
  check(
    "client admin CANNOT edit a BF user (404)",
    (await api(`/v1/admin/users/${hrFoodsUser.id}`, { method: "PATCH", token: roles.clientSt.token, body: { displayName: hrFoodsUser.displayName } })).status === 404,
  );
  check(
    "HR CANNOT manage users (403)",
    (await api(`/v1/admin/users/${hrFoodsUser.id}`, { method: "PATCH", token: roles.hrFoods.token, body: { displayName: hrFoodsUser.displayName } })).status === 403,
  );
  // IDEMPOTENT: re-sends the display name the account already has.
  check(
    "super admin CAN edit a super admin",
    (await api(`/v1/admin/users/${platformUser.id}`, { method: "PATCH", token: roles.platform.token, body: { displayName: platformUser.displayName } })).status === 200,
  );
  // Self-demotion is refused before the last-super-admin invariant is even
  // reached: nobody may change their own role, which also closes self-promotion.
  const selfDemote = await api(`/v1/admin/users/${platformUser.id}`, { method: "PATCH", token: roles.platform.token, body: { role: "ROLE_SUPPORT" } });
  check("a super admin CANNOT demote itself", selfDemote.json?.error?.code === "SELF_LOCKOUT", `got ${selfDemote.json?.error?.code}`);
  check(
    "the super admin is still a super admin afterwards",
    (await api("/v1/admin/users", { token: roles.platform.token })).json?.some((u) => u.role === "ROLE_PLATFORM_ADMIN"),
  );
}

// ---------------------------------------------------------------------------
// Permission matrix: the full cross-role view is PLATFORM_MANAGE only;
// everyone else sees their own column.
// ---------------------------------------------------------------------------
const platMatrix = await api("/v1/admin/permissions", { token: roles.platform.token });
const cbfMatrix = await api("/v1/admin/permissions", { token: roles.clientBf.token });
const audMatrix = await api("/v1/admin/permissions", { token: roles.auditor.token });
// Five admin roles plus the employee column.
check("super admin sees every role column", platMatrix.json?.roles?.length === 6, `got ${platMatrix.json?.roles?.length}`);
check("the matrix has no group admin", !platMatrix.json?.roles?.includes("ROLE_HR_GROUP_ADMIN"));
check("client admin sees only its own column", cbfMatrix.json?.roles?.length === 1 && cbfMatrix.json.roles[0] === "ROLE_CLIENT_ADMIN");
check("auditor sees only its own column", audMatrix.json?.roles?.length === 1 && audMatrix.json.roles[0] === "ROLE_AUDITOR");
check("super admin is a permission superset", platMatrix.json?.rows?.every((r) => r.permission === "CARD_READ_OWN" || r.grants.ROLE_PLATFORM_ADMIN === "full"));
check("no role holds MEMBER_ARCHIVE", !JSON.stringify(roles.platform.permissions ?? []).includes("MEMBER_ARCHIVE"));

// ACCESS_DENIED rows exist in audit (the matrix above produced plenty).
const denied = await api("/v1/admin/audit?action=ACCESS_DENIED", { token: roles.platform.token });
check("ACCESS_DENIED audited", denied.json?.totalItems > 0, `total ${denied.json?.totalItems}`);

// An admin token is not a card session.
check("card no auth -> 401", (await api("/v1/card")).status === 401);
check("card with an admin token -> 401", (await api("/v1/card", { token: roles.platform.token })).status === 401);

console.log(`\nPASS ${pass}  FAIL ${fail}`);
if (failures.length) {
  console.log("Failures:");
  for (const f of failures) console.log(" -", f);
  process.exit(1);
}
