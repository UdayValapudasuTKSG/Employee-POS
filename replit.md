# BHI Health Card Portal

## Overview
Digital health insurance card portal for the Beharry group (demo data, fake formats). Employees retrieve a card via email/phone lookup → 6-digit OTP → 15-minute card session. HR staff manage members through a role- and company-scoped admin portal. The core of the project is the server-side authorization layer: a 13-permission × 5-role matrix, company scoping, contact masking, and an append-only audit trail.

## Architecture
- `lib/api-spec/openapi.yaml` — OpenAPI contract (source of truth); `pnpm --filter @workspace/api-spec run codegen` regenerates clients.
- `lib/api-client-react` — generated React Query hooks; `custom-fetch.ts` attaches Bearer tokens via `setAuthTokenGetter`.
- `lib/db` — Drizzle schema, all in one schema `bhi` (21 tables): the client's 11 BHI tables (company, member, dependent, beneficiary, class, premium_rates, company_billing_rule, billing_run, billing_line, enrollment_status_history, import_exception) and the portal's 10 (admin_users, activity_log (append-only audit trail and employee events), employee_sessions (OTP, card and multi-company alert), change_requests (with their document), policy_memberships, client_groups, import_batch, import_exception_resolutions, member_class_history, billing_run_issues). The database structure is `deploy/db/schema.sql` plus `deploy/db/migrations/`.
- `artifacts/api-server` — Express 5. Key modules: `lib/rbac.ts` (permission matrix), `lib/auth.ts` (scrypt passwords, HS256 JWT, OTP/token hashing), `lib/masking.ts`, `lib/audit.ts`, `lib/issuer.ts` (card issuer details from env), `lib/memberImport.ts` (sheet layouts + parsing), `middlewares/adminAuth.ts` (requireAdmin + requirePermission with ACCESS_DENIED auditing), `lib/seed.ts` (deterministic seeder, seed 20260730), routes in `routes/employee.ts` and `routes/admin.ts`.

## Bulk import
- Four sheet layouts, each detected from its own header row: Members (22 col), Dependants (14 col), Beneficiaries (18 col), and a short 8-column members layout. A workbook containing several imports in one pass.
- Members commit first, so a dependant or beneficiary can reference a member the same file creates. Child rows join on CompanyNumber + MemberIDNumber, falling back to the member's own ID number.
- Re-import updates rather than duplicating: members key on employee number, children on their own ID number (or name + date of birth when they have none).
- The Beneficiaries sheet repeats LastName/FirstName — first pair is the member's, second is the beneficiary's — and has no Relationship column, so `beneficiaries.relationship` and `date_of_birth` are nullable.
- Layouts are defined once in `lib/memberImport.ts` (`IMPORT_LAYOUTS`) and served from `GET /v1/admin/import/layouts`; the admin screen and its CSV templates render from that, never from its own copy.

## Configuration, not code
- Card issuer identity — name, address, phone, signatory, plan title, property notice, back notice — is `ISSUER_*` / `CARD_*` env, read per request by `lib/issuer.ts` and sent to the frontend on the card payload. No insurer is named in source; unset values are omitted from the card, never defaulted to another insurer's.
- `CARD_EMAIL_OVERRIDE` diverts card emails for demos. It is opt-in and off by default — it previously defaulted to a hardcoded personal address, which meant a correctly configured production server still sent every member's card to one inbox.
- CORS is an allowlist (`CORS_ALLOWED_ORIGINS`), not `*`. `lib/cors.ts`: exact origin match, no subdomain inheritance; unset means same-origin only in production and loopback-only in development. Preflights are cached 10 minutes (`Access-Control-Max-Age`), so a PATCH is one round trip rather than two. Credentials stay off — tokens travel in `Authorization`, never cookies.
- `artifacts/bhi-card-portal` — React/Vite frontend (employee flow + admin portal), wouter routing.

## Security rules (do not break)
- Uniform lookup responses: unknown identifiers get decoy verification sessions with an identical response shape; decoys never verify.
- Cross-company access returns 404, never 403. Permission denials return 403 and are audited as ACCESS_DENIED.
- OTP: 5-min TTL, 3 attempts then LOCKED (423), resend 60s cooldown/max 3. Card sessions: 15-min TTL, revoked on archive and logout.
- OTP plaintext and card tokens are never persisted (sha256 hashes only). Reasons (min 3 chars) enforced server-side for member/dependent mutations.
- No DELETE statements anywhere; audit trail is append-only.
- Dev OTP mode (non-production or OTP_DEV_MODE=true): code returned as `devCode` and logged. It does NOT weaken verification — a decoy session fails whatever code is entered, in every mode. (An earlier dev-mode branch accepted any code on a decoy and issued a card for an arbitrary active member; that was an authentication bypass and has been removed.)

## Demo data
- Seeded automatically at startup if DB is empty. 6 companies (BF/BA/BL/BR/BM/BS), 120 members, dependents, admins (password `Demo@2026`): platform.admin@ (super admin), client.foods@ (BF client admin), hr.foods@ (BF), hr.auto@ (BA), support@, auditor@ — all `@bhi-demo.test` — plus client.admin@st.test and hr@st.test (ST).
- Shared-phone disambiguation demo: `+592-555-0123` (5 BF members → SELECT flow).
- Test suite: `node artifacts/api-server/scripts/rbac-test.mjs` (69 assertions; server must be running).

## User preferences
- Visual direction per brief §12: printed-certificate aesthetic (ink/plate/copper/paper palette), Bricolage Grotesque display, Public Sans body, IBM Plex Mono for identifiers, no emojis, never "Submit" on buttons.
