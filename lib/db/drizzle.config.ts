import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set (postgresql://USER:PASSWORD@HOST:5432/bhi_portal).");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  // Read-only use only (e.g. drizzle-kit studio). The database structure is
  // owned by deploy/db/schema.sql and deploy/db/migrations/: schema `bhi`
  // carries row-level security policies, grants and triggers that drizzle-kit
  // does not model, and a push would try to "fix" them away. Never push.
  schemaFilter: ["bhi"],
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
