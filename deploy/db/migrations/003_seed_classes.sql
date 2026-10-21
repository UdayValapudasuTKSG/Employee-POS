-- 003_seed_classes.sql — idempotent: the initial classes A, B and C (spec FR-021).
--
-- Values from deploy/db/seed/classes.csv. The names are placeholders until the
-- client confirms them; a super admin can rename them in the portal. Existing
-- rows are never overwritten.
--
-- bhi.class accepts writes only in the all-companies scope, and FORCE ROW
-- LEVEL SECURITY applies that to the owner running this file too, so the scope
-- is set for this transaction first.

BEGIN;
DO $$ BEGIN PERFORM set_config('bhi.all', 'on', true); END $$;

INSERT INTO bhi.class (class_code, class_name, description, active, sort_order) VALUES
  ('A', 'Class A', NULL, true, 1),
  ('B', 'Class B', NULL, true, 2),
  ('C', 'Class C', NULL, true, 3)
ON CONFLICT (class_code) DO NOTHING;

COMMIT;
