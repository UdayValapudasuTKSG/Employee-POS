# API reference — every endpoint, with test calls

43 endpoints across 38 paths. The OpenAPI contract in
[`lib/api-spec/openapi.yaml`](../lib/api-spec/openapi.yaml) is the source of
truth; this file is the testing companion.

For Postman, import [`postman/BHI-Health-Card-API.postman_collection.json`](postman/BHI-Health-Card-API.postman_collection.json)
and [`postman/BHI-Local.postman_environment.json`](postman/BHI-Local.postman_environment.json) —
same 43 endpoints, with the request bodies filled in and token capture wired up.

## Base URLs

| Environment | Base URL | Notes |
| --- | --- | --- |
| **Local (front door)** | `http://localhost:8080/api` | Use this one. `deploy/serve-local.mjs` proxies `/api/*` to the API and stands in for nginx. |
| Local (API direct) | `http://127.0.0.1:3101/api` | Bypasses the proxy, so the local "any 6-digit code" shortcut does not apply. |
| Production | `https://your-domain/api` | nginx is the only public entry point; the API binds to `127.0.0.1:3001`. |

Start the local stack with `pnpm run local`. Health check:
`curl http://localhost:8080/api/healthz`

## Cross-origin access

The API answers browser requests only from origins named in
`CORS_ALLOWED_ORIGINS` (comma-separated, exact match on scheme + host + port).
Unset means **same-origin only** in production and **loopback only** in
development — the portal is served from the same origin as the API, so it needs
no cross-origin permission at all.

A refused origin gets a normal response with **no** `Access-Control-Allow-*`
headers, and the browser blocks the read. It is never an error status, so do
not look for a 403 — look for the absence of the header:

```bash
# Allowed → header echoed back
curl -sD - -o /dev/null $BASE/healthz -H 'Origin: http://localhost:5173' | grep -i access-control
# → access-control-allow-origin: http://localhost:5173

# Refused → nothing
curl -sD - -o /dev/null $BASE/healthz -H 'Origin: https://evil.example.com' | grep -i access-control

# Preflight
curl -sD - -o /dev/null -X OPTIONS $BASE/v1/admin/members/x \
  -H 'Origin: http://localhost:8080' -H 'Access-Control-Request-Method: PATCH' | grep -i access-control
# → allow-origin / allow-methods: GET,POST,PATCH,OPTIONS / allow-headers / max-age: 600
```

`curl` without an `Origin` header is not a cross-origin request, so CORS never
applies to it — every example in this file works regardless of the policy.

## Authentication

Three kinds of caller, three kinds of credential:

| Caller | Header | Obtained from | Lifetime |
| --- | --- | --- | --- |
| Anonymous | — | — | — |
| Employee | `Authorization: Bearer <cardToken>` | `POST /v1/otp/verify` | 15 min, revoked on logout/archive |
| Admin | `Authorization: Bearer <jwt>` | `POST /v1/admin/auth/login` | 8 hours |

```bash
BASE=http://localhost:8080/api

# Admin token
TOKEN=$(curl -s -X POST $BASE/v1/admin/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"platform.admin@bhi-demo.test","password":"Demo@2026"}' \
  | python -c 'import sys,json;print(json.load(sys.stdin)["token"])')
```

Demo admins (password `Demo@2026`): `platform.admin@` (super admin),
`client.foods@` (BF client admin), `hr.foods@` (BF only), `hr.auto@` (BA only),
`support@`, `auditor@` — all `@bhi-demo.test` — plus `client.admin@st.test` and
`hr@st.test` (ST only).

---

## 1. Public

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/healthz` | — | Liveness. Never touches the database. |
| GET | `/readyz` | — | Readiness. Checks Postgres, so a 503 means the API is up but the database is not. |
| POST | `/v1/assistant/ask` | — | Portal FAQ assistant. Never touches member data. |

```bash
curl $BASE/healthz
curl $BASE/readyz

curl -X POST $BASE/v1/assistant/ask -H 'content-type: application/json' \
  -d '{"message":"my verification code did not arrive"}'
```

---

## 2. Employee card flow

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/lookup` | — | Find a member by email or phone; sends the OTP |
| POST | `/v1/lookup/select` | — | Pick a record when one contact matches several members |
| POST | `/v1/otp/verify` | — | Exchange the code for a 15-minute card token |
| POST | `/v1/otp/resend` | — | New code. 60s cooldown, max 3. |
| GET | `/v1/card` | card | The card payload |
| POST | `/v1/card/email` | card | Email the card as a PDF |
| POST | `/v1/card/change-requests` | card | Raise an RFM with a supporting document |
| GET | `/v1/card/change-requests` | card | The member's own RFMs |
| POST | `/v1/session/logout` | card | Revoke the card session |

### Walkthrough

```bash
# 1. Lookup — the OTP is emailed (or SMS'd) for real.
curl -X POST $BASE/v1/lookup -H 'content-type: application/json' \
  -d '{"identifier":"kanukuntla@gmail.com"}'
# → {"status":"CODE_SENT","verificationId":"<uuid>","maskedDestination":"k•••••••••@g••••.com","devCode":null}

# 2. Verify. Read the 6-digit code from the mailbox.
curl -X POST $BASE/v1/otp/verify -H 'content-type: application/json' \
  -d '{"verificationId":"<uuid>","code":"123456"}'
# → {"cardToken":"<token>","expiresAt":"...","confirm":{...}}

CARD=<token>

# 3. The card
curl $BASE/v1/card -H "Authorization: Bearer $CARD"

# 4. Email it as a PDF
curl -X POST $BASE/v1/card/email -H "Authorization: Bearer $CARD"

# 5. Done
curl -X POST $BASE/v1/session/logout -H "Authorization: Bearer $CARD"
```

**Local shortcut.** `deploy/serve-local.mjs` swaps any 6-digit code you type
for the one it captured, so `000000` verifies — but only for **SMS**, whose
codes land in `http://localhost:8080/__inbox`. Emailed codes are sent for real
and never reach the inbox, so email verification needs the code from the
mailbox. Disable with `OTP_ACCEPT_ANY=false`, or send `x-otp-strict: 1`.

### Resend and disambiguation

```bash
curl -X POST $BASE/v1/otp/resend -H 'content-type: application/json' \
  -d '{"verificationId":"<uuid>"}'

# +592-555-0123 is shared by 5 BF members, so lookup returns status SELECT
curl -X POST $BASE/v1/lookup -H 'content-type: application/json' \
  -d '{"identifier":"+592-555-0123"}'
curl -X POST $BASE/v1/lookup/select -H 'content-type: application/json' \
  -d '{"lookupRef":"<ref>","optionRef":"<option ref>"}'
```

### Change requests (RFM)

```bash
curl -X POST $BASE/v1/card/change-requests -H "Authorization: Bearer $CARD" \
  -H 'content-type: application/json' -d '{
    "requestedLastName": "Kanukuntla-Rao",
    "employeeNote": "Married, deed poll attached",
    "document": {
      "documentType": "MARRIAGE_CERTIFICATE",
      "fileName": "certificate.pdf",
      "mimeType": "application/pdf",
      "contentBase64": "<base64>"
    }
  }'

curl $BASE/v1/card/change-requests -H "Authorization: Bearer $CARD"
```

Document rules: PDF/JPEG/PNG only, 5 MB max, type sniffed from magic bytes —
a declared type that disagrees is rejected with `TYPE_MISMATCH`. Max 3 pending
requests per member. Pass `dependentId` to change a dependant instead.

---

## 3. Admin — session

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/admin/auth/login` | — | Sign in |
| GET | `/v1/admin/me` | any admin | Current identity, scope, permissions |
| POST | `/v1/admin/users/me/password` | any admin | Change own password |
| GET | `/v1/admin/permissions` | any admin | Permission matrix (own column; full grid needs `PLATFORM_MANAGE`) |

```bash
curl $BASE/v1/admin/me -H "Authorization: Bearer $TOKEN"
curl $BASE/v1/admin/permissions -H "Authorization: Bearer $TOKEN"

curl -X POST $BASE/v1/admin/users/me/password -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"currentPassword":"Demo@2026","newPassword":"NewPassw0rd!"}'
```

---

## 4. Admin — dashboard

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/v1/admin/dashboard` | `MEMBER_READ_SCOPED` |
| GET | `/v1/admin/companies` | `MEMBER_READ_SCOPED` |

```bash
curl $BASE/v1/admin/dashboard  -H "Authorization: Bearer $TOKEN"
curl $BASE/v1/admin/companies  -H "Authorization: Bearer $TOKEN"
```

---

## 5. Admin — members

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/v1/admin/members` | `MEMBER_READ_SCOPED` |
| POST | `/v1/admin/members` | `MEMBER_CREATE` |
| GET | `/v1/admin/members/{id}` | `MEMBER_READ_SCOPED` |
| PATCH | `/v1/admin/members/{id}` | `MEMBER_UPDATE` |
| POST | `/v1/admin/members/{id}/policy` | `POLICY_MANAGE` (super admin only) |
| PATCH | `/v1/admin/members/{id}/dependents/{dependentId}` | `DEPENDENT_UPDATE` |
| POST | `/v1/admin/members/{id}/beneficiaries` | `BENEFICIARY_MANAGE` |
| PATCH | `/v1/admin/members/{id}/beneficiaries/{beneficiaryId}` | `BENEFICIARY_MANAGE` |
| POST | `/v1/admin/members/{id}/beneficiaries/{beneficiaryId}/remove` | `BENEFICIARY_MANAGE` |
| POST | `/v1/admin/members/{id}/remove` | `MEMBER_DELETE` |
| POST | `/v1/admin/members/{id}/reactivate` | `MEMBER_REACTIVATE` |

Query params on the list: `q`, `company`, `status`, `employmentStatus`,
`page`, `pageSize` (max 100).

```bash
# Find the test member
curl "$BASE/v1/admin/members?q=kanukuntla" -H "Authorization: Bearer $TOKEN"
MEMBER=<id>

curl $BASE/v1/admin/members/$MEMBER -H "Authorization: Bearer $TOKEN"

# Every mutation needs a reason of at least 3 characters — enforced server-side
curl -X PATCH $BASE/v1/admin/members/$MEMBER -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"phone":"+592-600-2000","reason":"Member reported a new number"}'

curl -X POST $BASE/v1/admin/members/$MEMBER/policy -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{
    "policyholder":"Edward B. Beharry & Company Ltd","policyNumber":"POL-2026-90001",
    "groupNumber":"GRP-BF-01","memberNumber":"M-900001","certificateNumber":"CERT-BF-90001",
    "planName":"Group Health Plus","insurerName":"North American Life Insurance Co. Ltd.",
    "effectiveDate":"2026-01-01","expiryDate":"2026-12-31","reason":"Annual renewal"}'

curl -X POST $BASE/v1/admin/members/$MEMBER/remove -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"reason":"Left the company"}'
```

Creating a member returns `DUPLICATE_CANDIDATE` on a soft match; resubmit with
`"acknowledgeDuplicate": true`. An employee-number clash is fatal
(`EMPLOYEE_NUMBER_IN_USE`).

---

## 6. Admin — bulk import

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/v1/admin/import/layouts` | `MEMBER_IMPORT` |
| POST | `/v1/admin/import` | `MEMBER_IMPORT` |

```bash
# What the importer accepts, and the exact columns of each layout
curl $BASE/v1/admin/import/layouts -H "Authorization: Bearer $TOKEN"
```

| Layout | Columns | Joined to a member by |
| --- | --- | --- |
| `CARRIER` (Members) | 22 | matched on `Company Number` + `IDNumber` |
| `DEPENDANT` (Dependants) | 14 | `CompanyNumber` + `MemberIDNumber` |
| `BENEFICIARY` (Beneficiaries) | 18 | `CompanyNumber` + `MemberIDNumber` |
| `LEGACY` (Short members) | 8 | for hand-built files |

Three input shapes, all with `dryRun`:

```bash
# a) pasted CSV / TSV text
curl -X POST $BASE/v1/admin/import -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{
    "csvText":"employeeNumber,firstName,lastName,dateOfBirth,identificationId,email,phone,companyCode\nBF-99999,Test,Person,1990-01-01,SYN-99999999,test@bhi-demo.test,+592-600-0000,BF",
    "dryRun":true}'

# b) one pre-parsed sheet
curl -X POST $BASE/v1/admin/import -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"rows":[["..."],["..."]],"dryRun":true}'

# c) a whole workbook — the shape the admin screen sends
curl -X POST $BASE/v1/admin/import -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{
    "sheets":[
      {"name":"Members","rows":[[...],[...]]},
      {"name":"Dependants","rows":[[...],[...]]},
      {"name":"Beneficiaries","rows":[[...],[...]]}],
    "dryRun":true}'
```

Notes for testing:
- Always `dryRun: true` first; the response reports every row before anything
  is written. `dryRun: false` commits.
- Members commit before dependants and beneficiaries, so one file can create a
  member and everyone attached to them.
- Re-importing the same file **updates** rather than duplicating.
- The Beneficiaries sheet repeats `LastName`/`FirstName`: the **first** pair is
  the member's, the **second** is the beneficiary's.
- `Active=No` archives a dependant / withdraws a beneficiary — they come off
  the card.
- Beneficiary shares that do not total 100% are flagged `WARN` but still import.
- Body limit is 12 MB for this route (100 kB everywhere else).

---

## 7. Admin — change request review

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/v1/admin/change-requests` | `CHANGE_REQUEST_REVIEW` |
| GET | `/v1/admin/change-requests/{id}` | `CHANGE_REQUEST_REVIEW` |
| GET | `/v1/admin/change-requests/{id}/document` | `CHANGE_REQUEST_REVIEW` |
| POST | `/v1/admin/change-requests/{id}/approve` | `CHANGE_REQUEST_REVIEW` |
| POST | `/v1/admin/change-requests/{id}/reject` | `CHANGE_REQUEST_REVIEW` |

```bash
curl "$BASE/v1/admin/change-requests?status=PENDING" -H "Authorization: Bearer $TOKEN"
curl $BASE/v1/admin/change-requests/<id> -H "Authorization: Bearer $TOKEN"

# Fetching the document is itself audited — it is someone's passport
curl $BASE/v1/admin/change-requests/<id>/document -H "Authorization: Bearer $TOKEN"

curl -X POST $BASE/v1/admin/change-requests/<id>/approve -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"note":"Marriage certificate verified"}'

curl -X POST $BASE/v1/admin/change-requests/<id>/reject -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"note":"Document is illegible"}'
```

`status` accepts `PENDING` (default), `APPROVED`, `REJECTED`, `ALL`. Approval
re-reads the subject inside the transaction and refuses with `STALE_REQUEST` if
the record moved since the employee filed.

---

## 8. Admin — audit and verifications

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/v1/admin/audit` | `AUDIT_READ` |
| GET | `/v1/admin/verifications` | `VERIFICATION_READ` |
| POST | `/v1/admin/verifications/{id}/reset-lock` | `SESSION_MANAGE` |

Audit filters: `entityId`, `actor`, `action`, `from`, `to`, `page`, `pageSize`.

```bash
curl "$BASE/v1/admin/audit?action=MEMBERS_IMPORTED&pageSize=10" -H "Authorization: Bearer $TOKEN"
curl "$BASE/v1/admin/audit?entityId=$MEMBER" -H "Authorization: Bearer $TOKEN"
curl $BASE/v1/admin/verifications -H "Authorization: Bearer $TOKEN"

# Unlock a member locked out after 3 wrong codes. No code is re-sent.
curl -X POST $BASE/v1/admin/verifications/<id>/reset-lock -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"reason":"Member called the help desk"}'
```

`reset-lock` is `SESSION_MANAGE`, not `VERIFICATION_READ` — an auditor holds
the read permission and must never mutate.

---

## 9. Admin — user administration

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/v1/admin/users` | `ADMIN_USER_READ` |
| POST | `/v1/admin/users` | `ADMIN_USER_MANAGE` |
| PATCH | `/v1/admin/users/{id}` | `ADMIN_USER_MANAGE` |
| POST | `/v1/admin/users/{id}/reset-password` | `ADMIN_USER_MANAGE` |

```bash
curl $BASE/v1/admin/users -H "Authorization: Bearer $TOKEN"

# Returns a one-time temporary password; the account must change it at sign-in
curl -X POST $BASE/v1/admin/users -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"email":"new.hr@example.com","displayName":"New HR","role":"ROLE_HR_ADMIN","companyScope":"BF"}'

curl -X PATCH $BASE/v1/admin/users/<id> -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"active":false}'

curl -X POST $BASE/v1/admin/users/<id>/reset-password -H "Authorization: Bearer $TOKEN"
```

Guards worth testing: you cannot deactivate yourself or change your own role
(`SELF_LOCKOUT`); only a platform admin can touch a platform admin account; the
last account that can manage admin users cannot be demoted or deactivated
(`LAST_ADMIN_MANAGER`), nor the last super admin (`LAST_SUPER_ADMIN`), nor a
company's last client admin (`LAST_CLIENT_ADMIN`).

---

## Errors

Every failure is `{"error":{"code":"...","message":"..."}}`.

| Status | Meaning |
| --- | --- |
| 400 | Validation, or a business rule (`NO_CHANGES`, `ALREADY_ARCHIVED`, `SELF_LOCKOUT`) |
| 401 | Missing/expired token — `UNAUTHENTICATED`, or `SESSION_EXPIRED` for a card |
| 403 | `FORBIDDEN`. Audited as `ACCESS_DENIED`. |
| 404 | Not found **or out of your company scope** — deliberately indistinguishable |
| 413 | `PAYLOAD_TOO_LARGE` |
| 423 | `SESSION_LOCKED` — 3 wrong codes |
| 429 | `RESEND_TOO_SOON` (60s) / `RESEND_LIMIT` (3) |
| 503 | `EMAIL_DELIVERY_UNAVAILABLE` when a card PDF cannot be emailed. Code delivery failures are not reported to the caller: `/v1/lookup` always answers `CODE_SENT`, and the failure is logged in `bhi.activity_log`, kind `EVENT`, action `OTP_DELIVERY` |

**Cross-company access returns 404, not 403.** A scoped HR admin asking for
another company's member gets the same answer as for an id that does not exist,
so the API never confirms a record exists outside your scope.

---

## Regression suites

```bash
# 69-assertion RBAC matrix — needs the stack in dev-code mode
pnpm run local:devcode
BASE_URL=http://127.0.0.1:8080/api node artifacts/api-server/scripts/rbac-test.mjs

# Unit tests (parsers, PDF, RBAC, issuer config, change-request rules)
pnpm --filter @workspace/api-server test
```

Against the normal `pnpm run local` stack the RBAC suite reports 5 failures —
those are the assertions that read the inline `devCode`, which real delivery
deliberately withholds. Not regressions.
