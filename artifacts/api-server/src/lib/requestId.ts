import { randomUUID } from "node:crypto";

/**
 * The identifier that ties one request together across every log that sees it.
 *
 * pino-http's default is a counter that restarts at 1 on every process start,
 * so after a restart today's "request 42" collides with yesterday's, and the
 * `journalctl` search for a reference an administrator quoted returns several
 * unrelated requests. A random id per request has no such collision.
 *
 * nginx already generates one — `$request_id` — and proxy_params forwards it as
 * X-Request-Id. Reusing it is what lets a single reference find both the nginx
 * access line and the API's own logs for the same request, which is the whole
 * point: nginx knows the status code and the client address, the API knows the
 * stack trace, and neither is much use without the other.
 */

/**
 * Characters allowed in an inbound X-Request-Id.
 *
 * The header reaches the logs, and a value containing newlines could forge
 * whole log entries — a log file that cannot be trusted is worse than one with
 * a missing id. nginx's own `$request_id` is 32 hex characters, so this is not
 * a restriction on anything legitimate.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Short enough for someone to read down the phone, long enough not to repeat. */
function generate(): string {
  return randomUUID().replaceAll("-", "").slice(0, 16);
}

/**
 * Resolves the id for a request from its X-Request-Id header, generating one
 * when the header is absent or unusable.
 *
 * Trusting a caller-supplied header is safe *here* and nowhere else: nginx sets
 * it with proxy_set_header, which overwrites whatever the client sent, and the
 * API binds to 127.0.0.1 so nginx is the only route in. The value is a log
 * label and grants no authority, so the worst a direct caller on the loopback
 * interface achieves is choosing their own reference string.
 */
export function resolveRequestId(headerValue: unknown): string {
  if (typeof headerValue === "string") {
    const trimmed = headerValue.trim();
    if (SAFE_REQUEST_ID.test(trimmed)) return trimmed;
  }
  // An array means the header arrived more than once, which nginx never does;
  // treat it as untrustworthy rather than picking one.
  return generate();
}
