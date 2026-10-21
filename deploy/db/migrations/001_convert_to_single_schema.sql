-- 001_convert_to_single_schema.sql
--
-- Brings a database created before 2026-09-29 to the current layout: every
-- table in the one schema `bhi`, nothing in `public`.
--
--   * drops the pre-BHI member tables, their uuid links, and the migration's
--     key map (companies, employee_members, dependents, beneficiaries,
--     legacy_key_map);
--   * drops the seven client import tables the application never used
--     (source_workbook_archive, source_workbook_sheet, raw_enrollment_row,
--     raw_enrollment_cell, import_adjustment, import_documentation,
--     import_reconciliation) and import_batch_record, which only linked them;
--   * merges audit_logs + app_event_logs into bhi.activity_log;
--   * merges verification_sessions + card_sessions + lookup_alerts into
--     bhi.employee_sessions (open cards are not carried over: they last minutes,
--     and the employee simply looks the card up again);
--   * folds change_request_documents into bhi.change_requests;
--   * folds client_group_companies into bhi.client_groups.company_numbers;
--   * moves every other platform table, and the row-level security functions,
--     into bhi.
--
-- A database created from the current schema.sql has none of the old objects,
-- so every step below is skipped. Safe to run on every deploy.

BEGIN;

-- --- 1. the pre-BHI member model ---------------------------------------------
ALTER TABLE IF EXISTS public.card_sessions         DROP COLUMN IF EXISTS member_id;
ALTER TABLE IF EXISTS public.change_requests       DROP COLUMN IF EXISTS member_id;
ALTER TABLE IF EXISTS public.change_requests       DROP COLUMN IF EXISTS dependent_id;
ALTER TABLE IF EXISTS public.policy_memberships    DROP COLUMN IF EXISTS member_id;
ALTER TABLE IF EXISTS public.verification_sessions DROP COLUMN IF EXISTS member_id;
DROP TABLE IF EXISTS public.legacy_key_map;
DROP TABLE IF EXISTS public.beneficiaries;
DROP TABLE IF EXISTS public.dependents;
DROP TABLE IF EXISTS public.employee_members;
DROP TABLE IF EXISTS public.companies;

-- --- 2. client import tables the application never used ----------------------
DROP TABLE IF EXISTS bhi.raw_enrollment_cell, bhi.raw_enrollment_row,
                     bhi.source_workbook_sheet, bhi.source_workbook_archive,
                     bhi.import_adjustment, bhi.import_documentation,
                     bhi.import_reconciliation;
DROP TABLE IF EXISTS public.import_batch_record;

-- --- 3. row-level security functions move into bhi ---------------------------
-- ALTER ... SET SCHEMA keeps each function's identity, so the policies and
-- triggers that use them keep working. The bodies are then rewritten, because
-- they name each other by their old names.
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT * FROM (VALUES
      ('bhi_scope_all()',                'scope_all'),
      ('bhi_scope_readonly()',           'scope_readonly'),
      ('bhi_scope_has(text)',            'scope_has'),
      ('bhi_can_write(text)',            'can_write'),
      ('bhi_can_write_all()',            'can_write_all'),
      ('bhi_billing_line_final_guard()', 'billing_line_final_guard'),
      ('bhi_billing_run_final_guard()',  'billing_run_final_guard'),
      ('bhi_premium_rate_final_guard()', 'premium_rate_final_guard')
    ) AS t(old_sig, new_name)
  LOOP
    IF to_regprocedure('public.' || f.old_sig) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION public.%s SET SCHEMA bhi', f.old_sig);
      EXECUTE format('ALTER FUNCTION bhi.%s RENAME TO %I', f.old_sig, f.new_name);
    END IF;
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION bhi.scope_all() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('bhi.all', true), '') = 'on'
$$;
CREATE OR REPLACE FUNCTION bhi.scope_readonly() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('bhi.readonly', true), '') = 'on'
$$;
CREATE OR REPLACE FUNCTION bhi.scope_has(company text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT bhi.scope_all()
      OR (company IS NOT NULL
          AND company = ANY (string_to_array(nullif(current_setting('bhi.companies', true), ''), ',')))
$$;
CREATE OR REPLACE FUNCTION bhi.can_write(company text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT bhi.scope_readonly()
     AND (bhi.scope_all()
          OR (bhi.scope_has(company)
              AND EXISTS (SELECT 1 FROM bhi.company c WHERE c.company_number = company AND c.active)))
$$;
CREATE OR REPLACE FUNCTION bhi.can_write_all() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT bhi.scope_readonly() AND bhi.scope_all()
$$;
DO $$
BEGIN
  IF to_regprocedure('bhi.billing_line_final_guard()') IS NOT NULL THEN
    ALTER FUNCTION bhi.billing_line_final_guard() SET search_path = pg_catalog, bhi;
    ALTER FUNCTION bhi.billing_run_final_guard() SET search_path = pg_catalog, bhi;
    ALTER FUNCTION bhi.premium_rate_final_guard() SET search_path = pg_catalog, bhi;
  END IF;
END
$$;

-- --- 4. platform tables that move unchanged -----------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['admin_users', 'policy_memberships', 'change_requests', 'client_groups',
                           'import_batch', 'import_exception_resolutions', 'member_class_history',
                           'billing_run_issues']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA bhi', t);
    END IF;
  END LOOP;
  -- Owned by import_batch.source_ordinal, so it normally moves with the table.
  IF to_regclass('public.import_batch_ordinal_seq') IS NOT NULL THEN
    ALTER SEQUENCE public.import_batch_ordinal_seq SET SCHEMA bhi;
  END IF;
END
$$;

-- --- 5. audit_logs + app_event_logs -> activity_log ---------------------------
CREATE TABLE IF NOT EXISTS bhi.activity_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text        NOT NULL CHECK (kind IN ('AUDIT', 'EVENT')),
  "timestamp"  timestamptz NOT NULL DEFAULT now(),
  actor        text        NOT NULL,
  actor_role   text,
  action       text        NOT NULL,
  entity_type  text,
  entity_id    text,
  before_value text,
  after_value  text,
  reason       text,
  source_ip    text,
  company_code text,
  result       text,
  error_code   text,
  latency_ms   integer
);
CREATE INDEX IF NOT EXISTS activity_log_kind_timestamp_idx ON bhi.activity_log (kind, "timestamp" DESC);
CREATE INDEX IF NOT EXISTS activity_log_company_code_idx ON bhi.activity_log (company_code);

DO $$
BEGIN
  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    INSERT INTO bhi.activity_log (id, kind, "timestamp", actor, actor_role, action, entity_type, entity_id,
                                  before_value, after_value, reason, source_ip, company_code)
    SELECT id, 'AUDIT', "timestamp", actor, actor_role, action, entity_type, entity_id,
           before_value, after_value, reason, source_ip, company_code
      FROM public.audit_logs
    ON CONFLICT (id) DO NOTHING;
    DROP TABLE public.audit_logs;
  END IF;
  IF to_regclass('public.app_event_logs') IS NOT NULL THEN
    INSERT INTO bhi.activity_log (id, kind, "timestamp", actor, action, result, error_code, latency_ms)
    SELECT id, 'EVENT', "timestamp", anonymized_key, event_type, result, error_code, latency_ms
      FROM public.app_event_logs
    ON CONFLICT (id) DO NOTHING;
    DROP TABLE public.app_event_logs;
  END IF;
END
$$;

-- --- 6. verification_sessions + card_sessions + lookup_alerts -> employee_sessions
CREATE TABLE IF NOT EXISTS bhi.employee_sessions (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lookup_channel        text        NOT NULL CHECK (lookup_channel IN ('EMAIL', 'PHONE')),
  masked_destination    text        NOT NULL,
  destination           text,
  otp_hash              text        NOT NULL,
  company_code          text,
  matched_members       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  expires_at            timestamptz NOT NULL,
  attempts              integer     NOT NULL DEFAULT 0,
  resend_count          integer     NOT NULL DEFAULT 0,
  last_sent_at          timestamptz NOT NULL DEFAULT now(),
  status                text        NOT NULL DEFAULT 'PENDING'
                                    CHECK (status IN ('PENDING', 'VERIFIED', 'EXPIRED', 'LOCKED')),
  card_token_hash       text        UNIQUE,
  card_member_id        integer     REFERENCES bhi.member (member_id) ON UPDATE CASCADE,
  card_issued_at        timestamptz,
  card_expires_at       timestamptz,
  card_revoked          boolean     NOT NULL DEFAULT false,
  alert_status          text        CHECK (alert_status IN ('OPEN', 'RESOLVED')),
  alert_matches         jsonb,
  alert_raised_at       timestamptz,
  alert_resolved_by     text,
  alert_resolution_note text,
  alert_resolved_at     timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS employee_sessions_created_at_idx ON bhi.employee_sessions (created_at DESC);
CREATE INDEX IF NOT EXISTS employee_sessions_card_member_idx ON bhi.employee_sessions (card_member_id)
  WHERE card_member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS employee_sessions_alert_idx ON bhi.employee_sessions (alert_status, alert_raised_at DESC)
  WHERE alert_status IS NOT NULL;

DO $$
BEGIN
  IF to_regclass('public.verification_sessions') IS NOT NULL THEN
    INSERT INTO bhi.employee_sessions (id, lookup_channel, masked_destination, destination, otp_hash, company_code,
                                       matched_members, expires_at, attempts, resend_count, last_sent_at, status,
                                       created_at, updated_at)
    SELECT id, lookup_channel, masked_destination, destination, otp_hash, company_code,
           matched_members, expires_at, attempts, resend_count, last_sent_at, status, created_at, updated_at
      FROM public.verification_sessions
    ON CONFLICT (id) DO NOTHING;
    IF to_regclass('public.lookup_alerts') IS NOT NULL THEN
      UPDATE bhi.employee_sessions s
         SET alert_status = a.status, alert_matches = a.matches, alert_raised_at = a.created_at,
             alert_resolved_by = a.resolved_by, alert_resolution_note = a.resolution_note,
             alert_resolved_at = a.resolved_at
        FROM public.lookup_alerts a
       WHERE a.verification_session_id = s.id;
      DROP TABLE public.lookup_alerts;
    END IF;
    DROP TABLE public.verification_sessions;
  END IF;
  DROP TABLE IF EXISTS public.card_sessions;
END
$$;

-- --- 7. change_request_documents -> change_requests.document_* ----------------
ALTER TABLE bhi.change_requests
  ADD COLUMN IF NOT EXISTS document_type              text,
  ADD COLUMN IF NOT EXISTS document_file_name         text,
  ADD COLUMN IF NOT EXISTS document_mime_type         text,
  ADD COLUMN IF NOT EXISTS document_byte_size         integer,
  ADD COLUMN IF NOT EXISTS document_sha256            text,
  ADD COLUMN IF NOT EXISTS document_content           bytea,
  ADD COLUMN IF NOT EXISTS document_content_purged_at timestamptz;

DO $$
BEGIN
  IF to_regclass('public.change_request_documents') IS NOT NULL THEN
    UPDATE bhi.change_requests r
       SET document_type = d.document_type, document_file_name = d.file_name,
           document_mime_type = d.mime_type, document_byte_size = d.byte_size,
           document_sha256 = d.sha256, document_content = d.content,
           document_content_purged_at = d.content_purged_at
      FROM public.change_request_documents d
     WHERE d.change_request_id = r.id;
    DROP TABLE public.change_request_documents;
  END IF;
END
$$;

-- --- 8. client_group_companies -> client_groups.company_numbers ---------------
-- 004 drops client_groups; once it has, there is nothing to fold.
ALTER TABLE IF EXISTS bhi.client_groups ADD COLUMN IF NOT EXISTS company_numbers varchar(20)[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF to_regclass('public.client_group_companies') IS NOT NULL AND to_regclass('bhi.client_groups') IS NOT NULL THEN
    UPDATE bhi.client_groups g
       SET company_numbers = sub.numbers
      FROM (SELECT group_id, array_agg(company_number ORDER BY company_number) AS numbers
              FROM public.client_group_companies GROUP BY group_id) sub
     WHERE sub.group_id = g.id;
    DROP TABLE public.client_group_companies;
  END IF;
END
$$;

-- --- 9. card lookup by phone --------------------------------------------------
-- Matches phoneSuffixSql in artifacts/api-server/src/lib/phone.ts (phone.test.ts checks it).
CREATE INDEX IF NOT EXISTS member_phone_suffix_idx
    ON bhi.member (right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 7));

-- --- 10. pgcrypto is no longer needed ----------------------------------------
-- gen_random_uuid() is built into PostgreSQL 13 and later; hashing happens in
-- the API. Dropping the extension empties public. Only its owner may drop it,
-- so where a superuser created it this is skipped and it stays, unused.
DO $$
BEGIN
  DROP EXTENSION IF EXISTS pgcrypto;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'pgcrypto left in place: only its owner can drop it. Nothing uses it.';
END
$$;

COMMIT;

-- Every scoped role has its scope, so the role/scope check holds for all rows.
-- Validating an already valid constraint is a no-op.
ALTER TABLE bhi.admin_users VALIDATE CONSTRAINT admin_users_scope_by_role_check;
