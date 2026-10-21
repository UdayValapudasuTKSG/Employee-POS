import { uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { bhiSchema } from "./bhi/_schema";

export const adminUsersTable = bhiSchema.table("admin_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  // Stored values are unchanged from before the shared BHI model; only the
  // labels changed (ROLE_PLATFORM_ADMIN is shown as "Super admin"). See
  // lib/rbac.ts ROLE_LABELS and specs/002-per-company-schema/research.md R8.
  role: text("role", {
    enum: [
      "ROLE_PLATFORM_ADMIN",
      "ROLE_CLIENT_ADMIN",
      "ROLE_HR_ADMIN",
      "ROLE_SUPPORT",
      "ROLE_AUDITOR",
    ],
  }).notNull(),
  // The one company an HR administrator or client admin belongs to. Null for
  // every other role (enforced by admin_users_scope_by_role_check).
  companyScope: text("company_scope"),
  active: boolean("active").notNull().default(true),
  // Set on create / reset-password with a temporary password; forces a change at next sign-in.
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type AdminUser = typeof adminUsersTable.$inferSelect;
