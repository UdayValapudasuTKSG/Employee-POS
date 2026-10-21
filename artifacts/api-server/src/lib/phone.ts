/**
 * Matching a member by the phone number they know.
 *
 * A Guyanese employee thinks of their number as seven digits — "555-0100". The
 * carrier's spreadsheet stores it as "592-555-0100", and a few rows arrive as
 * "+592-555-0100" or with a space instead of a dash. Comparing the raw strings,
 * or even their digits, means the only people who can sign in are the ones who
 * happen to type the country code. That is the difference between a portal
 * employees can use and one they cannot.
 *
 * So the comparison is on digits, and a shorter national form is accepted as
 * naming the same number as the longer international one.
 *
 * WHY THIS IS SAFE, AND THE CONDITION IT DEPENDS ON
 *
 * Loose matching is only sound because the verification code is delivered to the
 * member's OWN stored number, never to the string the visitor typed — see
 * deliveryDestination in routes/employee.ts. If delivery ever follows the typed
 * value again, this matching becomes an account-takeover route: someone who
 * knows or guesses a suffix of a member's number could type a longer number they
 * control, match that member, and have the member's code sent to their own
 * phone. The two changes belong together; do not keep this one without the other.
 */

import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/** Digits only. A leading "+" carries no digits, so it simply disappears. */
export function phoneDigits(raw: string | null | undefined): string {
  return String(raw ?? "").replace(/\D/g, "");
}

/**
 * Below this, a number is not treated as identifying anybody.
 *
 * Guyana subscriber numbers are seven digits, which is the shortest national
 * form this data contains. The floor is what stops a short or junk identifier
 * matching broadly: the carrier file stores six members with the literal text
 * "No Phone", whose digits are the empty string, and without a minimum an
 * identifier like "abc" also reduces to the empty string and matches all of
 * them.
 */
export const MIN_MATCHABLE_DIGITS = 7;

/**
 * Does `typed` name the same subscriber as `stored`?
 *
 * True when the digits are equal, or when either is a suffix of the other —
 * which is how a national form relates to its international form. Both
 * directions are accepted because the stored side is inconsistent too: most rows
 * carry the country code, some do not, and a member should be findable either
 * way round.
 *
 * A suffix rule will occasionally match two different subscribers in different
 * countries who share their last seven digits. That is not a hole: the lookup
 * already handles several matches by returning the disambiguation screen, whose
 * labels are masked, and the code still goes only to the member finally chosen.
 */
export function phoneMatches(
  stored: string | null | undefined,
  typed: string | null | undefined,
): boolean {
  const a = phoneDigits(stored);
  const b = phoneDigits(typed);
  if (a.length < MIN_MATCHABLE_DIGITS || b.length < MIN_MATCHABLE_DIGITS) {
    return false;
  }
  return a === b || a.endsWith(b) || b.endsWith(a);
}

/**
 * The trailing digits a lookup can be narrowed by in SQL.
 *
 * phoneMatches is the authority on whether two numbers are the same subscriber,
 * but it cannot run in the database, and evaluating it in JavaScript means
 * reading every member row on every lookup. That was the original
 * implementation, and it is fine at three hundred members and untenable at fifty
 * thousand: one full table scan, and the whole roster in the API's memory, for
 * each person signing in.
 *
 * So the database narrows first on this expression and phoneMatches decides
 * afterwards. That is only correct because the narrowing can never discard a row
 * phoneMatches would have accepted, which holds by construction: every accepting
 * case — equality, or either side being a suffix of the other — requires the two
 * numbers to share their last MIN_MATCHABLE_DIGITS digits, because the shorter
 * side is at least that long. Rows with fewer digits than that, including the
 * six whose stored value is the text "No Phone", cannot match a well-formed
 * query and are excluded here too.
 *
 * The expression is deliberately equality on a fixed-length suffix rather than a
 * LIKE '%…', so it can be served by the index migration 008 adds. Keep this, the
 * index and MIN_MATCHABLE_DIGITS in step; the test in phone.test.ts reads the
 * migration and fails if they drift.
 */
export function phoneSuffixSql(column: AnyPgColumn): SQL<string> {
  return sql<string>`right(regexp_replace(coalesce(${column}, ''), '[^0-9]', '', 'g'), ${sql.raw(
    String(MIN_MATCHABLE_DIGITS),
  )})`;
}

/** The same suffix, computed in JavaScript, to bind against the expression above. */
export function phoneSuffix(raw: string | null | undefined): string {
  return phoneDigits(raw).slice(-MIN_MATCHABLE_DIGITS);
}

// ---------------------------------------------------------------------------
// Writing a number: one canonical stored form
// ---------------------------------------------------------------------------

/**
 * Everything above answers "is this the same subscriber?" for a lookup, and is
 * deliberately forgiving. What follows answers "may this be stored at all?",
 * and is deliberately strict. The two must not be confused: loosening the
 * matcher keeps members signing in, loosening this lets in numbers that can
 * never receive a code.
 *
 * This plan is written in Guyana for Guyanese members and the SMS gateway
 * delivers to +592 only, so a number from anywhere else is not a stricter rule
 * than necessary — it is a row that looks fine on the members list and fails at
 * verification time with the carrier appearing to be at fault.
 *
 * The failure is not hypothetical. A bare ten-digit Indian mobile `9121403078`
 * was stored as typed; the gateway's last-resort normalisation made it
 * `+9121403078`, which Twilio read as an Indian LANDLINE and rejected with
 * error 21635.
 *
 * Two defences, neither redundant:
 *   - here, so the value is never written, with an error the administrator can
 *     act on while the form is still in front of them; and
 *   - in deploy/sms-gateway.mjs, so a number that arrived some other way — an
 *     older row, a direct SQL edit, a seed — still cannot be messaged.
 */

/** Digits of the country this deployment serves. */
const COUNTRY = (process.env["SMS_DEFAULT_COUNTRY"] ?? "592").replace(/\D/g, "");

/**
 * Subscriber digits behind COUNTRY. Guyana is 7 — the same 7 as
 * MIN_MATCHABLE_DIGITS, though for a different reason: that one is the shortest
 * form worth matching on, this one is how long a complete number is. They
 * coincide for Guyana and would not for a country whose national numbers vary
 * in length, so they are kept apart.
 *
 * Mirrors the gateway's table rather than importing it: the gateway is a
 * zero-dependency .mjs shipped as its own service and the API bundle does not
 * include deploy/.
 */
const KNOWN_NATIONAL_LENGTHS: Record<string, number> = { "592": 7 };
const NATIONAL_LENGTH = ((): number | null => {
  const configured = Number(process.env["SMS_NATIONAL_LENGTH"]);
  if (Number.isInteger(configured) && configured > 0) return configured;
  return KNOWN_NATIONAL_LENGTHS[COUNTRY] ?? null;
})();

export type PhoneResult =
  | { ok: true; value: string | null }
  | { ok: false; reason: string };

/** How a valid number should look, for error messages. */
export function phoneExample(): string {
  return NATIONAL_LENGTH === null
    ? `+${COUNTRY}...`
    : `+${COUNTRY} ${"0".repeat(NATIONAL_LENGTH)}`;
}

/**
 * Normalises a member's phone for storage, rejecting anything this deployment
 * could not actually send to.
 *
 * Blank is not an error — phone is optional and a member reachable only by
 * email is a normal record — so it returns `{ ok: true, value: null }` and the
 * caller writes NULL rather than an empty string.
 *
 * Accepts the shapes an administrator types (bare local, with country code,
 * punctuation, spaces) and returns one form for all of them.
 */
export function normalizeMemberPhone(
  raw: string | null | undefined,
): PhoneResult {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") return { ok: true, value: null };

  const digits = phoneDigits(trimmed);
  if (digits === "") {
    // Includes the literal "No Phone" the carrier file stores.
    return { ok: false, reason: `"${trimmed}" is not a phone number.` };
  }

  // A bare local number, the common case: prefix the country code. Checked
  // before the country-code branch so a 7-digit number starting with the
  // country digits is still read as local.
  if (
    !trimmed.startsWith("+") &&
    NATIONAL_LENGTH !== null &&
    digits.length === NATIONAL_LENGTH
  ) {
    return { ok: true, value: `+${COUNTRY}${digits}` };
  }

  if (!digits.startsWith(COUNTRY)) {
    return {
      ok: false,
      reason:
        `"${trimmed}" is not a +${COUNTRY} number. This plan can only send ` +
        `verification codes to +${COUNTRY} numbers, so a number from another ` +
        `country would never receive one. Enter it as ${phoneExample()}.`,
    };
  }

  if (
    NATIONAL_LENGTH !== null &&
    digits.length !== COUNTRY.length + NATIONAL_LENGTH
  ) {
    const found = digits.length - COUNTRY.length;
    // The two-numbers hint belongs only on an over-long value — that is what the
    // imported rows holding a pair of numbers in one field look like. Offering it
    // for a number that is too SHORT sends the reader looking for a second
    // number that was never there.
    const hint =
      found > NATIONAL_LENGTH
        ? ` If this field holds two numbers, enter only the member's own, as ${phoneExample()}.`
        : ` Enter it as ${phoneExample()}.`;
    return {
      ok: false,
      reason:
        `"${trimmed}" has ${found} digit${found === 1 ? "" : "s"} after ` +
        `+${COUNTRY}, but a +${COUNTRY} number has ${NATIONAL_LENGTH}.${hint}`,
    };
  }

  return { ok: true, value: `+${digits}` };
}
