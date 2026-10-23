-- 002_admin_and_settings.sql — the admin portal, and discount settings an
-- admin can change without a restart.
--
-- Admins are listed in ADMIN_EMAILS (.env); they sign in with an emailed code
-- like employees, but with their own passcodes and sessions, so an admin
-- session can never act as an employee or the other way round.
--
-- The discount terms move from .env into the database. The app fills these
-- tables from the .env values on first start; after that the admin portal is
-- where they change.

CREATE TABLE IF NOT EXISTS admin_otp_challenges (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL CHECK (email = lower(email)),
    code_hash text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'USED', 'SUPERSEDED', 'LOCKED')),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_otp_challenges_email_idx ON admin_otp_challenges (email, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
);

-- The program as a whole: one row.
CREATE TABLE IF NOT EXISTS program_settings (
    id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    -- The most one employee can save in a calendar month, all stores together.
    monthly_cap numeric(15,2) NOT NULL CHECK (monthly_cap >= 0),
    code_ttl_minutes integer NOT NULL CHECK (code_ttl_minutes BETWEEN 1 AND 1440),
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text
);

-- Each partner store: its own percentage, an optional monthly limit of its own
-- (inside the overall one), and whether it takes codes at all.
CREATE TABLE IF NOT EXISTS store_settings (
    store text PRIMARY KEY CHECK (store IN ('KFC', 'PIZZA_HUT', 'STERLING', 'BEHARRY')),
    discount_percent numeric(5,2) NOT NULL CHECK (discount_percent > 0 AND discount_percent <= 100),
    monthly_cap numeric(15,2) CHECK (monthly_cap IS NULL OR monthly_cap >= 0),
    enabled boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text
);

-- A code no longer carries a percentage when it is made: the store that
-- redeems it decides. discount_percent now records what was applied.
ALTER TABLE discount_codes ALTER COLUMN discount_percent DROP NOT NULL;

-- Per-store spending this month, for the per-store limits and the dashboard.
CREATE INDEX IF NOT EXISTS discount_codes_store_redeemed_idx ON discount_codes (store, redeemed_at) WHERE status = 'REDEEMED';
