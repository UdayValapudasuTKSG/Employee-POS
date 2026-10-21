import { describe, expect, it } from "vitest";
import { APP_ROLE, databaseConfig, databaseConfigProblem, describeDatabase } from "@workspace/db/connection";

describe("databaseConfig", () => {
  it("uses DATABASE_URL and runs every connection as the restricted role", () => {
    const url = "postgresql://bhi_user:secret@db:5432/bhi_portal";
    expect(databaseConfig({ DATABASE_URL: url })).toEqual({ connectionString: url, options: `-c role=${APP_ROLE}` });
    expect(APP_ROLE).toBe("bhi_app");
  });

  it("ignores surrounding whitespace", () => {
    expect(databaseConfig({ DATABASE_URL: "  postgresql://u:p@h/d  " }).connectionString).toBe("postgresql://u:p@h/d");
  });

  it("names DATABASE_URL when it is missing or empty", () => {
    expect(databaseConfigProblem({})).toMatch(/DATABASE_URL/);
    expect(databaseConfigProblem({ DATABASE_URL: " " })).toMatch(/DATABASE_URL/);
    expect(() => databaseConfig({})).toThrow(/DATABASE_URL/);
    expect(databaseConfigProblem({ DATABASE_URL: "postgresql://u:p@h/d" })).toBeNull();
  });

  it("refuses a value that is not a postgres URL", () => {
    expect(databaseConfigProblem({ DATABASE_URL: "db:5432/bhi_portal" })).toMatch(/postgresql:\/\//);
  });
});

describe("describeDatabase", () => {
  it("shows login, host, port and database but never the password", () => {
    const text = describeDatabase({ DATABASE_URL: "postgresql://bhi_user:s3cr3t@db:5432/bhi_portal" });
    expect(text).toBe("bhi_user@db:5432/bhi_portal");
    expect(text).not.toContain("s3cr3t");
  });

  it("defaults the port", () => {
    expect(describeDatabase({ DATABASE_URL: "postgres://u:p@localhost/x" })).toBe("u@localhost:5432/x");
  });
});
