/**
 * Constitution Principle III: no hard-delete path. The application role cannot
 * DELETE any shared BHI table, and the audit log is insert-only — enforced by
 * grants (deploy/db/migrations/001_roles_grants.sql), so it holds whatever the code does.
 */
import { expect, it } from "vitest";
import { describeDb, useAppRoleGuard } from "./testDb";

async function attempt(sql: string): Promise<string> {
  const { pool } = await import("@workspace/db");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('bhi.all', 'on', true)");
    await client.query(sql);
    return "succeeded";
  } catch (err) {
    return (err as { code?: string }).code ?? "error";
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

describeDb("no delete path for the application role (Constitution III)", () => {
  useAppRoleGuard();

  // Every table in the one schema: the client's and the portal's.
  const bhiTables = [
    "company", "class", "member", "dependent", "beneficiary", "premium_rates",
    "billing_run", "billing_line", "company_billing_rule", "enrollment_status_history", "import_exception",
    "activity_log", "admin_users", "billing_run_issues", "change_requests",
    "employee_sessions", "import_batch", "import_exception_resolutions", "member_class_history",
    "policy_memberships",
  ];

  it.each(bhiTables)("cannot DELETE from bhi.%s, even with every company in scope", async (t) => {
    expect(await attempt(`DELETE FROM bhi.${t}`)).toBe("42501");
  });

  it.each(bhiTables)("cannot TRUNCATE bhi.%s", async (t) => {
    expect(await attempt(`TRUNCATE bhi.${t}`)).toBe("42501");
  });

  it("cannot rewrite or delete the audit log", async () => {
    expect(await attempt("UPDATE bhi.activity_log SET reason = 'rewritten'")).toBe("42501");
    expect(await attempt("DELETE FROM bhi.activity_log")).toBe("42501");
  });

  it("can still append to the audit log", async () => {
    expect(
      await attempt(
        "INSERT INTO bhi.activity_log (kind, actor, actor_role, action, entity_type) VALUES ('AUDIT', 'test', 'TEST', 'GRANTS_TEST', 'TEST')",
      ),
    ).toBe("succeeded");
  });

  it("has no pre-BHI member tables left anywhere", async () => {
    const { pool } = await import("@workspace/db");
    const { rows } = await pool.query(
      `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND c.relname IN ('companies', 'employee_members', 'dependents', 'beneficiaries', 'legacy_key_map')`,
    );
    expect(rows.map((r) => r.name)).toEqual([]);
  });
});
