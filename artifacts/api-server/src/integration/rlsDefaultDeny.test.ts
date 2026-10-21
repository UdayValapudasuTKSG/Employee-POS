/**
 * FR-011: segregation does not depend on a query remembering its company
 * filter. Row-level security (deploy/db/schema.sql) answers an unfiltered SELECT
 * with the caller's own company's rows only, a query with no scope with
 * nothing at all, and refuses writes outside the scope.
 */
import { beforeAll, expect, it } from "vitest";
import { describeDb, makeCompany, makeMember, useAppRoleGuard } from "./testDb";

interface Fixture {
  company: string;
  memberId: number;
}

async function seedCompany(): Promise<Fixture> {
  const db = await import("@workspace/db");
  const company = await makeCompany("RLS test");
  const { memberId } = await makeMember({ companyNumber: company });
  await db.withScope(db.SYSTEM_SCOPE, async (tx) => {
    await tx.insert(db.bhiDependentTable).values({
      memberId, dependentFullName: "Dep Endant", relationship: "CHILD", active: true,
    });
    await tx.insert(db.bhiBeneficiaryTable).values({
      memberId, beneficiaryFullName: "Bene Ficiary", active: true,
    });
    await tx.insert(db.bhiBillingRunTable).values({
      companyNumber: company, billingMonth: "2026-10-01", billingDate: "2026-10-01", status: "DRAFT",
    });
    const [batch] = await tx
      .insert(db.importBatchTable)
      .values({
        companyNumber: company,
        kind: "BULK_IMPORT",
        sourceFile: `${company}-rls-test.xlsx`,
        createdBy: "TEST",
      })
      .returning();
    await tx.insert(db.bhiImportExceptionTable).values({
      sourceAlias: "BULK_IMPORT", sourceFile: batch!.sourceFile, entityType: "MEMBER", personName: "Held Person",
    });
  });
  return { company, memberId };
}

/** Runs one statement with the given raw scope settings, then rolls back. */
async function asScope<T = Record<string, unknown>>(
  settings: { all?: boolean; companies?: string[]; readOnly?: boolean } | null,
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: T[]; error?: string }> {
  const { pool } = await import("@workspace/db");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (settings) {
      await client.query(
        "SELECT set_config('bhi.all', $1, true), set_config('bhi.companies', $2, true), set_config('bhi.readonly', $3, true)",
        [settings.all ? "on" : "off", (settings.companies ?? []).join(","), settings.readOnly ? "on" : "off"],
      );
    }
    const res = await client.query(sql, params);
    return { rows: res.rows as T[] };
  } catch (err) {
    return { rows: [], error: (err as { code?: string }).code ?? "error" };
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

describeDb("row-level security fails closed (FR-011)", () => {
  useAppRoleGuard();
  let A: Fixture;
  let B: Fixture;

  beforeAll(async () => {
    A = await seedCompany();
    B = await seedCompany();
  });

  const companyTables = [
    "company", "member", "dependent", "beneficiary", "billing_run", "import_exception",
    "enrollment_status_history", "billing_line", "company_billing_rule",
  ];

  it.each(companyTables)("shows no rows of bhi.%s when no scope is set", async (t) => {
    const { rows, error } = await asScope<{ n: string }>(null, `SELECT count(*) AS n FROM bhi.${t}`);
    expect(error).toBeUndefined();
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it("still shows the shared classes with no scope", async () => {
    const { rows } = await asScope<{ n: string }>(null, "SELECT count(*) AS n FROM bhi.class");
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(3);
  });

  it("answers an unfiltered SELECT with the caller's own company only", async () => {
    const members = await asScope<{ company_number: string }>(
      { companies: [A.company] },
      "SELECT DISTINCT company_number FROM bhi.member",
    );
    expect(members.rows.map((r) => r.company_number)).toEqual([A.company]);

    for (const [table, fk] of [["dependent", "member_id"], ["beneficiary", "member_id"]] as const) {
      const r = await asScope<{ member_id: number }>(
        { companies: [A.company] },
        `SELECT DISTINCT ${fk} AS member_id FROM bhi.${table} WHERE ${fk} IN ($1, $2)`,
        [A.memberId, B.memberId],
      );
      expect(r.rows.map((x) => x.member_id), table).toEqual([A.memberId]);
    }

    const runs = await asScope<{ company_number: string }>(
      { companies: [A.company] },
      "SELECT DISTINCT company_number FROM bhi.billing_run",
    );
    expect(runs.rows.map((r) => r.company_number)).toEqual([A.company]);

    const exceptions = await asScope<{ source_file: string }>(
      { companies: [A.company] },
      "SELECT source_file FROM bhi.import_exception",
    );
    expect(exceptions.rows.every((r) => r.source_file.startsWith(A.company))).toBe(true);
    expect(exceptions.rows.length).toBeGreaterThan(0);
  });

  it("refuses to write a member of a company outside the scope", async () => {
    const { error } = await asScope(
      { companies: [A.company] },
      `INSERT INTO bhi.member (id_type, id_number, company_number, last_name, first_name, class_code, active)
       VALUES ('NATIONAL ID', 'RLS-X-' || md5(random()::text), $1, 'Out', 'Scope', 'A', true)`,
      [B.company],
    );
    expect(error).toBe("42501");
  });

  it("refuses a company-scoped UPDATE of another company's member, silently matching nothing", async () => {
    const { rows } = await asScope<{ member_id: number }>(
      { companies: [A.company] },
      "UPDATE bhi.member SET notes = 'x' WHERE member_id = $1 RETURNING member_id",
      [B.memberId],
    );
    expect(rows).toEqual([]);
  });

  it("refuses any write from a read-only scope, even with every company visible", async () => {
    const { error } = await asScope(
      { all: true, readOnly: true },
      "UPDATE bhi.member SET notes = 'x' WHERE member_id = $1",
      [A.memberId],
    );
    expect(error).toBe("42501");
  });

  it("shows standard rates to everyone but lets only the all-companies scope write them", async () => {
    const insertRate = `INSERT INTO bhi.premium_rates
        (company_number, class_code, coverage_band, coverage_label, dependent_band,
         total_premium, company_premium, employee_premium, effective_date, active)
      VALUES (NULL, 'A', 'EMP_ONLY', 'Employee only', 0, 1, 1, 0, $1::date, true)`;
    const scoped = await asScope({ companies: [A.company] }, insertRate, ["2099-01-01"]);
    expect(scoped.error).toBe("42501");
    const all = await asScope({ all: true }, insertRate, ["2099-01-02"]);
    expect(all.error).toBeUndefined();
  });
});
