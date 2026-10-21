-- 008_exception_resolution_method.sql — idempotent: how an import exception
-- was resolved, and why.
--
-- An exception used to be resolved only by a corrected row in a later import.
-- HR can now also mark one resolved by hand — the record was fixed another way
-- (entered in the portal, or no longer needed) — with a note saying so.
--
--   method  IMPORT  a corrected row loaded (member_id is the member it made or
--                   updated)
--           MANUAL  marked resolved by hand; note is required
--   note    the reason, for MANUAL (optional for IMPORT)

BEGIN;
ALTER TABLE bhi.import_exception_resolutions ADD COLUMN IF NOT EXISTS method varchar(10) NOT NULL DEFAULT 'IMPORT';
ALTER TABLE bhi.import_exception_resolutions ADD COLUMN IF NOT EXISTS note text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'import_exception_resolutions_method_check'
                    AND conrelid = 'bhi.import_exception_resolutions'::regclass) THEN
    ALTER TABLE bhi.import_exception_resolutions
      ADD CONSTRAINT import_exception_resolutions_method_check CHECK (
        method IN ('IMPORT', 'MANUAL') AND (method <> 'MANUAL' OR length(trim(coalesce(note, ''))) >= 3));
  END IF;
END
$$;
COMMIT;
