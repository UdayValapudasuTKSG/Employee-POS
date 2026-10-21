/**
 * Date helpers for the forms, all working in the YYYY-MM-DD strings that
 * <input type="date"> reads and writes.
 */

/**
 * Today, as the date input sees it.
 *
 * Built from the local date parts rather than `toISOString().slice(0, 10)`,
 * which converts to UTC first: in Guyana (UTC-4) that returns tomorrow's date
 * for most of the evening, so "no future dates" would quietly permit one.
 *
 * Evaluated once per page load. A session left open across midnight keeps
 * yesterday's bound, which costs nothing here — a date of birth is never today.
 */
export const TODAY = (() => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
})();

/** This month as YYYY-MM, from the same local date as TODAY. */
export const THIS_MONTH = TODAY.slice(0, 7);

/** A YYYY-MM month moved by `delta` months, done on the parts so no time zone is involved. */
export function shiftMonth(month: string, delta: number): string {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  const index = year * 12 + (mon - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/**
 * Is this date-input value after today?
 *
 * Blank is not in the future — an empty field is the `required` attribute's
 * problem, and reporting "cannot be in the future" on an untouched input would
 * be nonsense. Plain string comparison is correct because YYYY-MM-DD sorts
 * lexicographically in date order.
 */
export function isFutureDate(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== "" && trimmed > TODAY;
}
