import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { corsOptions, isOriginAllowed, originPolicy, type OriginPolicy } from "./cors";

let savedOrigins: string | undefined;
let savedNodeEnv: string | undefined;

beforeEach(() => {
  savedOrigins = process.env["CORS_ALLOWED_ORIGINS"];
  savedNodeEnv = process.env["NODE_ENV"];
  delete process.env["CORS_ALLOWED_ORIGINS"];
});

afterEach(() => {
  if (savedOrigins === undefined) delete process.env["CORS_ALLOWED_ORIGINS"];
  else process.env["CORS_ALLOWED_ORIGINS"] = savedOrigins;
  if (savedNodeEnv === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = savedNodeEnv;
});

describe("originPolicy", () => {
  it("allows nothing cross-origin in production when unset", () => {
    // The portal is served from the same origin as the API, so this is the
    // correct production answer — and the opposite of the old bare cors().
    process.env["NODE_ENV"] = "production";
    expect(originPolicy()).toEqual({ kind: "none" });
  });

  it("allows loopback in development when unset", () => {
    process.env["NODE_ENV"] = "development";
    expect(originPolicy()).toEqual({ kind: "loopback" });
  });

  it("reads a comma-separated allowlist", () => {
    process.env["CORS_ALLOWED_ORIGINS"] = "https://portal.example.com,https://admin.example.com";
    expect(originPolicy()).toEqual({
      kind: "list",
      origins: ["https://portal.example.com", "https://admin.example.com"],
    });
  });

  it("normalises case, whitespace and trailing slashes", () => {
    process.env["CORS_ALLOWED_ORIGINS"] = "  HTTPS://Portal.Example.com/ , https://b.example.com ";
    expect(originPolicy()).toEqual({
      kind: "list",
      origins: ["https://portal.example.com", "https://b.example.com"],
    });
  });

  it("treats an explicit * as opting into anything", () => {
    process.env["CORS_ALLOWED_ORIGINS"] = "*";
    expect(originPolicy()).toEqual({ kind: "any" });
  });

  it("treats a list of nothing but commas as allowing nothing", () => {
    process.env["CORS_ALLOWED_ORIGINS"] = " , , ";
    expect(originPolicy()).toEqual({ kind: "none" });
  });
});

describe("isOriginAllowed", () => {
  const list: OriginPolicy = { kind: "list", origins: ["https://portal.example.com"] };

  it("matches an allowlisted origin exactly", () => {
    expect(isOriginAllowed("https://portal.example.com", list)).toBe(true);
  });

  it("ignores a trailing slash and casing on the request origin", () => {
    expect(isOriginAllowed("https://Portal.Example.com/", list)).toBe(true);
  });

  it("refuses a different host", () => {
    expect(isOriginAllowed("https://evil.example.com", list)).toBe(false);
  });

  it("refuses a subdomain of an allowlisted host", () => {
    // Exact match only. "evil.portal.example.com" is a different origin and an
    // attacker who can create a subdomain must not inherit access.
    expect(isOriginAllowed("https://evil.portal.example.com", list)).toBe(false);
  });

  it("refuses a host that merely ends with an allowlisted one", () => {
    expect(isOriginAllowed("https://notportal.example.com", list)).toBe(false);
    expect(isOriginAllowed("https://portal.example.com.evil.test", list)).toBe(false);
  });

  it("distinguishes scheme and port", () => {
    expect(isOriginAllowed("http://portal.example.com", list)).toBe(false);
    expect(isOriginAllowed("https://portal.example.com:8443", list)).toBe(false);
  });

  it("allows loopback on any port under the loopback policy", () => {
    const loopback = { kind: "loopback" } as const;
    for (const origin of [
      "http://localhost:8080",
      "http://localhost:5173",
      "http://127.0.0.1:3101",
      "https://localhost",
      "http://[::1]:8080",
    ]) {
      expect(isOriginAllowed(origin, loopback), origin).toBe(true);
    }
  });

  it("refuses a public origin under the loopback policy", () => {
    const loopback = { kind: "loopback" } as const;
    expect(isOriginAllowed("https://portal.example.com", loopback)).toBe(false);
    // A hostname that merely contains "localhost" is not loopback.
    expect(isOriginAllowed("https://localhost.evil.test", loopback)).toBe(false);
  });

  it("refuses everything under the none policy", () => {
    expect(isOriginAllowed("https://portal.example.com", { kind: "none" })).toBe(false);
    expect(isOriginAllowed("http://localhost:8080", { kind: "none" })).toBe(false);
  });

  it("allows everything under the any policy", () => {
    expect(isOriginAllowed("https://anything.test", { kind: "any" })).toBe(true);
  });

  it("refuses an empty origin", () => {
    expect(isOriginAllowed("", list)).toBe(false);
  });
});

describe("corsOptions", () => {
  const resolve = (origin: string | undefined): boolean => {
    let allowed = false;
    const opts = corsOptions();
    (opts.origin as (o: string | undefined, cb: (e: Error | null, ok?: boolean) => void) => void)(
      origin,
      (_err, ok) => {
        allowed = ok === true;
      },
    );
    return allowed;
  };

  it("permits a request with no Origin header", () => {
    // curl, health probes, server-to-server. Not a cross-origin read, and no
    // CORS headers are emitted for it either way.
    process.env["NODE_ENV"] = "production";
    expect(resolve(undefined)).toBe(true);
  });

  it("refuses rather than erroring, so a probe never becomes a 500", () => {
    process.env["NODE_ENV"] = "production";
    let error: Error | null | undefined;
    const opts = corsOptions();
    (opts.origin as (o: string | undefined, cb: (e: Error | null, ok?: boolean) => void) => void)(
      "https://evil.example.com",
      (err) => {
        error = err;
      },
    );
    expect(error).toBeNull();
  });

  it("honours the allowlist", () => {
    process.env["CORS_ALLOWED_ORIGINS"] = "https://portal.example.com";
    expect(resolve("https://portal.example.com")).toBe(true);
    expect(resolve("https://evil.example.com")).toBe(false);
  });

  it("advertises only the verbs the API exposes", () => {
    const { methods } = corsOptions();
    expect(methods).toEqual(["GET", "POST", "PATCH", "OPTIONS"]);
    // There is no DELETE anywhere in this service.
    expect(methods).not.toContain("DELETE");
  });

  it("allows the headers the clients actually send", () => {
    expect(corsOptions().allowedHeaders).toEqual([
      "Content-Type",
      "Authorization",
      "X-OTP-Strict",
    ]);
  });

  it("caches preflights, so a PATCH is one round trip and not two", () => {
    expect(corsOptions().maxAge).toBe(600);
  });

  it("does not enable credentials — tokens travel in Authorization", () => {
    expect(corsOptions().credentials).toBe(false);
  });
});
