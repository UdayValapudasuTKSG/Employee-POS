/**
 * SC-009, FR-016: the employee card lookup.
 *
 * Before verification: a contact that matches nobody is refused with
 * CONTACT_NOT_FOUND; otherwise one answer — CODE_SENT, same shape, at least
 * 800 ms — for one member, two in one company, or members in two companies. After verification: CARD, SELECT, or
 * MULTI_COMPANY with an alert and no card.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { describeDb, makeCompany, makeMember, startApp, useAppRoleGuard } from "./testDb";
import { makeAdmin, signIn } from "./adminFixtures";

const email = (tag: string) => `${tag}-${randomBytes(4).toString("hex")}@lookup.test`;

async function post(baseUrl: string, path: string, body: unknown) {
  const started = Date.now();
  const r = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown>, ms: Date.now() - started };
}

describeDb("employee card lookup (SC-009, FR-016)", () => {
  useAppRoleGuard();
  let app: Awaited<ReturnType<typeof startApp>>;
  const contacts = { nobody: email("nobody"), solo: email("solo"), family: email("family"), shared: email("shared"), leaver: email("leaver") };
  let A: string;
  let leaverId: number;
  // Stored with capitals, as an admin form or a carrier sheet may have entered it.
  const capitalised = `Mixed.Case-${randomBytes(4).toString("hex")}@Lookup.TEST`;
  const lockable = email("lockable");

  beforeAll(async () => {
    app = await startApp();
    A = await makeCompany("Lookup A");
    const B = await makeCompany("Lookup B");
    await makeMember({ companyNumber: A, email: contacts.solo, firstName: "Solo" });
    await makeMember({ companyNumber: A, email: capitalised, firstName: "Capital" });
    await makeMember({ companyNumber: A, email: lockable, firstName: "Locked" });
    await makeMember({ companyNumber: A, email: contacts.family, firstName: "Parent", dateOfBirth: "1980-02-02" });
    await makeMember({ companyNumber: A, email: contacts.family, firstName: "Grown", dateOfBirth: "2001-03-03" });
    await makeMember({ companyNumber: A, email: contacts.shared, firstName: "Shared" });
    await makeMember({ companyNumber: B, email: contacts.shared, firstName: "Other" });
    leaverId = (await makeMember({ companyNumber: A, email: contacts.leaver, firstName: "Leaver" })).memberId;
    // Like the other suites: a cold first start can take longer than the 10 s default.
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it("answers every matching lookup the same way, and never faster than the floor", async () => {
    const { nobody: _n, ...matching } = contacts;
    const results = await Promise.all(
      Object.values(matching).map((c) => post(app.baseUrl, "/v1/lookup", { identifier: c })),
    );
    const shapes = results.map((r) => {
      const { verificationId: _v, maskedDestination: _m, devCode: _d, ...rest } = r.body;
      return { status: r.status, rest };
    });
    // devCode is excluded: it exists only in OTP dev mode, never in production.
    for (const s of shapes) expect(s).toEqual(shapes[0]);
    expect(shapes[0]).toMatchObject({ status: 200, rest: { status: "CODE_SENT" } });
    for (const r of results) expect(r.ms).toBeGreaterThanOrEqual(790);
  });

  async function lookupAndVerify(identifier: string, code?: string) {
    const lookup = await post(app.baseUrl, "/v1/lookup", { identifier });
    return post(app.baseUrl, "/v1/otp/verify", {
      verificationId: lookup.body["verificationId"],
      code: code ?? (lookup.body["devCode"] as string | null) ?? "000000",
    });
  }

  it("issues a card for a single match", async () => {
    const v = await lookupAndVerify(contacts.solo);
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ status: "CARD", message: null, options: null });
    expect(typeof v.body["cardToken"]).toBe("string");
  });

  it("finds an email stored with capitals, however the employee types it", async () => {
    for (const typed of [capitalised.toLowerCase(), capitalised, ` ${capitalised.toUpperCase()} `]) {
      const v = await lookupAndVerify(typed);
      expect(v.body, typed).toMatchObject({ status: "CARD" });
    }
  });

  it("lets support clear a lockout, which is what SESSION_MANAGE is for", async () => {
    const lookup = await post(app.baseUrl, "/v1/lookup", { identifier: lockable });
    const verificationId = lookup.body["verificationId"] as string;
    const wrong = lookup.body["devCode"] === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i++) await post(app.baseUrl, "/v1/otp/verify", { verificationId, code: wrong });

    const auditor = await signIn(app.baseUrl, (await makeAdmin("ROLE_AUDITOR")).email);
    expect((await auditor("POST", `/v1/admin/verifications/${verificationId}/reset-lock`, { reason: "caller locked out" })).status).toBe(403);

    const support = await signIn(app.baseUrl, (await makeAdmin("ROLE_SUPPORT")).email);
    const unlocked = await support("POST", `/v1/admin/verifications/${verificationId}/reset-lock`, { reason: "caller locked out" });
    expect(unlocked.status).toBe(200);
    expect(unlocked.body).toMatchObject({ status: "PENDING", attempts: 0 });

    // The member can now verify with the code they already had.
    const v = await post(app.baseUrl, "/v1/otp/verify", { verificationId, code: lookup.body["devCode"] });
    expect(v.body).toMatchObject({ status: "CARD" });
  });

  it("asks which record after verification when two in one company share the contact", async () => {
    const lookup = await post(app.baseUrl, "/v1/lookup", { identifier: contacts.family });
    const v = await post(app.baseUrl, "/v1/otp/verify", {
      verificationId: lookup.body["verificationId"],
      code: lookup.body["devCode"],
    });
    expect(v.body).toMatchObject({ status: "SELECT", cardToken: null });
    const options = v.body["options"] as { ref: string; label: string }[];
    expect(options).toHaveLength(2);
    expect(options.map((o) => o.label).join(" ")).not.toMatch(/Parent|Grown|Member/);
    const chosen = await post(app.baseUrl, "/v1/otp/select", {
      verificationId: lookup.body["verificationId"],
      optionRef: options[0]!.ref,
    });
    expect(chosen.body).toMatchObject({ status: "CARD" });
    // An option from one verification cannot be replayed against another.
    const other = await post(app.baseUrl, "/v1/lookup", { identifier: contacts.family });
    const replay = await post(app.baseUrl, "/v1/otp/select", {
      verificationId: other.body["verificationId"],
      optionRef: options[0]!.ref,
    });
    expect(replay.status).toBe(400);
  });

  it("gives no card, names no company and raises an alert for a multi-company match", async () => {
    const lookup = await post(app.baseUrl, "/v1/lookup", { identifier: contacts.shared });
    const v = await post(app.baseUrl, "/v1/otp/verify", {
      verificationId: lookup.body["verificationId"],
      code: lookup.body["devCode"],
    });
    expect(v.body).toMatchObject({
      status: "MULTI_COMPANY",
      cardToken: null,
      message: "Your details were found in more than one company. Please contact your HR department.",
    });
    expect(JSON.stringify(v.body)).not.toContain(A);
    const db = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const alerts = await db.db
      .select()
      .from(db.employeeSessionsTable)
      .where(eq(db.employeeSessionsTable.id, lookup.body["verificationId"] as string));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.alertStatus).toBe("OPEN");
    expect(alerts[0]!.alertMatches).toHaveLength(2);
    expect(alerts[0]!.maskedDestination).not.toContain(contacts.shared);
  });

  it("refuses a contact that matches nobody, and starts no verification", async () => {
    const byEmail = await post(app.baseUrl, "/v1/lookup", { identifier: contacts.nobody });
    expect(byEmail.status).toBe(404);
    expect(byEmail.body["error"]).toMatchObject({ code: "CONTACT_NOT_FOUND", message: expect.stringMatching(/correct email/) });
    expect(byEmail.body["verificationId"]).toBeUndefined();
    expect(byEmail.ms).toBeGreaterThanOrEqual(790);
    const byPhone = await post(app.baseUrl, "/v1/lookup", { identifier: "+1 555 000 9999" });
    expect(byPhone.status).toBe(404);
    expect(byPhone.body["error"]).toMatchObject({ code: "CONTACT_NOT_FOUND", message: expect.stringMatching(/correct mobile number/) });
  });

  it("stops counting a member who is deactivated between lookup and verify", async () => {
    const lookup = await post(app.baseUrl, "/v1/lookup", { identifier: contacts.leaver });
    const db = await import("@workspace/db");
    const { setActive } = await import("../lib/statusHistory");
    await db.withScope(db.SYSTEM_SCOPE, (tx) =>
      setActive(tx, { entityType: "MEMBER", id: leaverId, active: false, reason: "Left mid-lookup", actor: "TEST" }),
    );
    const v = await post(app.baseUrl, "/v1/otp/verify", {
      verificationId: lookup.body["verificationId"],
      code: lookup.body["devCode"],
    });
    expect(v.status).toBe(400);
    expect((v.body["error"] as { code: string }).code).toBe("CODE_INVALID");
  });

  it.runIf(process.env["LOOKUP_TIMING"] === "1")(
    "takes the same time for every outcome: medians within 50 ms over 200 runs",
    async () => {
      const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      const medians: number[] = [];
      for (const c of [contacts.solo, contacts.family, contacts.shared]) {
        const times: number[] = [];
        for (let i = 0; i < 200; i++) times.push((await post(app.baseUrl, "/v1/lookup", { identifier: c })).ms);
        medians.push(median(times));
      }
      expect(Math.max(...medians) - Math.min(...medians)).toBeLessThan(50);
    },
    20 * 60_000,
  );
});
