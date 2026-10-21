/**
 * SC-005, FR-028 to FR-036: monthly bills, checked line by line against a
 * hand-calculated table, to the cent.
 *
 * Every change in the fixture is recorded at an explicit moment around the
 * month boundaries (00:00 Guyana time = 04:00 UTC on the 1st), so what each
 * bill must contain follows from research R11 alone.
 *
 * Standard rates (the placeholder card, from 2026-10-01):
 *   A: EMP_ONLY 5000/4000/1000  EMP_PLUS_1 9000/7200/1800  EMP_PLUS_2 12000/9600/2400  EMP_PLUS_3PLUS 14000/11200/2800
 *   B: EMP_ONLY 4000/3200/800   EMP_PLUS_1 7000/5600/1400  EMP_PLUS_2 9500/7600/1900   EMP_PLUS_3PLUS 11000/8800/2200
 *   C: EMP_ONLY 3000/2400/600   ...
 * Company CR has its own class A rate from 2026-09-01; company RR splits 70/30
 * from 2026-10-01.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { describeDb, makeCompany, randomIdNumber, startApp, useAppRoleGuard } from "./testDb";
import { makeAdmin, signIn, type AdminClient } from "./adminFixtures";

type Db = typeof import("@workspace/db");
type Tx = import("@workspace/db").ScopedTx;

/** Noon in Guyana on a date: safely inside that day. */
const g = (date: string) => new Date(Date.parse(`${date}T16:00:00Z`));

interface Person {
  name: string;
  created: Date;
  classCode: string;
  deps?: { created: Date; off?: Date }[];
  classChanges?: { code: string; at: Date }[];
  status?: { active: boolean; at: Date }[];
}

/** [name, class, dependants, band, total, company, employee] */
type Line = [string, string, number, string, string, string, string];

describeDb("monthly billing (FR-028 to FR-036)", () => {
  useAppRoleGuard();
  let db: Db;
  let runs: typeof import("../lib/billing/runs");
  let app: Awaited<ReturnType<typeof startApp>>;
  let superAdmin: AdminClient;
  let clientAdmin: AdminClient;
  let S: string; // standard rates only
  let CR: string; // its own class A rate
  let RR: string; // a 70/30 billing rule
  const actor = { email: "billing-test@integration.test", role: "ROLE_PLATFORM_ADMIN" };

  async function person(tx: Tx, companyNumber: string, p: Person): Promise<void> {
    const { setActive } = await import("../lib/statusHistory");
    const [first, last] = p.name.split(" ") as [string, string];
    const [m] = await tx
      .insert(db.bhiMemberTable)
      .values({
        companyNumber,
        idType: "NATIONAL ID",
        idNumber: randomIdNumber(),
        firstName: first,
        lastName: last,
        classCode: p.classCode,
        active: true,
        createdAt: p.created,
      })
      .returning();
    const memberId = m!.memberId;
    await tx.insert(db.memberClassHistoryTable).values({ memberId, classCode: p.classCode, recordedAt: p.created, recordedBy: "TEST" });
    const events: { at: Date; run: () => Promise<unknown> }[] = [];
    for (const [i, d] of (p.deps ?? []).entries()) {
      const [dep] = await tx
        .insert(db.bhiDependentTable)
        .values({ memberId, dependentFullName: `Dep${i} ${last}`, relationship: "CHILD", active: true, createdAt: d.created })
        .returning();
      if (d.off) {
        const off = d.off;
        events.push({ at: off, run: () => setActive(tx, { entityType: "DEPENDENT", id: dep!.dependentId, active: false, reason: "Left the plan", actor: "TEST", changedAt: off }) });
      }
    }
    for (const c of p.classChanges ?? []) {
      events.push({
        at: c.at,
        run: async () => {
          await tx.update(db.bhiMemberTable).set({ classCode: c.code }).where(eq(db.bhiMemberTable.memberId, memberId));
          await tx.insert(db.memberClassHistoryTable).values({ memberId, classCode: c.code, recordedAt: c.at, recordedBy: "TEST" });
        },
      });
    }
    for (const s of p.status ?? []) {
      events.push({ at: s.at, run: () => setActive(tx, { entityType: "MEMBER", id: memberId, active: s.active, reason: s.active ? "Back" : "Left the company", actor: "TEST", changedAt: s.at }) });
    }
    // In time order, as they would have happened.
    for (const e of events.sort((a, b) => a.at.getTime() - b.at.getTime())) await e.run();
  }

  const tiers = (base: [string, string, string][]) =>
    base.map(([total, company, employee], band) => ({ total, company, employee, band }));

  beforeAll(async () => {
    app = await startApp(); // also loads the standard rate card
    db = await import("@workspace/db");
    runs = await import("../lib/billing/runs");
    S = await makeCompany("Billing standard");
    CR = await makeCompany("Billing company rate");
    RR = await makeCompany("Billing split rule");
    superAdmin = await signIn(app.baseUrl, (await makeAdmin("ROLE_PLATFORM_ADMIN")).email);
    clientAdmin = await signIn(app.baseUrl, (await makeAdmin("ROLE_CLIENT_ADMIN", { companyScope: S })).email);

    await db.withScope(db.SYSTEM_SCOPE, async (tx) => {
      const aug = g("2026-08-01");
      // --- S: standard rates only ---------------------------------------------
      await person(tx, S, { name: "Ann One", created: g("2026-08-15"), classCode: "A" });
      await person(tx, S, { name: "Ben Two", created: g("2026-08-15"), classCode: "B", deps: [{ created: g("2026-08-15") }, { created: g("2026-09-20") }] });
      // Added one hour after 00:00 on 1 Oct (Guyana): billed from November.
      await person(tx, S, { name: "Cal Three", created: new Date("2026-10-01T05:00:00Z"), classCode: "A" });
      // Added one minute before 00:00 on 1 Oct (Guyana): billed in October.
      await person(tx, S, { name: "Dee Four", created: new Date("2026-10-01T03:59:00Z"), classCode: "A" });
      // Removed mid-October: billed in October, not November.
      await person(tx, S, { name: "Eve Five", created: aug, classCode: "C", status: [{ active: false, at: g("2026-10-15") }] });
      // Removed on 30 September: not billed in October.
      await person(tx, S, { name: "Fay Six", created: aug, classCode: "A", status: [{ active: false, at: g("2026-09-30") }] });
      // Class change and a new dependant on 10 Oct: both count from November.
      await person(tx, S, {
        name: "Gus Seven",
        created: aug,
        classCode: "A",
        classChanges: [{ code: "B", at: g("2026-10-10") }],
        deps: [{ created: g("2026-10-10") }],
      });
      // Seven dependants, one gone in September: six, still the flat top tier.
      await person(tx, S, {
        name: "Hal Eight",
        created: aug,
        classCode: "A",
        deps: [{ created: aug, off: g("2026-09-15") }, ...Array.from({ length: 6 }, () => ({ created: aug }))],
      });
      // Three dependants, one gone before October: two.
      await person(tx, S, { name: "Ida Nine", created: aug, classCode: "A", deps: [{ created: aug }, { created: aug }, { created: aug, off: g("2026-09-10") }] });
      // quickstart §6.
      await person(tx, S, {
        name: "Jo Quick",
        created: g("2026-09-10"),
        classCode: "A",
        deps: [{ created: g("2026-09-10") }, { created: g("2026-09-20") }, { created: g("2026-10-03") }],
        classChanges: [{ code: "B", at: g("2026-10-03") }],
        status: [{ active: false, at: g("2026-10-15") }],
      });
      await person(tx, S, {
        name: "Kim Quick",
        created: g("2026-09-10"),
        classCode: "A",
        deps: [{ created: g("2026-09-10") }, { created: g("2026-09-20") }, { created: g("2026-10-03") }],
        classChanges: [{ code: "B", at: g("2026-10-03") }],
        status: [{ active: false, at: g("2026-10-15") }, { active: true, at: g("2026-10-20") }],
      });

      // --- CR: its own class A rate from 1 September -------------------------------
      for (const t of tiers([
        ["6000.00", "4500.00", "1500.00"],
        ["7000.00", "5250.00", "1750.00"],
        ["8000.00", "6000.00", "2000.00"],
        ["9000.00", "6750.00", "2250.00"],
      ])) {
        const band = ["EMP_ONLY", "EMP_PLUS_1", "EMP_PLUS_2", "EMP_PLUS_3PLUS"][t.band]!;
        await tx.insert(db.bhiPremiumRatesTable).values({
          companyNumber: CR,
          classCode: "A",
          coverageBand: band,
          coverageLabel: band,
          dependentBand: t.band,
          totalPremium: t.total,
          companyPremium: t.company,
          employeePremium: t.employee,
          effectiveDate: "2026-09-01",
          active: true,
        });
      }
      await person(tx, CR, { name: "Lee Comp", created: aug, classCode: "A", deps: [{ created: aug }] });
      await person(tx, CR, { name: "Max Std", created: aug, classCode: "B" });

      // --- RR: 70/30 from 1 October ----------------------------------------------
      await tx.insert(db.bhiCompanyBillingRuleTable).values({
        companyNumber: RR,
        companySharePercent: "70",
        employeeSharePercent: "30",
        effectiveDate: "2026-10-01",
        active: true,
      });
      await person(tx, RR, { name: "Ned Split", created: aug, classCode: "A" });
      await person(tx, RR, { name: "Oda Split", created: aug, classCode: "B", deps: [{ created: aug }, { created: aug }] });
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  const linesOf = async (runId: number): Promise<Line[]> => {
    const r = await superAdmin("GET", `/v1/admin/billing/runs/${runId}`);
    expect(r.status).toBe(200);
    return (r.body["lines"] as Record<string, unknown>[])
      .map((l) => [l["memberName"], l["classCode"], l["activeDependentCount"], l["coverageBand"], l["totalPremium"], l["companyPremium"], l["employeePremium"]] as Line)
      .sort((a, b) => a[0].localeCompare(b[0]));
  };

  const generate = async (company: string, month: string, now: Date) => {
    const r = await runs.generateRun(company, month, actor, now);
    if (r.status !== "DRAFT") throw new Error(`expected a draft, got ${r.status}`);
    return r;
  };

  let octS: number;

  it("September: nobody is priced before the standard card starts", async () => {
    const sep = await generate(S, "2026-09", g("2026-09-02"));
    // Ann, Ben, Eve, Fay, Gus, Hal, Ida: created before 1 Sep and active then.
    expect(sep).toMatchObject({ lines: 0, issues: 7 });
    const fin = await superAdmin("POST", `/v1/admin/billing/runs/${sep.runId}/finalise`, { reason: "try" });
    expect(fin.status).toBe(409);
    expect(fin.body.error?.code).toBe("RUN_HAS_ISSUES");
  });

  it("October: the state at 00:00 on 1 October, though generated on 5 October", async () => {
    const oct = await generate(S, "2026-10", g("2026-10-05"));
    octS = oct.runId;
    expect(await linesOf(oct.runId)).toEqual<Line[]>([
      ["Ann One", "A", 0, "EMP_ONLY", "5000.00", "4000.00", "1000.00"],
      ["Ben Two", "B", 2, "EMP_PLUS_2", "9500.00", "7600.00", "1900.00"],
      ["Dee Four", "A", 0, "EMP_ONLY", "5000.00", "4000.00", "1000.00"],
      ["Eve Five", "C", 0, "EMP_ONLY", "3000.00", "2400.00", "600.00"],
      ["Gus Seven", "A", 0, "EMP_ONLY", "5000.00", "4000.00", "1000.00"],
      ["Hal Eight", "A", 6, "EMP_PLUS_3PLUS", "14000.00", "11200.00", "2800.00"],
      ["Ida Nine", "A", 2, "EMP_PLUS_2", "12000.00", "9600.00", "2400.00"],
      ["Jo Quick", "A", 2, "EMP_PLUS_2", "12000.00", "9600.00", "2400.00"],
      ["Kim Quick", "A", 2, "EMP_PLUS_2", "12000.00", "9600.00", "2400.00"],
    ]);
    expect(oct.issues).toBe(0);
    expect(oct.totals).toEqual({ totalPremium: "77500.00", companyPremium: "62000.00", employeePremium: "15500.00" });
    const detail = await superAdmin("GET", `/v1/admin/billing/runs/${oct.runId}`);
    expect((detail.body["run"] as Record<string, unknown>)["billingDate"]).toBe("2026-10-05");
  });

  it("November: October's additions, removals, class changes and new dependants", async () => {
    const nov = await generate(S, "2026-11", g("2026-11-03"));
    expect(await linesOf(nov.runId)).toEqual<Line[]>([
      ["Ann One", "A", 0, "EMP_ONLY", "5000.00", "4000.00", "1000.00"],
      ["Ben Two", "B", 2, "EMP_PLUS_2", "9500.00", "7600.00", "1900.00"],
      ["Cal Three", "A", 0, "EMP_ONLY", "5000.00", "4000.00", "1000.00"],
      ["Dee Four", "A", 0, "EMP_ONLY", "5000.00", "4000.00", "1000.00"],
      ["Gus Seven", "B", 1, "EMP_PLUS_1", "7000.00", "5600.00", "1400.00"],
      ["Hal Eight", "A", 6, "EMP_PLUS_3PLUS", "14000.00", "11200.00", "2800.00"],
      ["Ida Nine", "A", 2, "EMP_PLUS_2", "12000.00", "9600.00", "2400.00"],
      ["Kim Quick", "B", 3, "EMP_PLUS_3PLUS", "11000.00", "8800.00", "2200.00"],
    ]);
  });

  it("recalculating a draft supersedes it and keeps its lines", async () => {
    const before = await generate(S, "2026-11", g("2026-11-04"));
    const again = await generate(S, "2026-11", g("2026-11-05"));
    expect(again.supersededRunId).toBe(before.runId);
    const old = await superAdmin("GET", `/v1/admin/billing/runs/${before.runId}`);
    expect((old.body["run"] as Record<string, unknown>)["status"]).toBe("SUPERSEDED");
    expect((old.body["lines"] as unknown[]).length).toBe(8);
    const listed = await superAdmin("GET", `/v1/admin/billing/runs?company=${S}&month=2026-11`);
    expect((listed.body["runs"] as { billingRunId: number }[]).map((r) => r.billingRunId)).toEqual([again.runId]);
  });

  it("a company rate beats the standard rate; a missing rate is an issue", async () => {
    const sep = await generate(CR, "2026-09", g("2026-09-02"));
    expect(await linesOf(sep.runId)).toEqual<Line[]>([["Lee Comp", "A", 1, "EMP_PLUS_1", "7000.00", "5250.00", "1750.00"]]);
    expect(sep.issues).toBe(1); // Max, class B: no standard rate before October
    const oct = await generate(CR, "2026-10", g("2026-10-02"));
    expect(await linesOf(oct.runId)).toEqual<Line[]>([
      ["Lee Comp", "A", 1, "EMP_PLUS_1", "7000.00", "5250.00", "1750.00"],
      ["Max Std", "B", 0, "EMP_ONLY", "4000.00", "3200.00", "800.00"],
    ]);
    const detail = await superAdmin("GET", `/v1/admin/billing/runs/${oct.runId}`);
    const sources = Object.fromEntries((detail.body["lines"] as { memberName: string; rateSource: string }[]).map((l) => [l.memberName, l.rateSource]));
    expect(sources).toEqual({ "Lee Comp": "COMPANY", "Max Std": "STANDARD" });
  });

  it("a 70/30 billing rule splits total × 0.70 and the remainder", async () => {
    const oct = await generate(RR, "2026-10", g("2026-10-02"));
    expect(await linesOf(oct.runId)).toEqual<Line[]>([
      ["Ned Split", "A", 0, "EMP_ONLY", "5000.00", "3500.00", "1500.00"],
      ["Oda Split", "B", 2, "EMP_PLUS_2", "9500.00", "6650.00", "2850.00"],
    ]);
  });

  it("a finalised run is frozen, and so are the rates it used", async () => {
    const fin = await superAdmin("POST", `/v1/admin/billing/runs/${octS}/finalise`, { reason: "October approved" });
    expect(fin.status).toBe(200);
    expect(fin.body).toMatchObject({ status: "FINAL", lineCount: 9 });
    expect((await runs.generateRun(S, "2026-10", actor, g("2026-10-06"))).status).toBe("ALREADY_FINAL");
    const again = await superAdmin("POST", `/v1/admin/billing/runs/${octS}/finalise`, { reason: "twice" });
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("RUN_NOT_DRAFT");

    const sqlState = async (fn: (tx: Tx) => Promise<unknown>) => {
      try {
        await db.withScope(db.SYSTEM_SCOPE, fn);
        return "no error";
      } catch (err) {
        const e = err as { code?: string; cause?: { code?: string } };
        return e.cause?.code ?? e.code ?? "unknown";
      }
    };
    expect(await sqlState((tx) => tx.update(db.bhiBillingLineTable).set({ totalPremium: "1.00" }).where(eq(db.bhiBillingLineTable.billingRunId, octS)))).toBe("BHF01");
    expect(await sqlState((tx) => tx.update(db.bhiBillingRunTable).set({ notes: "edited" }).where(eq(db.bhiBillingRunTable.billingRunId, octS)))).toBe("BHF01");

    // Freeze CR's October too, then try to change the company rate it used.
    const cr = await superAdmin("GET", `/v1/admin/billing/runs?company=${CR}&month=2026-10`);
    const crRun = (cr.body["runs"] as { billingRunId: number }[])[0]!.billingRunId;
    expect((await superAdmin("POST", `/v1/admin/billing/runs/${crRun}/finalise`, { reason: "CR October approved" })).status).toBe(200);
    const [used] = await db.withScope(db.SYSTEM_SCOPE, (tx) =>
      tx.select().from(db.bhiBillingLineTable).where(eq(db.bhiBillingLineTable.billingRunId, crRun)),
    );
    const rateId = used!.premiumRateId!;
    expect(await sqlState((tx) => tx.update(db.bhiPremiumRatesTable).set({ totalPremium: "1.00" }).where(eq(db.bhiPremiumRatesTable.premiumRateId, rateId)))).toBe("BHF01");
    expect(await sqlState((tx) => tx.update(db.bhiPremiumRatesTable).set({ notes: "annotated" }).where(eq(db.bhiPremiumRatesTable.premiumRateId, rateId)))).toBe("no error");
  });

  it("a client admin sees only its own company's runs", async () => {
    const mine = await clientAdmin("GET", "/v1/admin/billing/runs");
    expect(mine.status).toBe(200);
    const companies = new Set((mine.body["runs"] as { companyNumber: string }[]).map((r) => r.companyNumber));
    expect([...companies]).toEqual([S]);
    const cr = await superAdmin("GET", `/v1/admin/billing/runs?company=${CR}`);
    const other = (cr.body["runs"] as { billingRunId: number }[])[0]!.billingRunId;
    expect((await clientAdmin("GET", `/v1/admin/billing/runs/${other}`)).status).toBe(404);
    expect((await clientAdmin("POST", "/v1/admin/billing/runs", { month: "2026-12", companies: [S] })).status).toBe(403);
    const csv = await fetch(`${app.baseUrl}/v1/admin/billing/runs/${octS}/export.csv`, { headers: {} });
    expect(csv.status).toBe(401);
  });
});
