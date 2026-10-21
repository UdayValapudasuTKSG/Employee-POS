# Quickstart: Validating the Shared BHI Database

This guide shows how to prove the feature works end to end on a developer machine. It links to the [data model](data-model.md) and [contracts](contracts/) rather than repeating them.

## Prerequisites

- Local stack as in [deploy/LOCAL-DEV.md](../../deploy/LOCAL-DEV.md). PostgreSQL **15 or newer** (research R7).
- Two database roles (research R5), created by `pnpm run local:db`:
  ```text
  DATABASE_URL=postgres://bhi_app:...@localhost:5432/bhi_portal          # API
  DATABASE_OWNER_URL=postgres://bhi_owner:...@localhost:5432/bhi_portal  # migrations only
  ```
- **Never run the API or the tests as `postgres`.** A superuser bypasses row-level security, and segregation bugs would not show.
- Demo seed loaded (the default when `DEMO_SEED` is not `false`). All data is synthetic (FR-048).
- Standard rates for classes A, B and C in `deploy/db/seed/premium_rates_standard.csv`. Use test values until the client supplies the real card (research R14).

> `pnpm run local` starts the API from the **prebuilt** bundle in `deploy/api/`. After each change, rebuild and copy it, or you will be testing old code:
> ```text
> pnpm --filter @workspace/api-server run build
> cp -r artifacts/api-server/dist/. deploy/api/
> ```

## 1. Structure matches the BHI model (US1, SC-001)

```text
pnpm --filter @workspace/api-server test -- bhiSchema
```

Expected: **18/18 tables, 0 differences** against [contracts/bhi-schema.sql](contracts/bhi-schema.sql), with only D1–D3 allowed.

Spot check in `psql`:
```sql
SELECT count(*) FROM information_schema.tables WHERE table_schema = 'bhi';     -- 18
SELECT count(*) FROM pg_constraint WHERE connamespace = 'bhi'::regnamespace AND contype = 'f';  -- 8
SELECT relname FROM pg_class WHERE relnamespace = 'bhi'::regnamespace
   AND relkind = 'r' AND NOT (relrowsecurity AND relforcerowsecurity);         -- 0 rows
```

## 2. Segregation (US2, SC-003)

```text
pnpm --filter @workspace/api-server test -- segregation
BASE_URL=http://localhost/api pnpm local:test          # extended rbac-test.mjs
```

The database backstop, run as `bhi_app`:
```sql
BEGIN;
SELECT set_config('bhi.companies','BF',true), set_config('bhi.all','off',true);
SELECT DISTINCT company_number FROM bhi.member;          -- BF only, even with no WHERE
SELECT count(*) FROM bhi.dependent;                      -- BF members' dependents only
ROLLBACK;
BEGIN; SELECT count(*) FROM bhi.member; ROLLBACK;        -- 0: no scope set, fails closed
```

Through the API:

| As | Request | Expected |
|---|---|---|
| `hr.foods@` (BF) | `GET /v1/admin/members` | BF rows only |
| `hr.foods@` | `GET /v1/admin/companies/BA/members/1` | `404`, the same body as a missing BF member |
| `group.admin@` (group Beharry) | `GET /v1/admin/members` | The six Beharry companies only, never a test company outside the group |
| `platform.admin@` (super admin) | `GET /v1/admin/members` | Every company |
| `support@`, `auditor@` | any member `PATCH` or `POST` | `403` |

Add a non-Beharry company `ST` ("Sterling test") in step 3 and repeat: nobody except the super admin, support and auditor sees it.

## 3. Onboarding and client admin (US3, SC-002, SC-010)

As the super admin:
- `POST /v1/admin/companies {companyNumber:"ST", companyName:"Sterling Test", clientAdmin:{email:"admin@st.test", displayName:"ST Admin"}, reason:"qs"}` returns `201` with a temporary password. Time it (SC-002: under 5 minutes; expected under 1 second).
- Repeating the same call returns `409 COMPANY_EXISTS`, and nothing else is created.

As `admin@st.test` (after changing the password):
- Create `hr@st.test` as `ROLE_HR_ADMIN`: `201`, scoped to ST.
- Create a user for BF, or any super admin, group, support or auditor user: `403 ROLE_NOT_GRANTABLE`.
- Deactivate yourself while you are the only client admin: `409 LAST_CLIENT_ADMIN`.

Offboard ST: it disappears from the lookup and from billing, `admin@st.test` can no longer sign in, and the super admin can still read ST's members.

## 4. Card lookup (US2 scenarios 7–10, SC-009)

Test contacts: `solo@x.test` on one BF member; `family@x.test` on two BF members; `shared@x.test` on one BF member and one ST member (two different people).

| Lookup | `/v1/lookup` | After a correct code |
|---|---|---|
| `nobody@x.test` | `200 CODE_SENT` | The code never verifies |
| `solo@x.test` | `200 CODE_SENT` | `CARD` |
| `family@x.test` | `200 CODE_SENT` | `SELECT`, then `/v1/otp/select` gives `CARD` |
| `shared@x.test` | `200 CODE_SENT` | `MULTI_COMPANY` with no card. The super admin sees the alert. `hr.foods@` sees only `sharedContactAlert: true`. |

All four lookup bodies must be identical apart from `verificationId` and `maskedDestination`, and each response must take at least 800 ms.

Also try to add a member to ST with the same ID type and number as a BF member: `409 ID_ALREADY_REGISTERED`, and the message does not mention BF (FR-007).

## 5. Classes and rates (US5, SC-008)

As the super admin:
- `POST /v1/admin/classes {classCode:"D", className:"Class D", reason:"qs"}`. D shows `rateComplete:false` and cannot be assigned to a member yet.
- `POST /v1/admin/rates` with the standard rates for D (four tiers, effective 2026-10-01). D becomes `rateComplete:true` and assignable. Time both steps together (SC-008: under 5 minutes).
- Post a rate with three tiers: `400`. Post one where company + employee ≠ total: `400`.
- Add company-specific rates for ST, class A, effective 2026-11-01. `GET /v1/admin/rates?company=ST&asOf=2026-11-01` shows class A as `COMPANY` and B, C, D as `STANDARD`.

As `hr.foods@`: `POST /v1/admin/classes` and `POST /v1/admin/rates` return `403`, and `GET /v1/admin/rates?company=BF` works.

## 6. Monthly billing (US6, SC-005, SC-011)

```text
pnpm --filter @workspace/api-server test -- billing
```

This fixture test checks every line against a hand-calculated table, to the cent. Walk through the same thing by hand for one BF member:

| When recorded (Guyana time) | Change |
|---|---|
| 2026-09-10 | Member created, class A, 1 dependent |
| 2026-09-20 | Second dependent added |
| 2026-10-03 | Class changed to B, third dependent added |
| 2026-10-15 | Member deactivated |

| Bill | Expected line |
|---|---|
| September 2026 | none (created after 1 Sep) |
| October 2026 | Class A, 2 dependents, tier `EE+2`, even though the October bill is generated on 5 Oct |
| November 2026 | none (inactive at 1 Nov) |

If the member is instead reactivated on 2026-10-20, November shows class B, 3 dependents, tier `EE+3+`.

Also check:
- Finalise the October run, then try to change a rate it used: rejected. Generate October again: `ALREADY_FINAL`.
- Remove all rates for class C, then generate: members in C are listed under `issues`, and finalising returns `409 RUN_HAS_ISSUES`.
- Give BF a CompanyBillingRule of 80/20: its lines split total × 0.80 / remainder. Other companies use the rate card's own split.
- Generating a bill for all companies with about 5,000 synthetic members takes under 5 minutes (SC-011).

## 7. Legacy migration (US4, SC-004, SC-007)

Against a fresh database with the demo seed in the **old** structure:

```text
node deploy/api/migrate-legacy.mjs --dry-run      # prints the report, then rolls back
node deploy/api/migrate-legacy.mjs                # real run
```

Expected:
- **Structure after migration:**
  - `bhi.company` has the six seed companies.
  - No group admin account, `group_scope` column or `client_groups` table remains (migration 004).
- **Reconciliation:**
  - For every company and table, `loaded + held = source`.
  - Every `import_reconciliation` row has `passed = true`.
- **Exceptions:**
  - Seed members missing an ID type or class are in `bhi.import_exception` under their company's batch.
  - `GET /v1/admin/companies/{c}/import-exceptions` shows them to that company's HR only.
- **Status mapping:**
  - Suspended BM seed members are `active=false`, with `inactive_reason` starting `Suspended`.
  - Removed over-65 members have `Removed: …`.
- **Card access (SC-007):** the members who could get a card before are exactly the `active=true` members after, excluding held ones.
- **Platform tables:**
  - `card_sessions`, `change_requests` and `policy_memberships` have `member_ref` filled.
  - The number and content of `audit_logs` rows are unchanged.

## 8. HR fixes an exception through bulk import (FR-041, FR-042)

As `hr.foods@`, upload a carrier file with one held BF member, now with IDType and ClassCode filled in:
- The dry run shows the row as OK and "resolves 1 exception".
- After commit, the member exists with the dependents and beneficiaries restored from the snapshot, the exception shows as RESOLVED, and the lookup issues a card.

Also check:
- A row with a blank ClassCode is reported, written to `import_exception` under this upload's batch, and not loaded.
- The legacy 8-column layout returns `400 LAYOUT_WITHDRAWN`.

## 9. No delete path, audit append-only (Constitution III)

Run as `bhi_app`:
```sql
DELETE FROM bhi.member WHERE member_id = 1;         -- ERROR: permission denied
DELETE FROM bhi.billing_run WHERE billing_run_id = 1; -- ERROR: permission denied
UPDATE public.audit_logs SET reason = 'x';          -- ERROR: permission denied
```
