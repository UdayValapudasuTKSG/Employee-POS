-- 010_discount_coupon_otps.sql — idempotent: a one-time code before each coupon.
--
-- Generating a discount coupon now asks for a fresh one-time code, sent to the
-- member's email (or phone) on file. One row per code sent; only its sha256 is
-- stored, as with sign-in codes. Three wrong entries lock it.
--
-- A portal table, reached only through the member's own card session. bhi_app
-- may read, insert and update it, never delete.

BEGIN;

CREATE TABLE IF NOT EXISTS bhi.discount_coupon_otps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    member_ref integer NOT NULL,
    brand text NOT NULL,
    otp_hash text NOT NULL,
    channel text NOT NULL,
    masked_destination text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    coupon_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT discount_coupon_otps_pkey PRIMARY KEY (id),
    CONSTRAINT discount_coupon_otps_member_ref_fk FOREIGN KEY (member_ref)
        REFERENCES bhi.member(member_id) ON UPDATE CASCADE,
    CONSTRAINT discount_coupon_otps_coupon_fk FOREIGN KEY (coupon_id)
        REFERENCES bhi.discount_coupons(id),
    CONSTRAINT discount_coupon_otps_brand_check CHECK (brand = ANY (ARRAY['KFC'::text, 'PIZZA_HUT'::text])),
    CONSTRAINT discount_coupon_otps_channel_check CHECK (channel = ANY (ARRAY['EMAIL'::text, 'PHONE'::text])),
    CONSTRAINT discount_coupon_otps_status_check
        CHECK (status = ANY (ARRAY['PENDING'::text, 'USED'::text, 'SUPERSEDED'::text, 'LOCKED'::text])),
    CONSTRAINT discount_coupon_otps_used_check CHECK (status <> 'USED' OR (used_at IS NOT NULL AND coupon_id IS NOT NULL))
);

-- The resend cool-down and the supersede both look up a member's pending codes.
CREATE INDEX IF NOT EXISTS discount_coupon_otps_member_idx
    ON bhi.discount_coupon_otps USING btree (member_ref, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON bhi.discount_coupon_otps TO bhi_app;
REVOKE DELETE, TRUNCATE ON bhi.discount_coupon_otps FROM bhi_app;

COMMIT;
