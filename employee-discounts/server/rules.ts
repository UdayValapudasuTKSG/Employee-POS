/**
 * The discount rules, as pure functions: no database, no environment.
 *
 * An employee holds at most one live code. It is used once, at any one of the
 * participating stores, and takes a percentage off that bill — never more than
 * what is left of the employee's monthly allowance, which every store shares.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const STORES = ["KFC", "PIZZA_HUT", "STERLING", "BEHARRY"] as const;
export type Store = (typeof STORES)[number];

export const STORE_NAMES: Record<Store, string> = {
  KFC: "KFC",
  PIZZA_HUT: "Pizza Hut",
  STERLING: "Sterling",
  BEHARRY: "Edward B. Beharry & Co.",
};

// ---------------------------------------------------------------------------
// Discount codes
// ---------------------------------------------------------------------------

/**
 * Crockford base32: no I, L, O or U, so a code read aloud or typed from a
 * screen survives. 12 characters is 60 bits — ample for a code that is single
 * use, expires in minutes and is only accepted from a keyed till.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 12;

/** A new code, grouped for reading: K7PQ-3MZX-9TRA. */
export function generateDiscountCode(): string {
  // 32 divides 256, so masking a byte to 5 bits is uniform.
  const chars = [...randomBytes(CODE_LENGTH)].map((b) => ALPHABET[b & 31]);
  return [0, 4, 8].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

/**
 * The canonical form of a scanned or typed code, or null when it cannot be one.
 * Case, spaces and hyphens are ignored; O, I and L read as 0, 1 and 1.
 */
export function normalizeCode(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return s.length === CODE_LENGTH && [...s].every((c) => ALPHABET.includes(c)) ? s : null;
}

/** "K7PQ3MZX9TRA" as "K7PQ-3MZX-9TRA". */
export function formatCode(canonical: string): string {
  return [0, 4, 8].map((i) => canonical.slice(i, i + 4)).join("-");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** What is looked up at the till: the hash of the canonical code. */
export function codeHash(canonical: string): string {
  return sha256(`code:${canonical}`);
}

/**
 * The code itself, kept so the employee can see their live code again on any
 * device. AES-256-GCM under a key derived from SESSION_SECRET; tampering fails
 * the tag check.
 */
function codeKey(secret: string): Buffer {
  return createHash("sha256").update(`discount-code-key:${secret}`).digest();
}

export function encryptCode(code: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", codeKey(secret), iv);
  const ct = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}

export function decryptCode(enc: string, secret: string): string {
  const [iv, tag, ct] = enc.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", codeKey(secret), iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(ct!), decipher.final()]).toString("utf8");
}

/** The store a POS key belongs to, or null. Every key is compared, in constant time. */
export function storeForKey(given: string, keys: Record<Store, string | undefined>): Store | null {
  const g = createHash("sha256").update(given).digest();
  let found: Store | null = null;
  for (const store of STORES) {
    const k = keys[store];
    if (k && timingSafeEqual(g, createHash("sha256").update(k).digest())) found = store;
  }
  return found;
}

// ---------------------------------------------------------------------------
// One-time passcodes
// ---------------------------------------------------------------------------

export function generateOtp(): string {
  return (randomBytes(4).readUInt32BE(0) % 1_000_000).toString().padStart(6, "0");
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** "uday@example.com" as "u•••@e••••••.com": enough to recognise, not to harvest. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const dot = domain.lastIndexOf(".");
  const name = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local.slice(0, 1)}${"•".repeat(Math.max(3, local.length - 1))}@${name.slice(0, 1)}${"•".repeat(Math.max(3, name.length - 1))}${tld}`;
}

// ---------------------------------------------------------------------------
// Money: GYD, held as integer cents
// ---------------------------------------------------------------------------

/** An amount as integer cents, or null with more than two decimals or not a number. */
export function toCents(amount: number): number | null {
  if (!Number.isFinite(amount)) return null;
  const cents = Math.round(amount * 100);
  return Math.abs(amount * 100 - cents) < 1e-6 ? cents : null;
}

export const fromCents = (cents: number): number => cents / 100;

/** A numeric column ("1500.00") as cents. */
export const centsOf = (v: string | null | undefined): number => (v == null ? 0 : Math.round(Number(v) * 100));

export interface Quote {
  billCents: number;
  /** What the percentage alone would give. */
  fullDiscountCents: number;
  /** What is given: the full discount, or what is left of the allowance. */
  discountCents: number;
  payableCents: number;
  /** The allowance, not the percentage, set the discount: the cashier must confirm. */
  capApplied: boolean;
}

export function quote(billCents: number, percentBp: number, remainingCents: number): Quote {
  const full = Math.round((billCents * percentBp) / 10_000);
  const remaining = Math.max(0, remainingCents);
  const discount = Math.min(full, remaining);
  return { billCents, fullDiscountCents: full, discountCents: discount, payableCents: billCents - discount, capApplied: full > remaining };
}

const GYD = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const gyd = (cents: number): string => `GYD ${GYD.format(cents / 100)}`;

/**
 * The line the till shows the cashier; asks first when the allowance falls
 * short. `atStore` names the store when its own monthly limit is what binds.
 */
export function quoteMessage(q: Quote, percent: number, atStore?: string): string {
  if (!q.capApplied) return `${percent}% off: ${gyd(q.discountCents)}. Customer pays ${gyd(q.payableCents)}.`;
  return (
    `This employee has only ${gyd(q.discountCents)} of discount left this month${atStore ? ` at ${atStore}` : ""} ` +
    `(${percent}% would be ${gyd(q.fullDiscountCents)}). Apply ${gyd(q.discountCents)}? ` +
    `Customer pays ${gyd(q.payableCents)}.`
  );
}

// ---------------------------------------------------------------------------
// The allowance month: Guyana time, UTC-4 all year
// ---------------------------------------------------------------------------

const GUYANA_OFFSET_MS = -4 * 60 * 60 * 1000;

export interface Month {
  /** YYYY-MM */
  month: string;
  start: Date;
  end: Date;
}

export function monthWindow(month: string): Month {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) throw new Error(`Not a YYYY-MM month: ${month}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const start = new Date(Date.UTC(y, mo - 1, 1) - GUYANA_OFFSET_MS);
  const end = new Date(Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1) - GUYANA_OFFSET_MS);
  return { month, start, end };
}

/** The Guyana calendar month that `now` falls in. */
export function currentMonth(now: Date = new Date()): Month {
  return monthWindow(new Date(now.getTime() + GUYANA_OFFSET_MS).toISOString().slice(0, 7));
}

/** "3:42 pm, 22 Oct 2026" in Guyana time. */
export function guyanaClock(at: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Guyana",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(at);
}
