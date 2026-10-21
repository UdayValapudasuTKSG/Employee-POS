-- 002_roles_grants.sql — what the API may do. Idempotent: run on every deploy.
--
-- There is ONE database login: the one in DATABASE_URL. It owns the tables and
-- runs these migrations. The API connects with that same URL but switches every
-- connection to the restricted role bhi_app as it opens (lib/db/src/connection.ts,
-- "-c role=bhi_app"), and even RESET ROLE stays on bhi_app. As bhi_app it:
--   * may read, insert and update every table in bhi but never DELETE or
--     TRUNCATE one, so no application path can hard-delete a member,
--     dependant, beneficiary, class, rate, bill or any record of the portal
--     (Constitution Principle III);
--   * may only insert and read bhi.activity_log: history is never rewritten;
--   * is subject to row-level security on the client's tables, because it is
--     neither a superuser nor BYPASSRLS nor the table owner.
--
-- This file creates bhi_app (no login of its own, no password) and lets the
-- DATABASE_URL login switch to it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bhi_app') THEN
    BEGIN
      CREATE ROLE bhi_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'The login % cannot create the bhi_app role. Run the migrations once with a login that can create roles (the Postgres superuser, or a cloud database''s admin user).', current_user;
    END;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bhi_app' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Role bhi_app must not be SUPERUSER or BYPASSRLS: it would skip the row-level security that keeps companies apart.';
  END IF;
  -- The DATABASE_URL login must be allowed to switch to bhi_app. A superuser
  -- always may; anyone else needs membership.
  IF NOT pg_has_role(current_user, 'bhi_app', 'MEMBER') THEN
    BEGIN
      EXECUTE format('GRANT bhi_app TO %I', current_user);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'The login % may not switch to bhi_app, so the API will not connect with it. Run as the Postgres superuser: GRANT bhi_app TO %;', current_user, current_user;
    END;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA bhi TO bhi_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA bhi TO bhi_app;
REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA bhi FROM bhi_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA bhi TO bhi_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA bhi TO bhi_app;

-- Tables added to bhi later get the same rights automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA bhi GRANT SELECT, INSERT, UPDATE ON TABLES TO bhi_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA bhi GRANT USAGE, SELECT ON SEQUENCES TO bhi_app;

-- The activity log is append-only.
REVOKE UPDATE ON bhi.activity_log FROM bhi_app;

-- Nothing lives in public any more.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM bhi_app;

-- So `psql` finds the tables without a schema prefix. The application itself
-- always names the schema.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = bhi, public', current_database());
END
$$;
