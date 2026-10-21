# Data Model: Multi-Company BHI Enrollment and Monthly Billing

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Research**: [research.md](research.md)

One database, three schemas:

| Schema | Contents | `bhi_app` rights |
|---|---|---|
| `bhi` | The 18 BHI tables, shared by every company. Exact DDL: [contracts/bhi-schema.sql](contracts/bhi-schema.sql). | SELECT, INSERT, UPDATE. No DELETE. Row-level security forced (research R4). |
| `public` | Platform tables: existing ones plus the new ones below | As today, except `audit_logs` is INSERT/SELECT only |
| `legacy` | The four retired tables, after sign-off | SELECT only |

---

## BHI tables (`bhi`)

The column-level definition is the contract. A script checked it against spec Key Entities: 18 tables, 224 columns (223 from the Access file plus D1), 8 relationships (R1–R8), 0 differences.

### Company ownership and visibility (row-level security)

| Table | Belongs to | Company-scoped users see |
|---|---|---|
| company | itself | their own company row |
| member | `company_number` | their company's members |
| dependent, beneficiary | the member they belong to | dependents and beneficiaries of their company's members |
| class | shared | every class |
| premium_rates | `company_number`; blank = standard | standard rates plus their own company's rates |
| billing_run, billing_line | `company_number` | their company's runs and lines, if the role holds BILLING_READ |
| company_billing_rule | `company_number` | their company's rules |
| enrollment_status_history | `company_number`, else via `member_id` | their company's rows |
| source_workbook_archive, source_workbook_sheet, raw_enrollment_row, raw_enrollment_cell | `source_ordinal` → `public.import_batch` | their company's imports |
| import_exception, import_adjustment | `source_file` → `public.import_batch` | their company's imports |
| import_reconciliation, import_documentation | row ID → `public.import_batch_record` | their company's imports |

Only a scope with `bhi.all = on` can write `class` rows and standard `premium_rates` rows. The permission checks give that scope to super admins only.

### Rules the application adds

| Table | Rule | Requirement |
|---|---|---|
| member | `(id_type, id_number)` is unique across the platform. A duplicate returns `409 ID_ALREADY_REGISTERED` without naming the other company. | FR-007 |
| member | `class_code` must be an active class with active standard rates for all four tiers when set or changed. An existing retired class may stay. | FR-021, FR-022 |
| member | `active = false` requires `inactive_date` and a non-empty `inactive_reason` | FR-038, FR-047 |
| member | `company_number` must be an active company in the caller's scope | FR-010, FR-019 |
| member | Every create and class change writes `public.member_class_history` | research R11 |
| member, dependent, beneficiary | Every change of `active` writes one `enrollment_status_history` row (with `changed_at`) and one audit entry | FR-047, research R11 |
| dependent | `relationship` is one of the current values (SPOUSE, CHILD, FATHER, MOTHER, BROTHER, SISTER, OTHER). All count the same for billing. | FR-023 |
| class | `class_code` is one character `[A-Z0-9]`, upper-cased | FR-021 |
| premium_rates | Created as a set of 4 tiers per class, and per company when company-specific. Band values are fixed: 0 `EE` "Employee only", 1 `EE+1` "Employee +1", 2 `EE+2` "Employee +2", 3 `EE+3+` "Employee + more than two". | FR-022 |
| premium_rates | `total_premium = company_premium + employee_premium` | FR-032 |
| premium_rates | Amount, key and date columns are frozen once a FINAL billing line uses the row (trigger) | FR-025 |
| company_billing_rule | `company_share_percent + employee_share_percent = 100` | FR-032 |
| billing_run | `status` is DRAFT, FINAL or SUPERSEDED. At most one non-superseded run per company and month. `billing_month` is the 1st of the month. | FR-028, FR-034 |
| billing_run, billing_line | No update once the run is FINAL (trigger) | FR-034 |
| beneficiary | Active `share_percent` values for a member should total 100. This is a warning, not a block (existing import rule). | existing |

### State transitions

**Member, dependent and beneficiary**

```text
          deactivate (reason required) / age-65 sweep ("Aged out at 65")
 active ─────────────────────────────────────────────────────────────► inactive
  = true ◄───────────────────────────────────────────────────────────  = false
                         reactivate (reason required)
```

- Every transition writes `enrollment_status_history` and `audit_logs`.
- A member moving to inactive also revokes their card sessions.
- For billing, a change counts from its `changed_at` (R11).

**Billing run**

```text
 generate ──► DRAFT ──finalise (no issues)──► FINAL (frozen)
               │
               └──recalculate──► SUPERSEDED   (+ a new DRAFT)
```

**Class**: `active` ⇄ `retired`. Retiring and reactivating need a reason. A class is never deleted.

**Company**: `active` → `inactive` (offboarded). Offboarding is a super admin action. The data is kept, and writes are refused.

---

## Platform tables (`public`)

### New

**client_groups** *(removed 2026-09-29 with the group admin role; see spec FR-013. Migration 004 drops the table and `admin_users.group_scope`.)*

| Column | Type | Rules |
|---|---|---|
| id | uuid PK | |
| name | text not null unique | e.g. "Beharry" |
| active | boolean not null default true | |
| created_at, updated_at | timestamptz | |

**client_group_companies**

| Column | Type | Rules |
|---|---|---|
| group_id | uuid → client_groups | |
| company_number | varchar(20) unique → bhi.company | A company is in at most one group |

**import_batch** (FR-009)

| Column | Type | Rules |
|---|---|---|
| id | uuid PK | |
| company_number | varchar(20) not null → bhi.company | |
| kind | text: `BULK_IMPORT`, `LEGACY_MIGRATION` | |
| source_ordinal | integer not null unique | Issued by a platform sequence and written to the workbook, sheet and raw tables |
| source_file | varchar(255) not null unique | System-generated, e.g. `BF-20261001-0007.xlsx`, and written to the exception and adjustment tables. The uploaded file's own name is kept in `original_file_name`. |
| original_file_name | text | |
| created_by | text not null | Admin email, or `SYSTEM` |
| created_at | timestamptz | |

**import_batch_record** (links rows that have neither ordinal nor file)

| Column | Type | Rules |
|---|---|---|
| batch_id | uuid → import_batch | |
| table_name | text: `import_reconciliation`, `import_documentation` | |
| record_id | integer | PK is (table_name, record_id) |

**import_exception_resolutions** (FR-041)

| Column | Type | Rules |
|---|---|---|
| exception_id | integer PK → bhi.import_exception | |
| resolved_at | timestamptz not null | |
| resolved_by | text not null | |
| member_id | integer → bhi.member | The member the fix loaded |

**member_class_history** (billing as at the start of the month, research R11)

| Column | Type | Rules |
|---|---|---|
| id | bigint identity PK | |
| member_id | integer not null → bhi.member | |
| class_code | varchar(1) not null → bhi.class | |
| recorded_at | timestamptz not null | Index (member_id, recorded_at) |
| recorded_by | text not null | |

**billing_run_issues** (FR-034)

| Column | Type | Rules |
|---|---|---|
| billing_run_id | integer → bhi.billing_run | |
| member_id | integer → bhi.member | |
| reason | text: `NO_RATE`, `CLASS_RETIRED_NO_RATE` | PK is (billing_run_id, member_id) |

**lookup_alerts** (FR-016)

| Column | Type | Rules |
|---|---|---|
| id | uuid PK | |
| lookup_channel | text: `EMAIL`, `PHONE` | |
| masked_contact | text not null | Masked with the existing `maskIdentifier`. The full contact is never stored. |
| matches | jsonb not null | `[{companyNumber, memberId}]`, from two or more companies |
| verification_session_id | uuid not null | |
| status | text: `OPEN`, `RESOLVED` | |
| resolved_by, resolution_note, resolved_at | | Required when RESOLVED |
| created_at | timestamptz | |

Visibility: super admins see all of it. Client admins and HR see only a flag on their own member. (Group admins, who saw their group's alerts, were removed on 2026-09-29.)

**legacy_key_map** (FR-043)

| Column | Type | Rules |
|---|---|---|
| legacy_uuid | uuid PK | Old `employee_members.id`, `dependents.id` or `beneficiaries.id` |
| entity_type | text: `MEMBER`, `DEPENDENT`, `BENEFICIARY` | |
| new_id | integer | Null while the record is held as an exception |
| exception_id | integer → bhi.import_exception | Set while held |

### Changed

| Table | Change | Removed at sign-off |
|---|---|---|
| admin_users | The role enum gains `ROLE_CLIENT_ADMIN`. Checks: HR and client admin require `company_scope`; the others have none; `role` is one of the five roles below. (`group_scope` was added here and removed on 2026-09-29.) | none |
| card_sessions | `member_ref integer → bhi.member` | `member_id uuid` FK |
| change_requests | `member_ref → bhi.member`, `dependent_ref → bhi.dependent` | `member_id`, `dependent_id` FKs |
| policy_memberships | `member_ref → bhi.member` | `member_id` FK |
| verification_sessions | `matched_members jsonb not null default '[]'` | `member_id`, `company_code` |
| audit_logs | Grants only: `bhi_app` INSERT/SELECT. Rows are never rewritten. | none |

### Retired (moved to `legacy` at sign-off)

`companies`, `employee_members`, `dependents`, `beneficiaries`.

---

## Roles and scopes

| Role (stored) | Label | Scope | Reach | Can manage users |
|---|---|---|---|---|
| ROLE_PLATFORM_ADMIN | Super admin | none | All companies, read and write | Anyone. At least one super admin must remain active. |
| ROLE_CLIENT_ADMIN | Client admin | company_scope | Own company | Client admin and HR users in own company. At least one active client admin per company. |
| ROLE_HR_ADMIN | HR administrator | company_scope | Own company | None |
| ROLE_SUPPORT | Support | none | All companies, read-only | None |
| ROLE_AUDITOR | Auditor | none | All companies, read-only | None |

New permissions: `CLASS_MANAGE`, `RATE_MANAGE` and `BILLING_MANAGE` (super admin only), and `BILLING_READ` (super admin, client admin, auditor). `ADMIN_USER_MANAGE` is added to client admin, and is always scope-checked.

---

## Legacy to BHI column mapping

This is the documented mapping FR-037 requires. Every dropped field is listed, so the loss can be signed off (FR-039).

### companies → bhi.company (plus import_batch)

| Legacy | BHI | Notes |
|---|---|---|
| code | company_number | Over 20 characters: the migration stops, because the company key is invalid |
| name | company_name | Over 120 characters: the migration stops |
| active | active | |
| created_at, updated_at | created_at, updated_at | |
| id | none | Mapped only while members are moved |
| none | address1, address2, city, contact_*, notes | Null. Filled in later. |

The six current companies were placed in client group "Beharry"; migration 004 removes client groups again (2026-09-29).

### employee_members → bhi.member

| Legacy | BHI | Notes |
|---|---|---|
| id | legacy_key_map.legacy_uuid → member.member_id | New integer ID |
| id_type | id_type | **Required.** Null: `MISSING_ID_TYPE` |
| identification_id | id_number | Over 40 characters: `VALUE_TOO_LONG` |
| company_id → companies.code | company_number | |
| last_name, first_name | last_name, first_name | Over 80 characters: `VALUE_TOO_LONG` |
| middle_initials, sex | same | Sizes 20 and 10 |
| date_of_birth | date_of_birth | |
| class_code | class_code | **Required.** Null: `MISSING_CLASS`. Not in the class list: `UNKNOWN_CLASS`. |
| address_line1/2 | same | Over 150 characters: `VALUE_TOO_LONG` |
| phone, email | same | Sizes 50 and 100 |
| employment_date, plan_date, occupation | same | |
| rate_of_pay numeric(12,2) | rate_of_pay numeric(15,2) | Widening; always fits |
| member_status | active | ACTIVE → true; SUSPENDED, REMOVED, ARCHIVED → false (FR-038) |
| removed_at / archived_at / audit date of suspension | inactive_date | FR-038 table |
| removed_reason / archived_reason | inactive_reason | Prefixed as in FR-038 |
| active, inactive_date, inactive_reason (the imported file's values) | notes (appended) | Only when they disagree with `member_status` (research R16) |
| notes, created_at, updated_at | same | `created_at` is kept, because billing uses it (R11) |
| none | member_class_history | One row: `class_code` at `created_at`, by `LEGACY_MIGRATION` |
| none | enrollment_status_history | One row for each inactive member: old true, new false, `changed_at` = `inactive_date` at 00:00 Guyana time |
| employee_number | **dropped** | Kept only in exception snapshots, so HR can recognise a held member |
| employment_status | **dropped** | |
| archived_at, archived_reason, removed_at, removed_reason | **dropped** after being folded into inactive_date and inactive_reason | |

A duplicate `(id_type, id_number)` **anywhere on the platform** holds every member in the set as `DUPLICATE_ID`.

### dependents → bhi.dependent

| Legacy | BHI | Notes |
|---|---|---|
| member_id | member_id (via legacy_key_map) | If the parent is held, the dependent stays in the parent's exception snapshot and is not loaded |
| first_name + " " + last_name | dependent_full_name | Over 120 characters: `VALUE_TOO_LONG` |
| relationship | relationship | |
| date_of_birth, id_type, id_number, sex, notes | same | |
| status ACTIVE / ARCHIVED | active | ARCHIVED → false. `inactive_date` defaults to the migration date, `inactive_reason` to "Archived". |
| inactive_date, inactive_reason | same | When present |
| created_at, updated_at | same | |

### beneficiaries → bhi.beneficiary

| Legacy | BHI | Notes |
|---|---|---|
| member_id | member_id (via map) | As for dependents |
| first_name + " " + last_name | beneficiary_full_name | Over 120 characters: `VALUE_TOO_LONG` |
| relationship, date_of_birth, id_type, id_number, sex, phone, email, notes | same | |
| allocation_percent | share_percent | |
| status ACTIVE / REMOVED, removed_at | active, inactive_date | REMOVED → false; reason "Removed" if none recorded |
| created_at, updated_at | same | |

### Exception record (bhi.import_exception)

| Column | Value |
|---|---|
| source_alias | `LEGACY_MIGRATION` or `BULK_IMPORT` |
| source_file | The batch's system-generated `source_file`, which ties the row to its company |
| entity_type | `MEMBER`, `DEPENDENT` or `BENEFICIARY` |
| person_name | Full name |
| member_identifier | The ID number HR will enter in the corrected row |
| reason_codes | Comma list: `MISSING_ID_TYPE`, `MISSING_CLASS`, `UNKNOWN_CLASS`, `VALUE_TOO_LONG`, `DUPLICATE_ID` |
| reason | Plain language, naming the field and, for lengths, the actual versus allowed size |
| required_action | For example "Supply IDType and ClassCode for this member in the bulk import." |
| raw_row_summary | JSON snapshot of the member, dependents and beneficiaries, used to restore the family (R17) |

### Reconciliation (bhi.import_reconciliation, linked through import_batch_record)

For each company and table: `legacy.<table>.source`, `.loaded` and `.held`, with `passed = (loaded + held = source)` (FR-044, SC-004).
