-- 007_billing_rule_shares.sql — idempotent: a billing rule's shares total 100.
--
-- CompanySharePercent + EmployeeSharePercent = 100 was checked only when a rule
-- was entered in the portal. Billing takes the company's part from the first
-- and the employee's as the remainder, which equals the second only while the
-- two total 100 — so the database now holds every row to it, and to 0-100 each.
--
-- Added NOT VALID first, then validated: a row that breaks it stops the
-- migration with the offending rule named, instead of billing on it.

BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'company_billing_rule_shares_check'
                    AND conrelid = 'bhi.company_billing_rule'::regclass) THEN
    ALTER TABLE bhi.company_billing_rule
      ADD CONSTRAINT company_billing_rule_shares_check CHECK (
        company_share_percent BETWEEN 0 AND 100
        AND employee_share_percent BETWEEN 0 AND 100
        AND company_share_percent + employee_share_percent = 100) NOT VALID;
  END IF;
END
$$;
ALTER TABLE bhi.company_billing_rule VALIDATE CONSTRAINT company_billing_rule_shares_check;
COMMIT;
