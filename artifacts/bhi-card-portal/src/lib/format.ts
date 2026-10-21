import { format } from 'date-fns';

/**
 * Display formatting shared by the pricing and billing pages: money in GYD,
 * plain dates, months and timestamps.
 */

/** GYD with thousands separators and two decimals. The column headers carry the currency. */
export const MONEY = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** An amount string from the server ("12500.00") for display; null is a dash. */
export function formatMoney(value: string | null | undefined): string {
  if (value == null) return '—';
  const n = Number(value);
  return Number.isFinite(n) ? MONEY.format(n) : value;
}

/**
 * A YYYY-MM-DD date for display. Built from its parts: `new Date('2026-01-01')`
 * is UTC midnight, which Guyana (UTC-4) shows as the day before.
 */
export function formatDay(value: string | null | undefined): string {
  if (!value) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  return format(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), 'd MMM yyyy');
}

/** A YYYY-MM month for display ("September 2026"), built from its parts for the same reason. */
export function formatMonth(value: string | null | undefined): string {
  if (!value) return '—';
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  if (!m) return value;
  return format(new Date(Number(m[1]), Number(m[2]) - 1, 1), 'MMMM yyyy');
}

/** A full timestamp in the viewer's local time. */
export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : format(date, 'd MMM yyyy, HH:mm');
}
