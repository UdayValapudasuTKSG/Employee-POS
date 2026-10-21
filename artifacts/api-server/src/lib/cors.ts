/**
 * Cross-origin policy.
 *
 * This used to be a bare `cors()`, which answers every request with
 * `Access-Control-Allow-Origin: *` — any page on the internet could call the
 * API from a browser and read the response. That is wider than this deployment
 * has ever needed: nginx serves the frontend and proxies `/api` on the SAME
 * origin, so the portal itself makes no cross-origin requests at all and the
 * correct production answer is to allow none.
 *
 * The allowlist is `CORS_ALLOWED_ORIGINS`, a comma-separated list of exact
 * origins. Nothing is hardcoded here; an origin this deployment does not name
 * is refused.
 *
 * Refusal means "reply without the CORS headers", never an error. Throwing
 * would turn a browser's probe into a 500 and bury the real cause; without the
 * headers the browser blocks the read itself, which is the outcome we want and
 * is what the spec expects.
 */

import type { CorsOptions } from "cors";
import { logger } from "./logger";

/**
 * Only the verbs the API actually exposes. There is no DELETE anywhere in this
 * service — the audit trail is append-only and removals are soft — so
 * advertising one would be a lie.
 */
const METHODS = ["GET", "POST", "PATCH", "OPTIONS"];

/**
 * `x-otp-strict` is the local proxy's opt-out; the rest are the standard pair.
 * Bearer tokens travel in Authorization, which is why credentials stay off.
 */
const ALLOWED_HEADERS = ["Content-Type", "Authorization", "X-OTP-Strict"];

/**
 * How long a browser may cache a preflight, in seconds.
 *
 * This is the whole cost of CORS: without it a browser re-asks OPTIONS before
 * every non-simple request, doubling the round trips on every PATCH and on
 * every POST carrying a JSON body. Ten minutes removes that from all but the
 * first call in a session. Chromium caps its own cache at 2 hours, so asking
 * for more than that achieves nothing.
 */
const PREFLIGHT_MAX_AGE_SECONDS = 600;

/** Lower-cased, trailing slash removed, so "https://X.com/" matches "https://x.com". */
function normalise(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, "");
}

/**
 * Loopback on any port, which is every shape the local stack takes: the front
 * door on 8080, Vite on 5173, the API direct on 3101.
 */
const LOOPBACK_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export type OriginPolicy =
  | { kind: "list"; origins: string[] }
  /** Explicitly opted into `*`. Kept so an existing deployment can say so. */
  | { kind: "any" }
  /** Unset in development: loopback only, so a dev server just works. */
  | { kind: "loopback" }
  /** Unset in production: same-origin only, which is how this is deployed. */
  | { kind: "none" };

export function originPolicy(): OriginPolicy {
  const raw = process.env["CORS_ALLOWED_ORIGINS"]?.trim();
  if (!raw) {
    return process.env["NODE_ENV"] === "production"
      ? { kind: "none" }
      : { kind: "loopback" };
  }
  if (raw === "*") return { kind: "any" };
  const origins = raw
    .split(",")
    .map(normalise)
    .filter((o) => o !== "");
  return origins.length > 0 ? { kind: "list", origins } : { kind: "none" };
}

/** Whether `origin` may read responses from this API. */
export function isOriginAllowed(origin: string, policy = originPolicy()): boolean {
  const candidate = normalise(origin);
  if (candidate === "") return false;
  switch (policy.kind) {
    case "any":
      return true;
    case "loopback":
      return LOOPBACK_RE.test(candidate);
    case "list":
      return policy.origins.includes(candidate);
    case "none":
      return false;
  }
}

export function corsOptions(): CorsOptions {
  return {
    origin(origin, callback) {
      // No Origin header: curl, a health probe, a server-to-server call, or a
      // same-origin navigation. Not a cross-origin read, so there is nothing to
      // refuse — and no CORS headers get added either way.
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, isOriginAllowed(origin));
    },
    methods: METHODS,
    allowedHeaders: ALLOWED_HEADERS,
    // Bearer tokens are sent in the Authorization header, not as cookies, so
    // the API never needs credentialed requests. Leaving this off also keeps
    // `*` from being silently ignored by browsers, which reject that
    // combination outright.
    credentials: false,
    maxAge: PREFLIGHT_MAX_AGE_SECONDS,
    optionsSuccessStatus: 204,
  };
}

/** One line at startup saying what is permitted, so it is never a guess. */
export function logOriginPolicy(): void {
  const policy = originPolicy();
  switch (policy.kind) {
    case "any":
      logger.warn(
        "CORS_ALLOWED_ORIGINS is '*' — any website can call this API from a browser. " +
          "Name the origins you actually serve instead.",
      );
      return;
    case "list":
      logger.info({ allowedOrigins: policy.origins }, "CORS allowlist active");
      return;
    case "loopback":
      logger.info(
        "CORS: loopback origins only (development default). Set CORS_ALLOWED_ORIGINS to name others.",
      );
      return;
    case "none":
      logger.info(
        "CORS: no cross-origin requests allowed — same-origin only, which is how nginx serves this. " +
          "Set CORS_ALLOWED_ORIGINS if a separate frontend origin needs access.",
      );
  }
}
