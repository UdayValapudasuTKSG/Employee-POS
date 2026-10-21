/**
 * FR-021 to FR-027, SC-008: classes are added and priced without a code
 * release, become assignable only once all four standard tiers are priced, and
 * a company rate overrides the standard rate for that company only.
 *
 * Classes are shared by the whole platform and the application role cannot
 * delete, so each run takes a class code nobody uses yet. The 36-code limit is
 * checked only with TEST_CLASS_EXHAUSTION=1, because it uses up every code for
 * good: run it last, on a disposable database.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, makeCompany, randomIdNumber, startApp, useAppRoleGuard } from "./testDb";
import { makeAdmin, signIn, type AdminClient } from "./adminFixtures";

const CODES = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");

const tiers = (base: number) =>
  [0, 1, 2, 3].map((dependentBand) => {
    const total = base + dependentBand * 1000;
    return {
      dependentBand,
      totalPremium: total.toFixed(2),
      companyPremium: (total * 0.75).toFixed(2),
      employeePremium: (total * 0.25).toFixed(2),
    };
  });

describeDb("classes and rates (FR-021 to FR-027)", () => {
  useAppRoleGuard();
  let app: Awaited<ReturnType<typeof startApp>>;
  let superAdmin: AdminClient;
  let hr: AdminClient;
  let company: string;
  let other: string;
  let code: string;

  beforeAll(async () => {
    app = await startApp();
    company = await makeCompany("Rates company");
    other = await makeCompany("Other company");
    superAdmin = await signIn(app.baseUrl, (await makeAdmin("ROLE_PLATFORM_ADMIN")).email);
    hr = await signIn(app.baseUrl, (await makeAdmin("ROLE_HR_ADMIN", { companyScope: company })).email);
    const list = await superAdmin("GET", "/v1/admin/classes?includeRetired=true");
    const used = new Set((list.body["classes"] as { classCode: string }[]).map((c) => c.classCode));
    const free = CODES.filter((c) => !used.has(c));
    if (free.length === 0) throw new Error("Every class code is used in this test database. Recreate it.");
    // From the end, so the letters a person would pick first stay free.
    code = free[free.length - 1]!;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  const createMember = (classCode: string) =>
    hr("POST", `/v1/admin/companies/${company}/members`, {
      idType: "NATIONAL ID",
      idNumber: randomIdNumber(),
      firstName: "Rate",
      lastName: "Tester",
      dateOfBirth: "1990-05-05",
      classCode,
      reason: "integration test",
    });

  it("adds a class that is not assignable until its four standard tiers are priced", async () => {
    const created = await superAdmin("POST", "/v1/admin/classes", { classCode: code.toLowerCase(), className: `Test ${code}`, reason: "new class" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ classCode: code, active: true, rateComplete: false, memberCount: 0 });

    const refused = await createMember(code);
    expect(refused.status).toBe(400);
    expect(refused.body.error?.code).toBe("CLASS_NOT_ASSIGNABLE");

    const again = await superAdmin("POST", "/v1/admin/classes", { classCode: code, className: "Duplicate", reason: "again" });
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("CLASS_EXISTS");
    expect(again.body.error?.message).toContain(`Test ${code}`);
  });

  it("refuses an incomplete or unbalanced rate set, then accepts a complete one", async () => {
    const three = await superAdmin("POST", "/v1/admin/rates", {
      classCode: code,
      effectiveDate: "2026-10-01",
      tiers: tiers(1000).slice(0, 3),
      reason: "rates",
    });
    expect(three.status).toBe(400);

    const unbalanced = tiers(1000);
    unbalanced[1]!.employeePremium = "1.00";
    const bad = await superAdmin("POST", "/v1/admin/rates", { classCode: code, effectiveDate: "2026-10-01", tiers: unbalanced, reason: "rates" });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.message).toMatch(/must equal the total/);

    const ok = await superAdmin("POST", "/v1/admin/rates", { classCode: code, effectiveDate: "2026-10-01", tiers: tiers(1000), reason: "rates" });
    expect(ok.status).toBe(201);
    const rows = ok.body["rates"] as { coverageBand: string; coverageLabel: string; companyNumber: string | null }[];
    expect(rows.map((r) => r.coverageBand)).toEqual(["EMP_ONLY", "EMP_PLUS_1", "EMP_PLUS_2", "EMP_PLUS_3PLUS"]);
    expect(rows[3]!.coverageLabel).toBe("Employee + 3 or more dependents");
    expect(rows.every((r) => r.companyNumber === null)).toBe(true);

    const dup = await superAdmin("POST", "/v1/admin/rates", { classCode: code, effectiveDate: "2026-10-01", tiers: tiers(1000), reason: "again" });
    expect(dup.status).toBe(409);
    expect(dup.body.error?.code).toBe("RATE_EXISTS");

    const list = await superAdmin("GET", "/v1/admin/classes");
    expect((list.body["classes"] as { classCode: string; rateComplete: boolean }[]).find((c) => c.classCode === code)?.rateComplete).toBe(true);
    const member = await createMember(code);
    expect(member.status).toBe(200);
  });

  it("a company rate overrides the standard rate for that company from its date", async () => {
    const created = await superAdmin("POST", "/v1/admin/rates", {
      companyNumber: company,
      classCode: "A",
      effectiveDate: "2026-11-01",
      tiers: tiers(2000),
      reason: "negotiated rate",
    });
    expect(created.status).toBe(201);

    type Card = { classes: { classCode: string; tiers: { source: string; totalPremium: string | null }[] }[] };
    const on = (await superAdmin("GET", `/v1/admin/rates?company=${company}&asOf=2026-11-01`)).body as unknown as Card;
    const a = on.classes.find((c) => c.classCode === "A")!;
    expect(a.tiers.map((t) => t.source)).toEqual(["COMPANY", "COMPANY", "COMPANY", "COMPANY"]);
    expect(a.tiers[0]!.totalPremium).toBe("2000.00");
    expect(on.classes.find((c) => c.classCode === "B")!.tiers.every((t) => t.source === "STANDARD")).toBe(true);

    const before = (await superAdmin("GET", `/v1/admin/rates?company=${company}&asOf=2026-10-15`)).body as unknown as Card;
    expect(before.classes.find((c) => c.classCode === "A")!.tiers.every((t) => t.source === "STANDARD")).toBe(true);

    // Another company still pays the standard rate.
    const elsewhere = (await superAdmin("GET", `/v1/admin/rates?company=${other}&asOf=2026-11-01`)).body as unknown as Card;
    expect(elsewhere.classes.find((c) => c.classCode === "A")!.tiers.every((t) => t.source === "STANDARD")).toBe(true);
  });

  it("company users read their own rates but cannot change classes or rates", async () => {
    expect((await hr("GET", `/v1/admin/rates?company=${company}`)).status).toBe(200);
    expect((await hr("GET", `/v1/admin/rates?company=${other}`)).status).toBe(404);
    expect((await hr("POST", "/v1/admin/classes", { classCode: "Q", className: "No", reason: "not allowed" })).status).toBe(403);
    expect(
      (await hr("POST", "/v1/admin/rates", { classCode: "A", effectiveDate: "2027-01-01", tiers: tiers(1), reason: "not allowed" })).status,
    ).toBe(403);
    expect((await hr("PATCH", `/v1/admin/classes/${code}`, { active: false, reason: "not allowed" })).status).toBe(403);
  });

  it("a retired class stays on its members but is refused for new assignments", async () => {
    const retired = await superAdmin("PATCH", `/v1/admin/classes/${code}`, { active: false, reason: "retire" });
    expect(retired.status).toBe(200);
    expect(retired.body).toMatchObject({ active: false });
    expect(Number(retired.body["memberCount"])).toBeGreaterThan(0);

    const refused = await createMember(code);
    expect(refused.status).toBe(400);
    expect(refused.body.error?.code).toBe("CLASS_NOT_ASSIGNABLE");

    const hidden = await superAdmin("GET", "/v1/admin/classes");
    expect((hidden.body["classes"] as { classCode: string }[]).some((c) => c.classCode === code)).toBe(false);
  });

  it("billing-rule shares must total 100", async () => {
    const bad = await superAdmin("POST", `/v1/admin/companies/${company}/billing-rules`, {
      companySharePercent: "70",
      employeeSharePercent: "20",
      effectiveDate: "2026-10-01",
      reason: "split",
    });
    expect(bad.status).toBe(400);
    const ok = await superAdmin("POST", `/v1/admin/companies/${company}/billing-rules`, {
      companySharePercent: "80",
      employeeSharePercent: "20",
      effectiveDate: "2026-10-01",
      reason: "split",
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ companySharePercent: "80.00", employeeSharePercent: "20.00" });
    const list = await superAdmin("GET", `/v1/admin/companies/${company}/billing-rules`);
    expect((list.body["rules"] as unknown[]).length).toBe(1);
    expect((await hr("POST", `/v1/admin/companies/${company}/billing-rules`, { companySharePercent: "50", employeeSharePercent: "50", effectiveDate: "2027-01-01", reason: "no" })).status).toBe(403);
  });

  it.runIf(process.env["TEST_CLASS_EXHAUSTION"] === "1")("the 37th class code is refused", async () => {
    const list = await superAdmin("GET", "/v1/admin/classes?includeRetired=true");
    const used = new Set((list.body["classes"] as { classCode: string }[]).map((c) => c.classCode));
    for (const c of CODES.filter((x) => !used.has(x))) {
      expect((await superAdmin("POST", "/v1/admin/classes", { classCode: c, className: `Filler ${c}`, reason: "fill" })).status).toBe(201);
    }
    const full = await superAdmin("POST", "/v1/admin/classes", { classCode: "A", className: "One too many", reason: "fill" });
    expect(full.status).toBe(409);
    expect(full.body.error?.code).toBe("CLASS_CODES_EXHAUSTED");
  }, 60_000);
});
