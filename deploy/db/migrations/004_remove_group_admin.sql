-- 004_remove_group_admin.sql
--
-- Removes the group admin role and client groups (decision 2026-09-29): the
-- super admin is the only role above a company, and every company has its own
-- client admin and HR administrators.
--
--   * deletes group admin accounts (ROLE_HR_GROUP_ADMIN). No table refers to an
--     admin_users row, and their past actions stay in bhi.activity_log, which
--     keeps the actor's email and role as text;
--   * drops admin_users.group_scope and bhi.client_groups;
--   * narrows the role/scope check to company_scope alone.
--
-- A database created from the current schema.sql has none of these, so every
-- step is skipped. Safe to run on every deploy.

BEGIN;

DO $$
DECLARE
  removed text;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'bhi' AND table_name = 'admin_users' AND column_name = 'group_scope') THEN
    SELECT string_agg(email, ', ' ORDER BY email) INTO removed
      FROM bhi.admin_users WHERE role = 'ROLE_HR_GROUP_ADMIN';
    IF removed IS NOT NULL THEN
      RAISE NOTICE 'Removing group admin accounts: %', removed;
      DELETE FROM bhi.admin_users WHERE role = 'ROLE_HR_GROUP_ADMIN';
    END IF;

    ALTER TABLE bhi.admin_users DROP CONSTRAINT IF EXISTS admin_users_scope_by_role_check;
    ALTER TABLE bhi.admin_users DROP CONSTRAINT IF EXISTS admin_users_group_scope_fk;
    ALTER TABLE bhi.admin_users DROP COLUMN group_scope;
    ALTER TABLE bhi.admin_users ADD CONSTRAINT admin_users_scope_by_role_check CHECK (
      CASE role
        WHEN 'ROLE_HR_ADMIN' THEN company_scope IS NOT NULL
        WHEN 'ROLE_CLIENT_ADMIN' THEN company_scope IS NOT NULL
        ELSE company_scope IS NULL
      END);
  END IF;

  -- The role column is free text; this keeps a removed role from coming back.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_users_role_check' AND conrelid = 'bhi.admin_users'::regclass) THEN
    ALTER TABLE bhi.admin_users ADD CONSTRAINT admin_users_role_check CHECK (role IN (
      'ROLE_PLATFORM_ADMIN', 'ROLE_CLIENT_ADMIN', 'ROLE_HR_ADMIN', 'ROLE_SUPPORT', 'ROLE_AUDITOR'));
  END IF;
END
$$;

DROP TABLE IF EXISTS bhi.client_groups;

COMMIT;
