-- =============================================================================
-- BHI Health Card Portal — database schema
-- =============================================================================
--
-- Everything lives in ONE schema, `bhi` (20 tables):
--
--   The client's BHI Enrollment Database (11 tables, row-level security forced
--   on each so companies only ever see their own rows):
--     company, member, dependent, beneficiary, class, premium_rates,
--     company_billing_rule, billing_run, billing_line,
--     enrollment_status_history, import_exception
--
--   The portal's own tables (9):
--     admin_users                   admin logins, role and company scope
--     activity_log                  audit trail and employee-side events (append-only)
--     employee_sessions             card lookup: code sent -> verified -> card, and
--                                   multi-company alerts
--     change_requests               employee change requests, with their document
--     policy_memberships            a member's policy details shown on the card
--     import_batch                  one bulk import per company
--     import_exception_resolutions  held import rows that HR has fixed
--     member_class_history          class at the start of each billing month
--     billing_run_issues            members a bill could not price
--
--   Migration 009 adds the 21st, discount_coupons (employee discount coupons
--   and their redemptions); it is not in this dump.
--
-- Load it ONCE, into an empty database, as the owner role (bhi_user). Then run
-- every file in deploy/db/migrations/, on a new installation and on every
-- upgrade: they grant bhi_app its rights and add the starting classes, and are
-- safe to re-run. The API itself connects as bhi_app, never as the owner.
--
-- Generated with pg_dump (--schema-only --no-owner --no-privileges). Grants are
-- not in this file: they need the bhi_app role, which exists only once the
-- installer has created it.

--
-- PostgreSQL database dump
--

\restrict P1UAIMSPmAuwpcAqgV7sSPf3Y1PNpKKkQjWfhwCm85scRBMaADBU76uf5TjkFGr

-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: bhi; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA bhi;


--
-- Name: billing_line_final_guard(); Type: FUNCTION; Schema: bhi; Owner: -
--

CREATE FUNCTION bhi.billing_line_final_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'bhi'
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM bhi.billing_run r WHERE r.billing_run_id = OLD.billing_run_id AND r.status = 'FINAL') THEN
    RAISE EXCEPTION 'Billing line % belongs to a FINAL run and cannot be changed.', OLD.billing_line_id USING ERRCODE = 'BHF01';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;


--
-- Name: billing_run_final_guard(); Type: FUNCTION; Schema: bhi; Owner: -
--

CREATE FUNCTION bhi.billing_run_final_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'bhi'
    AS $$
BEGIN
  IF OLD.status = 'FINAL' THEN
    RAISE EXCEPTION 'Billing run % is FINAL and cannot be changed.', OLD.billing_run_id USING ERRCODE = 'BHF01';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;


--
-- Name: can_write(text); Type: FUNCTION; Schema: bhi; Owner: -
--

CREATE FUNCTION bhi.can_write(company text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT NOT bhi.scope_readonly()
     AND (bhi.scope_all()
          OR (bhi.scope_has(company)
              AND EXISTS (SELECT 1 FROM bhi.company c WHERE c.company_number = company AND c.active)))
$$;


--
-- Name: can_write_all(); Type: FUNCTION; Schema: bhi; Owner: -
--

CREATE FUNCTION bhi.can_write_all() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT NOT bhi.scope_readonly() AND bhi.scope_all()
$$;


--
-- Name: premium_rate_final_guard(); Type: FUNCTION; Schema: bhi; Owner: -
--

CREATE FUNCTION bhi.premium_rate_final_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'bhi'
    AS $$
BEGIN
  IF (NEW.company_number, NEW.class_code, NEW.coverage_band, NEW.dependent_band,
      NEW.total_premium, NEW.company_premium, NEW.employee_premium, NEW.effective_date)
     IS DISTINCT FROM
     (OLD.company_number, OLD.class_code, OLD.coverage_band, OLD.dependent_band,
      OLD.total_premium, OLD.company_premium, OLD.employee_premium, OLD.effective_date)
     AND EXISTS (SELECT 1 FROM bhi.billing_line l
                   JOIN bhi.billing_run r ON r.billing_run_id = l.billing_run_id
                  WHERE l.premium_rate_id = OLD.premium_rate_id AND r.status = 'FINAL') THEN
    RAISE EXCEPTION 'Premium rate % was used by a FINAL bill; add a new rate instead of changing it.', OLD.premium_rate_id
      USING ERRCODE = 'BHF01';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: scope_all(); Type: FUNCTION; Schema: bhi; Owner: -
--

CREATE FUNCTION bhi.scope_all() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT coalesce(current_setting('bhi.all', true), '') = 'on'
$$;


--
-- Name: scope_has(text); Type: FUNCTION; Schema: bhi; Owner: -
--

CREATE FUNCTION bhi.scope_has(company text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT bhi.scope_all()
      OR (company IS NOT NULL
          AND company = ANY (string_to_array(nullif(current_setting('bhi.companies', true), ''), ',')))
$$;


--
-- Name: scope_readonly(); Type: FUNCTION; Schema: bhi; Owner: -
--

CREATE FUNCTION bhi.scope_readonly() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT coalesce(current_setting('bhi.readonly', true), '') = 'on'
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: activity_log; Type: TABLE; Schema: bhi; Owner: -
--

CREATE TABLE bhi.activity_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
    actor text NOT NULL,
    actor_role text,
    action text NOT NULL,
    entity_type text,
    entity_id text,
    before_value text,
    after_value text,
    reason text,
    source_ip text,
    company_code text,
    result text,
    error_code text,
    latency_ms integer,
    CONSTRAINT activity_log_kind_check CHECK ((kind = ANY (ARRAY['AUDIT'::text, 'EVENT'::text])))
);


--
-- Name: admin_users; Type: TABLE; Schema: bhi; Owner: -
--

CREATE TABLE bhi.admin_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    display_name text NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL,
    company_scope text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    must_change_password boolean DEFAULT false NOT NULL,
    CONSTRAINT admin_users_role_check CHECK ((role = ANY (ARRAY['ROLE_PLATFORM_ADMIN'::text, 'ROLE_CLIENT_ADMIN'::text, 'ROLE_HR_ADMIN'::text, 'ROLE_SUPPORT'::text, 'ROLE_AUDITOR'::text]))),
    CONSTRAINT admin_users_scope_by_role_check CHECK (
CASE role
    WHEN 'ROLE_HR_ADMIN'::text THEN (company_scope IS NOT NULL)
    WHEN 'ROLE_CLIENT_ADMIN'::text THEN (company_scope IS NOT NULL)
    ELSE (company_scope IS NULL)
END)
);


--
-- Name: beneficiary; Type: TABLE; Schema: bhi; Owner: -
--

CREATE TABLE bhi.beneficiary (
    beneficiary_id integer NOT NULL,
    member_id integer NOT NULL,
    id_type character varying(20),
    id_number character varying(40),
    beneficiary_full_name character varying(120) NOT NULL,
    date_of_birth date,
    sex character varying(10),
    relationship character varying(30),
    phone character varying(50),
    email character varying(100),
    share_percent numeric,
    active boolean NOT NULL,
    inactive_date date,
    inactive_reason text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY bhi.beneficiary FORCE ROW LEVEL SECURITY;


--
-- Name: beneficiary_beneficiary_id_seq; Type: SEQUENCE; Schema: bhi; Owner: -
--

ALTER TABLE bhi.beneficiary ALTER COLUMN beneficiary_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME bhi.beneficiary_beneficiary_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: billing_line; Type: TABLE; Schema: bhi; Owner: -
--

CREATE TABLE bhi.billing_line (
    billing_line_id integer NOT NULL,
    billing_run_id integer NOT NULL,
    member_id integer NOT NULL,
    id_type character varying(20) NOT NULL,
    id_number character varying(40) NOT NULL,
    member_name character varying(180) NOT NULL,
    company_number character varying(20) NOT NULL,
    class_code character varying(1) NOT NULL,
    active_dependent_count integer NOT NULL,
    coverage_band character varying(20) NOT NULL,
    coverage_label character varying(80) NOT NULL,
    total_premium numeric(15,2) NOT NULL,
    company_premium numeric(15,2) NOT NULL,
    employee_premium numeric(15,2) NOT NULL,
    rate_effective_date date NOT NULL,
    premium_rate_id integer,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY bhi.billing_line FORCE ROW LEVEL SECURITY;


--
-- Name: billing_line_billing_line_id_seq; Type: SEQUENCE; Schema: bhi; Owner: -
--

ALTER TABLE bhi.billing_line ALTER COLUMN billing_line_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME bhi.billing_line_billing_line_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: billing_run; Type: TABLE; Schema: bhi; Owner: -
--

CREATE TABLE bhi.billing_run (
    billing_run_id integer NOT NULL,
    company_number character varying(20) NOT NULL,
    billing_month date NOT NULL,
    billing_date date NOT NULL,
    generated_at timestamp with time zone,
    generated_by character varying(80),
    status character varying(20),
    notes text,
    CONSTRAINT billing_run_status_check CHECK (((status)::text = ANY (ARRAY[('DRAFT'::character varying)::text, ('FINAL'::character varying)::text, ('SUPERSEDED'::character varying)::text])))
);

ALTER TABLE ONLY bhi.billing_run FORCE ROW LEVEL SECURITY;


--
-- Name: billing_run_billing_run_id_seq; Type: SEQUENCE; Schema: bhi; Owner: -
--

ALTER TABLE bhi.billing_run ALTER COLUMN billing_run_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME bhi.billing_run_billing_run_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: billing_run_issues; Type: TABLE; Schema: bhi; Owner: -
--

CREATE TABLE bhi.billing_run_issues (
    billing_run_id integer NOT NULL,
    member_id integer NOT NULL,
    reason text NOT NULL,
    CONSTRAINT billing_run_issues_reason_check CHECK ((reason = ANY (ARRAY['NO_RATE'::text, 'CLASS_RETIRED_NO_RATE'::text])))
);


--
-- Name: change_requests; Type: TABLE; Schema: bhi; Owner: -
--

CREATE TABLE bhi.change_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subject_type text NOT NULL,
    current_first_name text NOT NULL,
    current_last_name text NOT NULL,
    current_date_of_birth date,
    current_relationship text,
    requested_first_name text,
    requested_last_name text,
    requested_date_of_birth date,
    requested_relationship text,
    employee_note text,
    status text DEFAULT 'PENDING'::text NOT NULL,
    reviewed_by text,
    reviewed_at timestamp with time zone,
    review_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    member_ref integer,
    dependent_ref integer,
    document_type text,
    document_file_name text,
    document_mime_type text,
    document_byte_size integer,
    document_sha256 text,
    document_content bytea,
    document_content_purged_at timestamp with time zone
);


--
-- Name: class; Type: TABLE; Schema: bhi; Owner: -
--

CREATE TABLE bhi.class (
    class_code character varying(1) NOT NULL,
    class_name character varying(50) NOT NULL,
    description character varying(255),
    active boolean NOT NULL,
    sort_order integer
);

ALTER TABLE ONLY bhi.class FORCE ROW LEVEL SECURITY;


--
-- Name: company; Type: TABLE; Schema: bhi; Owner: -
--

CREATE TABLE bhi.company (
    company_number character varying(20) NOT NULL,
    company_name character varying(120) NOT NULL,
    address1 character varying(120),
    address2 character varying(120),
    city character varying(80),
    contact_name character varying(100),
    contact_phone character varying(50),
    contact_email character varying(100),
    active boolean NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY bhi.company FORCE ROW LEVEL SECURITY;


--
-- Name: company_billing_rule; Type: TABLE; Schema: bhi; Owner: -
--

CREATE TABLE bhi.company_billing_rule (
    company_billing_rule_id integer NOT NULL,
    company_number character varying(20) NOT NULL,
    company_share_percent numeric NOT NULL,
    employee_share_percent numeric NOT NULL,
    effective_date date NOT NULL,
    active boolean NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY bhi.company_billing_rule FORCE ROW LEVEL SECURITY;


--
-- Name: company_billing_rule_company_billing_rule_id_seq; Type: SEQUENCE; Schema: bhi; Owner: -
--

ALTER TABLE bhi.company_billing_rule ALTER COLUMN company_billing_rule_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME bhi.company_billing_rule_company_billing_rule_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: dependent; Type: TABLE; Schema: bhi; Owner: -
--

CREATE TABLE bhi.dependent (
    dependent_id integer NOT NULL,
    member_id integer NOT NULL,
    id_type character varying(20),
    id_number character varying(40),
    dependent_full_name character varying(120) NOT NULL,
    date_of_birth date,
    sex character varying(10),
    relationship character varying(30) NOT NULL,
    active boolean NOT NULL,
    inactive_date date,
    inactive_reason text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY bhi.dependent FORCE ROW LEVEL SECURITY;


--
-- Name: dependent_dependent_id_seq; Type: SEQUENCE; Schema: bhi; Owner: -
--

ALTER TABLE bhi.dependent ALTER COLUMN dependent_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME bhi.dependent_dependent_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: employee_sessions; Type: TABLE; Schema: bhi; Owner: -
--

CREATE TABLE bhi.employee_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lookup_channel text NOT NULL,
    masked_destination text NOT NULL,
    destination text,
    otp_hash text NOT NULL,
    company_code text,
    matched_members jsonb DEFAULT '[]'::jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    resend_count integer DEFAULT 0 NOT NULL,
    last_sent_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    card_token_hash text,
    card_member_id integer,
    card_issued_at timestamp with time zone,
    card_expires_at timestamp with time zone,
    card_revoked boolean DEFAULT false NOT NULL,
    alert_status text,
    alert_matches jsonb,
    alert_raised_at timestamp with time zone,
    alert_resolved_by text,
    alert_resolution_note text,
    alert_resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT employee_sessions_alert_status_check CHECK ((alert_status = ANY (ARRAY['OPEN'::text, 'RESOLVED'::text]))),
    CONSTRAINT employee_sessions_lookup_channel_check CHECK ((lookup_channel = ANY (ARRAY['EMAIL'::text, 'PHONE'::text]))),
    CONSTRAINT employee_sessions_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'VERIFIED'::text, 'EXPIRED'::text, 'LOCKED'::text])))
);


--
-- Name: enrollment_status_history; Type: TABLE; Schema: bhi; Owner: -
--

CREATE TABLE bhi.enrollment_status_history (
    status_history_id integer NOT NULL,
    entity_type character varying(20) NOT NULL,
    entity_id integer NOT NULL,
    member_id integer,
    company_number character varying(20),
    person_identifier character varying(100),
    person_name character varying(180) NOT NULL,
    old_active boolean NOT NULL,
    new_active boolean NOT NULL,
    effective_date date NOT NULL,
    reason text NOT NULL,
    cascade_applied boolean NOT NULL,
    related_records_changed integer,
    changed_at timestamp with time zone,
    changed_by character varying(100),
    notes text
);

ALTER TABLE ONLY bhi.enrollment_status_history FORCE ROW LEVEL SECURITY;


--
-- Name: enrollment_status_history_status_history_id_seq; Type: SEQUENCE; Schema: bhi; Owner: -
--

ALTER TABLE bhi.enrollment_status_history ALTER COLUMN status_history_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME bhi.enrollment_status_history_status_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: import_batch; Type: TABLE; Schema: bhi; Owner: -
--

CREATE TABLE bhi.import_batch (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_number character varying(20) NOT NULL,
    kind text NOT NULL,
    source_ordinal integer NOT NULL,
    source_file character varying(255) NOT NULL,
    original_file_name text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT import_batch_kind_check CHECK ((kind = ANY (ARRAY['BULK_IMPORT'::text, 'LEGACY_MIGRATION'::text])))
);


--
-- Name: import_batch_ordinal_seq; Type: SEQUENCE; Schema: bhi; Owner: -
--

CREATE SEQUENCE bhi.import_batch_ordinal_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: import_batch_ordinal_seq; Type: SEQUENCE OWNED BY; Schema: bhi; Owner: -
--

ALTER SEQUENCE bhi.import_batch_ordinal_seq OWNED BY bhi.import_batch.source_ordinal;


--
-- Name: import_exception; Type: TABLE; Schema: bhi; Owner: -
--

CREATE TABLE bhi.import_exception (
    exception_id integer NOT NULL,
    source_alias character varying(255),
    source_file character varying(255),
    source_path text,
    sheet_name character varying(100),
    excel_row integer,
    cell_or_range character varying(255),
    entity_type character varying(30),
    person_name character varying(255),
    member_identifier character varying(100),
    reason_codes text,
    reason text,
    required_action text,
    raw_row_summary text,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY bhi.import_exception FORCE ROW LEVEL SECURITY;


--
-- Name: import_exception_exception_id_seq; Type: SEQUENCE; Schema: bhi; Owner: -
--

ALTER TABLE bhi.import_exception ALTER COLUMN exception_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME bhi.import_exception_exception_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: import_exception_resolutions; Type: TABLE; Schema: bhi; Owner: -
--

CREATE TABLE bhi.import_exception_resolutions (
    exception_id integer NOT NULL,
    resolved_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_by text NOT NULL,
    member_id integer
);


--
-- Name: member; Type: TABLE; Schema: bhi; Owner: -
--

CREATE TABLE bhi.member (
    member_id integer NOT NULL,
    id_type character varying(20) NOT NULL,
    id_number character varying(40) NOT NULL,
    company_number character varying(20) NOT NULL,
    last_name character varying(80) NOT NULL,
    first_name character varying(80) NOT NULL,
    middle_initials character varying(20),
    date_of_birth date,
    sex character varying(10),
    class_code character varying(1) NOT NULL,
    address_line1 character varying(150),
    address_line2 character varying(150),
    phone character varying(50),
    email character varying(100),
    employment_date date,
    plan_date date,
    rate_of_pay numeric(15,2),
    occupation character varying(100),
    active boolean NOT NULL,
    inactive_date date,
    inactive_reason text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY bhi.member FORCE ROW LEVEL SECURITY;


--
-- Name: member_class_history; Type: TABLE; Schema: bhi; Owner: -
--

CREATE TABLE bhi.member_class_history (
    id bigint NOT NULL,
    member_id integer NOT NULL,
    class_code character varying(1) NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_by text NOT NULL
);


--
-- Name: member_class_history_id_seq; Type: SEQUENCE; Schema: bhi; Owner: -
--

ALTER TABLE bhi.member_class_history ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME bhi.member_class_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: member_member_id_seq; Type: SEQUENCE; Schema: bhi; Owner: -
--

ALTER TABLE bhi.member ALTER COLUMN member_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME bhi.member_member_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: policy_memberships; Type: TABLE; Schema: bhi; Owner: -
--

CREATE TABLE bhi.policy_memberships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    policyholder text NOT NULL,
    policy_number text NOT NULL,
    group_number text NOT NULL,
    member_number text NOT NULL,
    certificate_number text NOT NULL,
    plan_name text NOT NULL,
    effective_date date NOT NULL,
    expiry_date date,
    insurer_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    member_ref integer
);


--
-- Name: premium_rates; Type: TABLE; Schema: bhi; Owner: -
--

CREATE TABLE bhi.premium_rates (
    premium_rate_id integer NOT NULL,
    company_number character varying(20),
    class_code character varying(1) NOT NULL,
    coverage_band character varying(20) NOT NULL,
    coverage_label character varying(80) NOT NULL,
    dependent_band smallint NOT NULL,
    total_premium numeric(15,2) NOT NULL,
    company_premium numeric(15,2) NOT NULL,
    employee_premium numeric(15,2) NOT NULL,
    effective_date date NOT NULL,
    active boolean NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY bhi.premium_rates FORCE ROW LEVEL SECURITY;


--
-- Name: premium_rates_premium_rate_id_seq; Type: SEQUENCE; Schema: bhi; Owner: -
--

ALTER TABLE bhi.premium_rates ALTER COLUMN premium_rate_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME bhi.premium_rates_premium_rate_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: import_batch source_ordinal; Type: DEFAULT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.import_batch ALTER COLUMN source_ordinal SET DEFAULT nextval('bhi.import_batch_ordinal_seq'::regclass);


--
-- Name: activity_log activity_log_pkey; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.activity_log
    ADD CONSTRAINT activity_log_pkey PRIMARY KEY (id);


--
-- Name: admin_users admin_users_email_unique; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.admin_users
    ADD CONSTRAINT admin_users_email_unique UNIQUE (email);


--
-- Name: admin_users admin_users_pkey; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.admin_users
    ADD CONSTRAINT admin_users_pkey PRIMARY KEY (id);


--
-- Name: beneficiary beneficiary_pk; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.beneficiary
    ADD CONSTRAINT beneficiary_pk PRIMARY KEY (beneficiary_id);


--
-- Name: billing_line billing_line_pk; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.billing_line
    ADD CONSTRAINT billing_line_pk PRIMARY KEY (billing_line_id);


--
-- Name: billing_run_issues billing_run_issues_pk; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.billing_run_issues
    ADD CONSTRAINT billing_run_issues_pk PRIMARY KEY (billing_run_id, member_id);


--
-- Name: billing_run billing_run_pk; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.billing_run
    ADD CONSTRAINT billing_run_pk PRIMARY KEY (billing_run_id);


--
-- Name: change_requests change_requests_pkey; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.change_requests
    ADD CONSTRAINT change_requests_pkey PRIMARY KEY (id);


--
-- Name: class class_pk; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.class
    ADD CONSTRAINT class_pk PRIMARY KEY (class_code);


--
-- Name: company_billing_rule company_billing_rule_company_date_uq; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.company_billing_rule
    ADD CONSTRAINT company_billing_rule_company_date_uq UNIQUE (company_number, effective_date);


--
-- Name: company_billing_rule company_billing_rule_pk; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.company_billing_rule
    ADD CONSTRAINT company_billing_rule_pk PRIMARY KEY (company_billing_rule_id);


--
-- Name: company company_pk; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.company
    ADD CONSTRAINT company_pk PRIMARY KEY (company_number);


--
-- Name: dependent dependent_pk; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.dependent
    ADD CONSTRAINT dependent_pk PRIMARY KEY (dependent_id);


--
-- Name: employee_sessions employee_sessions_card_token_hash_key; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.employee_sessions
    ADD CONSTRAINT employee_sessions_card_token_hash_key UNIQUE (card_token_hash);


--
-- Name: employee_sessions employee_sessions_pkey; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.employee_sessions
    ADD CONSTRAINT employee_sessions_pkey PRIMARY KEY (id);


--
-- Name: enrollment_status_history enrollment_status_history_pk; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.enrollment_status_history
    ADD CONSTRAINT enrollment_status_history_pk PRIMARY KEY (status_history_id);


--
-- Name: import_batch import_batch_pkey; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.import_batch
    ADD CONSTRAINT import_batch_pkey PRIMARY KEY (id);


--
-- Name: import_batch import_batch_source_file_unique; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.import_batch
    ADD CONSTRAINT import_batch_source_file_unique UNIQUE (source_file);


--
-- Name: import_batch import_batch_source_ordinal_unique; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.import_batch
    ADD CONSTRAINT import_batch_source_ordinal_unique UNIQUE (source_ordinal);


--
-- Name: import_exception import_exception_pk; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.import_exception
    ADD CONSTRAINT import_exception_pk PRIMARY KEY (exception_id);


--
-- Name: import_exception_resolutions import_exception_resolutions_pkey; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.import_exception_resolutions
    ADD CONSTRAINT import_exception_resolutions_pkey PRIMARY KEY (exception_id);


--
-- Name: member_class_history member_class_history_pkey; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.member_class_history
    ADD CONSTRAINT member_class_history_pkey PRIMARY KEY (id);


--
-- Name: member member_id_type_id_number_uq; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.member
    ADD CONSTRAINT member_id_type_id_number_uq UNIQUE (id_type, id_number);


--
-- Name: member member_pk; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.member
    ADD CONSTRAINT member_pk PRIMARY KEY (member_id);


--
-- Name: policy_memberships policy_memberships_pkey; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.policy_memberships
    ADD CONSTRAINT policy_memberships_pkey PRIMARY KEY (id);


--
-- Name: premium_rates premium_rates_company_class_band_date_uq; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.premium_rates
    ADD CONSTRAINT premium_rates_company_class_band_date_uq UNIQUE NULLS NOT DISTINCT (company_number, class_code, coverage_band, effective_date);


--
-- Name: premium_rates premium_rates_pk; Type: CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.premium_rates
    ADD CONSTRAINT premium_rates_pk PRIMARY KEY (premium_rate_id);


--
-- Name: activity_log_company_code_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX activity_log_company_code_idx ON bhi.activity_log USING btree (company_code);


--
-- Name: activity_log_kind_timestamp_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX activity_log_kind_timestamp_idx ON bhi.activity_log USING btree (kind, "timestamp" DESC);


--
-- Name: beneficiary_active_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX beneficiary_active_idx ON bhi.beneficiary USING btree (active);


--
-- Name: beneficiary_id_type_id_number_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX beneficiary_id_type_id_number_idx ON bhi.beneficiary USING btree (id_type, id_number);


--
-- Name: beneficiary_member_id_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX beneficiary_member_id_idx ON bhi.beneficiary USING btree (member_id);


--
-- Name: billing_line_billing_run_id_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX billing_line_billing_run_id_idx ON bhi.billing_line USING btree (billing_run_id);


--
-- Name: billing_line_id_type_id_number_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX billing_line_id_type_id_number_idx ON bhi.billing_line USING btree (id_type, id_number);


--
-- Name: billing_line_member_id_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX billing_line_member_id_idx ON bhi.billing_line USING btree (member_id);


--
-- Name: billing_run_company_month_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX billing_run_company_month_idx ON bhi.billing_run USING btree (company_number, billing_month);


--
-- Name: change_requests_member_ref_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX change_requests_member_ref_idx ON bhi.change_requests USING btree (member_ref);


--
-- Name: company_active_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX company_active_idx ON bhi.company USING btree (active);


--
-- Name: dependent_active_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX dependent_active_idx ON bhi.dependent USING btree (active);


--
-- Name: dependent_id_type_id_number_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX dependent_id_type_id_number_idx ON bhi.dependent USING btree (id_type, id_number);


--
-- Name: dependent_member_id_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX dependent_member_id_idx ON bhi.dependent USING btree (member_id);


--
-- Name: employee_sessions_alert_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX employee_sessions_alert_idx ON bhi.employee_sessions USING btree (alert_status, alert_raised_at DESC) WHERE (alert_status IS NOT NULL);


--
-- Name: employee_sessions_card_member_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX employee_sessions_card_member_idx ON bhi.employee_sessions USING btree (card_member_id) WHERE (card_member_id IS NOT NULL);


--
-- Name: employee_sessions_created_at_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX employee_sessions_created_at_idx ON bhi.employee_sessions USING btree (created_at DESC);


--
-- Name: enrollment_status_history_effective_date_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX enrollment_status_history_effective_date_idx ON bhi.enrollment_status_history USING btree (effective_date);


--
-- Name: enrollment_status_history_entity_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX enrollment_status_history_entity_idx ON bhi.enrollment_status_history USING btree (entity_type, entity_id);


--
-- Name: enrollment_status_history_member_id_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX enrollment_status_history_member_id_idx ON bhi.enrollment_status_history USING btree (member_id);


--
-- Name: idx_change_requests_status; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX idx_change_requests_status ON bhi.change_requests USING btree (status, created_at DESC);


--
-- Name: import_exception_source_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX import_exception_source_idx ON bhi.import_exception USING btree (source_file, sheet_name, excel_row);


--
-- Name: member_active_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX member_active_idx ON bhi.member USING btree (active);


--
-- Name: member_class_code_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX member_class_code_idx ON bhi.member USING btree (class_code);


--
-- Name: member_class_history_member_recorded_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX member_class_history_member_recorded_idx ON bhi.member_class_history USING btree (member_id, recorded_at);


--
-- Name: member_company_number_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX member_company_number_idx ON bhi.member USING btree (company_number);


--
-- Name: member_phone_suffix_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX member_phone_suffix_idx ON bhi.member USING btree ("right"(regexp_replace((COALESCE(phone, ''::character varying))::text, '[^0-9]'::text, ''::text, 'g'::text), 7));


--
-- Name: policy_memberships_member_ref_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX policy_memberships_member_ref_idx ON bhi.policy_memberships USING btree (member_ref);


--
-- Name: premium_rates_active_idx; Type: INDEX; Schema: bhi; Owner: -
--

CREATE INDEX premium_rates_active_idx ON bhi.premium_rates USING btree (active);


--
-- Name: billing_line billing_line_final_guard; Type: TRIGGER; Schema: bhi; Owner: -
--

CREATE TRIGGER billing_line_final_guard BEFORE DELETE OR UPDATE ON bhi.billing_line FOR EACH ROW EXECUTE FUNCTION bhi.billing_line_final_guard();


--
-- Name: billing_run billing_run_final_guard; Type: TRIGGER; Schema: bhi; Owner: -
--

CREATE TRIGGER billing_run_final_guard BEFORE DELETE OR UPDATE ON bhi.billing_run FOR EACH ROW EXECUTE FUNCTION bhi.billing_run_final_guard();


--
-- Name: premium_rates premium_rate_final_guard; Type: TRIGGER; Schema: bhi; Owner: -
--

CREATE TRIGGER premium_rate_final_guard BEFORE UPDATE ON bhi.premium_rates FOR EACH ROW EXECUTE FUNCTION bhi.premium_rate_final_guard();


--
-- Name: beneficiary beneficiary_member_fk; Type: FK CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.beneficiary
    ADD CONSTRAINT beneficiary_member_fk FOREIGN KEY (member_id) REFERENCES bhi.member(member_id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: billing_line billing_line_run_fk; Type: FK CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.billing_line
    ADD CONSTRAINT billing_line_run_fk FOREIGN KEY (billing_run_id) REFERENCES bhi.billing_run(billing_run_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: billing_run billing_run_company_fk; Type: FK CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.billing_run
    ADD CONSTRAINT billing_run_company_fk FOREIGN KEY (company_number) REFERENCES bhi.company(company_number) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: billing_run_issues billing_run_issues_member_fk; Type: FK CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.billing_run_issues
    ADD CONSTRAINT billing_run_issues_member_fk FOREIGN KEY (member_id) REFERENCES bhi.member(member_id) ON UPDATE CASCADE;


--
-- Name: billing_run_issues billing_run_issues_run_fk; Type: FK CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.billing_run_issues
    ADD CONSTRAINT billing_run_issues_run_fk FOREIGN KEY (billing_run_id) REFERENCES bhi.billing_run(billing_run_id);


--
-- Name: change_requests change_requests_dependent_ref_fk; Type: FK CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.change_requests
    ADD CONSTRAINT change_requests_dependent_ref_fk FOREIGN KEY (dependent_ref) REFERENCES bhi.dependent(dependent_id) ON UPDATE CASCADE;


--
-- Name: change_requests change_requests_member_ref_fk; Type: FK CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.change_requests
    ADD CONSTRAINT change_requests_member_ref_fk FOREIGN KEY (member_ref) REFERENCES bhi.member(member_id) ON UPDATE CASCADE;


--
-- Name: dependent dependent_member_fk; Type: FK CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.dependent
    ADD CONSTRAINT dependent_member_fk FOREIGN KEY (member_id) REFERENCES bhi.member(member_id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: employee_sessions employee_sessions_card_member_id_fkey; Type: FK CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.employee_sessions
    ADD CONSTRAINT employee_sessions_card_member_id_fkey FOREIGN KEY (card_member_id) REFERENCES bhi.member(member_id) ON UPDATE CASCADE;


--
-- Name: import_batch import_batch_company_fk; Type: FK CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.import_batch
    ADD CONSTRAINT import_batch_company_fk FOREIGN KEY (company_number) REFERENCES bhi.company(company_number) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: import_exception_resolutions import_exception_resolutions_exception_fk; Type: FK CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.import_exception_resolutions
    ADD CONSTRAINT import_exception_resolutions_exception_fk FOREIGN KEY (exception_id) REFERENCES bhi.import_exception(exception_id);


--
-- Name: import_exception_resolutions import_exception_resolutions_member_fk; Type: FK CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.import_exception_resolutions
    ADD CONSTRAINT import_exception_resolutions_member_fk FOREIGN KEY (member_id) REFERENCES bhi.member(member_id) ON UPDATE CASCADE;


--
-- Name: member member_class_fk; Type: FK CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.member
    ADD CONSTRAINT member_class_fk FOREIGN KEY (class_code) REFERENCES bhi.class(class_code) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: member_class_history member_class_history_class_fk; Type: FK CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.member_class_history
    ADD CONSTRAINT member_class_history_class_fk FOREIGN KEY (class_code) REFERENCES bhi.class(class_code) ON UPDATE CASCADE;


--
-- Name: member_class_history member_class_history_member_fk; Type: FK CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.member_class_history
    ADD CONSTRAINT member_class_history_member_fk FOREIGN KEY (member_id) REFERENCES bhi.member(member_id) ON UPDATE CASCADE;


--
-- Name: member member_company_fk; Type: FK CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.member
    ADD CONSTRAINT member_company_fk FOREIGN KEY (company_number) REFERENCES bhi.company(company_number) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: policy_memberships policy_memberships_member_ref_fk; Type: FK CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.policy_memberships
    ADD CONSTRAINT policy_memberships_member_ref_fk FOREIGN KEY (member_ref) REFERENCES bhi.member(member_id) ON UPDATE CASCADE;


--
-- Name: premium_rates premium_rates_class_fk; Type: FK CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.premium_rates
    ADD CONSTRAINT premium_rates_class_fk FOREIGN KEY (class_code) REFERENCES bhi.class(class_code) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: premium_rates premium_rates_company_fk; Type: FK CONSTRAINT; Schema: bhi; Owner: -
--

ALTER TABLE ONLY bhi.premium_rates
    ADD CONSTRAINT premium_rates_company_fk FOREIGN KEY (company_number) REFERENCES bhi.company(company_number) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: beneficiary; Type: ROW SECURITY; Schema: bhi; Owner: -
--

ALTER TABLE bhi.beneficiary ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_line; Type: ROW SECURITY; Schema: bhi; Owner: -
--

ALTER TABLE bhi.billing_line ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_run; Type: ROW SECURITY; Schema: bhi; Owner: -
--

ALTER TABLE bhi.billing_run ENABLE ROW LEVEL SECURITY;

--
-- Name: class; Type: ROW SECURITY; Schema: bhi; Owner: -
--

ALTER TABLE bhi.class ENABLE ROW LEVEL SECURITY;

--
-- Name: company; Type: ROW SECURITY; Schema: bhi; Owner: -
--

ALTER TABLE bhi.company ENABLE ROW LEVEL SECURITY;

--
-- Name: company_billing_rule; Type: ROW SECURITY; Schema: bhi; Owner: -
--

ALTER TABLE bhi.company_billing_rule ENABLE ROW LEVEL SECURITY;

--
-- Name: dependent; Type: ROW SECURITY; Schema: bhi; Owner: -
--

ALTER TABLE bhi.dependent ENABLE ROW LEVEL SECURITY;

--
-- Name: enrollment_status_history; Type: ROW SECURITY; Schema: bhi; Owner: -
--

ALTER TABLE bhi.enrollment_status_history ENABLE ROW LEVEL SECURITY;

--
-- Name: import_exception; Type: ROW SECURITY; Schema: bhi; Owner: -
--

ALTER TABLE bhi.import_exception ENABLE ROW LEVEL SECURITY;

--
-- Name: member; Type: ROW SECURITY; Schema: bhi; Owner: -
--

ALTER TABLE bhi.member ENABLE ROW LEVEL SECURITY;

--
-- Name: premium_rates; Type: ROW SECURITY; Schema: bhi; Owner: -
--

ALTER TABLE bhi.premium_rates ENABLE ROW LEVEL SECURITY;

--
-- Name: beneficiary scope_policy; Type: POLICY; Schema: bhi; Owner: -
--

CREATE POLICY scope_policy ON bhi.beneficiary USING ((EXISTS ( SELECT 1
   FROM bhi.member m
  WHERE ((m.member_id = beneficiary.member_id) AND bhi.scope_has((m.company_number)::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM bhi.member m
  WHERE ((m.member_id = beneficiary.member_id) AND bhi.can_write((m.company_number)::text)))));


--
-- Name: billing_line scope_policy; Type: POLICY; Schema: bhi; Owner: -
--

CREATE POLICY scope_policy ON bhi.billing_line USING (bhi.scope_has((company_number)::text)) WITH CHECK (bhi.can_write_all());


--
-- Name: billing_run scope_policy; Type: POLICY; Schema: bhi; Owner: -
--

CREATE POLICY scope_policy ON bhi.billing_run USING (bhi.scope_has((company_number)::text)) WITH CHECK (bhi.can_write_all());


--
-- Name: class scope_policy; Type: POLICY; Schema: bhi; Owner: -
--

CREATE POLICY scope_policy ON bhi.class USING (true) WITH CHECK (bhi.can_write_all());


--
-- Name: company scope_policy; Type: POLICY; Schema: bhi; Owner: -
--

CREATE POLICY scope_policy ON bhi.company USING (bhi.scope_has((company_number)::text)) WITH CHECK (((NOT bhi.scope_readonly()) AND (bhi.scope_all() OR (bhi.scope_has((company_number)::text) AND active))));


--
-- Name: company_billing_rule scope_policy; Type: POLICY; Schema: bhi; Owner: -
--

CREATE POLICY scope_policy ON bhi.company_billing_rule USING (bhi.scope_has((company_number)::text)) WITH CHECK (bhi.can_write_all());


--
-- Name: dependent scope_policy; Type: POLICY; Schema: bhi; Owner: -
--

CREATE POLICY scope_policy ON bhi.dependent USING ((EXISTS ( SELECT 1
   FROM bhi.member m
  WHERE ((m.member_id = dependent.member_id) AND bhi.scope_has((m.company_number)::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM bhi.member m
  WHERE ((m.member_id = dependent.member_id) AND bhi.can_write((m.company_number)::text)))));


--
-- Name: enrollment_status_history scope_policy; Type: POLICY; Schema: bhi; Owner: -
--

CREATE POLICY scope_policy ON bhi.enrollment_status_history USING ((bhi.scope_has((company_number)::text) OR ((company_number IS NULL) AND (EXISTS ( SELECT 1
   FROM bhi.member m
  WHERE ((m.member_id = enrollment_status_history.member_id) AND bhi.scope_has((m.company_number)::text))))))) WITH CHECK (bhi.can_write((COALESCE(company_number, ( SELECT m.company_number
   FROM bhi.member m
  WHERE (m.member_id = enrollment_status_history.member_id))))::text));


--
-- Name: import_exception scope_policy; Type: POLICY; Schema: bhi; Owner: -
--

CREATE POLICY scope_policy ON bhi.import_exception USING ((bhi.scope_all() OR (EXISTS ( SELECT 1
   FROM bhi.import_batch b
  WHERE (((b.source_file)::text = (import_exception.source_file)::text) AND bhi.scope_has((b.company_number)::text)))))) WITH CHECK ((bhi.can_write_all() OR (EXISTS ( SELECT 1
   FROM bhi.import_batch b
  WHERE (((b.source_file)::text = (import_exception.source_file)::text) AND bhi.can_write((b.company_number)::text))))));


--
-- Name: member scope_policy; Type: POLICY; Schema: bhi; Owner: -
--

CREATE POLICY scope_policy ON bhi.member USING (bhi.scope_has((company_number)::text)) WITH CHECK (bhi.can_write((company_number)::text));


--
-- Name: premium_rates scope_policy; Type: POLICY; Schema: bhi; Owner: -
--

CREATE POLICY scope_policy ON bhi.premium_rates USING (((company_number IS NULL) OR bhi.scope_has((company_number)::text))) WITH CHECK (bhi.can_write_all());


--
-- PostgreSQL database dump complete
--

\unrestrict P1UAIMSPmAuwpcAqgV7sSPf3Y1PNpKKkQjWfhwCm85scRBMaADBU76uf5TjkFGr

