import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PgDialect, pgTable, text } from "drizzle-orm/pg-core";
import {
  MIN_MATCHABLE_DIGITS,
  phoneDigits,
  phoneMatches,
  phoneSuffix,
  phoneSuffixSql,
  normalizeMemberPhone,
} from "./phone";

/**
 * Every number here is fictional, in the 555-01xx range reserved for examples.
 * Real subscriber numbers do not belong in source: these files are read, copied
 * into tickets and shared far more widely than the database is, and a member's
 * number is theirs rather than ours. The SHAPES are what the tests care about —
 * seven national digits, ten with the Guyana country code — not the digits.
 */
const GY_LOCAL = "555-0100"; // as an employee thinks of their number
const GY_STORED = "592-555-0100"; // as the carrier's file stores it
const GY_OTHER = "592-555-0142"; // a different subscriber
const INTL = "+915550123456"; // a longer, non-Guyana number

/** Enough of employee_members to render the expression against. */
const members = pgTable("employee_members", { phone: text("phone") });

const REPO_ROOT = new URL("../../../../", import.meta.url);

const renderSql = (): string =>
  new PgDialect().sqlToQuery(phoneSuffixSql(members.phone)).sql;

/**
 * Strips the quoting, casts, brackets, padding and case that differ between the
 * three copies — pg_dump casts the varchar column and brackets it again. This
 * is safe for this expression specifically: its only string literals are '',
 * '[^0-9]' and 'g', which contain no brackets and carry no meaning in their
 * case. Do not reuse this blindly on a fragment whose literals do.
 */
const canonicalise = (fragment: string): string =>
  fragment
    .replace(/::(text|character varying)/g, "")
    .replace(/[()]/g, " ")
    .replace(/"/g, "")
    .replace(/\b\w+\.(?=\w)/g, "")
    .replace(/\s+/g, " ")
    .replace(/ ?, ?/g, ", ")
    .toLowerCase()
    .trim();

describe("phoneDigits", () => {
  it("keeps only digits", () => {
    expect(phoneDigits(`+${GY_STORED}`)).toBe("5925550100");
    expect(phoneDigits("592-555 0100")).toBe("5925550100");
    expect(phoneDigits("+592 555 0100")).toBe("5925550100");
  });

  it("reduces a null, blank or non-numeric value to nothing", () => {
    expect(phoneDigits(null)).toBe("");
    expect(phoneDigits(undefined)).toBe("");
    // The carrier file really does store this string in the phone column.
    expect(phoneDigits("No Phone")).toBe("");
  });
});

describe("phoneSuffix / phoneSuffixSql", () => {
  it("takes the trailing digits, whatever the formatting", () => {
    expect(phoneSuffix(GY_STORED)).toBe("5550100");
    expect(phoneSuffix("+592 555 0100")).toBe("5550100");
    expect(phoneSuffix(GY_LOCAL)).toBe("5550100");
    expect(phoneSuffix(INTL)).toBe("0123456");
  });

  it("renders the SQL the index is built from", () => {
    expect(canonicalise(renderSql())).toBe(
      `right regexp_replace coalesce phone, '', '[^0-9]', '', 'g', 7`,
    );
  });

  it("is the expression the migration and schema.sql index on", () => {
    // Three copies of one expression decide whether a member can sign in. If the
    // index stops matching the query the planner silently falls back to a
    // sequential scan; if it stops matching phoneMatches, members go missing.
    for (const path of [
      "deploy/db/migrations/001_convert_to_single_schema.sql",
      "deploy/db/schema.sql",
    ]) {
      const file = canonicalise(readFileSync(new URL(path, REPO_ROOT), "utf8"));
      expect(file).toContain(canonicalise(renderSql()));
    }
  });

  /**
   * The narrowing must never drop a row the matcher would have accepted, or a
   * member simply cannot sign in. Every accepting case shares the trailing
   * MIN_MATCHABLE_DIGITS digits, so the prefilter is a superset — asserted here
   * rather than left as a claim in a comment.
   */
  it("never excludes a row that phoneMatches would accept", () => {
    const numbers = [
      GY_STORED, GY_LOCAL, `+${GY_STORED}`, "5925550100",
      GY_OTHER, "5550142", INTL, "5550123456",
      "592-555 0100", "No Phone", "", "0100",
    ];
    for (const stored of numbers) {
      for (const typed of numbers) {
        if (!phoneMatches(stored, typed)) continue;
        expect(phoneSuffix(stored)).toBe(phoneSuffix(typed));
      }
    }
  });
});

describe("phoneMatches", () => {
  it("finds the member from the local form an employee actually types", () => {
    expect(phoneMatches(GY_STORED, GY_LOCAL)).toBe(true);
    expect(phoneMatches(GY_STORED, "5550100")).toBe(true);
  });

  it("finds the member from the full international form", () => {
    expect(phoneMatches(GY_STORED, GY_STORED)).toBe(true);
    expect(phoneMatches(GY_STORED, `+${GY_STORED}`)).toBe(true);
    expect(phoneMatches(GY_STORED, "+592 555 0100")).toBe(true);
    expect(phoneMatches(GY_STORED, "5925550100")).toBe(true);
  });

  it("works when the stored value is the one missing its country code", () => {
    expect(phoneMatches("5550100", `+${GY_STORED}`)).toBe(true);
  });

  it("still matches a longer number from outside Guyana", () => {
    expect(phoneMatches(INTL, INTL)).toBe(true);
    expect(phoneMatches(INTL, "5550123456")).toBe(true);
  });

  it("does not match a different subscriber", () => {
    expect(phoneMatches(GY_STORED, "5550142")).toBe(false);
    expect(phoneMatches(GY_STORED, GY_OTHER)).toBe(false);
  });

  it("refuses anything shorter than a national number", () => {
    // Otherwise "0100" would match every number ending in it.
    expect(phoneMatches(GY_STORED, "0100")).toBe(false);
    expect(phoneMatches(GY_STORED, "100")).toBe(false);
    expect("5550100".length).toBe(MIN_MATCHABLE_DIGITS);
  });

  it("never matches the members whose phone is the text 'No Phone'", () => {
    // The bug this closes: an identifier with no digits used to reduce to the
    // empty string on both sides and match all six of them.
    expect(phoneMatches("No Phone", "abc")).toBe(false);
    expect(phoneMatches("No Phone", "")).toBe(false);
    expect(phoneMatches("No Phone", "5550100")).toBe(false);
  });

  // Four imported rows hold two numbers in a single field. They are recorded
  // here as they actually behave, not as one might wish: the field is 20 digits,
  // so only the LAST number's suffix matches, and the first number finds nobody.
  //
  // Matching is not the real problem for these rows in any case. Delivery goes
  // to the stored field verbatim, which normalises to a 20-digit number the
  // provider rejects — so the member gets as far as the code being sent and then
  // a delivery failure. The fix is in the data, not here: someone has to decide
  // which of the two numbers is theirs.
  it("matches a two-number field only on its trailing number", () => {
    const twoNumbers = `${GY_STORED}; ${GY_OTHER}`;
    expect(phoneMatches(twoNumbers, "5550142")).toBe(true);
    expect(phoneMatches(twoNumbers, "5550100")).toBe(false);
    expect(phoneMatches(twoNumbers, GY_STORED)).toBe(false);
  });
});

/**
 * The write path. Fictional numbers here too, for the reason given at the top:
 * the number that caused the production failure was a real member's, so what is
 * reproduced below is its SHAPE — ten digits that are not a Guyana number — not
 * its digits.
 */
const BARE_FOREIGN = "9155501234"; // ten digits, no country code, not Guyana

describe("normalizeMemberPhone", () => {
  it("canonicalises every Guyana shape an administrator types", () => {
    for (const input of [
      GY_LOCAL,
      GY_STORED,
      `+${GY_STORED}`,
      "5925550100",
      "+592 555 0100",
      "  (592) 555-0100  ",
    ]) {
      expect(normalizeMemberPhone(input)).toEqual({
        ok: true,
        value: "+5925550100",
      });
    }
  });

  it("treats a blank number as absent rather than invalid", () => {
    // Phone is optional; the column should hold NULL, not "".
    for (const input of [null, undefined, "", "   "]) {
      expect(normalizeMemberPhone(input)).toEqual({ ok: true, value: null });
    }
  });

  it("refuses the bare foreign mobile that became a landline", () => {
    // The regression. Stored as typed, the gateway's fallback turned a number
    // of this shape into "+9155501234", which the provider read as a landline
    // in another country and rejected (Twilio 21635).
    const result = normalizeMemberPhone(BARE_FOREIGN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("+592");
  });

  it("refuses other countries however they are written", () => {
    for (const input of [INTL, "915550123456", "+15550123456"]) {
      expect(normalizeMemberPhone(input).ok).toBe(false);
    }
  });

  it("refuses a +592 number of the wrong length", () => {
    // A prefix test alone would admit both of these.
    expect(normalizeMemberPhone("+5925550100999").ok).toBe(false);
    expect(normalizeMemberPhone("+59255501").ok).toBe(false);
  });

  it("refuses the two-number fields the import produced", () => {
    // Documented in phoneMatches above: four rows hold two numbers in one
    // field, and only the trailing one ever matched. Neither is recoverable
    // automatically, so the administrator is asked which is the member's.
    const result = normalizeMemberPhone(`${GY_STORED}; ${GY_OTHER}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("two numbers");
  });

  it("refuses text carrying no digits, including the carrier's 'No Phone'", () => {
    expect(normalizeMemberPhone("No Phone").ok).toBe(false);
    expect(normalizeMemberPhone("abc").ok).toBe(false);
  });

  it("stores what the matcher can still find the member by", () => {
    // The two halves of this file must agree: whatever is stored here has to
    // remain findable from the local form an employee types.
    const stored = normalizeMemberPhone(GY_LOCAL);
    expect(stored.ok).toBe(true);
    if (!stored.ok || stored.value === null) return;
    expect(phoneMatches(stored.value, GY_LOCAL)).toBe(true);
    expect(phoneMatches(stored.value, GY_STORED)).toBe(true);
  });
});
