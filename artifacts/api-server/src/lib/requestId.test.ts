import { describe, expect, it } from "vitest";
import { resolveRequestId } from "./requestId";

describe("resolveRequestId", () => {
  it("reuses nginx's $request_id so one reference finds both logs", () => {
    // nginx emits 32 hex characters. Keeping it is what lets a single id match
    // the access log line and the API's own entries for the same request.
    const fromNginx = "9f2a1c4e8b7d6a5f0e3c2b1a09876543";
    expect(resolveRequestId(fromNginx)).toBe(fromNginx);
  });

  it("generates an id when the header is absent", () => {
    const id = resolveRequestId(undefined);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does not repeat itself", () => {
    // pino-http's default counter restarts at 1 on every process start, so after
    // a restart the same id refers to two unrelated requests and a search for a
    // quoted reference returns both.
    const ids = new Set(Array.from({ length: 500 }, () => resolveRequestId(undefined)));
    expect(ids.size).toBe(500);
  });

  it("rejects a value that could forge log entries", () => {
    // The id is written into the logs. A newline in it would let a caller append
    // whatever lines they liked, and a log that can be written to by its subject
    // is worth less than no log.
    const injected = "abc\n{\"level\":30,\"msg\":\"nothing to see here\"}";
    const resolved = resolveRequestId(injected);
    expect(resolved).not.toContain("\n");
    expect(resolved).toMatch(/^[0-9a-f]{16}$/);
  });

  it("rejects an over-long value", () => {
    expect(resolveRequestId("a".repeat(65))).toMatch(/^[0-9a-f]{16}$/);
    expect(resolveRequestId("a".repeat(64))).toBe("a".repeat(64));
  });

  it("rejects a repeated header, which nginx never sends", () => {
    expect(resolveRequestId(["first", "second"])).toMatch(/^[0-9a-f]{16}$/);
  });

  it("ignores surrounding whitespace rather than the whole header", () => {
    expect(resolveRequestId("  9f2a1c4e  ")).toBe("9f2a1c4e");
  });

  it("falls back when the header is empty", () => {
    expect(resolveRequestId("")).toMatch(/^[0-9a-f]{16}$/);
    expect(resolveRequestId("   ")).toMatch(/^[0-9a-f]{16}$/);
  });
});
