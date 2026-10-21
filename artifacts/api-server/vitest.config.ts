import { defineConfig } from "vitest/config";

// Integration tests (src/integration) run against TEST_DATABASE_URL, which must
// be the application role (bhi_app) — never a superuser, which would bypass the
// row-level security those tests exist to prove. When it is set, it becomes the
// DATABASE_URL that @workspace/db reads at import time, together with the few
// settings the app needs to boot in-process.
//
// Unit tests are unaffected: with TEST_DATABASE_URL unset nothing is injected,
// and the integration suites skip themselves (see src/integration/testDb.ts).
const testDb = process.env["TEST_DATABASE_URL"];

export default defineConfig({
  test: {
    env: testDb
      ? {
          DATABASE_URL: testDb,
          SESSION_SECRET: process.env["SESSION_SECRET"] ?? "integration-test-secret-not-for-production",
          OTP_DEV_MODE: "true",
          NODE_ENV: "test",
          DEMO_SEED: process.env["DEMO_SEED"] ?? "false",
        }
      : {},
  },
});
