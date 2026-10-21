---
description: "Task list for Multi-Company BHI Enrollment and Monthly Billing on One Shared Database"
---

# Tasks: Multi-Company BHI Enrollment and Monthly Billing on One Shared Database

**Input**: Design documents from `specs/002-per-company-schema/`

**Prerequisites**:
- [plan.md](plan.md) and [spec.md](spec.md) are required.
- [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/) and [quickstart.md](quickstart.md) are referenced by the tasks.

**Tests**: included. The spec asks for automated tests (SC-003, SC-005, SC-009, SC-010), and the constitution's testing gate requires negative-case tests for disclosure, audit, and unauthorised scope.

**Organization**: tasks are grouped by user story so that each story can be built and tested on its own. User Story 1 creates the database structure that every other story uses. Its structure tasks sit in Phase 2 (Foundational), and its verification tasks in Phase 3.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task).
- **[Story]**: US1–US6, as in [spec.md](spec.md).

## Conventions used by every task

- **Paths**: API `artifacts/api-server/src/`, portal `artifacts/bhi-card-portal/src/`, database library `lib/db/src/`, SQL `deploy/db/`.
- **SQL migrations**: re-runnable (`IF NOT EXISTS`, `DO $$ … $$` guards), in the style of `deploy/db/migrations/009_member_removal.sql`. They run as `bhi_owner`.
- **Tests**:
  - Unit tests sit next to the code as `*.test.ts`.
  - Integration tests go in `artifacts/api-server/src/integration/*.test.ts`. They connect as **`bhi_app`**, never as a superuser (research R4).
  - To test HTTP routes, import `app` from `artifacts/api-server/src/app.ts`, listen on port 0 and call it with `fetch`.
- **API contract**: after editing `lib/api-spec/openapi.yaml`, run `pnpm --filter @workspace/api-spec codegen`. It regenerates `lib/api-zod` and `lib/api-client-react`. `openapi.yaml` is one file, so openapi tasks are never parallel with each other.
- **Database work in routes**: every read and write on `bhi.*` runs inside `withScope(scope, fn)` (T017). Any change to `active` goes through `setActive` (T021). Every write also calls `writeAudit`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: folders, configuration and the test harness.

- [X] T001 Create the empty folders `lib/db/src/schema/bhi/`, `artifacts/api-server/src/lib/billing/`, `artifacts/api-server/src/integration/`, `artifacts/api-server/src/integration/fixtures/` and `deploy/db/seed/`. Each gets a one-line `README.md` stating its purpose, as listed in plan.md, Project Structure.
- [X] T002 [P] Create `deploy/db/seed/classes.csv` with header `class_code,class_name,description,sort_order` and rows `A,Class A,,1`, `B,Class B,,2`, `C,Class C,,3`. Add a comment line at the top: the names are placeholders until the client confirms them (plan, dependency 2).
- [X] T003 [P] Create `deploy/db/seed/premium_rates_standard.csv`:
  - Header: `class_code,dependent_band,total_premium,company_premium,employee_premium,effective_date`.
  - 12 rows (A/B/C × bands 0–3) of **clearly fake test values**: A 5000/9000/12000/14000, B 4000/7000/9500/11000, C 3000/5500/7500/9000; company share 80%; effective date 2026-10-01.
  - A first-line comment: TEST VALUES, replace with the client's rate card before go-live (plan, dependency 1).
- [X] T004 [P] Add `schemaFilter: ["public"]` to `lib/db/drizzle.config.ts`, so `drizzle-kit push` never touches the `bhi` schema or its RLS policies (research R6).
- [X] T005 [P] Document the two connection strings in `.env.example`, `deploy/LOCAL-DEV.md` and `deploy/README.md`:
  - `DATABASE_URL`: `bhi_app`, used by the API.
  - `DATABASE_OWNER_URL`: `bhi_owner`, used by migrations and `migrate-legacy` only.
  - Include the warning never to run the API or the tests as `postgres` (research R4).
- [X] T006 Create the integration test harness `artifacts/api-server/src/integration/testDb.ts`:
  - Read `TEST_DATABASE_URL`.
  - When it is unset, `describe.skip` the suite with a clear message.
  - **Fail** if `SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user` is true.
  - Export `withTestScope(companies | "ALL", fn)`.
  - Export `makeCompany()`, which inserts a `bhi.company` with a random `T<6 chars>` number and returns it.
  - Export `startApp()`, which listens `app` on port 0 and returns `{baseUrl, close}`.
  - Add the script `"test:integration": "vitest run src/integration"` to `artifacts/api-server/package.json`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the database structure (the 18 BHI tables, platform tables, RLS, roles), the scope mechanism, and the new roles. **No user story can start until this phase is complete.**

### Database roles and runners

- [X] T007 Update `deploy/db/setup-local.ps1` to create two login roles. Keep the script re-runnable.
  - `bhi_owner`: `NOSUPERUSER`, owns the database objects.
  - `bhi_app`: `NOSUPERUSER NOBYPASSRLS`, used by the API.
  - Reassign existing `bhi_user` objects to `bhi_owner` (`REASSIGN OWNED BY bhi_user TO bhi_owner`).
  - Run every migration as `bhi_owner`.
  - Print both connection strings for `.env`.
- [X] T008 [P] Update `docker/db/initdb/` (new `01-roles.sh`), `docker/migrate/apply-migrations.sh` and `compose.yaml`:
  - Create `bhi_owner` and `bhi_app` from `.env` passwords.
  - The `migrate` service connects as `bhi_owner`, and the `api` service uses `bhi_app`.
- [X] T009 [P] Update `deploy/azure/03-migrate-db.ps1` to create the two roles when missing and to apply migrations as `bhi_owner`. Update the matching steps in `docs/DEPLOY-AZURE.md` and `docs/DEPLOY-GCP.md`.

### SQL migrations

- [X] T010 Create `deploy/db/migrations/010_bhi_schema.sql`:
  - `CREATE SCHEMA IF NOT EXISTS bhi`.
  - The 18 tables exactly as in `specs/002-per-company-schema/contracts/bhi-schema.sql`, made re-runnable (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).
  - Every object schema-qualified (`bhi.member`, …).
  - Keep constraint names identical to the contract.
- [X] T011 Create `deploy/db/migrations/011_platform_tables.sql` with every new `public` table and column in data-model.md, Platform tables, all additive:
  - `client_groups`, `client_group_companies` (`company_number` unique, FK to `bhi.company`).
  - `import_batch`, plus sequence `import_batch_ordinal_seq` for `source_ordinal`; `import_batch_record`.
  - `import_exception_resolutions`, `member_class_history` (index on `(member_id, recorded_at)`), `billing_run_issues`, `lookup_alerts`, `legacy_key_map`.
  - `admin_users.group_scope uuid` (FK to `client_groups`).
  - `member_ref integer` (FK to `bhi.member`) on `card_sessions`, `change_requests` and `policy_memberships`; `dependent_ref integer` (FK to `bhi.dependent`) on `change_requests`.
  - `verification_sessions.matched_members jsonb NOT NULL DEFAULT '[]'`.
  - Drop NOT NULL on the old uuid `member_id` columns of `card_sessions`, `change_requests` and `policy_memberships`.
- [X] T012 Create `deploy/db/migrations/012_bhi_rls.sql`:
  - Functions `public.bhi_scope_all()` and `public.bhi_scope_has(company text)`. They read `current_setting('bhi.all', true)` and `current_setting('bhi.companies', true)`, and return false when a setting is unset.
  - `ENABLE` and `FORCE ROW LEVEL SECURITY` on all 18 `bhi` tables.
  - `USING` and `WITH CHECK` policies following data-model.md, Company ownership and visibility:
    - `class`, and `premium_rates` rows with no company: readable by all, writable only when `bhi_scope_all()`.
    - `dependent` and `beneficiary`: via `EXISTS` on `bhi.member`.
    - Import tables: via `public.import_batch` (on `source_ordinal` or `source_file`) or `public.import_batch_record`.
  - Company-scoped writes also require `bhi.company.active`.
- [X] T013 Create `deploy/db/migrations/013_roles_grants.sql`:
  - `bhi_app`: `USAGE` on `bhi` and `legacy`; `SELECT, INSERT, UPDATE` on all `bhi` tables and sequences, and **no DELETE**.
  - `public.audit_logs`: `SELECT, INSERT` only (revoke `UPDATE, DELETE`).
  - Other `public` tables keep their current rights.
  - `ALTER DEFAULT PRIVILEGES FOR ROLE bhi_owner IN SCHEMA bhi` gives future tables the same rights.
  - Add `CHECK` constraints on `admin_users`:
    - `ROLE_HR_ADMIN` and `ROLE_CLIENT_ADMIN` require `company_scope`.
    - `ROLE_HR_GROUP_ADMIN` requires `group_scope`.
    - Other roles require both to be null.
  - Add these constraints `NOT VALID`. They are validated in `deploy/db/retire-legacy.sql` (T085), after the migration has set group scopes.
- [X] T014 Create `deploy/db/migrations/015_seed_classes.sql`, which inserts classes A, B and C (values from `deploy/db/seed/classes.csv`, `active = true`) with `ON CONFLICT (class_code) DO NOTHING` (FR-021).

### Database library

- [X] T015 [P] Create one Drizzle file per table in `lib/db/src/schema/bhi/`, all using `pgSchema("bhi")`: `company.ts`, `class.ts`, `member.ts`, `dependent.ts`, `beneficiary.ts`, `premiumRates.ts`, `billingRun.ts`, `billingLine.ts`, `companyBillingRule.ts`, `enrollmentStatusHistory.ts`, `sourceWorkbookArchive.ts`, `sourceWorkbookSheet.ts`, `rawEnrollmentRow.ts`, `rawEnrollmentCell.ts`, `importException.ts`, `importAdjustment.ts`, `importReconciliation.ts`, `importDocumentation.ts`.
  - Column names, types and nullability must match `contracts/bhi-schema.sql` exactly.
  - Types: `integer().generatedByDefaultAsIdentity()` for auto numbers; `varchar({length})`; `numeric({precision:15, scale:2})` for money; `date({mode:"string"})` for calendar fields and `timestamp({withTimezone:true})` for event times, as in research R3.
  - Export each table as `bhi<Name>Table` (e.g. `bhiMemberTable`) to avoid clashing with the legacy tables.
  - `index.ts` re-exports all of them.
- [X] T016 [P] Add the platform tables from T011 to `lib/db/src/schema/`: new files `clientGroups.ts`, `importBatch.ts`, `importExceptionResolutions.ts`, `memberClassHistory.ts`, `billingRunIssues.ts`, `lookupAlerts.ts` and `legacyKeyMap.ts`. Add the new columns to `adminUsers.ts` (role enum gains `ROLE_CLIENT_ADMIN`; `groupScope`), `cardSessions.ts`, `changeRequests.ts`, `policies.ts` and `verificationSessions.ts`. Export everything from `lib/db/src/schema/index.ts`, including `./bhi`.
- [X] T017 Create `lib/db/src/scope.ts` and export it from `lib/db/src/index.ts`:
  - `type Scope = { all: true; readOnly: boolean } | { all: false; companies: string[]; readOnly: boolean }`.
  - `withScope(scope, fn)`: opens a transaction, runs `SELECT set_config('bhi.all', …, true), set_config('bhi.companies', <comma list>, true)`, then calls `fn(tx)`.
  - `SYSTEM_SCOPE = {all: true, readOnly: false}`, for jobs.
  - A company list of zero entries sets an empty string, so RLS matches nothing.
- [X] T018 In `lib/db/src/index.ts`, after the pool is created, check that the connected role is not a superuser and has no `BYPASSRLS`. In `NODE_ENV=production`, throw on start-up. Elsewhere, log a warning.

### Roles, scope and shared helpers

- [X] T019 Update `artifacts/api-server/src/lib/rbac.ts` and `artifacts/api-server/src/lib/rbac.test.ts`:
  - Add `ROLE_CLIENT_ADMIN`, with the permissions of `ROLE_HR_ADMIN` plus `ADMIN_USER_READ`, `ADMIN_USER_MANAGE` and `BILLING_READ`.
  - Add the permissions `CLASS_MANAGE`, `RATE_MANAGE` and `BILLING_MANAGE` (platform admin only), and `BILLING_READ` (platform admin, group admin, client admin, auditor).
  - Give `ROLE_HR_GROUP_ADMIN` the client admin permission set.
  - Export `ROLE_LABELS`: Super admin, Group admin, Client admin, HR administrator, Support, Auditor (data-model.md, Roles and scopes).
- [X] T020 Update `artifacts/api-server/src/middlewares/adminAuth.ts` so that `AdminContext` carries `scope: Scope` (T017). Resolve it from the role:
  - Platform admin: `{all:true, readOnly:false}`.
  - Support and auditor: `{all:true, readOnly:true}`.
  - Group admin: the companies in `client_group_companies` for its `group_scope`, but only active companies of an active group.
  - Client admin and HR: `[company_scope]`, if that company is active.
  - Reject with 401 an HR or client admin with a null `company_scope`, a group admin with a null `group_scope`, or a user whose company is inactive.
  - Rename the existing string field `scope` to `legacyScopeCode`, so `scope` holds the new `Scope` object. Routes not yet moved read `legacyScopeCode`, which is removed in T112.
- [X] T021 Create `artifacts/api-server/src/lib/statusHistory.ts` with `setActive(tx, {entityType: "MEMBER"|"DEPENDENT"|"BENEFICIARY", id, active, reason, effectiveDate, actor, cascade})`:
  - Updates `active`, `inactive_date` and `inactive_reason` on the entity.
  - Inserts one `bhi.enrollment_status_history` row, with `changed_at = now()` and `person_name` / `person_identifier` from the record.
  - Returns the before and after values for `writeAudit`.
  - For a member moving to inactive, revokes their `card_sessions` (by `member_ref`).
  - Refuses `active=false` without a reason.
- [X] T022 Rewrite `artifacts/api-server/src/lib/adminScope.ts` on top of `Scope`:
  - `inScope(scope, companyNumber)`.
  - `assertWritable(scope)`, which throws 403 when `readOnly`.
  - `scopedMember(admin, companyNumber, memberId)`, which loads `bhi.member` inside `withScope` and returns null (so the caller answers the standard 404) when the company is out of scope or the member does not exist.
  - Keep `contact()` masking unchanged.
- [X] T023 [P] Create `artifacts/api-server/src/lib/bhiErrors.ts`, mapping PostgreSQL errors to API errors, and use it in `artifacts/api-server/src/middlewares/errorHandler.ts`:
  - Unique violation on `member_id_type_id_number_uq`: `409 ID_ALREADY_REGISTERED`, "This ID is already registered on the platform. Contact NALICO." (FR-007).
  - Violation on `company_pk`: `409 COMPANY_EXISTS`.
  - `varchar` length (22001): `400 VALUE_TOO_LONG`, naming the column.
  - RLS `WITH CHECK` failure (42501): the standard 404.
  - Add `bhiErrors.test.ts`.

**Checkpoint**: migrations 010–015 apply cleanly to an empty database and to one with the current data. The API still starts, because the legacy tables are untouched.

---

## Phase 3: User Story 1 - Hold every company's enrollment data in the BHI model (Priority: P1) 🎯 MVP

**Goal**: prove the 18 BHI tables exist exactly as the client specified, shared by all companies, and fail closed without a scope.

**Independent Test**: `pnpm --filter @workspace/api-server test:integration -- bhiSchema rlsDefaultDeny grants` passes. See also quickstart §1 and §9.

### Tests for User Story 1

- [X] T024 [P] [US1] Create `artifacts/api-server/src/integration/fixtures/bhiSchemaExpected.ts`, transcribed from `specs/002-per-company-schema/contracts/bhi-schema.sql`:
  - The 18 tables.
  - Each table's columns as `{name, dataType, charMaxLength, numericPrecision, numericScale, nullable, identity}`.
  - Primary keys and unique constraints, including `NULLS NOT DISTINCT` on `premium_rates_company_class_band_date_uq`.
  - Indexes with their column lists.
  - The 8 foreign keys with `ON UPDATE` and `ON DELETE` actions.
- [X] T025 [US1] Create `artifacts/api-server/src/integration/bhiSchema.test.ts` (SC-001):
  - Read `information_schema.columns`, `table_constraints`, `key_column_usage`, `referential_constraints` and `pg_indexes` for schema `bhi`.
  - Assert an exact match with T024: 18 tables, 224 columns, 8 foreign keys and no extra tables.
  - Assert `relrowsecurity` and `relforcerowsecurity` on every table.
- [X] T026 [P] [US1] Create `artifacts/api-server/src/integration/rlsDefaultDeny.test.ts` (FR-011):
  - As `bhi_app`, with no scope set: `SELECT count(*)` on each of the 18 tables returns 0, apart from `class`.
  - With scope `[A]`, and two companies A and B holding a member, dependent, beneficiary, billing run and import batch exception each: an unfiltered `SELECT` returns only A's rows.
  - An `INSERT` of a B member under scope `[A]` fails.
  - Standard `premium_rates` rows are readable under `[A]`, but an insert or update of one fails unless `bhi.all=on`.
- [X] T027 [P] [US1] Create `artifacts/api-server/src/integration/grants.test.ts` (Constitution III). As `bhi_app`, each of these raises `permission denied`:
  - `DELETE` on `bhi.member`, `bhi.billing_run` and `bhi.class`.
  - `UPDATE` and `DELETE` on `public.audit_logs`.
  - Any write on `legacy.*`, when the schema exists.
- [X] T028 [P] [US1] Create `artifacts/api-server/src/integration/memberUniqueness.test.ts` (FR-007): insert a member with `(NATIONAL_ID, 123)` in company A, then insert the same pair in company B under scope `[B]`. Assert that the error maps through `bhiErrors` to `409 ID_ALREADY_REGISTERED`, and that the message does not contain A's number.

### Implementation for User Story 1

- [X] T029 [US1] Run migrations 010–015 on a fresh database and on a copy of the demo database. Fix any ordering or idempotency problems found in `deploy/db/migrations/010`–`015`, so that both runs, and a second run, succeed.
- [X] T030 [US1] Update `deploy/db/schema.sql` handling in `deploy/db/setup-local.ps1`, `docker/migrate/apply-migrations.sh` and `deploy/azure/03-migrate-db.ps1`, so that fresh installs apply `schema.sql` and then every migration including 010–015. Add a smoke check that runs `SELECT count(*) FROM information_schema.tables WHERE table_schema='bhi'` and requires 18.

**Checkpoint**: the BHI structure exists, segregation fails closed, and there is no delete path.

---

## Phase 4: User Story 2 - Keep each client's data apart (Priority: P1)

**Goal**: every admin route and the employee lookup work on the BHI tables within the caller's scope.
- Company-scoped users see only their company, group admins their group, and super admins everything.
- Support and auditor are read-only.
- The lookup gives one response before verification.

**Independent Test**: `test:integration -- segregation lookup` passes. See also quickstart §2 and §4.

**Depends on**: Phase 2. US1 is not required.

### Tests for User Story 2

- [X] T031 [P] [US2] Create `artifacts/api-server/src/integration/segregation.test.ts` (SC-003, FR-010 to FR-015):
  - **Fixtures**: companies BF and BA in group "G1", company ST in no group; one member in each; users for every role (HR@BF, client admin@ST, group admin@G1, super, support, auditor).
  - **Reads**: for every admin `GET` route in `contracts/admin-api.md`, HR@BF reading a BA or ST record gets the same 404 body as for a missing BF record.
  - **Members list**: group admin@G1 sees BF and BA, never ST. Super admin sees all three.
  - **Writes**: support and auditor get 403 on every `POST`, `PATCH`, deactivate and reactivate.
- [X] T032 [P] [US2] Create `artifacts/api-server/src/integration/lookup.test.ts` (SC-009, FR-016). Contacts:
  - no match;
  - one BF member;
  - two BF members;
  - one BF and one ST member with the same email.

  Assert:
  - The four `/v1/lookup` bodies are equal apart from `verificationId` and `maskedDestination`, every response takes at least 800 ms, and response-time medians over 200 runs differ by less than 50 ms. Run the timing test only when `LOOKUP_TIMING=1`.
  - After a correct code (dev mode), the results are `CARD`, `SELECT` (then `/v1/otp/select` gives `CARD`), and `MULTI_COMPANY` with a `lookup_alerts` row and no card token.
  - A decoy code gives `400 CODE_INVALID`.
  - A member deactivated between lookup and verify no longer counts.

### Implementation for User Story 2

- [X] T033 [US2] Update `lib/api-spec/openapi.yaml` for members, following `contracts/admin-api.md`, Members, and Dashboard:
  - Move member, dependent, beneficiary and policy paths under `/v1/admin/companies/{companyNumber}/members/{memberId}`.
  - Replace `remove` with `deactivate`, and add `deactivate` and `reactivate` for dependents and beneficiaries.
  - Rewrite the `MemberSummary`, `MemberDetail`, `MemberCreate`, `MemberUpdate`, dependent and beneficiary schemas with the BHI fields (`fullName` for dependents and beneficiaries), and remove the dropped fields.
  - Change the list query parameters to `company`, `active`, `classCode` and `q`.
  - Dashboard: replace the suspended, archived and removed counts with `inactiveMembers`, and add `openLookupAlerts`.
  - Run codegen.
- [X] T034 [US2] Update `lib/api-spec/openapi.yaml` for the employee flow, following `contracts/employee-lookup.md`:
  - `/v1/lookup` always returns `CODE_SENT`, with no 404 or 503.
  - Remove `/v1/lookup/select`.
  - `/v1/otp/verify` returns `status: CARD | SELECT | MULTI_COMPANY`.
  - Add `/v1/otp/select`.
  - The card schema's dependent and beneficiary names become `fullName`.
  - Run codegen.
- [X] T035 [US2] Update `lib/api-spec/openapi.yaml` for `/v1/admin/lookup-alerts` (list, resolve) and change requests (`companyNumber` + `memberId`, no `employeeNumber`), then run codegen.
- [X] T036 [US2] Rewrite `artifacts/api-server/src/lib/memberDetail.ts` to build `MemberDetail` from `bhi.member`, `bhi.dependent`, `bhi.beneficiary` and `public.policy_memberships` (by `member_ref`), inside the caller's `withScope`. Include `className`, `activeDependentCount` and `sharedContactAlert` (an open `lookup_alerts` row containing this member).
- [X] T037 [US2] Update `artifacts/api-server/src/lib/memberCreate.ts` and `memberCreate.test.ts`:
  - Remove `resolveEmployeeNumber`.
  - `checkCreateScope` uses `Scope` and `assertWritable`.
  - Validate the BHI required fields and sizes (id_type ≤20, id_number ≤40, first/last ≤80, class_code: an active class).
- [X] T038 [US2] In `artifacts/api-server/src/routes/admin.ts`, rewrite `GET /v1/admin/members` and `GET /v1/admin/companies`:
  - Query `bhi.member` and `bhi.company` in `withScope(admin.scope)`, with optional `company`, `active`, `classCode` and `q` filters (`q` matches names, `id_number`, email and phone, using the existing ILIKE approach).
  - Return `companyNumber` on every row and paginate as today.
  - Remove the employee number, employment status and member status filters.
- [X] T039 [US2] In `artifacts/api-server/src/routes/admin.ts`, rewrite `POST /v1/admin/companies/{companyNumber}/members` and `GET`/`PATCH .../members/{memberId}` on `bhi.member`:
  - Check `companyNumber` with `inScope` and `assertWritable`.
  - Create inserts one `public.member_class_history` row.
  - `PATCH` rejects `active`, and writes a `member_class_history` row when `classCode` changes.
  - Normalise the phone with `normalizeMemberPhone`, as today.
  - Map errors with `bhiErrors`.
  - Remove the employee-number clash check and the name-duplicate check. Uniqueness is now `(id_type, id_number)` (FR-007).
- [X] T040 [US2] In `artifacts/api-server/src/routes/admin.ts`, replace `POST .../remove` and `.../reactivate`:
  - Add `POST /v1/admin/companies/{companyNumber}/members/{memberId}/deactivate {reason, effectiveDate?}` and `.../reactivate {reason}`, using `setActive` (T021) and `writeAudit` (actions `MEMBER_DEACTIVATED`, `MEMBER_REACTIVATED`).
  - Delete the old handlers and the `memberStatus` / `employmentStatus` handling.
- [X] T041 [US2] In `artifacts/api-server/src/routes/admin.ts`, rewrite the dependent routes (`PATCH`, plus new `deactivate` and `reactivate`) on `bhi.dependent`, with integer `dependentId` checked to belong to `memberId`. `fullName` maps to `dependent_full_name`. Status changes go through `setActive`.
- [X] T042 [US2] In `artifacts/api-server/src/routes/admin.ts`, rewrite the beneficiary routes (`POST`, `PATCH`, `deactivate`, `reactivate`, replacing `.../remove`) on `bhi.beneficiary`. `sharePercent` maps to `share_percent`. Keep the 100% total warning.
- [X] T043 [US2] In `artifacts/api-server/src/routes/admin.ts`, rewrite `POST .../members/{memberId}/policy` to read and write `public.policy_memberships` by `member_ref`, after `scopedMember` succeeds.
- [X] T044 [US2] In `artifacts/api-server/src/routes/admin.ts`, rewrite `GET /v1/admin/dashboard`:
  - Member and dependent counts from `bhi` in `withScope`.
  - `inactiveMembers`.
  - `openLookupAlerts`, for platform and group admins only.
  - Verification and audit counts filtered by the scope's company list (`company_code = ANY(...)`, or all for `all`).
- [X] T045 [US2] In `artifacts/api-server/src/routes/admin.ts`, update `GET /v1/admin/audit`, `GET /v1/admin/verifications` and `reset-lock` to filter `company_code` by the scope's company list instead of the single `admin.scope` code.
- [X] T046 [US2] Update `artifacts/api-server/src/routes/adminChangeRequests.ts`:
  - `scopedRequest` loads the request, then checks `member_ref` with `scopedMember`.
  - The list query joins `bhi.member` by `member_ref`, filtered by scope.
  - Approve and reject write `bhi.member` or `bhi.dependent` (by `dependent_ref`) in one transaction with the request update.
  - Remove `employeeNumber` from the responses.
  - Update `artifacts/api-server/src/lib/changeRequest.ts` and `changeRequest.test.ts` for the `fullName` dependent field.
- [X] T047 [US2] In `artifacts/api-server/src/routes/employee.ts`, rewrite `findMembersByIdentifier` to query `bhi.member` joined with active `bhi.company`, under `SYSTEM_SCOPE` with read-only intent. Keep the loose phone match from `lib/phone.ts`, and return `{companyNumber, memberId, member}[]` for `active = true` members.
- [X] T048 [US2] In `artifacts/api-server/src/routes/employee.ts`, rewrite `POST /v1/lookup` per `contracts/employee-lookup.md`:
  - Always create one `verification_sessions` row with `matched_members`.
  - Always return `200 CODE_SENT`.
  - Delivery: send the code to each distinct stored contact on the channel after the response is written, logging failures against the session. Remove the `503` path.
  - Hold the response to at least 800 ms from request start (`LOOKUP_MIN_MS`, default 800).
  - Delete `POST /v1/lookup/select`.
  - Update `POST /v1/otp/resend` to redeliver the same way and never return 503.
- [X] T049 [US2] In `artifacts/api-server/src/routes/employee.ts`, rewrite `POST /v1/otp/verify`. After a correct code, re-check `matched_members` against currently active members.
  - **1 member**: issue a card session with `member_ref`.
  - **Several members in 1 company**: return `SELECT` with `disambiguationLabel` options, as signed tokens bound to the verification session.
  - **2 or more companies**: return `MULTI_COMPANY` with the fixed message and insert `public.lookup_alerts` (masked contact via `maskIdentifier`, matches, session id).

  Add `POST /v1/otp/select {verificationId, optionRef}`, which issues the card for the chosen member.
- [X] T050 [US2] In `artifacts/api-server/src/routes/employee.ts`:
  - `cardSessionFromRequest` resolves `member_ref`.
  - `GET /v1/card`, `POST /v1/card/email` and the card PDF build from `bhi.member`, `bhi.dependent` and `bhi.beneficiary` (`fullName`), and from `policy_memberships` by `member_ref`. `identificationId` comes from `id_number`.
  - Change-request submit sets `member_ref` / `dependent_ref`, and uses the audit actor and event key `member:<memberId>`.
  - Update `artifacts/api-server/src/lib/cardPdf.ts` and `cardPdf.test.ts` for `fullName`.
- [X] T051 [P] [US2] Create `artifacts/api-server/src/routes/adminLookupAlerts.ts`, and register it in `artifacts/api-server/src/routes/index.ts`:
  - `GET /v1/admin/lookup-alerts?status=`: super admin sees everything; group admin sees alerts involving its companies, with other companies' entries replaced by `"another company"`.
  - `POST /v1/admin/lookup-alerts/{id}/resolve {note}`: super admin only, with an audit entry.
- [X] T052 [P] [US2] Update the employee portal `artifacts/bhi-card-portal/src/pages/lookup.tsx` and `artifacts/bhi-card-portal/src/pages/verify.tsx`:
  - Lookup always moves to code entry, with no "not found" or selection screen.
  - After verify, handle `CARD`, `SELECT` (show the options and call `/v1/otp/select`) and `MULTI_COMPANY` (show the fixed message and no card).
- [X] T053 [P] [US2] Update `artifacts/bhi-card-portal/src/pages/card.tsx` to show dependents and beneficiaries by `fullName` (lines 184 and 355 today). The rendered text must be unchanged for migrated records.
- [X] T054 [P] [US2] Update `artifacts/bhi-card-portal/src/pages/admin-members.tsx`:
  - Add a Company column.
  - Replace the status filter with Active / Inactive / All, and add a Class filter.
  - Remove the employee number, employment status and member status columns.
  - Link rows to `/admin/companies/:companyNumber/members/:memberId`.
- [X] T055 [P] [US2] Update `artifacts/bhi-card-portal/src/pages/admin-member-detail.tsx`:
  - Show the BHI fields, class, active status with inactive date and reason, and the shared-contact flag.
  - Deactivate and Reactivate buttons with a reason dialog, replacing Remove.
  - Dependents and beneficiaries by `fullName`, with their own deactivate and reactivate.
- [X] T056 [P] [US2] Update `artifacts/bhi-card-portal/src/pages/admin-member-edit.tsx` and `artifacts/bhi-card-portal/src/pages/admin-member-create.tsx`:
  - BHI fields: ID type, ID number, middle initials, sex, class (active classes only), address lines, employment and plan dates, rate of pay, occupation, notes.
  - Remove employee number and employment status.
  - Show the `ID_ALREADY_REGISTERED` message.
- [X] T057 [P] [US2] Update `artifacts/bhi-card-portal/src/components/status-badge.tsx` (Active and Inactive only; remove SUSPENDED, REMOVED and ARCHIVED), `artifacts/bhi-card-portal/src/components/policy-panel.tsx` (no employee number), and `artifacts/bhi-card-portal/src/pages/admin-dashboard.tsx` (the new counts).
- [X] T058 [P] [US2] Update `artifacts/bhi-card-portal/src/pages/admin-change-requests.tsx` to address members by company and ID and remove employee number.
- [X] T059 [P] [US2] Create `artifacts/bhi-card-portal/src/pages/admin-lookup-alerts.tsx` (list plus resolve with note). Add routes for it and the new member paths in `artifacts/bhi-card-portal/src/App.tsx`, and a nav entry for super and group admins in `artifacts/bhi-card-portal/src/components/admin-nav.tsx`.

**Checkpoint**: on a database with BHI data, every admin screen works within scope, and the lookup is uniform.

---

## Phase 5: User Story 3 - Onboard a client and let its admin manage its users (Priority: P1)

**Goal**: a super admin onboards and offboards companies and client groups. Client admins and group admins manage their own users, and cannot escalate privileges.

**Independent Test**: `test:integration -- onboarding userManagement` passes. See also quickstart §3.

**Depends on**: Phase 2. The US2 routes are not needed for its tests.

### Tests for User Story 3

- [X] T060 [P] [US3] Create `artifacts/api-server/src/integration/onboarding.test.ts` (FR-017, FR-019, SC-002):
  - Onboarding returns 201 and creates the `bhi.company` and one active `ROLE_CLIENT_ADMIN` with `must_change_password`, in under 5 s.
  - Repeating it returns `409 COMPANY_EXISTS`, with no second user.
  - A forced failure after the company insert (test hook) leaves no company and no user.
  - Offboarding sets `active=false` and deactivates the users. Those users get 401. The company drops out of the lookup. A super admin can still read its members. Writes get `409 COMPANY_INACTIVE`.
- [X] T061 [P] [US3] Create `artifacts/api-server/src/integration/userManagement.test.ts` (FR-013, FR-018, SC-010):
  - A client admin of ST can create a `ROLE_HR_ADMIN` or `ROLE_CLIENT_ADMIN` in ST only. Every other role or company gives `403 ROLE_NOT_GRANTABLE`.
  - A group admin can create users for any company in its group and none outside it.
  - Deactivating the last active client admin of a company gives `409 LAST_CLIENT_ADMIN`. Deactivating the last super admin gives `409 LAST_SUPER_ADMIN`.
  - The scope column checks give `400 SCOPE_REQUIRED` or `SCOPE_NOT_ALLOWED`.
  - Adding a company that is already in another group gives `409 COMPANY_IN_OTHER_GROUP`.

### Implementation for User Story 3

- [X] T062 [US3] Update `lib/api-spec/openapi.yaml` per `contracts/admin-api.md` (Companies and onboarding, Client groups, Admin users): `POST`/`PATCH /v1/admin/companies`, `offboard`, `reactivate`, `/v1/admin/groups`, and user bodies with `groupScope` and the new role and error codes. Run codegen.
- [X] T063 [US3] Create `artifacts/api-server/src/routes/adminCompanies.ts` and register it:
  - `POST /v1/admin/companies` (`PLATFORM_MANAGE`), in one `SYSTEM_SCOPE` transaction:
    - insert `bhi.company` (`active=true`);
    - optionally insert into `client_group_companies`;
    - create the client admin with a temporary password, using the existing temporary-password helper (as in `adminUserUpdate.ts` or the `POST /v1/admin/users` flow);
    - write an audit entry (`COMPANY_ONBOARDED`);
    - return the temporary password once.
  - `PATCH` (platform admin for all fields; client or group admin for address and contact fields in scope).
  - `offboard` and `reactivate` (platform admin, reason required): set `company.active`, deactivate or reactivate the company's `admin_users`, and audit.
  - Remove the old `GET /v1/admin/companies` handler from `admin.ts`, if T038 kept it there, so there is exactly one.
- [X] T064 [US3] Create `artifacts/api-server/src/routes/adminGroups.ts` (`PLATFORM_MANAGE`) and register it. `GET`, `POST` and `PATCH` for `/v1/admin/groups`, with add and remove companies. The unique `company_number` gives `409 COMPANY_IN_OTHER_GROUP`. Deactivating a group removes it from group admins' scope (T020 reads `active`). Audit every change.
- [X] T065 [US3] Update `artifacts/api-server/src/lib/lastAdmin.ts` and `lastAdmin.test.ts`:
  - Add `isLastClientAdmin(companyNumber, userId)` and `isLastSuperAdmin(userId)`, counting active users.
  - Use them in `artifacts/api-server/src/lib/adminUserUpdate.ts`, keeping the existing "parking" behaviour covered by `adminUserUpdate.test.ts`.
- [X] T066 [US3] Update the user routes in `artifacts/api-server/src/routes/admin.ts` (`GET`/`POST`/`PATCH /v1/admin/users`, currently around lines 2359–2658) and `artifacts/api-server/src/lib/adminUserUpdate.ts`:
  - Lists are filtered to users whose scope company is in the caller's scope. Platform admin sees all; group admin sees users of its group's companies and itself.
  - Grantable roles: client and group admins may grant only `ROLE_CLIENT_ADMIN` or `ROLE_HR_ADMIN`, with a `companyScope` in their scope. Only a platform admin may grant any other role or set `groupScope`.
  - Enforce the scope rules of T013 in code, with the error codes of `contracts/admin-api.md`.
  - Audit every change.
- [X] T067 [P] [US3] Create `artifacts/bhi-card-portal/src/pages/admin-companies.tsx` (list; onboard dialog with client admin email and name, showing the temporary password once; offboard and reactivate with a reason) and `artifacts/bhi-card-portal/src/pages/admin-groups.tsx` (list, create, add and remove companies). Both are super admin only. Add their routes in `App.tsx` and their nav entries in `components/admin-nav.tsx`.
- [X] T068 [P] [US3] Update `artifacts/bhi-card-portal/src/pages/admin-users.tsx` and `artifacts/bhi-card-portal/src/pages/admin-permissions.tsx`:
  - Role labels from `ROLE_LABELS`, with "Super admin" for the platform admin.
  - The role picker offers only grantable roles.
  - Company picker limited to the caller's scope; group picker for super admin only.
  - Show the `LAST_CLIENT_ADMIN`, `LAST_SUPER_ADMIN` and `ROLE_NOT_GRANTABLE` messages.
- [X] T069 [US3] Write the new demo seed in `artifacts/api-server/src/lib/seed.ts`, used when there are no `bhi.company` rows and `DEMO_SEED` is not `false`.
  - **Structure**: the six Beharry companies (BF, BA, BL, BR, BM, BS) in group "Beharry", plus a non-group company ST ("Sterling Test"); classes are already present from T014.
  - **Members**: members with valid ID type and class, dependents (0–7 per member), beneficiaries and policies, with `member_class_history` rows.
  - **Admins**: one admin for each role. Keep the existing demo emails, add `client.admin@st.test` and `hr@st.test`, and set `group.admin@` to group "Beharry". Password `Demo@2026`.
  - Move the old seed that writes the legacy tables, unchanged, to `artifacts/api-server/src/lib/legacySeed.ts`, for migration rehearsal only (T082).
  - Update `bootstrapProductionAdmin` to create a platform admin (super admin) with no scope.

**Checkpoint**: NALICO can onboard Sterling. Sterling's client admin creates its HR user, and neither user can see Beharry.

---

## Phase 6: User Story 4 - Move the existing data into the BHI model (Priority: P1)

**Goal**: a one-off, single-transaction command moves the current data into the BHI tables, holds incomplete records as exceptions, and produces a reconciliation. HR fixes exceptions through bulk import. The age-65 sweep and bulk import work on the BHI tables.

**Independent Test**: `test:integration -- legacyMigration importExceptions` passes, and `migrate-legacy --dry-run` on the legacy demo seed prints a passing reconciliation. See also quickstart §7 and §8.

**Depends on**: Phase 2. For the portal import screen, US2's member screens should be in place.

### Tests for User Story 4

- [X] T070 [P] [US4] Update `artifacts/api-server/src/lib/memberImport.test.ts`:
  - The LEGACY 8-column layout is rejected with `LAYOUT_WITHDRAWN`.
  - A carrier row missing IDType, IDNumber, ClassCode, first or last name gives `ERROR` with the field listed.
  - Over-length values give `ERROR` with the actual and allowed lengths.
  - `synthesiseEmployeeNumber` is no longer used.
  - A dependant row's name is mapped to `fullName`.
- [X] T071 [P] [US4] Create `artifacts/api-server/src/integration/legacyMigration.test.ts` (SC-004, SC-007, FR-037 to FR-044). Load `legacySeed` into the legacy tables, run `runLegacyMigration({dryRun:false})` as the owner role, then assert:
  - **Counts**: for each company and table, loaded + held = source, and every `import_reconciliation` row has `passed`.
  - **Status mapping**: suspended and removed members are `active=false`, with `inactive_reason` prefixed as in FR-038.
  - **Exceptions**: members missing an ID type or class are held under their company's `import_batch`. A duplicate `(id_type, id_number)` in two companies holds both records.
  - **Card access**: the set of legacy members eligible for a card (`member_status='ACTIVE'`) equals the set of `active=true` BHI members plus the held ones.
  - **Re-keying**: `card_sessions`, `change_requests` and `policy_memberships` all have `member_ref` set for non-held members.
  - **Audit**: `audit_logs` row count and a checksum of its content are unchanged.
  - **History**: `member_class_history` has one row per loaded member, and `enrollment_status_history` one row per inactive record.
  - **Scope**: group "Beharry" exists, with the six companies and the group admins scoped to it.
  - **Dry run**: a `dryRun:true` run changes nothing.
- [X] T072 [P] [US4] Create `artifacts/api-server/src/integration/importExceptions.test.ts` (FR-041, FR-042):
  - HR@BF sees only BF exceptions through `GET /v1/admin/companies/BF/import-exceptions`, and gets 404 for BA.
  - Uploading a carrier row that supplies the missing IDType and ClassCode for a held member loads the member, restores the held dependents and beneficiaries from the snapshot, and marks the exception resolved.
  - A row with a blank ClassCode is written to `import_exception` under the upload's batch and not loaded.
  - The whole commit rolls back if any write fails.

### Implementation for User Story 4

- [X] T073 [US4] Rewrite `artifacts/api-server/src/lib/memberImport.ts`:
  - Remove the LEGACY layout from `detectLayout` and `IMPORT_LAYOUTS`; when detected, return `LAYOUT_WITHDRAWN`.
  - `mapRow` enforces the BHI required fields (IDType, IDNumber, Company Number, LastName, FirstName, ClassCode, Active) and sizes (data-model.md, Legacy to BHI column mapping).
  - Remove `synthesiseEmployeeNumber` and its callers.
  - The dependant and beneficiary mappers produce `fullName` (first + " " + last) and enforce 120 characters.
- [X] T074 [US4] Create `artifacts/api-server/src/lib/importBatch.ts`:
  - `createBatch(tx, {companyNumber, kind, originalFileName, createdBy})` takes `source_ordinal` from `import_batch_ordinal_seq` and generates `source_file` as `<company>-<yyyymmdd>-<ordinal padded to 4>.<ext>`.
  - `recordException(tx, batch, {entityType, personName, memberIdentifier, reasonCodes, reason, requiredAction, snapshot})` inserts `bhi.import_exception` with `source_alias` = the batch kind and `source_file` = the batch's.
  - `linkRecord(tx, batch, table, id)` inserts `import_batch_record`.
- [X] T075 [US4] Rewrite `POST /v1/admin/import` in `artifacts/api-server/src/routes/admin.ts` (currently lines 1297–2135), per `contracts/admin-api.md`, Import:
  - Group rows by Company Number; each must be in scope (`assertWritable`).
  - For each company, one transaction in `withScope`: create a batch, then load member rows matched by `(id_type, id_number)`, updating when the member exists in this company.
  - A match in another company returns `ID_ALREADY_REGISTERED` for that row.
  - Failing rows go to `recordException`.
  - Dependant and beneficiary rows are matched to their member by `(id_type, id_number)`.
  - Status changes go through `setActive`, and class changes write `member_class_history`.
  - The dry run reports without writing.
  - Remove the employee-number matching and the company auto-creation. Companies are now created only by onboarding (T063).
- [X] T076 [US4] Add exception resolution to the import commit in `artifacts/api-server/src/routes/admin.ts` (or `artifacts/api-server/src/lib/importBatch.ts`):
  - A loaded member row that matches an open `import_exception` for the same company — by `member_identifier`, plus ID type when the exception has one, plus name when it does not — inserts `import_exception_resolutions`.
  - It also loads the snapshot's dependents and beneficiaries from `raw_row_summary`, unless the same file supplies rows for that member.
  - It updates `legacy_key_map.new_id` when the exception came from the migration.
  - The response lists `resolvedExceptions`.
- [X] T077 [US4] Update `lib/api-spec/openapi.yaml` for the import changes (`LAYOUT_WITHDRAWN`, `resolvedExceptions`, per-row error fields) and add `GET /v1/admin/companies/{companyNumber}/import-exceptions?status=`. Run codegen.
- [X] T078 [P] [US4] Create `artifacts/api-server/src/routes/adminImportExceptions.ts` and register it: `GET /v1/admin/companies/{companyNumber}/import-exceptions?status=OPEN|RESOLVED`, joining `import_exception_resolutions` and **excluding** `raw_row_summary` from the response. Readable by any admin with `MEMBER_READ_*` in scope.
- [X] T079 [US4] Rewrite `artifacts/api-server/src/lib/retirementSweep.ts` (R19). Under `SYSTEM_SCOPE`:
  - Select `bhi.member` rows with `active = true`, `date_of_birth <= retirementCutoff()` and an active company.
  - For each, call `setActive` with reason `Aged out at 65` and write an audit entry (`MEMBER_DEACTIVATED_RETIREMENT_AGE`, actor SYSTEM).
  - Return `{deactivated, noDateOfBirth: [{companyNumber, memberId}]}`.

  Keep the schedule in `artifacts/api-server/src/index.ts` unchanged. Update `artifacts/api-server/src/lib/retirement.test.ts` if needed.
- [X] T080 [US4] Create `artifacts/api-server/src/lib/legacyMigration.ts` with `runLegacyMigration({dryRun, log})`, following research R16 and data-model.md, Legacy to BHI column mapping. It runs as the owner role in one transaction under `SYSTEM_SCOPE`:
  - (a) Insert `bhi.company` from `public.companies` and create a `LEGACY_MIGRATION` batch per company.
  - (b) Create group "Beharry" with the existing companies. Set `group_scope` for `ROLE_HR_GROUP_ADMIN` users.
  - (c) Map members:
    - status per FR-038;
    - the imported file's inactive values, when they disagree, appended to notes;
    - write `legacy_key_map`, `member_class_history` at `created_at`, and `enrollment_status_history` for inactive members;
    - hold `MISSING_ID_TYPE`, `MISSING_CLASS`, `UNKNOWN_CLASS`, `VALUE_TOO_LONG` and platform-wide `DUPLICATE_ID` records with a JSON snapshot of the member, dependents and beneficiaries.
  - (d) Map dependents and beneficiaries (`fullName`, status, dates). Children of held members stay only in the snapshot.
  - (e) Set `member_ref` / `dependent_ref` on the platform tables from `legacy_key_map`.
  - (f) Write `import_reconciliation` rows per company and table, linked through `import_batch_record`, and return the same counts.
  - When `dryRun`, roll back at the end.
- [X] T081 [US4] Create `artifacts/api-server/src/scripts/migrateLegacy.ts`:
  - A CLI with `--dry-run`, using `DATABASE_OWNER_URL` (refuse to run without it in production).
  - Calls `runLegacyMigration`.
  - Prints a per-company, per-table table of source, loaded, held and passed, with **no names or IDs**.
  - Exits non-zero if any row did not pass.

  Add it as a second entry point (`dist/migrate-legacy.mjs`) in `artifacts/api-server/build.mjs`.
- [X] T082 [US4] Add a rehearsal path: `pnpm --filter @workspace/api-server run rehearse:migration` loads `lib/legacySeed.ts` into an empty legacy structure, then runs `migrate-legacy --dry-run`. Add the script to `artifacts/api-server/package.json`, with a short section in `deploy/LOCAL-DEV.md`. Data is synthetic only (FR-048).
- [X] T083 [P] [US4] Update `artifacts/bhi-card-portal/src/pages/admin-import.tsx`:
  - Carrier layouts only; show the `LAYOUT_WITHDRAWN` message for the old layout.
  - Per-row errors with the missing or too-long field.
  - Show "resolves N exceptions" in the dry run and `resolvedExceptions` after commit.
  - Remove the employee-number column hints (lines 593–669 today).
- [X] T084 [P] [US4] Create `artifacts/bhi-card-portal/src/pages/admin-import-exceptions.tsx`: the open and resolved list per company (person, identifier, reasons, required action, source), with a link to bulk import. Add its route and a nav entry for HR, client, group and super admins.
- [X] T085 [US4] Create `deploy/db/retire-legacy.sql` (sign-off step, research R18 step 7):
  - `CREATE SCHEMA IF NOT EXISTS legacy`.
  - `ALTER TABLE public.companies, employee_members, dependents, beneficiaries SET SCHEMA legacy`.
  - Drop the old uuid `member_id` / `dependent_id` columns and their foreign keys on `card_sessions`, `change_requests` and `policy_memberships`.
  - Drop `verification_sessions.member_id` and `company_code`.
  - Grant `bhi_app` SELECT only on `legacy`.
  - Validate the `admin_users` constraints from T013.
- [X] T086 [US4] Remove the legacy table definitions `companies.ts`, `members.ts`, `dependents.ts` and `beneficiaries.ts` from `lib/db/src/schema/index.ts` exports. Keep the files, marked as legacy with a `legacy` schema via `pgSchema("legacy")`, so `migrateLegacy` and `legacySeed` can still read them after sign-off. Fix any remaining imports in `artifacts/api-server/src`.
- [X] T087 [US4] Write the cut-over runbook `docs/CUTOVER-002-BHI-MODEL.md`:
  - The steps of research R18: additive migrations, maintenance page, backup, dry run, real run, reconciliation review, deploy, reopen, and later `retire-legacy.sql`.
  - The rollback procedure before reopening.
  - The rollback rehearsal required by the constitution's release-readiness gate.
  - Where to record the measured duration.

**Checkpoint**: after a rehearsal, reconciliation passes, card access is unchanged, and HR can fix held members through bulk import.

---

## Phase 7: User Story 5 - Manage classes and the rate card (Priority: P2)

**Goal**: super admins add, retire and rename classes, and maintain standard and company-specific rates, four tiers per class. Classes are assignable only when their standard rates are complete. Company users can view their applicable rates.

**Independent Test**: `test:integration -- classesRates` passes. See also quickstart §5.

**Depends on**: Phase 2. The class checks at member assignment (T092) touch the US2 member routes.

### Tests for User Story 5

- [X] T088 [P] [US5] Create `artifacts/api-server/src/integration/classesRates.test.ts` (FR-021 to FR-027, SC-008). A super admin:
  - adds class D, which shows `rateComplete:false`, and assigning D to a member fails;
  - posts four standard tiers, after which D is assignable;
  - posts three tiers and gets 400, and posts company + employee ≠ total and gets 400;
  - posts a duplicate key and gets `409 RATE_EXISTS`.

  Company rates for ST class A from 2026-11-01 make `GET /v1/admin/rates?company=ST&asOf=2026-11-01` show A as `COMPANY` and the other classes as `STANDARD`.

  Other checks:
  - HR@BF gets 403 on class and rate writes, and 200 on `GET /v1/admin/rates?company=BF`.
  - A retired class stays on its members but is refused for new assignments.
  - The 37th class code gives `409 CLASS_CODES_EXHAUSTED`.
  - Billing-rule shares not totalling 100 give 400.

### Implementation for User Story 5

- [X] T089 [US5] Update `lib/api-spec/openapi.yaml` per `contracts/admin-api.md`, Classes and Rates: `/v1/admin/classes`, `/v1/admin/rates`, `/v1/admin/rates/history`, `PATCH /v1/admin/rates/{premiumRateId}` and `/v1/admin/companies/{companyNumber}/billing-rules`. Run codegen.
- [X] T090 [P] [US5] Create `artifacts/api-server/src/lib/rateBands.ts` and `rateBands.test.ts`:
  - The fixed band table: 0 `EE` "Employee only", 1 `EE+1` "Employee +1", 2 `EE+2` "Employee +2", 3 `EE+3+` "Employee + more than two".
  - `tierFor(activeDependentCount)` returns `min(count, 3)`.
  - `validateRateSet(tiers)`: exactly bands 0–3, and company + employee = total, to the cent.
- [X] T091 [US5] Create `artifacts/api-server/src/routes/adminClasses.ts` and register it:
  - `GET /v1/admin/classes?includeRetired=`, with `rateComplete` (all four bands have an active standard rate).
  - `POST` (`CLASS_MANAGE`, `SYSTEM_SCOPE`): upper-case the code and check `[A-Z0-9]`. Duplicates give `409 CLASS_EXISTS` naming the existing class; 36 existing codes give `409 CLASS_CODES_EXHAUSTED`.
  - `PATCH /v1/admin/classes/{classCode}` (name, description, sort order, active; reason required).
  - Audit each change (FR-027).
- [X] T092 [US5] Create `artifacts/api-server/src/lib/classRules.ts` with `assertAssignable(tx, classCode)`: the class is active and `rateComplete`, otherwise `400 CLASS_NOT_ASSIGNABLE`. Call it in member create and in class change (T039) and in bulk import (T075) for **new** assignments only. An unchanged class, including a retired one, is not rechecked.
- [X] T093 [US5] Create `artifacts/api-server/src/routes/adminRates.ts` and register it:
  - `GET /v1/admin/rates?company=&asOf=`: resolves each class and band to the company rate, or the standard rate, with the latest `effective_date <= asOf`. Returns `source`. Company users may call it only for companies in scope.
  - `GET /v1/admin/rates/history` (`RATE_MANAGE`).
  - `POST /v1/admin/rates` (`RATE_MANAGE`, `SYSTEM_SCOPE`): `validateRateSet`, fill `coverage_band` and `coverage_label` from `rateBands`, insert four rows in one transaction, `409 RATE_EXISTS` on the unique key.
  - `PATCH /v1/admin/rates/{id}`: `active` and `notes` only.
  - `GET`/`POST /v1/admin/companies/{companyNumber}/billing-rules`: shares must total 100.
  - Audit each change (FR-027).
- [X] T094 [US5] Create `artifacts/api-server/src/scripts/loadStandardRates.ts`, added as a third build entry (`dist/load-standard-rates.mjs`) in `artifacts/api-server/build.mjs`. It reads `deploy/db/seed/premium_rates_standard.csv` (or a path argument), validates each class's four-tier set with `rateBands`, and inserts standard rates idempotently (skipping existing keys). It prints the counts only, and refuses to run in production when the file still carries the TEST VALUES comment.
- [X] T095 [P] [US5] Create `artifacts/bhi-card-portal/src/pages/admin-classes.tsx` (list with rate-complete status; add, rename, retire and reactivate for super admin) and `artifacts/bhi-card-portal/src/pages/admin-rates.tsx`:
  - The rate set in force, by company and date, with the source shown per tier.
  - The history.
  - An "add rate set" form with four tier rows (super admin).
  - The company billing-rules tab.
  - A read-only view for company users.

  Add their routes and nav entries.

**Checkpoint**: class D can be introduced and priced without a code release, and a company rate overrides the standard rate for that company only.

---

## Phase 8: User Story 6 - Produce the monthly bill for each company (Priority: P2)

**Goal**: one billing run per company per month.
- Members are priced from their state at 00:00 on the 1st (Guyana time), with tier and rate chosen by the rules.
- Drafts are recalculated by superseding, and finalised runs are frozen.
- Unpriced members block finalising.

**Independent Test**: `test -- pricing` and `test:integration -- billing` pass, and every fixture line matches the hand calculation to the cent. See also quickstart §6.

**Depends on**: US5, for rates. Reads member, dependent and status history written through the US2 and US4 code paths.

### Tests for User Story 6

- [X] T096 [P] [US6] Create `artifacts/api-server/src/lib/billing/pricing.test.ts` (unit):
  - `chooseRate` prefers a company rate over the standard rate, picks the latest `effective_date <= date(T)`, ignores inactive rates, and returns null when neither exists.
  - `split` uses the rate's company and employee amounts without a rule. With an 80/20 rule it gives `round(total×0.8, 2)` to the company and the remainder to the employee, including a total of 33,333.33.
  - Tiers for 0, 1, 2, 3 and 7 dependents are 0, 1, 2, 3 and 3.
- [X] T097 [P] [US6] Create `artifacts/api-server/src/integration/billing.test.ts` (SC-005, FR-028 to FR-036). Build a fixture with an explicit `recorded_at` / `changed_at` / `created_at` for every change, matching quickstart §6: an addition, a removal, a class change and a new dependent recorded before and after 1 Oct, members with 0–7 dependents, a standard-rate company, a company-rate company and an 80/20 billing-rule company.
  - Generate September, October and November, and compare every line with a hand-written expected table in the test.
  - A bill generated "on 5 Oct" (clock injected) still reflects 1 Oct.
  - Finalising, then generating again, gives `ALREADY_FINAL`. Updating a FINAL line or a used rate's amount fails on the trigger.
  - A class with no rate produces `billing_run_issues`, and finalising gives `409 RUN_HAS_ISSUES`.
  - Recalculating a draft marks the old one `SUPERSEDED` and keeps its lines.
  - HR@BF sees only BF runs.
- [X] T098 [P] [US6] Create `artifacts/api-server/src/integration/billingPerf.test.ts`, run only when `BILLING_PERF=1`. Seed 5,000 synthetic members across 6 companies, with random 0–7 dependents, and assert that generating all companies for one month takes under 5 minutes (SC-011). Log the measured time.

### Implementation for User Story 6

- [X] T099 [US6] Create `deploy/db/migrations/014_billing_triggers.sql`:
  - A trigger function rejecting `UPDATE` on `bhi.billing_run` rows whose current status is `FINAL`, and on `bhi.billing_line` rows whose run is `FINAL`.
  - A trigger rejecting `UPDATE` of `company_number`, `class_code`, `coverage_band`, `dependent_band`, `total_premium`, `company_premium`, `employee_premium` or `effective_date` on `bhi.premium_rates` rows referenced by a line of a FINAL run (research R13, R14).
  - A `CHECK (status IN ('DRAFT','FINAL','SUPERSEDED'))` on `billing_run.status`, added `NOT VALID` and then validated.
- [X] T100 [P] [US6] Create `artifacts/api-server/src/lib/billing/pricing.ts` (pure, no database):
  - `monthStart(month)` returns T as 00:00 America/Guyana (UTC−4), as a UTC instant.
  - `chooseRate(rates, {companyNumber, classCode, band, asOf})`.
  - `split(rate, rule | null)`, per research R12.
  - Re-export `tierFor` from `rateBands.ts`.
- [X] T101 [US6] Create `artifacts/api-server/src/lib/billing/asOf.ts` with `membersAsOf(tx, companyNumber, T)`. It runs **one set-based SQL query per company** (research R11) and returns, for each member billed in the month, `{memberId, idType, idNumber, memberName, classCode, activeDependentCount}`:
  - **Which members**: those with `created_at < T` whose latest `enrollment_status_history` row with `changed_at < T` shows them active, or, when there is no row, whose creation state was active.
  - **Class**: from the latest `member_class_history` row with `recorded_at < T`.
  - **Active dependents**: dependents with `created_at < T` that were active at T, by the same history rule.
- [X] T102 [US6] Create `artifacts/api-server/src/lib/billing/runs.ts`:
  - `generateRun(companyNumber, month, actor)`, per research R13:
    - take `pg_advisory_xact_lock` on (company, month);
    - return `ALREADY_FINAL` if the month is FINAL;
    - mark any DRAFT as `SUPERSEDED`;
    - insert a new DRAFT `billing_run` (`billing_month` = the 1st, `billing_date` = today, `generated_at`, `generated_by`);
    - load `membersAsOf`, the company and standard rates, and the billing rule;
    - insert one `billing_line` per priced member (`rate_effective_date`, `premium_rate_id`) and one `billing_run_issues` row per unpriced member;
    - write an audit entry.
  - `generateAll(month, actor)` runs each active company in its own transaction.
  - `finaliseRun(runId, actor, reason)`: `409 RUN_HAS_ISSUES` or `RUN_NOT_DRAFT`, otherwise set FINAL and write an audit entry.
- [X] T103 [US6] Update `lib/api-spec/openapi.yaml` per `contracts/admin-api.md`, Billing (runs list, generate, detail with class and tier totals, `export.csv`, finalise, line fields) and the dashboard's `draftBillingRuns` and `unpricedMembers`. Run codegen.
- [X] T104 [US6] Create `artifacts/api-server/src/routes/adminBilling.ts` and register it:
  - `POST /v1/admin/billing/runs` (`BILLING_MANAGE`; `companies: "ALL" | string[]`).
  - `GET /v1/admin/billing/runs` and `GET .../{runId}` (`BILLING_READ`, in `withScope`). The detail groups lines into totals per class × tier (headcount × rate) and lists issues.
  - `GET .../{runId}/export.csv`: streams the lines, with the premium columns and no contact details.
  - `POST .../{runId}/finalise` (`BILLING_MANAGE`).
- [X] T105 [US6] Add `draftBillingRuns` and `unpricedMembers` to `GET /v1/admin/dashboard` in `artifacts/api-server/src/routes/admin.ts`, for roles with `BILLING_READ`, counted in scope.
- [X] T106 [P] [US6] Create `artifacts/bhi-card-portal/src/pages/admin-billing.tsx`:
  - Month picker, runs by company with status and totals.
  - "Generate" for one or all companies (super admin), showing per-company results including `ALREADY_FINAL` and issue counts.
- [X] T107 [P] [US6] Create `artifacts/bhi-card-portal/src/pages/admin-billing-run.tsx`:
  - Header, totals per class × tier, the lines table, and the unpriced issues list.
  - CSV export.
  - "Finalise" with a reason (super admin, disabled while there are issues).

  Add the routes for both billing pages in `App.tsx` and a "Billing" nav entry for `BILLING_READ` roles in `components/admin-nav.tsx`.

**Checkpoint**: the September to November fixture bills match the hand calculation. A late-generated bill is still correct, and finalised bills cannot change.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [X] T108 [P] Extend `artifacts/api-server/scripts/rbac-test.mjs` with the new roles and routes (companies, groups, users, classes, rates, billing, import exceptions, lookup alerts), and the expected 200, 403 and 404 per role, mirroring T031, T061 and T088.
- [X] T109 [P] Update `README.md`, `deploy/README.md` and `deploy/LOCAL-DEV.md`:
  - The shared `bhi` schema, the two roles and `DATABASE_OWNER_URL`.
  - The new admin areas.
  - Loading standard rates (`load-standard-rates`).
  - The migration rehearsal.
  - Rebuild and copy `deploy/api/` after changes: `pnpm --filter @workspace/api-server run build`, then `cp -r artifacts/api-server/dist/. deploy/api/`.
- [X] T110 [P] Update `docs/postman/BHI-Health-Card-API.postman_collection.json` for the moved and new admin routes and the changed lookup and verify responses.
- [X] T111 [P] Remove dead code: `artifacts/api-server/src/lib/duplicateName.ts` and its test (name uniqueness no longer applies), the `employeeNumber` helpers, and the `memberStatus` / `employmentStatus` references. Search `artifacts/` and `lib/` for `employeeNumber`, `employee_number`, `memberStatus`, `employmentStatus`, `SUSPENDED`, `identificationId` and `lookup/select`, and remove every hit outside `legacySeed.ts`, `legacyMigration.ts` and the legacy schema files.
- [X] T112 Remove the transitional `legacyScopeCode` field (T020) from `artifacts/api-server/src/middlewares/adminAuth.ts` and every caller, so routes use only `admin.scope`. Run `pnpm -w run typecheck`.
- [X] T113 [P] Prepare the review pack `specs/002-per-company-schema/reviews.md` for the constitution's gates.
  - **Security review**: the disclosure surface of `/v1/lookup` and `/v1/otp/verify`, role and scope resolution, user-management escalation rules, RLS policies, grants, the superuser/BYPASSRLS start-up check, and triggers.
  - **Data protection review**: the fields dropped and added, where exception snapshots hold personal data, lookup alerts (masked), billing lines, and the new policyholders beyond Beharry.
  - Link the test files that evidence each point.
- [X] T114 Run every scenario in `specs/002-per-company-schema/quickstart.md` §1–§9 against a local stack (after rebuilding `deploy/api/`). Record the measured times for SC-002, SC-008, SC-011 and the migration in `docs/CUTOVER-002-BHI-MODEL.md`, and fix any failures found.
- [X] T115 Run `pnpm --filter @workspace/api-server test`, `test:integration` (with `TEST_DATABASE_URL` as `bhi_app`, plus `LOOKUP_TIMING=1` and `BILLING_PERF=1` once each) and `pnpm -w run typecheck`. All must pass before requesting the security and data protection reviews.

---

## Dependencies & Execution Order

### Phase dependencies

| Phase | Depends on | Blocks |
|---|---|---|
| 1 Setup | nothing | 2 |
| 2 Foundational | 1 | every user story |
| 3 US1 | 2 | nothing (verification of the structure) |
| 4 US2 | 2 | US4 portal import screen (T083), US6 dashboard (T105) |
| 5 US3 | 2 | nothing. T069 (new seed) is needed for demoing US2 by hand. |
| 6 US4 | 2. T075 reuses the US2 member write rules (T037, T039). | production cut-over |
| 7 US5 | 2. T092 touches the US2 and US4 member write paths. | US6 |
| 8 US6 | US5 (rates), plus the history written by the US2 and US4 code | first bill |
| 9 Polish | all desired stories | release |

### User story dependencies

```text
Setup ─► Foundational ─┬─► US1 (verify structure)
                       ├─► US2 (segregation + lookup) ──┐
                       ├─► US3 (onboarding + users)     ├─► US4 (migration + import) ─► cut-over
                       └─► US5 (classes + rates) ───────┴─► US6 (billing) ─► first bill
```

- **Production cut-over** needs US1–US4.
- **The first bill** also needs US5, US6, and the client's real rate card (plan, dependency 1).

### Within each story

- Tests first, and confirm they fail.
- Then the OpenAPI edit and codegen, then library code, then routes, then portal pages.
- `lib/api-spec/openapi.yaml` and `artifacts/api-server/src/routes/admin.ts` are shared files, so tasks that touch them run one after another, even across stories.

### Parallel opportunities

- **Setup**: T002, T003, T004 and T005.
- **Foundational**: T008 and T009 (runners); T015 and T016 (Drizzle definitions), once T010 and T011 are written; T023 alongside T019–T022.
- **US1**: T024, T026, T027 and T028.
- **US2**: tests T031 and T032; after codegen (T033–T035), the API work in `employee.ts` (T047–T050) runs in parallel with the `admin.ts` work (T038–T045), and portal pages T052–T059 are all parallel.
- **US3**: T060 and T061; T067 and T068.
- **US4**: T070, T071 and T072; T078, T083 and T084.
- **US5**: T088 and T090; T095.
- **US6**: T096, T097 and T098; T100 alongside T099; T106 and T107.
- **Across stories**: once Phase 2 is done, US1, US3 and US5 touch mostly separate files and can be built by different people at the same time as US2.

---

## Parallel Example: User Story 2

```text
# Tests first (different files):
T031 integration/segregation.test.ts
T032 integration/lookup.test.ts

# After T033–T035 (openapi + codegen), two API tracks in parallel:
Track A (routes/admin.ts, one after another):  T038 → T039 → T040 → T041 → T042 → T043 → T044 → T045
Track B (routes/employee.ts, one after another): T047 → T048 → T049 → T050
Plus T046 (adminChangeRequests.ts) and T051 (adminLookupAlerts.ts) in parallel

# Portal pages, all in parallel once codegen is done:
T052 lookup/verify   T053 card   T054 members   T055 member detail
T056 edit/create     T057 badge/policy/dashboard   T058 change requests   T059 alerts
```

## Parallel Example: User Story 6

```text
T096 pricing.test.ts   T097 billing.test.ts   T098 billingPerf.test.ts   # tests together
T099 014_billing_triggers.sql   T100 billing/pricing.ts                   # together
T101 asOf.ts → T102 runs.ts → T103 openapi → T104 adminBilling.ts → T105 dashboard
T106 admin-billing.tsx   T107 admin-billing-run.tsx                       # together
```

---

## Implementation Strategy

### MVP (User Story 1)

1. Phase 1 and Phase 2: the BHI structure, platform tables, RLS, roles, and the scope helper.
2. Phase 3: prove the structure (SC-001), fail-closed segregation, and no delete path.
3. **Stop and validate** with quickstart §1 and §9. This shows the client's 18-table model running in the shared database, before any feature moves onto it.

### Incremental delivery

| Step | Delivers | Validates |
|---|---|---|
| 1 | Setup + Foundational + US1 | the structure in place (MVP) |
| 2 | US2 | admin screens and the card lookup running on BHI data, within scope (quickstart §2, §4) |
| 3 | US3 | NALICO can onboard Sterling (quickstart §3) |
| 4 | US4 | rehearse, then cut over production (quickstart §7, §8, runbook T087) |
| 5 | US5 | classes and the rate card, loaded with the client's real rates (T094) |
| 6 | US6 | the first monthly bill (quickstart §6) |
| 7 | Polish | the security and data protection reviews (T113), then release |

### Suggested team split after Phase 2

| Developer | Stories |
|---|---|
| A | US2 API (`admin.ts` track), then US4 |
| B | US2 employee flow (`employee.ts`), then US3 |
| C | US1 tests, then US5, then US6 |
| D | Portal pages for each story, after its codegen task |

---

## Notes

- Constraints from the spec and constitution that apply to every task:
  - Do not add a DELETE path anywhere.
  - Deactivate, supersede or archive instead.
  - Log no personal data (Principle VII).
  - Keep the pre-verification lookup uniform (Principle I).
- If an integration test passes while connected as `postgres`, it proves nothing. The harness (T006) refuses that connection.
- Mark each task `[X]` when done, and commit after each task or logical group.
