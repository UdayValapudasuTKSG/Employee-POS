-- 009_employee_discounts.sql — idempotent: employee discount coupons.
--
-- One portal table, bhi.discount_coupons: a coupon a member generates for a
-- partner brand (KFC, Pizza Hut), and its redemption by that brand's POS. The
-- code is stored only as its sha256. Only REDEEMED rows count against the
-- member's monthly allowance (artifacts/api-server/src/lib/discounts.ts).
--
-- A portal table like change_requests: not under row-level security. The API
-- reaches it only through a card session (the member's own rows) or a POS key
-- (that brand's coupons). bhi_app may read, insert and update it, never delete.

BEGIN;

CREATE TABLE IF NOT EXISTS bhi.discount_coupons (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    member_ref integer NOT NULL,
    company_number text NOT NULL,
    brand text NOT NULL,
    code_hash text NOT NULL,
    discount_percent numeric(5,2) NOT NULL,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    redeemed_at timestamp with time zone,
    bill_amount numeric(15,2),
    discount_amount numeric(15,2),
    pos_reference text,
    pos_store text,
    voided_at timestamp with time zone,
    void_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT discount_coupons_pkey PRIMARY KEY (id),
    CONSTRAINT discount_coupons_code_hash_key UNIQUE (code_hash),
    CONSTRAINT discount_coupons_member_ref_fk FOREIGN KEY (member_ref)
        REFERENCES bhi.member(member_id) ON UPDATE CASCADE,
    CONSTRAINT discount_coupons_brand_check CHECK (brand = ANY (ARRAY['KFC'::text, 'PIZZA_HUT'::text])),
    CONSTRAINT discount_coupons_status_check
        CHECK (status = ANY (ARRAY['ACTIVE'::text, 'REDEEMED'::text, 'VOIDED'::text, 'CANCELLED'::text])),
    CONSTRAINT discount_coupons_percent_check CHECK (discount_percent > 0 AND discount_percent <= 100),
    -- A redeemed (or later voided) coupon always carries what it was redeemed for.
    CONSTRAINT discount_coupons_redemption_check CHECK (
        status NOT IN ('REDEEMED', 'VOIDED')
        OR (redeemed_at IS NOT NULL AND bill_amount IS NOT NULL AND discount_amount IS NOT NULL)),
    CONSTRAINT discount_coupons_amounts_check CHECK (
        (bill_amount IS NULL OR bill_amount >= 0)
        AND (discount_amount IS NULL OR (discount_amount >= 0 AND discount_amount <= bill_amount)))
);

CREATE INDEX IF NOT EXISTS discount_coupons_member_ref_idx
    ON bhi.discount_coupons USING btree (member_ref, created_at DESC);

-- The monthly allowance sums exactly these rows.
CREATE INDEX IF NOT EXISTS discount_coupons_redeemed_idx
    ON bhi.discount_coupons USING btree (member_ref, redeemed_at)
    WHERE status = 'REDEEMED';

-- 002's default privileges already cover a table the owner creates; stated
-- here as well so the rights do not depend on which login ran 002.
GRANT SELECT, INSERT, UPDATE ON bhi.discount_coupons TO bhi_app;
REVOKE DELETE, TRUNCATE ON bhi.discount_coupons FROM bhi_app;

COMMIT;
