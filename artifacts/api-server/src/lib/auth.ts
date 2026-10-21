import {
  createHmac,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const SECRET = (() => {
  const secret = process.env["SESSION_SECRET"];
  if (!secret) {
    throw new Error(
      "SESSION_SECRET environment variable is required for token signing.",
    );
  }
  return secret;
})();

// ---------------------------------------------------------------------------
// Password hashing (scrypt)
// ---------------------------------------------------------------------------

export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(plain, salt, 32).toString("hex");
  return `s2:${salt}:${hash}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "s2") return false;
  const [, salt, expected] = parts;
  const actual = scryptSync(plain, salt!, 32).toString("hex");
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected!, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Minimal HS256 JWT
// ---------------------------------------------------------------------------

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function signToken(
  payload: Record<string, unknown>,
  ttlSeconds: number,
): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(
    JSON.stringify({
      ...payload,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    }),
  );
  const sig = createHmac("sha256", SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = createHmac("sha256", SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  const a = Buffer.from(sig!);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(body!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (typeof payload["exp"] !== "number" || payload["exp"] * 1000 < Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hashing helpers (OTP codes, card tokens) — plaintext is never persisted
// ---------------------------------------------------------------------------

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateOtpCode(): string {
  // 6-digit, uniformly distributed
  const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return n.toString().padStart(6, "0");
}

export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

// Re-exported so existing `from "./auth"` imports keep working; the values
// themselves live in ./constants, which has no environment requirements.
export {
  OTP_TTL_SECONDS,
  CARD_TTL_SECONDS,
  MAX_OTP_ATTEMPTS,
  ADMIN_JWT_TTL_SECONDS,
} from "./constants";

export function isOtpDevMode(): boolean {
  if (process.env["OTP_DEV_MODE"] === "false") return false;
  return process.env["NODE_ENV"] !== "production" || process.env["OTP_DEV_MODE"] === "true";
}
