import { describe, expect, it } from "vitest";
import { classifyBhiError, errorSummary, ID_ALREADY_REGISTERED_MESSAGE } from "./bhiErrors";

/** What Drizzle throws: a wrapper with the driver's error on `cause`. */
function wrapped(code: string, extra: Record<string, unknown> = {}) {
  const driver = Object.assign(new Error((extra["message"] as string) ?? "db error"), { code, ...extra });
  return Object.assign(new Error("Failed query: ..."), { query: "insert ...", params: ["x"], cause: driver });
}

describe("classifyBhiError", () => {
  it("answers a person already registered in another company without naming it", () => {
    const answer = classifyBhiError(
      wrapped("23505", { constraint: "member_id_type_id_number_uq", detail: "Key (id_type, id_number)=(A, 1) already exists." }),
    );
    expect(answer).toMatchObject({ status: 409, code: "ID_ALREADY_REGISTERED" });
    expect(answer?.message).toBe(ID_ALREADY_REGISTERED_MESSAGE);
    expect(answer?.message).not.toMatch(/Key|already exists\./);
  });

  it("maps a duplicate company, class and rate", () => {
    expect(classifyBhiError(wrapped("23505", { constraint: "company_pk" }))?.code).toBe("COMPANY_EXISTS");
    expect(classifyBhiError(wrapped("23505", { constraint: "class_pk" }))?.code).toBe("CLASS_EXISTS");
    expect(
      classifyBhiError(wrapped("23505", { constraint: "premium_rates_company_class_band_date_uq" }))?.code,
    ).toBe("RATE_EXISTS");
  });

  it("maps a value too long for its column to 400", () => {
    expect(classifyBhiError(wrapped("22001"))).toMatchObject({ status: 400, code: "VALUE_TOO_LONG" });
  });

  it("answers a row-level security refusal exactly like a missing record", () => {
    const answer = classifyBhiError(
      wrapped("42501", { message: 'new row violates row-level security policy for table "member"' }),
    );
    expect(answer).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("leaves a plain permission error, and anything else, to the generic handler", () => {
    expect(classifyBhiError(wrapped("42501", { message: "permission denied for table member" }))).toBeNull();
    expect(classifyBhiError(wrapped("23505", { constraint: "admin_users_email_unique" }))).toBeNull();
    expect(classifyBhiError(new Error("boom"))).toBeNull();
    expect(classifyBhiError(null)).toBeNull();
  });
});

describe("errorSummary", () => {
  it("keeps the database message and code, never the query's parameters", () => {
    const wrapped = Object.assign(new Error('Failed query: insert into "member" ... params: NATIONAL_ID,123456,Asha,Persaud'), {
      query: 'insert into "member" ...',
      params: ["NATIONAL_ID", "123456", "Asha", "Persaud"],
      cause: Object.assign(new Error("numeric field overflow"), { code: "22003" }),
    });
    const summary = errorSummary(wrapped);
    expect(summary).toBe("numeric field overflow (22003)");
    expect(summary).not.toContain("Asha");
  });

  it("passes other errors through", () => {
    expect(errorSummary(new Error("plain"))).toBe("plain");
    expect(errorSummary("text")).toBe("text");
  });
});
