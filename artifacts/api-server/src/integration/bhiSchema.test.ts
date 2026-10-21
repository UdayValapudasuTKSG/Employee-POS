/**
 * SC-001: the live "bhi" schema holds exactly the client's BHI Enrollment
 * Database tables the application uses — 11 tables, their columns, sizes,
 * required flags, keys, indexes and the R1–R8 relationships, plus only the
 * documented deviations D1–D3, with row-level security forced on each — and,
 * beside them, exactly the portal's own 10 tables.
 *
 * The expectation (fixtures/bhiSchemaExpected.ts) is generated from
 * specs/002-per-company-schema/contracts/bhi-schema.sql, not from the
 * migration, so this compares the database with the client's model rather than
 * with itself. Reads pg_catalog: some information_schema views hide
 * constraints from a role that does not own the table.
 */
import { expect, it } from "vitest";
import { describeDb, useAppRoleGuard } from "./testDb";
import { EXPECTED_INDEXES, EXPECTED_TABLES } from "./fixtures/bhiSchemaExpected";

const ACTION: Record<string, "CASCADE" | "RESTRICT" | "NO ACTION" | "SET NULL" | "SET DEFAULT"> = {
  c: "CASCADE",
  r: "RESTRICT",
  a: "NO ACTION",
  n: "SET NULL",
  d: "SET DEFAULT",
};

async function q<T>(text: string): Promise<T[]> {
  const { pool } = await import("@workspace/db");
  return (await pool.query(text)).rows as T[];
}

/** The portal's own tables, kept beside the client's in the one schema. */
const PLATFORM_TABLES = ["activity_log", "admin_users", "billing_run_issues", "change_requests", "discount_coupons", "employee_sessions", "import_batch", "import_exception_resolutions", "member_class_history", "policy_memberships"];
const CLIENT_TABLES = Object.keys(EXPECTED_TABLES);
const inClientTables = `(${CLIENT_TABLES.map((t) => `'${t}'`).join(", ")})`;

describeDb("bhi schema matches the client's BHI Enrollment Database (SC-001)", () => {
  useAppRoleGuard();

  it("has exactly the 11 client tables and the 10 portal tables, and nothing else", async () => {
    const rows = await q<{ relname: string }>(
      "SELECT relname FROM pg_class WHERE relnamespace = 'bhi'::regnamespace AND relkind IN ('r','p','v','m','f') ORDER BY 1",
    );
    expect(rows.map((r) => r.relname)).toEqual([...CLIENT_TABLES, ...PLATFORM_TABLES].sort());
  });

  it("leaves no tables in public", async () => {
    const rows = await q<{ relname: string }>(
      "SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p','v','m','f')",
    );
    expect(rows).toEqual([]);
  });

  it("has every column with its type, size, required flag and identity", async () => {
    const rows = await q<{
      table_name: string;
      column_name: string;
      data_type: string;
      character_maximum_length: number | null;
      numeric_precision: number | null;
      numeric_scale: number | null;
      is_nullable: "YES" | "NO";
      is_identity: "YES" | "NO";
    }>(
      `SELECT table_name, column_name, data_type, character_maximum_length,
              numeric_precision, numeric_scale, is_nullable, is_identity
         FROM information_schema.columns
        WHERE table_schema = 'bhi' AND table_name IN ${inClientTables}
        ORDER BY table_name, ordinal_position`,
    );
    const actual: Record<string, unknown[]> = {};
    for (const r of rows) {
      (actual[r.table_name] ??= []).push({
        name: r.column_name,
        dataType: r.data_type,
        charMaxLength: r.character_maximum_length,
        numericPrecision: r.numeric_precision,
        numericScale: r.numeric_scale,
        nullable: r.is_nullable === "YES",
        identity: r.is_identity === "YES",
      });
    }
    let count = 0;
    for (const [table, t] of Object.entries(EXPECTED_TABLES)) {
      expect(actual[table], table).toEqual(t.columns);
      count += t.columns.length;
    }
    expect(count).toBe(149); // the 11 tables' columns in the Access file, + D1
  });

  it("has every primary key, unique key and foreign key, with R1–R8 actions", async () => {
    const rows = await q<{
      table: string;
      name: string;
      contype: "p" | "u" | "f";
      columns: string[];
      ref_table: string | null;
      ref_columns: string[] | null;
      upd: string;
      del: string;
      nulls_not_distinct: boolean | null;
    }>(
      `SELECT rel.relname AS table, con.conname AS name, con.contype,
              ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
                      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n
                     ORDER BY k.i)::text[] AS columns,
              ref.relname AS ref_table,
              ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, i)
                      JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n
                     ORDER BY k.i)::text[] AS ref_columns,
              con.confupdtype AS upd, con.confdeltype AS del,
              idx.indnullsnotdistinct AS nulls_not_distinct
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         LEFT JOIN pg_class ref ON ref.oid = con.confrelid
         LEFT JOIN pg_index idx ON idx.indexrelid = con.conindid AND con.contype = 'u'
        WHERE con.connamespace = 'bhi'::regnamespace AND con.contype IN ('p','u','f')
          AND rel.relname IN ${inClientTables}
        ORDER BY 1, 2`,
    );
    for (const [table, t] of Object.entries(EXPECTED_TABLES)) {
      const mine = rows.filter((r) => r.table === table);
      expect(mine.filter((r) => r.contype === "p").map((r) => r.columns), `${table} PK`).toEqual([t.primaryKey]);
      expect(
        mine
          .filter((r) => r.contype === "u")
          .map((r) => ({ name: r.name, columns: r.columns, nullsNotDistinct: Boolean(r.nulls_not_distinct) })),
        `${table} unique`,
      ).toEqual([...t.unique].sort((a, b) => a.name.localeCompare(b.name)));
      expect(
        mine
          .filter((r) => r.contype === "f")
          .map((r) => ({
            name: r.name,
            column: r.columns[0],
            refTable: r.ref_table,
            refColumn: r.ref_columns?.[0],
            onUpdate: ACTION[r.upd],
            onDelete: ACTION[r.del],
          })),
        `${table} foreign keys`,
      ).toEqual([...t.foreignKeys].sort((a, b) => a.name.localeCompare(b.name)));
    }
    expect(rows.filter((r) => r.contype === "f")).toHaveLength(8); // R1–R8
  });

  it("has every secondary index with its columns in order, and no others", async () => {
    const rows = await q<{ name: string; table: string; columns: string[] }>(
      `SELECT ic.relname AS name, tc.relname AS table,
              ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY k(n, o)
                      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n
                     ORDER BY k.o)::text[] AS columns
         FROM pg_index i
         JOIN pg_class ic ON ic.oid = i.indexrelid
         JOIN pg_class tc ON tc.oid = i.indrelid
        WHERE tc.relnamespace = 'bhi'::regnamespace AND tc.relname IN ${inClientTables}
          AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
        ORDER BY 1`,
    );
    // Indexes the platform adds on top of the client's model. Indexes only — no
    // column or constraint changes. Each is named here so any other extra fails.
    const platformIndexes = ["member_phone_suffix_idx"]; // card lookup by phone (migration 004)
    expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(platformIndexes));
    expect(rows.filter((r) => !platformIndexes.includes(r.name))).toEqual(
      [...EXPECTED_INDEXES].sort((a, b) => a.name.localeCompare(b.name)),
    );
  });

  it("forces row-level security on every client table", async () => {
    const rows = await q<{ relname: string }>(
      `SELECT relname FROM pg_class
        WHERE relnamespace = 'bhi'::regnamespace AND relkind = 'r'
          AND relrowsecurity AND relforcerowsecurity ORDER BY 1`,
    );
    expect(rows.map((r) => r.relname)).toEqual([...CLIENT_TABLES].sort());
  });
});
