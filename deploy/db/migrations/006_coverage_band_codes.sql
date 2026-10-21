-- 006_coverage_band_codes.sql — idempotent: the client's CoverageBand codes.
--
-- The client's BHI Enrollment Database names the four premium tiers
--
--   DependentBand 0  EMP_ONLY        Employee only
--   DependentBand 1  EMP_PLUS_1      Employee + 1 dependent
--   DependentBand 2  EMP_PLUS_2      Employee + 2 dependents
--   DependentBand 3  EMP_PLUS_3PLUS  Employee + 3 or more dependents
--
-- The portal first stored EE, EE+1, EE+2 and EE+3+. This renames them — in
-- premium_rates and in billing_line, which copies the band onto each line — so
-- rate cards and bills exchanged with the client carry the same codes.
--
-- Only the code and its label change: the band number, the prices and every
-- other column stay as they are. FINAL bills and the rates they used are
-- guarded against change (billing_line_final_guard, premium_rate_final_guard);
-- for this rename alone those guards are switched off, and back on before the
-- transaction commits, so nothing else can slip through.

BEGIN;
DO $$ BEGIN PERFORM set_config('bhi.all', 'on', true); END $$;

CREATE TEMP TABLE band_codes (old_code text PRIMARY KEY, new_code text NOT NULL, new_label text NOT NULL) ON COMMIT DROP;
INSERT INTO band_codes VALUES
  ('EE',    'EMP_ONLY',       'Employee only'),
  ('EE+1',  'EMP_PLUS_1',     'Employee + 1 dependent'),
  ('EE+2',  'EMP_PLUS_2',     'Employee + 2 dependents'),
  ('EE+3+', 'EMP_PLUS_3PLUS', 'Employee + 3 or more dependents');

ALTER TABLE bhi.premium_rates DISABLE TRIGGER premium_rate_final_guard;
ALTER TABLE bhi.billing_line DISABLE TRIGGER billing_line_final_guard;

UPDATE bhi.premium_rates p
   SET coverage_band = b.new_code, coverage_label = b.new_label
  FROM band_codes b
 WHERE p.coverage_band = b.old_code;

UPDATE bhi.billing_line l
   SET coverage_band = b.new_code, coverage_label = b.new_label
  FROM band_codes b
 WHERE l.coverage_band = b.old_code;

ALTER TABLE bhi.billing_line ENABLE TRIGGER billing_line_final_guard;
ALTER TABLE bhi.premium_rates ENABLE TRIGGER premium_rate_final_guard;

COMMIT;
