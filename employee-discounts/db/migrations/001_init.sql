-- 001_init.sql — Beharry staff discounts.
--
-- Applied automatically by the app on start (server/migrate.ts), once, and
-- recorded in schema_migrations. Every statement is also safe to re-run.
--
-- The rule the schema holds: an employee has at most ONE live code at a time
-- (one_active_code_per_employee), and a code is used once, at any one store.
-- Codes and one-time passcodes are stored as sha256 hashes; the code itself is
-- also kept encrypted (code_enc) so the employee can see it again until it is
-- used — the key never leaves the server.

CREATE TABLE IF NOT EXISTS employees (
    id serial PRIMARY KEY,
    email text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND email LIKE '%@%'),
    first_name text NOT NULL,
    last_name text NOT NULL,
    employee_number text UNIQUE,
    company text NOT NULL DEFAULT 'Edward B. Beharry & Company Ltd',
    phone text,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- A one-time passcode, for signing in (LOGIN) or for confirming a new
-- discount code (CODE). Only the newest PENDING one of each purpose works.
CREATE TABLE IF NOT EXISTS otp_challenges (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id integer NOT NULL REFERENCES employees(id),
    purpose text NOT NULL CHECK (purpose IN ('LOGIN', 'CODE')),
    code_hash text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'USED', 'SUPERSEDED', 'LOCKED')),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_challenges_employee_idx ON otp_challenges (employee_id, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id integer NOT NULL REFERENCES employees(id),
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS discount_codes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id integer NOT NULL REFERENCES employees(id),
    code_hash text NOT NULL UNIQUE,
    code_enc text NOT NULL,
    discount_percent numeric(5,2) NOT NULL CHECK (discount_percent > 0 AND discount_percent <= 100),
    status text NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'REDEEMED', 'VOIDED', 'REPLACED', 'EXPIRED')),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- the redemption: which store, which till, what bill
    store text CHECK (store IN ('KFC', 'PIZZA_HUT', 'STERLING', 'BEHARRY')),
    store_location text,
    pos_reference text,
    redeemed_at timestamptz,
    bill_amount numeric(15,2),
    full_discount_amount numeric(15,2),
    discount_amount numeric(15,2),
    voided_at timestamptz,
    void_reason text,
    CONSTRAINT discount_codes_redemption_check CHECK (
        status NOT IN ('REDEEMED', 'VOIDED')
        OR (store IS NOT NULL AND redeemed_at IS NOT NULL AND bill_amount IS NOT NULL AND discount_amount IS NOT NULL)),
    CONSTRAINT discount_codes_amounts_check CHECK (
        (bill_amount IS NULL OR bill_amount > 0)
        AND (discount_amount IS NULL OR (discount_amount >= 0 AND discount_amount <= bill_amount)))
);
-- One live code per employee, enforced by the database itself.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_code_per_employee ON discount_codes (employee_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS discount_codes_history_idx ON discount_codes (employee_id, created_at DESC);
-- The monthly allowance sums exactly these rows.
CREATE INDEX IF NOT EXISTS discount_codes_redeemed_idx ON discount_codes (employee_id, redeemed_at) WHERE status = 'REDEEMED';

-- Append-only trail of who did what.
CREATE TABLE IF NOT EXISTS audit_log (
    id bigserial PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT now(),
    actor text NOT NULL,
    action text NOT NULL,
    entity_id text,
    detail jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);
