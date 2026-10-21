/**
 * Calendar dates in Guyana time.
 *
 * Guyana is UTC−4 all year (no daylight saving), and the plan's calendar —
 * inactive dates, the 65th birthday, the start of a billing month — is Guyana's.
 * Using the server's own timezone would shift a date by a day for anything
 * recorded between 20:00 and midnight Guyana time on a UTC server.
 */

export const GUYANA_UTC_OFFSET_HOURS = -4;
const OFFSET_MS = GUYANA_UTC_OFFSET_HOURS * 60 * 60 * 1000;

/** Today's date in Guyana, as YYYY-MM-DD. */
export function guyanaToday(now: Date = new Date()): string {
  return new Date(now.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** 00:00 Guyana time on a YYYY-MM-DD date, as the UTC instant it is. */
export function guyanaMidnightUtc(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  return new Date(Date.parse(`${date}T00:00:00Z`) - OFFSET_MS);
}

/**
 * The instant a billing month starts: 00:00 Guyana time on its 1st (research
 * R11). `month` is YYYY-MM.
 */
export function monthStartUtc(month: string): Date {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`Not a YYYY-MM month: ${month}`);
  return guyanaMidnightUtc(`${month}-01`);
}

/** The 1st of a YYYY-MM month as a YYYY-MM-DD date (billing_run.billing_month). */
export function monthFirstDay(month: string): string {
  monthStartUtc(month); // validates
  return `${month}-01`;
}

/**
 * The first billing month a change made now reaches, as its 1st (YYYY-MM-DD):
 * the 1st of next month in Guyana. A bill reflects the state at 00:00 on the 1st,
 * so anything recorded today — a new member, a class change — is billed from then.
 */
export function nextBillingMonthStart(now: Date = new Date()): string {
  const [y, m] = guyanaToday(now).split("-").map(Number) as [number, number];
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  return `${next.y}-${String(next.m).padStart(2, "0")}-01`;
}
