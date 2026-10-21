# Contract: Admin API Changes

All changes go into `lib/api-spec/openapi.yaml`. Then `pnpm --filter @workspace/api-spec codegen` regenerates the zod schemas (server) and react-query hooks (portal). This file lists what changes; once the OpenAPI file is edited, it is the source of truth.

## Common rules

- Every route keeps `requireAdmin` and `requirePermission`, and runs its database work in the caller's scope (research R4):

| Role | Label | Scope |
|---|---|---|
| ROLE_PLATFORM_ADMIN | Super admin | All companies, read and write |
| ROLE_CLIENT_ADMIN | Client admin | Own company |
| ROLE_HR_ADMIN | HR administrator | Own company |
| ROLE_SUPPORT, ROLE_AUDITOR | Support, Auditor | All companies, read-only |

- A company or record outside the caller's scope returns the **same** `404 NOT_FOUND` body as one that does not exist.
- A write to an inactive company returns `409 COMPANY_INACTIVE`. Only in-scope callers ever see this.
- Record IDs are the BHI integers (`memberId`, `dependentId`, `beneficiaryId`). Paths carry the company, `/v1/admin/companies/{companyNumber}/…`, and the server checks it against the scope before reading.

## Companies and onboarding

| Method and path | Permission | Notes |
|---|---|---|
| `GET /v1/admin/companies` | any admin | Companies in scope: `companyNumber`, `companyName`, `active`, `group`, `activeMembers`, `inactiveMembers` |
| `POST /v1/admin/companies` | PLATFORM_MANAGE (super admin) | Onboard `{companyNumber, companyName, address1?, address2?, city?, contactName?, contactPhone?, contactEmail?, groupId?, clientAdmin: {email, displayName}, reason}`. Returns `201` with the company and the client admin (temporary password shown once). `409 COMPANY_EXISTS` for a duplicate number. `400` if a value is too long. All-or-nothing (FR-017). |
| `PATCH /v1/admin/companies/{companyNumber}` | super admin; client admin for contact fields | Company profile fields |
| `POST /v1/admin/companies/{companyNumber}/offboard` | super admin | `{reason}` sets `active=false` and deactivates the company's users (FR-019) |
| `POST /v1/admin/companies/{companyNumber}/reactivate` | super admin | `{reason}` |

## Client groups (removed 2026-09-29)

The `/v1/admin/groups` routes, the group admin role and `groupScope` were removed: the super admin is the only role above one company (spec FR-013). The routes now answer `404`, and `ROLE_HR_GROUP_ADMIN` is refused as `400 INVALID_INPUT`.

## Admin users (changed)

| Method and path | Who | Rules |
|---|---|---|
| `GET /v1/admin/users` | super, client admin | Users in the caller's scope only |
| `POST /v1/admin/users` | super, client admin | A client admin may create only `ROLE_CLIENT_ADMIN` or `ROLE_HR_ADMIN` with `companyScope` equal to its own company. Anything else returns `403 ROLE_NOT_GRANTABLE`. A scope missing or present for the wrong role returns `400 SCOPE_REQUIRED` or `SCOPE_NOT_ALLOWED`. |
| `PATCH /v1/admin/users/{id}` | same | The same limits. Deactivating or demoting the last active client admin of a company returns `409 LAST_CLIENT_ADMIN`; the last super admin returns `409 LAST_SUPER_ADMIN` (extends `lib/lastAdmin.ts`). |

## Members (changed)

| Before | After |
|---|---|
| `GET /v1/admin/members?company=&status=&employmentStatus=&q=` | `GET /v1/admin/members?company=&active=&classCode=&q=`. Results cover the scope; each row has `companyNumber`. `q` matches names, ID number, email and phone. |
| `POST /v1/admin/members` | `POST /v1/admin/companies/{companyNumber}/members`. A duplicate ID anywhere on the platform returns `409 ID_ALREADY_REGISTERED`: "This ID is already registered on the platform. Contact NALICO." (FR-007) |
| `GET`/`PATCH /v1/admin/members/{id}` | `GET`/`PATCH /v1/admin/companies/{companyNumber}/members/{memberId}` |
| `POST .../members/{id}/remove` | `POST .../members/{memberId}/deactivate {reason}` sets `active=false` |
| `POST .../members/{id}/reactivate` | `POST .../members/{memberId}/reactivate {reason}` |
| `POST .../members/{id}/policy` | `POST .../companies/{companyNumber}/members/{memberId}/policy` |
| Dependents and beneficiaries under `/members/{id}/…` | The same sub-paths under `.../companies/{companyNumber}/members/{memberId}/…`, with integer IDs. Dependents and beneficiaries also get `deactivate` and `reactivate`. |

**Member body** (`MemberSummary`, `MemberDetail`, `MemberCreate`, `MemberUpdate`):

| Group | Fields |
|---|---|
| Identity | `memberId`, `companyNumber`, `idType`, `idNumber`, `firstName`, `lastName`, `middleInitials`, `dateOfBirth`, `sex` |
| Class | `classCode`, `className` |
| Contact | `addressLine1`, `addressLine2`, `phone`, `email` |
| Employment | `employmentDate`, `planDate`, `rateOfPay`, `occupation` |
| Status | `active`, `inactiveDate`, `inactiveReason`, `notes` |
| Billing tier | `activeDependentCount`, `currentTier` (the tier that will be billed next month) |
| Flag | `sharedContactAlert: boolean` |

- **Removed fields**: `employeeNumber`, `identificationId` (now `idNumber`), `employmentStatus`, `memberStatus`, `archivedAt`, `archivedReason`, `removedAt`, `removedReason`.
- `MemberUpdate` cannot change `active`. Only deactivate and reactivate can, so every change has a reason and history.
- A `classCode` change writes `member_class_history`.
- **Dependent body**: `dependentId`, `fullName`, `relationship`, `dateOfBirth`, `idType`, `idNumber`, `sex`, `active`, `inactiveDate`, `inactiveReason`, `notes`.
- **Beneficiary body**: `beneficiaryId`, `fullName`, `relationship`, `dateOfBirth`, `idType`, `idNumber`, `sex`, `phone`, `email`, `sharePercent`, `active`, `inactiveDate`, `inactiveReason`, `notes`.

## Classes (new)

| Method and path | Permission | Notes |
|---|---|---|
| `GET /v1/admin/classes?includeRetired=` | any admin | Shared list with `rateComplete` (all four standard tiers active) |
| `POST /v1/admin/classes` | CLASS_MANAGE | `{classCode, className, description?, sortOrder?, reason}`. `409 CLASS_EXISTS` names the existing class. `409 CLASS_CODES_EXHAUSTED` when all 36 codes are in use. The class is not assignable until its rates are complete. |
| `PATCH /v1/admin/classes/{classCode}` | CLASS_MANAGE | `{className?, description?, sortOrder?, active?, reason}`. `active:false` retires the class; there is no delete. |

## Rates (new)

| Method and path | Permission | Notes |
|---|---|---|
| `GET /v1/admin/rates?company=&asOf=` | RATE_MANAGE (all), or any admin for their company | The rate set in force for the company on `asOf`, showing the source (`STANDARD` or `COMPANY`) per tier. Without `company`, standard rates only. |
| `GET /v1/admin/rates/history?classCode=&company=` | RATE_MANAGE | Every rate row, oldest first |
| `POST /v1/admin/rates` | RATE_MANAGE | `{companyNumber?: null \| "BF", classCode, effectiveDate, tiers: [{dependentBand:0..3, totalPremium, companyPremium, employeePremium}] ×4, notes?, reason}`. Exactly four tiers are required. `companyPremium + employeePremium = totalPremium`. The same key already present returns `409 RATE_EXISTS`. `coverageBand` and `coverageLabel` are filled from the fixed band table. |
| `PATCH /v1/admin/rates/{premiumRateId}` | RATE_MANAGE | `{active?, notes?, reason}` only. Amounts are never edited (FR-025). |
| `GET`/`POST /v1/admin/companies/{companyNumber}/billing-rules` | RATE_MANAGE; readable by BILLING_READ | CompanyBillingRule rows `{companySharePercent, employeeSharePercent, effectiveDate, active, notes?}`. The two shares must total 100. |

## Billing (new)

| Method and path | Permission | Notes |
|---|---|---|
| `POST /v1/admin/billing/runs` | BILLING_MANAGE | `{month: "2026-10", companies: "ALL" \| string[]}`. For each company, it creates or recalculates the DRAFT run for that month (the previous draft becomes SUPERSEDED). It returns per company: `runId`, `status`, `lines`, `totals`, `issues`. A company whose month is already FINAL returns `ALREADY_FINAL`. |
| `GET /v1/admin/billing/runs?company=&month=&status=` | BILLING_READ | In scope. SUPERSEDED runs are hidden unless `status=SUPERSEDED`. |
| `GET /v1/admin/billing/runs/{runId}` | BILLING_READ | Header, totals per class and tier (headcount × rate, as in the client's current Access process), and lines |
| `GET /v1/admin/billing/runs/{runId}/export.csv` | BILLING_READ | One row per line |
| `POST /v1/admin/billing/runs/{runId}/finalise` | BILLING_MANAGE | `{reason}`. Returns `409 RUN_HAS_ISSUES` while any member is unpriced, `409 RUN_NOT_DRAFT` otherwise if not a draft. |

**Line fields**: `memberId`, `idType`, `idNumber`, `memberName`, `classCode`, `activeDependentCount`, `coverageBand`, `coverageLabel`, `totalPremium`, `companyPremium`, `employeePremium`, `rateEffectiveDate`, `premiumRateId`, `rateSource`.

## Import (changed)

- `POST /v1/admin/import` accepts only the carrier layouts: members (22 columns), dependants and beneficiaries. The legacy 8-column layout returns `400 LAYOUT_WITHDRAWN`.
- Each row's Company Number must be in scope.
- Rows missing a BHI-required value, or with a value too long, show as `ERROR` in the dry run with the field and reason. On commit they are written to `bhi.import_exception` under the upload's `import_batch` and are not loaded (FR-042).
- Members are matched by `(idType, idNumber)`, and a match in another company returns `ID_ALREADY_REGISTERED`. A row that fixes an open exception resolves it and restores the held dependents and beneficiaries (FR-041). The response lists `resolvedExceptions`.
- The commit is one transaction per company.

| New route | Notes |
|---|---|
| `GET /v1/admin/companies/{companyNumber}/import-exceptions?status=OPEN\|RESOLVED` | HR's fix list: person, identifier, reason codes, required action, source. The raw snapshot is **not** returned. |

## Lookup alerts (new)

| Method and path | Permission | Notes |
|---|---|---|
| `GET /v1/admin/lookup-alerts?status=` | super admin | Masked contact, the matched companies and members, and when the alert was raised |
| `POST /v1/admin/lookup-alerts/{id}/resolve` | super admin | `{note}` required |

## Dashboard, change requests, audit, verifications (changed)

- **Dashboard**: counts across the scope. `suspendedMembers`, `archivedMembers` and `removedMembers` are replaced by `inactiveMembers`. New figures:
  - `openImportExceptions`;
  - `openLookupAlerts` (super admin only);
  - `draftBillingRuns` and `unpricedMembers` (BILLING_READ).
- **Change requests**: members are addressed as `{companyNumber, memberId}`, and `employeeNumber` is removed. Approval writes to `bhi.member` or `bhi.dependent`.
- **Audit and verifications**: filtered by the companies in scope (`company_code` in the scope list).
