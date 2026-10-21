-- 005_id_type_values.sql — idempotent: one stored spelling per Access ID type.
--
-- The Access database's IDType list is National ID, Passport and E-ID. The
-- portal now offers exactly those, stored upper-case as the carrier import has
-- always written them: NATIONAL ID, PASSPORT, E-ID. Members are matched on ID
-- type + ID number, so other spellings of the same type (NATIONAL_ID from the
-- old demo seed, NATIONALID, NID, E_ID, EID) are folded onto the stored form.
--
-- A member is left alone if the folded value would collide with another member
-- holding the same ID number (bhi.member_id_type_id_number_uq); the notice
-- names how many, for HR to review. Values outside the three types are kept.
--
-- The bhi tables accept writes only in the all-companies scope, and FORCE ROW
-- LEVEL SECURITY applies that to the owner running this file too.

BEGIN;
DO $$ BEGIN PERFORM set_config('bhi.all', 'on', true); END $$;

CREATE OR REPLACE FUNCTION pg_temp.fold_id_type(v text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE regexp_replace(upper(coalesce(v, '')), '[^A-Z]', '', 'g')
    WHEN 'NATIONALID' THEN 'NATIONAL ID'
    WHEN 'NATIONALIDCARD' THEN 'NATIONAL ID'
    WHEN 'NATID' THEN 'NATIONAL ID'
    WHEN 'NID' THEN 'NATIONAL ID'
    WHEN 'PASSPORT' THEN 'PASSPORT'
    WHEN 'PP' THEN 'PASSPORT'
    WHEN 'EID' THEN 'E-ID'
    WHEN 'EIDCARD' THEN 'E-ID'
    ELSE v
  END
$$;

DO $$
DECLARE
  r record;
  skipped integer := 0;
BEGIN
  -- One row at a time, so a clash — with a member already holding the folded
  -- value, or with another row folded a moment earlier — skips just that row.
  FOR r IN SELECT member_id, id_type FROM bhi.member
            WHERE pg_temp.fold_id_type(id_type) <> id_type ORDER BY member_id
  LOOP
    BEGIN
      UPDATE bhi.member SET id_type = pg_temp.fold_id_type(r.id_type) WHERE member_id = r.member_id;
    EXCEPTION WHEN unique_violation THEN
      skipped := skipped + 1;
    END;
  END LOOP;
  IF skipped > 0 THEN
    RAISE NOTICE '% member(s) kept their ID type: the folded value would duplicate another member with the same ID number', skipped;
  END IF;

  UPDATE bhi.dependent SET id_type = pg_temp.fold_id_type(id_type)
   WHERE id_type IS NOT NULL AND pg_temp.fold_id_type(id_type) <> id_type;
  UPDATE bhi.beneficiary SET id_type = pg_temp.fold_id_type(id_type)
   WHERE id_type IS NOT NULL AND pg_temp.fold_id_type(id_type) <> id_type;
END
$$;

COMMIT;
