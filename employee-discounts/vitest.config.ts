import { defineConfig } from "vitest/config";

// Unit tests only: no database is opened, but config.ts insists these exist.
export default defineConfig({
  test: {
    include: ["server/**/*.test.ts"],
    env: {
      SESSION_SECRET: "unit-test-secret-unit-test-secret-0000",
      DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
      APP_URL: "https://discounts.example.test",
    },
  },
});
