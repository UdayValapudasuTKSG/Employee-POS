/**
 * The retirement-age rule: coverage under the group plan ends when a member
 * turns 65.
 *
 * Pure date arithmetic, no database, so the rule can be unit-tested and applied
 * from three places that must never disagree:
 *
 *   - `eligible()` in routes/employee.ts, which decides whether a member may
 *     look up and be issued a card. This is the one that has to be right the
 *     moment the birthday passes, because the sweep below runs on a timer.
 *   - `sweepRetirementAge()`, which moves members who have aged out off the
 *     members list so HR sees the roster the carrier would recognise.
 *   - The create and import guards, which refuse to put someone on the roster
 *     who would be swept off it minutes later.
 *
 * Everything works in the YYYY-MM-DD strings the `date` columns already use.
 * Going via `Date` would drag in the timezone bug the frontend's dates.ts
 * documents: `toISOString()` converts to UTC first, so west of Greenwich the
 * "today" it reports is tomorrow for part of every evening — which would age a
 * member out a day early.
 */

export const RETIREMENT_AGE = 65;

const pad = (n: number): string => String(n).padStart(2, "0");

/** Days in a month, 1-indexed. Day 0 of the next month is the last of this one. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Today as a YYYY-MM-DD string, in the server's local timezone.
 *
 * Built from the local date parts for the reason given in the module comment.
 * Takes the instant as an argument so tests need no clock control.
 */
export function localDateString(at: Date = new Date()): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * `date` minus `years`, clamping the day to the length of the target month.
 *
 * The clamp is what Postgres's `date - INTERVAL 'n years'` does, and the sweep
 * asks Postgres the same question in SQL, so the two must agree: without it,
 * 2024-02-29 minus 65 years would be the string "1959-02-29", a date that does
 * not exist and that Postgres would reject outright.
 */
export function subtractYears(date: string, years: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const year = y - years;
  return `${year}-${pad(m)}-${pad(Math.min(d, daysInMonth(year, m)))}`;
}

/**
 * The latest date of birth that has already reached retirement age on `asOf`.
 *
 * A member born on this date has their 65th birthday on `asOf` itself and is
 * out; one born the next day still has a day of cover.
 */
export function retirementCutoff(asOf: string): string {
  return subtractYears(asOf, RETIREMENT_AGE);
}

/** Has someone born on `dateOfBirth` turned 65 by `asOf`? */
export function hasReachedRetirementAge(dateOfBirth: string, asOf: string): boolean {
  // Lexicographic comparison is date order for YYYY-MM-DD.
  return dateOfBirth.slice(0, 10) <= retirementCutoff(asOf);
}

/** Whole years old on `asOf`. Negative dates of birth are not defended against. */
export function ageOn(dateOfBirth: string, asOf: string): number {
  const [by, bm, bd] = dateOfBirth.slice(0, 10).split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const [ay, am, ad] = asOf.split("-").map(Number) as [number, number, number];
  let age = ay - by;
  if (am < bm || (am === bm && ad < bd)) age -= 1;
  return age;
}

