/**
 * Every setting, read once at start from the environment (.env locally).
 * A restart applies a change. See .env.example for what each one does.
 */
import { STORES, type Store } from "./rules";

function str(name: string, fallback?: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : fallback;
}

function num(name: string, fallback: number, ok: (n: number) => boolean): number {
  const raw = str(name);
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && ok(n) ? n : fallback;
}

const sessionSecret = str("SESSION_SECRET");
if (!sessionSecret || sessionSecret.length < 32) {
  throw new Error("SESSION_SECRET must be set to at least 32 characters (see .env.example).");
}
const databaseUrl = str("DATABASE_URL");
if (!databaseUrl) throw new Error("DATABASE_URL must be set (see .env.example).");

const isProduction = process.env["NODE_ENV"] === "production";

/** A shorter POS key is ignored rather than trusted. */
export const MIN_POS_KEY_LENGTH = 24;

const POS_KEY_ENV: Record<Store, string> = {
  KFC: "POS_KEY_KFC",
  PIZZA_HUT: "POS_KEY_PIZZA_HUT",
  STERLING: "POS_KEY_STERLING",
  BEHARRY: "POS_KEY_BEHARRY",
};

export const config = {
  port: num("PORT", 3200, (n) => n > 0 && n < 65536),
  host: str("HOST", "0.0.0.0")!,
  isProduction,
  databaseUrl,
  sessionSecret,
  /** The address people open, for links in emails. */
  appUrl: str("APP_URL", "http://localhost:3200")!.replace(/\/$/, ""),
  /** Behind nginx or another proxy, the number of proxies to trust. */
  trustProxy: str("TRUST_PROXY"),

  /** true: one-time passcodes come back in the API response instead of being emailed. Never in production. */
  otpDevMode: str("OTP_DEV_MODE") === "true",
  otpTtlMinutes: 5,
  otpMaxAttempts: 3,
  otpResendSeconds: 60,
  sessionHours: num("SESSION_HOURS", 8, (n) => n >= 1 && n <= 24 * 30),

  discount: {
    percentBp: Math.round(num("DISCOUNT_PERCENT", 10, (n) => n > 0 && n <= 100) * 100),
    monthlyCapCents: Math.round(num("DISCOUNT_MONTHLY_CAP_GYD", 15_000, (n) => n >= 0) * 100),
    codeTtlMinutes: Math.round(num("CODE_TTL_MINUTES", 30, (n) => n >= 1 && n <= 24 * 60)),
  },

  smtp: {
    host: str("SMTP_HOST"),
    port: num("SMTP_PORT", 587, (n) => n > 0),
    user: str("SMTP_USER"),
    pass: str("SMTP_PASS")?.replace(/\s+/g, ""),
    from: str("SMTP_FROM") ?? str("SMTP_USER") ?? "no-reply@localhost",
  },

  /** Each store's POS key, or undefined when that store cannot redeem. */
  posKeys: Object.fromEntries(
    STORES.map((s) => {
      const key = str(POS_KEY_ENV[s]);
      return [s, key && key.length >= MIN_POS_KEY_LENGTH ? key : undefined];
    }),
  ) as Record<Store, string | undefined>,

  /**
   * Who may use the admin portal: ADMIN_EMAILS, comma-separated. Checked on
   * every request, so removing an address (and restarting) ends that access.
   */
  adminEmails: new Set(
    (str("ADMIN_EMAILS") ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes("@")),
  ),

  /** Add the named test employees in server/seed.ts on start. */
  seedEmployees: str("SEED_EMPLOYEES") !== "false",
  /** Also add made-up demo employees (@example.test). Local testing only. */
  seedDemoEmployees: str("SEED_DEMO_EMPLOYEES") === "true",
};

if (config.isProduction && config.otpDevMode) {
  throw new Error("OTP_DEV_MODE=true is refused in production: it would show every sign-in code on screen.");
}
