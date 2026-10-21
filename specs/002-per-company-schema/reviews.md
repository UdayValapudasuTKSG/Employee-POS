# Review pack: BHI Enrollment Database model (spec 002)

This pack is for the security review and the data protection review that the constitution's release-readiness gate requires. For each point it gives:
- the control;
- where the control is implemented;
- the test that evidences it;
- anything left open.

Paths are relative to the repository root. The integration tests run against PostgreSQL as the application role `bhi_app`. They fail on purpose if pointed at a superuser (`artifacts/api-server/src/integration/testDb.ts`, `useAppRoleGuard`).

Evidence run on 2026-09-29, against disposable PostgreSQL 16:
- integration suites all pass;
- unit suites all pass;
- the workspace typecheck is clean.

See "Test evidence" at the end.

---

## Part A: Security review

### A1. Company segregation in one shared schema (row-level security)

| | |
|---|---|
| Control | All companies share the 18 `bhi` tables. Row-level security is enabled **and forced** on every one, so the owner is subject to it too. Each transaction's scope comes from transaction-local settings (`bhi.all`, `bhi.companies`, `bhi.readonly`) set by `withScope`. A query run outside `withScope` sees no rows at all: the design fails closed. |
| Implementation | `deploy/db/schema.sql` (policies, and the functions `bhi_scope_has`, `bhi_can_write`, `bhi_can_write_all`); `lib/db/src/scope.ts` (`withScope`, which refuses company numbers containing commas); `artifacts/api-server/src/middlewares/adminAuth.ts` (`resolveScope`) |
| Import tables | The 10 BHI import tables have no company column and were kept exactly as the client supplied them. They reach a company through `public.import_batch`, via `source_file` or `source_ordinal`, or through `import_batch_record`. |
| Evidence | `src/integration/rlsDefaultDeny.test.ts` (no scope means no rows, on every company table); `segregation.test.ts` (through the API: HR at one company gets 404 for another's members, change requests, audit and verifications); `importExceptions.test.ts` (fix list 404 across companies); `billing.test.ts` (a client admin sees only its own runs, and 404 on another company's run) |
| Open | Scope is resolved from the database on every request, so a scope change takes effect on the next request. There is no caching to invalidate. |

### A2. The database role the API runs as

| | |
|---|---|
| Control | The API connects as `bhi_app`: NOSUPERUSER and NOBYPASSRLS, with no DELETE on `bhi`, and INSERT/SELECT only on `activity_log`. At start-up the API checks its own role and **refuses to start in production** if the role is a superuser or has BYPASSRLS. Only the schema load and migrations use the owner, `bhi_user`. |
| Implementation | `deploy/db/migrations/001_roles_grants.sql`; `lib/db/src/db.ts` (`checkAppRole`); `artifacts/api-server/src/index.ts` |
| Evidence | `src/integration/grants.test.ts` (DELETE refused; audit rows cannot be updated) |
| Open | **Deployment action**: every environment's `DATABASE_URL` must be switched to `bhi_app` (see `deploy/README.md`, step 1). Otherwise the API will not start in production. |

### A3. Roles, scopes and cross-scope answers

| | |
|---|---|
| Control | **Roles:** super admin (all companies), group admin (its client group), client admin and HR administrator (one company), support and auditor (all companies, read-only). A CHECK constraint ties each role to the right scope column. **Answers:** a cross-scope read answers 404, a missing permission 403 (audited as ACCESS_DENIED), and a read-only scope 403 on writes. |
| Implementation | `artifacts/api-server/src/lib/rbac.ts`; `middlewares/adminAuth.ts`; `lib/adminScope.ts` (`inScope`, `writable`); `deploy/db/schema.sql` (`admin_users_scope_by_role_check`) and `deploy/db/migrations/001_roles_grants.sql` (grants) |
| Evidence | `src/lib/rbac.test.ts`; `segregation.test.ts`; `classesRates.test.ts` (company users get 403 on class and rate writes); `artifacts/api-server/scripts/rbac-test.mjs` (end-to-end matrix against a demo stack) |

### A4. User management and escalation

| | |
|---|---|
| Control | Onboarding creates a company and its one client admin in a single transaction, with a temporary password and a forced change. **Grants:** a client admin can create only HR or client admins for its own company, and a group admin only within its group. Only super admins grant the all-companies roles. **Safeguards:** refusing to remove the last super admin (409) and a company's last client admin (409), and the codes SCOPE_REQUIRED, SCOPE_NOT_ALLOWED, ROLE_NOT_GRANTABLE, UNKNOWN_COMPANY and UNKNOWN_GROUP. Offboarding a company deactivates its admins. |
| Implementation | `src/routes/admin.ts` (users: `userInScope`, `checkGrant`); `src/routes/adminCompanies.ts`; `src/routes/adminGroups.ts`; `src/lib/lastAdmin.ts`; `src/lib/adminUserUpdate.ts` |
| Evidence | `userManagement.test.ts`, `adminUserUpdate.test.ts`, `onboarding.test.ts`, `src/lib/lastAdmin.test.ts` |

### A5. Employee card lookup: what it discloses (`/v1/lookup`, `/v1/otp/verify`, `/v1/otp/select`)

| | |
|---|---|
| Control | **Lookup:** `/v1/lookup` always answers `200 CODE_SENT`, whether nothing, one person or several people match. It has a minimum response time (`LOOKUP_MIN_MS`, 800 ms), and the code is sent after the response, so timing does not reveal a match. An unknown contact gets a decoy session that can never verify. **After a correct code:** the answer is the card; or SELECT, to choose between the verified contact's own members in one company; or MULTI_COMPANY. MULTI_COMPANY says "found in more than one company, ask your HR", names no company, and raises a lookup alert. OTP codes and card tokens are stored only as sha256 hashes. |
| Implementation | `src/routes/employee.ts`; `specs/002-per-company-schema/contracts/employee-lookup.md` |
| Evidence | `src/integration/lookup.test.ts`, which includes a timing check run with `LOOKUP_TIMING=1` |
| Open | The lookup reads all companies in a read-only scope, because an employee has no company yet. Any code path added there must stay read-only. A code that cannot be delivered leaves its session pending until it expires. That session is unusable, because nobody holds the code: it was never delivered and only its hash is stored. The failure is logged in `bhi.activity_log` (kind `EVENT`, `OTP_DELIVERY`, `FAILED`). `contracts/employee-lookup.md` says such failures are shown on the admin verifications screen, but **that is not built yet**: the verifications list has no delivery field. |

### A6. Lookup alerts

| | |
|---|---|
| Control | An alert stores the **masked** contact and the matched members' company and member IDs. The raw email or phone is never stored. Super admins see alerts, and so do group admins for their own companies; companies outside a group admin's scope appear as "another company". Only super admins resolve alerts, with a required note. |
| Implementation | `lib/db/src/schema/lookupAlerts.ts`; `src/routes/adminLookupAlerts.ts` |
| Evidence | `lookup.test.ts` (alert raised on MULTI_COMPANY) |

### A7. Uniqueness of a person across the platform

| | |
|---|---|
| Control | `(IDType, IDNumber)` is unique platform-wide. When company X tries to add an ID held by company Y, it gets `409 ID_ALREADY_REGISTERED` ("contact NALICO"), which never names company Y. Bulk import refuses such a row with the same message. It checks whether the ID exists with an all-companies **read-only** query that returns only that fact, which the unique constraint would reveal anyway. |
| Implementation | `deploy/db/schema.sql` (`member_id_type_id_number_uq`); `src/lib/bhiErrors.ts`; `src/routes/adminImport.ts` |
| Evidence | `memberUniqueness.test.ts`; `importExceptions.test.ts` ("refuses an ID registered to another company without saying whose") |

### A8. Bulk import

| | |
|---|---|
| Control | **Input:** carrier layouts only; the 8-column layout gives `400 LAYOUT_WITHDRAWN`. Each row's company must be in scope, and an import never creates companies. **Commit:** one transaction per company, so a failed write leaves that company as it was. **Held rows:** rows that fail validation are held under the upload's batch. **Logging:** a failed commit logs only the company and error code, because the failed statement's parameters contain personal data. |
| Implementation | `src/routes/adminImport.ts`; `src/lib/importBatch.ts`; `src/lib/memberImport.ts` |
| Evidence | `importExceptions.test.ts` (holding, fix and restore, rollback, scope, withdrawn layout); `src/lib/memberImport.test.ts` (133 mapping and validation cases) |

### A9. Frozen bills and rates (triggers)

| | |
|---|---|
| Control | The database rejects UPDATE and DELETE on a FINAL `billing_run` and its lines. It also rejects changes to the priced columns of any `premium_rates` row that a FINAL line used; `active` and `notes` can still change. The errors carry SQLSTATE `BHF01`, which the API reports as `409 BILL_FINAL`. Rates and billing are written only in the all-companies scope. Run generation takes an advisory lock per company and month. |
| Implementation | `deploy/db/schema.sql`; `src/lib/billing/runs.ts`; the `premium_rates`, `billing_run` and `billing_line` policies in `deploy/db/schema.sql` |
| Evidence | `billing.test.ts` ("a finalised run is frozen, and so are the rates it used") |

### A10. No pre-BHI tables remain

| | |
|---|---|
| Control | The data was moved into `bhi` once, on 2026-09-29, and the old member tables (`companies`, `employee_members`, `dependents`, `beneficiaries`), their uuid links from the platform tables and the migration's key map were then dropped. A new database is created from `deploy/db/schema.sql`, which has none of them. |
| Implementation | `deploy/db/schema.sql`; `deploy/db/migrations/003_drop_legacy_tables.sql` (drops them from databases created before) |
| Evidence | `src/integration/grants.test.ts` ("has no pre-BHI member tables left anywhere") |

### A11. Logging

| | |
|---|---|
| Control | **Central handler:** logs the SQL but not its parameters, and drops query strings from URLs. **Other paths:** background jobs and CLIs use `errorSummary`, which keeps only the database's message and SQLSTATE. **Always redacted:** authorization headers and cookies. |
| Implementation | `src/middlewares/errorHandler.ts` (`forLogging`); `src/lib/bhiErrors.ts` (`errorSummary`); `src/lib/logger.ts` |
| Evidence | `src/lib/bhiErrors.test.ts` ("keeps the database message and code, never the query's parameters") |
| Open | Reviewers may want to go through `logger.info` calls for personal data. The retirement sweep, for example, logs company and member **IDs** (not names) of the members it deactivated. |

---

## Part B: Data protection review

### B1. Fields dropped and added

The full column mapping, including every dropped field, is in `data-model.md`, "Legacy to BHI column mapping".

- **Dropped:**
  - `employee_number` (kept only inside exception snapshots, so HR can recognise a held member);
  - `employment_status`;
  - the separate `member_status`;
  - the archive and removal columns, which were folded into InactiveDate and InactiveReason.

  The old tables were then deleted; the pre-migration data exists only in the backups taken on 2026-09-29 (see B6).
- **Added:**
  - BHI's own fields: Sex, Occupation, RateOfPay, EmploymentDate and PlanDate on members; SharePercent on beneficiaries;
  - the class history (`public.member_class_history`);
  - the status history (`bhi.enrollment_status_history`), with person name and identifier at the time of each change;
  - billing lines (below).

### B2. Where exception snapshots hold personal data

- A held record's `bhi.import_exception.raw_row_summary` holds a JSON snapshot of the member and the dependants and beneficiaries held with them, so they can be restored when HR fixes the record:
  - names, ID numbers, dates of birth and contact details;
  - for the migration, also the employee number.
- **Access:** the fix-list API (`GET /v1/admin/companies/{c}/import-exceptions`) never returns the snapshot, only person, identifier, reasons and required action. In the database, the row is visible only in its company's scope, through its batch. Resolved exceptions keep their snapshot.
- **Open:** decide a retention period for resolved exceptions, and for exceptions that are never resolved.

### B3. Lookup alerts

- Only the masked contact is stored, plus company and member IDs. See A6.

### B4. Billing lines and export

- Each `bhi.billing_line` carries:
  - the member's ID type and number;
  - the member's name, as the BHI model defines it;
  - class, dependant count and the premiums.
- The CSV export has the same columns and no contact details. Cells beginning with `=`, `+`, `-` or `@` are neutralised against formula injection.
- Access: anyone with BILLING_READ, in scope. That is super admins, group admins, client admins and auditors, but not HR administrators.
- **Open:** confirm with the client that client admins should see the per-member lines, and not only the totals.

### B5. New policyholders beyond Beharry

- The production roster (`deploy/db/companies.sql`) includes GAM and GBTI, which are not Beharry companies.
- The migration puts only companies whose name starts with "Beharry" into the Beharry client group. It lists the companies it left out so the operator can confirm them. Beharry's group admin therefore cannot see the other clients' members.
- Each new client is onboarded with its own client admin.

### B6. Retention of the pre-migration backups

- The old tables are gone from every database. The pre-migration data survives only in the `pg_dump` backups taken before the move and before the drop.
- **Open:** how long to keep those backups, and where. This is a data-owner decision.

### B7. Synthetic data only in tests

- The integration tests use synthetic fixtures only (FR-048).

---

## Test evidence

| Suite | Result | Notes |
|---|---|---|
| Unit (`pnpm --filter @workspace/api-server test`, `src/lib`) | pass | See T115 in tasks.md for the final counts |
| Integration (`test:integration`, as `bhi_app`) | pass | Includes the segregation, RLS, grants, lookup, onboarding, user management, import exceptions, classes and rates, billing and sweep suites |
| `LOOKUP_TIMING=1` | pass | Lookup timing floor |
| `BILLING_PERF=1` | pass | 5,000 members across 6 companies in about 16 s (target: under 5 minutes) |
| `TEST_CLASS_EXHAUSTION=1` | pass | 37th class code refused; run on a disposable database |
| Workspace typecheck | pass | |
