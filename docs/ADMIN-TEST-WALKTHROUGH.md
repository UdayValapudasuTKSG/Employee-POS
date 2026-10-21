# Test walkthrough — admin and super admin portal (every API)

A step-by-step script that exercises **every API** of the BHI Health Card Portal in a sensible order, with a working example for each: the request, the status to expect, and a trimmed copy of the real response. The steps build on each other (the company made in step 3 is used in steps 4–14), so run them **in order**.

Every example here was run against a fresh copy of the demo data on 2026-09-30: **115 of 115 steps gave the expected status.** Ids in your responses (member ids, run ids, uuids) will differ; use the ones your own responses return.

## Before you start

- **Stack running:** `docker compose up -d` — portal at http://localhost:3000.
- **OTP dev mode on:** `OTP_DEV_MODE=true` in `artifacts/api-server/.env`, so card lookups return the code as `devCode` instead of sending it. Turn it off again before go-live.
- **Demo data:** with `DEMO_SEED=true` the stack starts with 7 companies (the six Beharry companies BA, BF, BL, BM, BR, BS, and ST) and 130 members.
- **API address for testing:** `http://127.0.0.1:3001/api`. That is the API directly. The front door (`http://localhost:3000/api`) works too, but it allows only **5 admin sign-ins a minute**, and this script signs in eight times.
- **Starting over:** the steps create data (company QA1, class D, members, bills). To run them again from a clean demo, `docker compose down -v` then `docker compose up -d` — this **erases the Docker database**.

### Demo logins (password `Demo@2026`)

| Email | Role | Sees |
|---|---|---|
| platform.admin@bhi-demo.test | Super admin | everything |
| client.foods@bhi-demo.test | Client admin | BF |
| hr.foods@bhi-demo.test | HR administrator | BF |
| hr.auto@bhi-demo.test | HR administrator | BA |
| client.admin@st.test | Client admin | ST |
| hr@st.test | HR administrator | ST |
| support@bhi-demo.test | Support | everything, read-only |
| auditor@bhi-demo.test | Auditor | activity log, verifications, bills |

There are five admin roles. Only the **super admin** reaches and changes every company. **Client admins** and **HR administrators** belong to one company each and see nothing of any other, not even a sister company. **Support** and **auditor** read every company but change nothing. There is no group admin: that role and client groups were removed.

> **Database seeded before this change?** `client.foods@bhi-demo.test` is added only when the demo data is first created. On an older database, section 13 needs it: reset the stack (below), or have the super admin create a BF client admin in **Users**.

### Sending the requests

**Postman:** import `docs/postman/BHI-Health-Card-API.postman_collection.json` and set `baseUrl` to `http://127.0.0.1:3001/api`. The examples below map one-to-one onto its requests.

**curl (Git Bash):** paste this once, then run each example as `api METHOD PATH 'JSON'`:

```bash
B=http://127.0.0.1:3001/api
login() { curl -s -X POST $B/v1/admin/auth/login -H 'content-type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"$2\"}" | sed -E 's/.*"token":"([^"]+)".*/\1/'; }
TOKEN=$(login platform.admin@bhi-demo.test 'Demo@2026')
api() { curl -s -X "$1" "$B$2" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' ${3:+-d "$3"}; echo; }

api GET /v1/admin/me
```

To act as another user, set `TOKEN=$(login hr@qa1.test '…')` before the step. For the employee card steps (section 8), set `TOKEN` to the `cardToken`.

Every change an admin makes asks for a `reason` (at least 3 characters). It is written to the activity log.

---

## 1. Health checks

### 1.1 API is running

Liveness: the API process is up.

*As:* no sign-in needed

```http
GET /healthz
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "status": "ok"
}
```

</details>

### 1.2 Database is reachable

Readiness: the API can reach PostgreSQL.

*As:* no sign-in needed

```http
GET /readyz
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "status": "ok",
  "database": "up",
  "databaseLatencyMs": 2
}
```

</details>


## 2. Sign in and your account

*In the portal:* /admin/login, then the dashboard at /admin and Permissions at /admin/permissions

### 2.1 Wrong password is refused

*As:* no sign-in needed

```http
POST /v1/admin/auth/login

{
  "email": "platform.admin@bhi-demo.test",
  "password": "wrong-password"
}
```

**Expect:** `401 Unauthorized`

<details><summary>Response (trimmed)</summary>

```json
{
  "error": {
    "code": "LOGIN_FAILED",
    "message": "That email and password combination is not correct."
  }
}
```

</details>

### 2.2 Sign in as the super admin

Copy `token` from the response: every admin request below sends it as `Authorization: Bearer <token>`.

*As:* no sign-in needed

```http
POST /v1/admin/auth/login

{
  "email": "platform.admin@bhi-demo.test",
  "password": "Demo@2026"
}
```

**Expect:** `200 OK` — **save** `token` → use as `Authorization: Bearer <token>`

<details><summary>Response (trimmed)</summary>

```json
{
  "token": "<token>",
  "role": "ROLE_PLATFORM_ADMIN",
  "scope": null,
  "displayName": "Priya Platform",
  "permissions": [
    "MEMBER_READ_SCOPED",
    "… 21 more"
  ],
  "mustChangePassword": false
}
```

</details>

### 2.3 Who am I

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
GET /v1/admin/me
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "email": "platform.admin@bhi-demo.test",
  "displayName": "Priya Platform",
  "role": "ROLE_PLATFORM_ADMIN",
  "roleLabel": "Super admin",
  "scope": null,
  "scopeCompanyName": null,
  "companies": null,
  "readOnly": false,
  "permissions": [
    "MEMBER_READ_SCOPED",
    "… 21 more"
  ]
}
```

</details>

### 2.4 Permission matrix

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
GET /v1/admin/permissions
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "roles": [
    "ROLE_PLATFORM_ADMIN",
    "… 5 more"
  ],
  "currentRole": "ROLE_PLATFORM_ADMIN",
  "currentPermissions": [
    "MEMBER_READ_SCOPED",
    "… 21 more"
  ],
  "rows": [
    {
      "permission": "MEMBER_READ_SCOPED",
      "description": "View member records within the assigned company scope",
      "grants": "{…}"
    },
    "… 22 more"
  ]
}
```

</details>

### 2.5 Dashboard figures

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
GET /v1/admin/dashboard
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "totalMembers": 130,
  "activeMembers": 122,
  "inactiveMembers": 8,
  "totalDependents": 233,
  "expiredPolicyCount": 2,
  "membersWithoutDateOfBirth": 0,
  "verificationsToday": 0,
  "lockedVerifications": 0,
  "openLookupAlerts": 0,
  "…": "5 more field(s)"
}
```

</details>


## 3. Companies

*In the portal:* /admin/companies

### 3.1 List companies

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
GET /v1/admin/companies
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
[
  {
    "companyNumber": "BA",
    "companyName": "Beharry Automotive Ltd",
    "active": true,
    "address1": null,
    "address2": null,
    "city": null,
    "…": "6 more field(s)"
  },
  "… 6 more"
]
```

</details>

### 3.2 Onboard a new company and its client admin

Creates the company and its one client admin in one step. Note `temporaryPassword`: it is shown once, and the client admin must change it at first sign-in.

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
POST /v1/admin/companies

{
  "companyNumber": "QA1",
  "companyName": "QA Test Company Ltd",
  "city": "Georgetown",
  "contactName": "Priya Test",
  "contactEmail": "office@qa1.test",
  "clientAdmin": {
    "email": "client.admin@qa1.test",
    "displayName": "QA1 Client Admin"
  },
  "reason": "QA walkthrough"
}
```

**Expect:** `201 Created` — **save** `temporaryPassword` (the client admin's first password)

<details><summary>Response (trimmed)</summary>

```json
{
  "company": {
    "companyNumber": "QA1",
    "companyName": "QA Test Company Ltd",
    "active": true,
    "address1": null,
    "address2": null,
    "city": "Georgetown",
    "…": "6 more field(s)"
  },
  "clientAdmin": {
    "id": "9b872f39-a401-4b09-a997-34a54d8fd256",
    "email": "client.admin@qa1.test",
    "displayName": "QA1 Client Admin",
    "role": "ROLE_CLIENT_ADMIN",
    "roleLabel": "Client admin",
    "companyScope": "QA1",
    "…": "2 more field(s)"
  },
  "temporaryPassword": "<shown once>"
}
```

</details>

### 3.3 Onboarding the same number again is refused

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
POST /v1/admin/companies

{
  "companyNumber": "QA1",
  "companyName": "Duplicate",
  "clientAdmin": {
    "email": "other@qa1.test",
    "displayName": "Other"
  },
  "reason": "QA walkthrough"
}
```

**Expect:** `409 Conflict`

<details><summary>Response (trimmed)</summary>

```json
{
  "error": {
    "code": "COMPANY_EXISTS",
    "message": "A company with number QA1 already exists."
  }
}
```

</details>

### 3.4 Update the company's details

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
PATCH /v1/admin/companies/QA1

{
  "contactPhone": "592-600-0000",
  "address1": "1 Main Street",
  "reason": "Add contact details"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "companyNumber": "QA1",
  "companyName": "QA Test Company Ltd",
  "active": true,
  "address1": "1 Main Street",
  "address2": null,
  "city": "Georgetown",
  "contactName": "Priya Test",
  "contactPhone": "592-600-0000",
  "contactEmail": "office@qa1.test",
  "…": "3 more field(s)"
}
```

</details>


## 4. Admin users and passwords

*In the portal:* /admin/users

### 4.1 List admin users

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
GET /v1/admin/users
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
[
  {
    "id": "6e2628a1-5795-4de3-a7ba-c873e2abbd03",
    "email": "auditor@bhi-demo.test",
    "displayName": "Aria Auditor",
    "role": "ROLE_AUDITOR",
    "roleLabel": "Auditor",
    "companyScope": null,
    "…": "2 more field(s)"
  },
  "… 8 more"
]
```

</details>

### 4.2 Create an HR administrator for QA1

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
POST /v1/admin/users

{
  "email": "hr@qa1.test",
  "displayName": "QA1 HR",
  "role": "ROLE_HR_ADMIN",
  "companyScope": "QA1"
}
```

**Expect:** `200 OK` — **save** the new user's `id` → `{qaHrId}`

<details><summary>Response (trimmed)</summary>

```json
{
  "user": {
    "id": "52b18805-a6ff-4449-8966-0700e1735a00",
    "email": "hr@qa1.test",
    "displayName": "QA1 HR",
    "role": "ROLE_HR_ADMIN",
    "roleLabel": "HR administrator",
    "companyScope": "QA1",
    "…": "2 more field(s)"
  },
  "temporaryPassword": "<shown once>"
}
```

</details>

### 4.3 An HR administrator must have a company

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
POST /v1/admin/users

{
  "email": "nocompany@qa1.test",
  "displayName": "No Company",
  "role": "ROLE_HR_ADMIN",
  "companyScope": null
}
```

**Expect:** `400 Bad Request`

<details><summary>Response (trimmed)</summary>

```json
{
  "error": {
    "code": "SCOPE_REQUIRED",
    "message": "HR administrator accounts belong to one company: choose it."
  }
}
```

</details>

### 4.4 Rename the HR administrator

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
PATCH /v1/admin/users/{qaHrId}

{
  "displayName": "QA1 HR Officer"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "id": "52b18805-a6ff-4449-8966-0700e1735a00",
  "email": "hr@qa1.test",
  "displayName": "QA1 HR Officer",
  "role": "ROLE_HR_ADMIN",
  "roleLabel": "HR administrator",
  "companyScope": "QA1",
  "active": true,
  "createdAt": "2026-09-30T08:01:59.134Z"
}
```

</details>

### 4.5 Reset their password

Returns a new temporary password, shown once.

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
POST /v1/admin/users/{qaHrId}/reset-password
```

**Expect:** `200 OK` — **save** `temporaryPassword`

<details><summary>Response (trimmed)</summary>

```json
{
  "temporaryPassword": "<shown once>"
}
```

</details>

### 4.6 The HR administrator signs in with the temporary password

`mustChangePassword` is true.

*As:* no sign-in needed

```http
POST /v1/admin/auth/login

{
  "email": "hr@qa1.test",
  "password": "<temporaryPassword>"
}
```

**Expect:** `200 OK` — **save** `token` (only good for changing the password)

<details><summary>Response (trimmed)</summary>

```json
{
  "token": "<token>",
  "role": "ROLE_HR_ADMIN",
  "scope": "QA1",
  "displayName": "QA1 HR Officer",
  "permissions": [
    "MEMBER_READ_SCOPED",
    "… 13 more"
  ],
  "mustChangePassword": true
}
```

</details>

### 4.7 …and sets their own password

*As:* QA1 HR administrator, temporary password

```http
POST /v1/admin/users/me/password

{
  "currentPassword": "<temporaryPassword>",
  "newPassword": "Qa1-Hr@2026!"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "ok": true
}
```

</details>

### 4.8 Sign in as the HR administrator with the new password

*As:* no sign-in needed

```http
POST /v1/admin/auth/login

{
  "email": "hr@qa1.test",
  "password": "Qa1-Hr@2026!"
}
```

**Expect:** `200 OK` — **save** `token` → the QA1 HR token

<details><summary>Response (trimmed)</summary>

```json
{
  "token": "<token>",
  "role": "ROLE_HR_ADMIN",
  "scope": "QA1",
  "displayName": "QA1 HR Officer",
  "permissions": [
    "MEMBER_READ_SCOPED",
    "… 13 more"
  ],
  "mustChangePassword": false
}
```

</details>

### 4.9 The QA1 client admin signs in (temporary password)

*As:* no sign-in needed

```http
POST /v1/admin/auth/login

{
  "email": "client.admin@qa1.test",
  "password": "<temporaryPassword>"
}
```

**Expect:** `200 OK` — **save** `token` (only good for changing the password)

<details><summary>Response (trimmed)</summary>

```json
{
  "token": "<token>",
  "role": "ROLE_CLIENT_ADMIN",
  "scope": "QA1",
  "displayName": "QA1 Client Admin",
  "permissions": [
    "MEMBER_READ_SCOPED",
    "… 16 more"
  ],
  "mustChangePassword": true
}
```

</details>

### 4.10 …and sets their own password

*As:* QA1 client admin, temporary password

```http
POST /v1/admin/users/me/password

{
  "currentPassword": "<temporaryPassword>",
  "newPassword": "Qa1-Client@2026!"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "ok": true
}
```

</details>

### 4.11 Sign in as the QA1 client admin

*As:* no sign-in needed

```http
POST /v1/admin/auth/login

{
  "email": "client.admin@qa1.test",
  "password": "Qa1-Client@2026!"
}
```

**Expect:** `200 OK` — **save** `token` → the QA1 client admin token

<details><summary>Response (trimmed)</summary>

```json
{
  "token": "<token>",
  "role": "ROLE_CLIENT_ADMIN",
  "scope": "QA1",
  "displayName": "QA1 Client Admin",
  "permissions": [
    "MEMBER_READ_SCOPED",
    "… 16 more"
  ],
  "mustChangePassword": false
}
```

</details>


## 5. Classes, rates and billing rules

*In the portal:* /admin/classes and /admin/rates

### 5.1 List classes

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
GET /v1/admin/classes
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "classes": [
    {
      "classCode": "A",
      "className": "Class A",
      "description": null,
      "active": true,
      "sortOrder": 1,
      "rateComplete": true,
      "…": "1 more field(s)"
    },
    "… 2 more"
  ]
}
```

</details>

### 5.2 Add class D

`rateComplete` is false: D cannot be given to a member until its four tiers are priced.

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
POST /v1/admin/classes

{
  "classCode": "D",
  "className": "Class D",
  "description": "Executives",
  "sortOrder": 4,
  "reason": "New class for executives"
}
```

**Expect:** `201 Created`

<details><summary>Response (trimmed)</summary>

```json
{
  "classCode": "D",
  "className": "Class D",
  "description": "Executives",
  "active": true,
  "sortOrder": 4,
  "rateComplete": false,
  "memberCount": 0
}
```

</details>

### 5.3 Rename class D

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
PATCH /v1/admin/classes/D

{
  "className": "Class D – Executives",
  "reason": "Clearer name"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "classCode": "D",
  "className": "Class D – Executives",
  "description": "Executives",
  "active": true,
  "sortOrder": 4,
  "rateComplete": false,
  "memberCount": 0
}
```

</details>

### 5.4 The standard rate card

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
GET /v1/admin/rates?asOf=2026-10-01
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "companyNumber": null,
  "asOf": "2026-10-01",
  "classes": [
    {
      "classCode": "A",
      "className": "Class A",
      "active": true,
      "tiers": [
        "… 4 item(s)"
      ]
    },
    "… 3 more"
  ]
}
```

</details>

### 5.5 A rate set needs all four tiers

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
POST /v1/admin/rates

{
  "classCode": "D",
  "effectiveDate": "2026-10-01",
  "tiers": [
    {
      "dependentBand": 0,
      "totalPremium": "8000.00",
      "companyPremium": "6400.00",
      "employeePremium": "1600.00"
    },
    {
      "dependentBand": 1,
      "totalPremium": "9500.00",
      "companyPremium": "7600.00",
      "employeePremium": "1900.00"
    },
    {
      "dependentBand": 2,
      "totalPremium": "11000.00",
      "companyPremium": "8800.00",
      "employeePremium": "2200.00"
    }
  ],
  "reason": "Rates for class D"
}
```

**Expect:** `400 Bad Request`

<details><summary>Response (trimmed)</summary>

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "A rate needs exactly one entry for each of the four tiers: Employee only, +1, +2 and mo…"
  }
}
```

</details>

### 5.6 Price class D (standard card, four tiers)

Tiers: 0 = Employee only, 1 = +1, 2 = +2, 3 = more than two. Company + employee must equal the total, to the cent.

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
POST /v1/admin/rates

{
  "classCode": "D",
  "effectiveDate": "2026-10-01",
  "tiers": [
    {
      "dependentBand": 0,
      "totalPremium": "8000.00",
      "companyPremium": "6400.00",
      "employeePremium": "1600.00"
    },
    {
      "dependentBand": 1,
      "totalPremium": "9500.00",
      "companyPremium": "7600.00",
      "employeePremium": "1900.00"
    },
    {
      "dependentBand": 2,
      "totalPremium": "11000.00",
      "companyPremium": "8800.00",
      "employeePremium": "2200.00"
    },
    {
      "dependentBand": 3,
      "totalPremium": "12500.00",
      "companyPremium": "10000.00",
      "employeePremium": "2500.00"
    }
  ],
  "reason": "Rates for class D"
}
```

**Expect:** `201 Created` — **save** any `premiumRateId` from `rates` → `{rateId}`

<details><summary>Response (trimmed)</summary>

```json
{
  "rates": [
    {
      "premiumRateId": 13,
      "companyNumber": null,
      "classCode": "D",
      "dependentBand": 0,
      "coverageBand": "EMP_ONLY",
      "coverageLabel": "Employee only",
      "…": "7 more field(s)"
    },
    "… 3 more"
  ]
}
```

</details>

### 5.7 Give QA1 its own class A rate from 1 November

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
POST /v1/admin/rates

{
  "companyNumber": "QA1",
  "classCode": "A",
  "effectiveDate": "2026-11-01",
  "tiers": [
    {
      "dependentBand": 0,
      "totalPremium": "4500.00",
      "companyPremium": "3375.00",
      "employeePremium": "1125.00"
    },
    {
      "dependentBand": 1,
      "totalPremium": "6000.00",
      "companyPremium": "4500.00",
      "employeePremium": "1500.00"
    },
    {
      "dependentBand": 2,
      "totalPremium": "7500.00",
      "companyPremium": "5625.00",
      "employeePremium": "1875.00"
    },
    {
      "dependentBand": 3,
      "totalPremium": "9000.00",
      "companyPremium": "6750.00",
      "employeePremium": "2250.00"
    }
  ],
  "reason": "Negotiated rate for QA1"
}
```

**Expect:** `201 Created`

<details><summary>Response (trimmed)</summary>

```json
{
  "rates": [
    {
      "premiumRateId": 17,
      "companyNumber": "QA1",
      "classCode": "A",
      "dependentBand": 0,
      "coverageBand": "EMP_ONLY",
      "coverageLabel": "Employee only",
      "…": "7 more field(s)"
    },
    "… 3 more"
  ]
}
```

</details>

### 5.8 QA1's rate card on 1 November

Class A shows `source: COMPANY`; the other classes still `STANDARD`.

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
GET /v1/admin/rates?company=QA1&asOf=2026-11-01
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "companyNumber": "QA1",
  "asOf": "2026-11-01",
  "classes": [
    {
      "classCode": "A",
      "className": "Class A",
      "active": true,
      "tiers": [
        "… 4 item(s)"
      ]
    },
    "… 3 more"
  ]
}
```

</details>

### 5.9 Rate history for class D

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
GET /v1/admin/rates/history?classCode=D
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "rates": [
    {
      "premiumRateId": 13,
      "companyNumber": null,
      "classCode": "D",
      "dependentBand": 0,
      "coverageBand": "EMP_ONLY",
      "coverageLabel": "Employee only",
      "…": "7 more field(s)"
    },
    "… 3 more"
  ]
}
```

</details>

### 5.10 Annotate a rate row

Only `active` and `notes` can change; amounts never do.

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
PATCH /v1/admin/rates/{rateId}

{
  "notes": "Checked with the client",
  "reason": "QA walkthrough"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "premiumRateId": 13,
  "companyNumber": null,
  "classCode": "D",
  "dependentBand": 0,
  "coverageBand": "EMP_ONLY",
  "coverageLabel": "Employee only",
  "totalPremium": "8000.00",
  "companyPremium": "6400.00",
  "employeePremium": "1600.00",
  "…": "4 more field(s)"
}
```

</details>

### 5.11 QA1's billing rules (none yet)

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
GET /v1/admin/companies/QA1/billing-rules
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "rules": []
}
```

</details>

### 5.12 QA1 pays 80% of every premium from 1 October

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
POST /v1/admin/companies/QA1/billing-rules

{
  "companySharePercent": "80",
  "employeeSharePercent": "20",
  "effectiveDate": "2026-10-01",
  "reason": "QA1 contract"
}
```

**Expect:** `201 Created`

<details><summary>Response (trimmed)</summary>

```json
{
  "companyBillingRuleId": 1,
  "companyNumber": "QA1",
  "companySharePercent": "80.00",
  "employeeSharePercent": "20.00",
  "effectiveDate": "2026-10-01",
  "active": true,
  "notes": null,
  "createdAt": "2026-09-30T08:01:59.714Z"
}
```

</details>


## 6. Members, dependants and beneficiaries

*In the portal:* /admin/members, then open a member

### 6.1 Add a member with two dependants

Signed in as QA1's HR administrator. Class D is allowed now that it is priced.

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
POST /v1/admin/companies/QA1/members

{
  "idType": "NATIONAL ID",
  "idNumber": "QA-100001",
  "firstName": "Asha",
  "lastName": "Persaud",
  "dateOfBirth": "1988-04-12",
  "sex": "F",
  "classCode": "D",
  "email": "asha.persaud@qa1.test",
  "phone": "600-5551",
  "occupation": "Analyst",
  "dependants": [
    {
      "fullName": "Ravi Persaud",
      "relationship": "SON",
      "dateOfBirth": "2015-06-01"
    },
    {
      "fullName": "Dev Persaud",
      "relationship": "SPOUSE",
      "dateOfBirth": "1986-02-03"
    }
  ],
  "reason": "New hire"
}
```

**Expect:** `200 OK` — **save** `memberId` → `{memberId}`; `dependents[0].dependentId` → `{dependentId}`

<details><summary>Response (trimmed)</summary>

```json
{
  "memberId": 131,
  "companyNumber": "QA1",
  "companyName": "QA Test Company Ltd",
  "idType": "NATIONAL ID",
  "idNumber": "QA-100001",
  "firstName": "Asha",
  "lastName": "Persaud",
  "middleInitials": null,
  "dateOfBirth": "1988-04-12",
  "…": "23 more field(s)"
}
```

</details>

### 6.2 An ID type outside the Access list is refused

ID type is one of NATIONAL ID, PASSPORT or E-ID (shown as National ID, Passport, E-ID). The portal offers only those.

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
POST /v1/admin/companies/QA1/members

{
  "idType": "NID",
  "idNumber": "QA-100002",
  "firstName": "Wrong",
  "lastName": "Type",
  "dateOfBirth": "1990-01-01",
  "classCode": "A",
  "reason": "QA walkthrough"
}
```

**Expect:** `400 Bad Request`

<details><summary>Response (trimmed)</summary>

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "Check the form. ID type, ID number, first and last name, date of birth, class and a rea…"
  }
}
```

</details>

### 6.3 The same ID cannot be registered twice

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
POST /v1/admin/companies/QA1/members

{
  "idType": "NATIONAL ID",
  "idNumber": "QA-100001",
  "firstName": "Asha",
  "lastName": "Copy",
  "dateOfBirth": "1990-01-01",
  "classCode": "A",
  "reason": "Duplicate test"
}
```

**Expect:** `409 Conflict`

<details><summary>Response (trimmed)</summary>

```json
{
  "error": {
    "code": "ID_ALREADY_REGISTERED",
    "message": "This ID is already registered on the platform. Contact NALICO. (reference: f5dd53ebbf25…",
    "requestId": "f5dd53ebbf25427f",
    "detail": "Failed query: insert into \"bhi\".\"member\" (\"member_id\", \"id_type\", \"id_number\", \"company…"
  }
}
```

</details>

### 6.4 List QA1's members

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
GET /v1/admin/members?company=QA1
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "items": [
    {
      "memberId": 131,
      "companyNumber": "QA1",
      "companyName": "QA Test Company Ltd",
      "idType": "NATIONAL ID",
      "idNumber": "QA-100001",
      "firstName": "Asha",
      "…": "6 more field(s)"
    }
  ],
  "page": 1,
  "pageSize": 20,
  "totalItems": 1,
  "totalPages": 1
}
```

</details>

### 6.5 Search members by name

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
GET /v1/admin/members?q=Persaud&pageSize=10
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "items": [
    {
      "memberId": 40,
      "companyNumber": "BA",
      "companyName": "Beharry Automotive Ltd",
      "idType": "NATIONAL ID",
      "idNumber": "SYN-008576277",
      "firstName": "Aaron",
      "…": "6 more field(s)"
    },
    "… 9 more"
  ],
  "page": 1,
  "pageSize": 10,
  "totalItems": 10,
  "totalPages": 1
}
```

</details>

### 6.6 Member detail

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
GET /v1/admin/companies/QA1/members/{memberId}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "memberId": 131,
  "companyNumber": "QA1",
  "companyName": "QA Test Company Ltd",
  "idType": "NATIONAL ID",
  "idNumber": "QA-100001",
  "firstName": "Asha",
  "lastName": "Persaud",
  "middleInitials": null,
  "dateOfBirth": "1988-04-12",
  "…": "23 more field(s)"
}
```

</details>

### 6.7 Change occupation and class

A class change is recorded in the class history, so billing uses the class that applied on the 1st of each month.

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
PATCH /v1/admin/companies/QA1/members/{memberId}

{
  "occupation": "Senior Analyst",
  "classCode": "A",
  "reason": "Promotion"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "memberId": 131,
  "companyNumber": "QA1",
  "companyName": "QA Test Company Ltd",
  "idType": "NATIONAL ID",
  "idNumber": "QA-100001",
  "firstName": "Asha",
  "lastName": "Persaud",
  "middleInitials": null,
  "dateOfBirth": "1988-04-12",
  "…": "23 more field(s)"
}
```

</details>

### 6.8 Record the member's policy

Without a policy the member can sign in but sees "No active policy is on file" instead of a card.

*As:* super admin. `POLICY_MANAGE` belongs to the super admin alone; a client admin or HR administrator gets `403`.

```http
POST /v1/admin/companies/QA1/members/{memberId}/policy

{
  "policyholder": "QA Test Company Ltd",
  "policyNumber": "POL-QA-0001",
  "groupNumber": "GRP-QA1-01",
  "memberNumber": "M-QA-0001",
  "certificateNumber": "CERT-QA-0001",
  "planName": "Group Health Standard",
  "insurerName": "North American Life Insurance Co. Ltd.",
  "effectiveDate": "2026-01-01",
  "expiryDate": "2026-12-31",
  "reason": "Policy issued"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "memberId": 131,
  "companyNumber": "QA1",
  "companyName": "QA Test Company Ltd",
  "idType": "NATIONAL ID",
  "idNumber": "QA-100001",
  "firstName": "Asha",
  "lastName": "Persaud",
  "middleInitials": null,
  "dateOfBirth": "1988-04-12",
  "…": "23 more field(s)"
}
```

</details>

### 6.9 Add another dependant

The dependant starts active and counts from next month's bill; three dependants moves the member to the "more than two" tier.

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
POST /v1/admin/companies/QA1/members/{memberId}/dependents

{
  "fullName": "Anil Persaud",
  "relationship": "SON",
  "dateOfBirth": "2024-02-10",
  "sex": "M",
  "reason": "New baby"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "memberId": 131,
  "companyNumber": "QA1",
  "companyName": "QA Test Company Ltd",
  "idType": "NATIONAL ID",
  "idNumber": "QA-100001",
  "firstName": "Asha",
  "lastName": "Persaud",
  "middleInitials": null,
  "dateOfBirth": "1988-04-12",
  "…": "23 more field(s)"
}
```

</details>

### 6.10 Correct a dependant's name

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
PATCH /v1/admin/companies/QA1/members/{memberId}/dependents/{dependentId}

{
  "fullName": "Ravi K. Persaud",
  "reason": "Spelling"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "memberId": 131,
  "companyNumber": "QA1",
  "companyName": "QA Test Company Ltd",
  "idType": "NATIONAL ID",
  "idNumber": "QA-100001",
  "firstName": "Asha",
  "lastName": "Persaud",
  "middleInitials": null,
  "dateOfBirth": "1988-04-12",
  "…": "23 more field(s)"
}
```

</details>

### 6.11 Deactivate the dependant

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
POST /v1/admin/companies/QA1/members/{memberId}/dependents/{dependentId}/deactivate

{
  "reason": "No longer eligible",
  "effectiveDate": "2026-09-30"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "memberId": 131,
  "companyNumber": "QA1",
  "companyName": "QA Test Company Ltd",
  "idType": "NATIONAL ID",
  "idNumber": "QA-100001",
  "firstName": "Asha",
  "lastName": "Persaud",
  "middleInitials": null,
  "dateOfBirth": "1988-04-12",
  "…": "23 more field(s)"
}
```

</details>

### 6.12 Reactivate the dependant

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
POST /v1/admin/companies/QA1/members/{memberId}/dependents/{dependentId}/reactivate

{
  "reason": "Deactivated in error"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "memberId": 131,
  "companyNumber": "QA1",
  "companyName": "QA Test Company Ltd",
  "idType": "NATIONAL ID",
  "idNumber": "QA-100001",
  "firstName": "Asha",
  "lastName": "Persaud",
  "middleInitials": null,
  "dateOfBirth": "1988-04-12",
  "…": "23 more field(s)"
}
```

</details>

### 6.13 Add a beneficiary

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
POST /v1/admin/companies/QA1/members/{memberId}/beneficiaries

{
  "fullName": "Dev Persaud",
  "relationship": "SPOUSE",
  "dateOfBirth": "1986-02-03",
  "sharePercent": 100,
  "reason": "Nominated by the member"
}
```

**Expect:** `200 OK` — **save** `beneficiaries[0].beneficiaryId` → `{beneficiaryId}`

<details><summary>Response (trimmed)</summary>

```json
{
  "memberId": 131,
  "companyNumber": "QA1",
  "companyName": "QA Test Company Ltd",
  "idType": "NATIONAL ID",
  "idNumber": "QA-100001",
  "firstName": "Asha",
  "lastName": "Persaud",
  "middleInitials": null,
  "dateOfBirth": "1988-04-12",
  "…": "23 more field(s)"
}
```

</details>

### 6.14 Update the beneficiary

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
PATCH /v1/admin/companies/QA1/members/{memberId}/beneficiaries/{beneficiaryId}

{
  "phone": "600-5552",
  "reason": "New number"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "memberId": 131,
  "companyNumber": "QA1",
  "companyName": "QA Test Company Ltd",
  "idType": "NATIONAL ID",
  "idNumber": "QA-100001",
  "firstName": "Asha",
  "lastName": "Persaud",
  "middleInitials": null,
  "dateOfBirth": "1988-04-12",
  "…": "23 more field(s)"
}
```

</details>

### 6.15 Deactivate the beneficiary

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
POST /v1/admin/companies/QA1/members/{memberId}/beneficiaries/{beneficiaryId}/deactivate

{
  "reason": "Withdrawn by the member"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "memberId": 131,
  "companyNumber": "QA1",
  "companyName": "QA Test Company Ltd",
  "idType": "NATIONAL ID",
  "idNumber": "QA-100001",
  "firstName": "Asha",
  "lastName": "Persaud",
  "middleInitials": null,
  "dateOfBirth": "1988-04-12",
  "…": "23 more field(s)"
}
```

</details>

### 6.16 Reactivate the beneficiary

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
POST /v1/admin/companies/QA1/members/{memberId}/beneficiaries/{beneficiaryId}/reactivate

{
  "reason": "Reinstated"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "memberId": 131,
  "companyNumber": "QA1",
  "companyName": "QA Test Company Ltd",
  "idType": "NATIONAL ID",
  "idNumber": "QA-100001",
  "firstName": "Asha",
  "lastName": "Persaud",
  "middleInitials": null,
  "dateOfBirth": "1988-04-12",
  "…": "23 more field(s)"
}
```

</details>

### 6.17 Deactivate the member

Nothing is deleted: the member is marked inactive with a date and reason, and any open card stops working.

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
POST /v1/admin/companies/QA1/members/{memberId}/deactivate

{
  "reason": "Left the company",
  "effectiveDate": "2026-09-30"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "memberId": 131,
  "companyNumber": "QA1",
  "companyName": "QA Test Company Ltd",
  "idType": "NATIONAL ID",
  "idNumber": "QA-100001",
  "firstName": "Asha",
  "lastName": "Persaud",
  "middleInitials": null,
  "dateOfBirth": "1988-04-12",
  "…": "23 more field(s)"
}
```

</details>

### 6.18 Reactivate the member

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
POST /v1/admin/companies/QA1/members/{memberId}/reactivate

{
  "reason": "Rehired"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "memberId": 131,
  "companyNumber": "QA1",
  "companyName": "QA Test Company Ltd",
  "idType": "NATIONAL ID",
  "idNumber": "QA-100001",
  "firstName": "Asha",
  "lastName": "Persaud",
  "middleInitials": null,
  "dateOfBirth": "1988-04-12",
  "…": "23 more field(s)"
}
```

</details>


## 7. Bulk import and the fix list

*In the portal:* /admin/import and /admin/import-exceptions

### 7.1 Accepted sheet layouts

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
GET /v1/admin/import/layouts
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "layouts": [
    {
      "layout": "CARRIER",
      "label": "Members",
      "columns": [
        "… 22 item(s)"
      ],
      "description": "Members, matched on IDType + IDNumber so a re-import updates rather than duplicates. ID…"
    },
    "… 2 more"
  ]
}
```

</details>

### 7.2 Preview an import (dry run)

Three rows: Neil is fine; Maya has no ClassCode and Omar has no DateOfBirth (a new member needs one), so both will be held for HR to fix. Nothing is saved.

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
POST /v1/admin/import

{
  "csvText": "CompanyNumber,CompanyName,IDType,IDNumber,LastName,FirstName,MiddleInitials,DateOfBirth,Sex,ClassCode,AddressLine1,AddressLine2,Phone,Email,EmploymentDate,PlanDate,RateOfPay,Occupation,Active,InactiveDate,InactiveReason,Notes\nQA1,QA Test Company Ltd,National ID,QA-200001,Singh,Neil,,1990-07-15,M,B,,,,neil.singh@qa1.test,,,,,Yes,,,\nQA1,QA Test Company Ltd,National ID,QA-200002,Khan,Maya,,1990-07-15,M,,,,,maya.khan@qa1.test,,,,,Yes,,,\nQA1,QA Test Company Ltd,National ID,QA-200003,Baptiste,Omar,,,M,B,,,,omar.baptiste@qa1.test,,,,,Yes,,,",
  "fileName": "qa1-members.csv",
  "dryRun": true
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "dryRun": true,
  "layout": "CARRIER",
  "totalRows": 3,
  "okCount": 1,
  "warnCount": 0,
  "errorCount": 2,
  "duplicateCount": 0,
  "invalidPhoneCount": 0,
  "heldCount": 2,
  "…": "5 more field(s)"
}
```

</details>

### 7.3 Commit the import

Neil is created; Maya's and Omar's rows go to QA1's import exceptions.

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
POST /v1/admin/import

{
  "csvText": "CompanyNumber,CompanyName,IDType,IDNumber,LastName,FirstName,MiddleInitials,DateOfBirth,Sex,ClassCode,AddressLine1,AddressLine2,Phone,Email,EmploymentDate,PlanDate,RateOfPay,Occupation,Active,InactiveDate,InactiveReason,Notes\nQA1,QA Test Company Ltd,National ID,QA-200001,Singh,Neil,,1990-07-15,M,B,,,,neil.singh@qa1.test,,,,,Yes,,,\nQA1,QA Test Company Ltd,National ID,QA-200002,Khan,Maya,,1990-07-15,M,,,,,maya.khan@qa1.test,,,,,Yes,,,\nQA1,QA Test Company Ltd,National ID,QA-200003,Baptiste,Omar,,,M,B,,,,omar.baptiste@qa1.test,,,,,Yes,,,",
  "fileName": "qa1-members.csv",
  "dryRun": false
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "dryRun": false,
  "layout": "CARRIER",
  "totalRows": 3,
  "okCount": 1,
  "warnCount": 0,
  "errorCount": 2,
  "duplicateCount": 0,
  "invalidPhoneCount": 0,
  "heldCount": 2,
  "…": "5 more field(s)"
}
```

</details>

### 7.4 QA1's import exceptions (the fix list)

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
GET /v1/admin/companies/QA1/import-exceptions?status=OPEN
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "companyNumber": "QA1",
  "openCount": 2,
  "resolvedCount": 0,
  "exceptions": [
    {
      "exceptionId": 2,
      "entityType": "MEMBER",
      "personName": "Omar Baptiste",
      "memberIdentifier": "QA-200003",
      "reasonCodes": [
        "… 1 item(s)"
      ],
      "reason": "DateOfBirth is required for a new member (cover ends at 65).",
      "…": "13 more field(s)"
    },
    "… 1 more"
  ]
}
```

</details>

### 7.5 Upload the corrected row

`resolvedExceptions` lists Maya's held record as fixed.

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
POST /v1/admin/import

{
  "csvText": "CompanyNumber,CompanyName,IDType,IDNumber,LastName,FirstName,MiddleInitials,DateOfBirth,Sex,ClassCode,AddressLine1,AddressLine2,Phone,Email,EmploymentDate,PlanDate,RateOfPay,Occupation,Active,InactiveDate,InactiveReason,Notes\nQA1,QA Test Company Ltd,National ID,QA-200002,Khan,Maya,,1990-07-15,M,C,,,,maya.khan@qa1.test,,,,,Yes,,,",
  "fileName": "qa1-fix.csv",
  "dryRun": false
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "dryRun": false,
  "layout": "CARRIER",
  "totalRows": 1,
  "okCount": 1,
  "warnCount": 0,
  "errorCount": 0,
  "duplicateCount": 0,
  "invalidPhoneCount": 0,
  "heldCount": 0,
  "…": "5 more field(s)"
}
```

</details>

### 7.6 Omar is still held, for his date of birth

Reason code MISSING_DATE_OF_BIRTH.

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
GET /v1/admin/companies/QA1/import-exceptions?status=OPEN
```

**Expect:** `200 OK` — **save** Omar's `exceptionId` → `{omarExceptionId}`

<details><summary>Response (trimmed)</summary>

```json
{
  "companyNumber": "QA1",
  "openCount": 1,
  "resolvedCount": 1,
  "exceptions": [
    {
      "exceptionId": 2,
      "entityType": "MEMBER",
      "personName": "Omar Baptiste",
      "memberIdentifier": "QA-200003",
      "reasonCodes": [
        "… 1 item(s)"
      ],
      "reason": "DateOfBirth is required for a new member (cover ends at 65).",
      "…": "13 more field(s)"
    }
  ]
}
```

</details>

### 7.7 Mark a held record resolved by hand

For a record fixed another way or no longer needed. Nothing is loaded; the note is kept, and the record shows as resolved by hand (`resolutionMethod` MANUAL).

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
POST /v1/admin/companies/QA1/import-exceptions/{omarExceptionId}/resolve

{
  "note": "Omar has left; not joining the plan"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "exceptionId": 2,
  "entityType": "MEMBER",
  "personName": "Omar Baptiste",
  "memberIdentifier": "QA-200003",
  "reasonCodes": [
    "MISSING_DATE_OF_BIRTH"
  ],
  "reason": "DateOfBirth is required for a new member (cover ends at 65).",
  "requiredAction": "Fill in DateOfBirth (a new member needs one; cover ends at 65). Then upload the correct…",
  "source": "BULK_IMPORT",
  "sourceFile": "QA1-20260930-0001.csv",
  "…": "10 more field(s)"
}
```

</details>

### 7.8 …only once

`ALREADY_RESOLVED`.

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
POST /v1/admin/companies/QA1/import-exceptions/{omarExceptionId}/resolve

{
  "note": "Again"
}
```

**Expect:** `400 Bad Request`

<details><summary>Response (trimmed)</summary>

```json
{
  "error": {
    "code": "ALREADY_RESOLVED",
    "message": "This exception has already been resolved."
  }
}
```

</details>

### 7.9 The old 8-column layout is refused

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
POST /v1/admin/import

{
  "csvText": "employeeNumber,firstName,lastName,dateOfBirth,identificationId,email,phone,companyCode\nE1,A,B,1990-01-01,X1,a@b.test,,QA1",
  "dryRun": true
}
```

**Expect:** `400 Bad Request`

<details><summary>Response (trimmed)</summary>

```json
{
  "error": {
    "code": "LAYOUT_WITHDRAWN",
    "message": "Sheet \"Pasted\" uses the old short members layout, which is no longer accepted: it has n…"
  }
}
```

</details>


## 8. Employee card and change requests (the public side)

*In the portal:* http://localhost:3000/ → Find my card

### 8.1 Look up a card by email

With OTP_DEV_MODE=true the code comes back as `devCode`; in production it is emailed or texted.

*As:* no sign-in needed

```http
POST /v1/lookup

{
  "identifier": "asha.persaud@qa1.test"
}
```

**Expect:** `200 OK` — **save** `verificationId` and `devCode`

<details><summary>Response (trimmed)</summary>

```json
{
  "status": "CODE_SENT",
  "message": "If this contact is on file, a 6-digit code has been sent.",
  "verificationId": "985fc8bb-d5a3-4cb8-9a77-5f746d18c105",
  "maskedDestination": "a•••••••••••@q••.test",
  "lookupRef": null,
  "options": null,
  "devCode": "027769"
}
```

</details>

### 8.2 Resend the code (too soon)

A resend is allowed once a minute; within the minute it answers 429 RESEND_TOO_SOON.

*As:* no sign-in needed

```http
POST /v1/otp/resend

{
  "verificationId": "<verificationId>"
}
```

**Expect:** `429 Too Many Requests`

<details><summary>Response (trimmed)</summary>

```json
{
  "error": {
    "code": "RESEND_TOO_SOON",
    "message": "Wait a minute before requesting another code."
  }
}
```

</details>

### 8.3 Verify the code

`status: CARD` and a `cardToken` for the next calls.

*As:* no sign-in needed

```http
POST /v1/otp/verify

{
  "verificationId": "<verificationId>",
  "code": "<devCode>"
}
```

**Expect:** `200 OK` — **save** `cardToken` → send as `Authorization: Bearer <cardToken>`

<details><summary>Response (trimmed)</summary>

```json
{
  "status": "CARD",
  "cardToken": "<token>",
  "expiresAt": "2026-09-30T08:17:01.229Z",
  "confirm": {
    "firstName": "Asha",
    "maskedIdentifier": "a•••••••••••@q••.test",
    "companyName": "QA Test Company Ltd"
  },
  "options": null,
  "message": null
}
```

</details>

### 8.4 Show the card

*As:* the employee's `cardToken`

```http
GET /v1/card
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "insurerName": "North American Life Insurance Co. Ltd.",
  "planName": "Group Health Standard",
  "policyholder": "QA Test Company Ltd",
  "policyNumber": "POL-QA-0001",
  "groupNumber": "GRP-QA1-01",
  "memberId": "M-QA-0001",
  "certificateNumber": "CERT-QA-0001",
  "employeeName": "Asha Persaud",
  "identificationId": "QA-100001",
  "…": "8 more field(s)"
}
```

</details>

### 8.5 Raise a change request (with a supporting document)

`contentBase64` is the file, Base64-encoded (a PDF, JPEG or PNG up to 5 MB).

*As:* the employee's `cardToken`

```http
POST /v1/card/change-requests

{
  "dependentId": null,
  "requestedFirstName": "Aasha",
  "requestedLastName": null,
  "requestedDateOfBirth": null,
  "requestedRelationship": null,
  "employeeNote": "My name is spelled Aasha",
  "document": {
    "documentType": "NATIONAL_ID",
    "fileName": "national-id.pdf",
    "mimeType": "application/pdf",
    "contentBase64": "JVBERi0xLjQKMSAwIG9iajw8Pj5lbmRvYmoKdHJhaWxlcjw8Pj4KJSVFT0YK"
  }
}
```

**Expect:** `200 OK` — **save** `id` → `{crId}`

<details><summary>Response (trimmed)</summary>

```json
{
  "id": "455d8934-be48-4932-9806-13aec17b5591",
  "subjectType": "MEMBER",
  "subjectName": "Asha Persaud",
  "requestedFirstName": "Aasha",
  "requestedLastName": null,
  "requestedDateOfBirth": null,
  "requestedRelationship": null,
  "employeeNote": "My name is spelled Aasha",
  "status": "PENDING",
  "…": "4 more field(s)"
}
```

</details>

### 8.6 The employee's own requests

*As:* the employee's `cardToken`

```http
GET /v1/card/change-requests
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
[
  {
    "id": "455d8934-be48-4932-9806-13aec17b5591",
    "subjectType": "MEMBER",
    "subjectName": "Asha Persaud",
    "requestedFirstName": "Aasha",
    "requestedLastName": null,
    "requestedDateOfBirth": null,
    "…": "7 more field(s)"
  }
]
```

</details>


## 9. Reviewing change requests

*In the portal:* /admin/change-requests

### 9.1 Pending change requests

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
GET /v1/admin/change-requests?status=PENDING
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "items": [
    {
      "id": "455d8934-be48-4932-9806-13aec17b5591",
      "memberId": 131,
      "memberName": "Asha Persaud",
      "companyNumber": "QA1",
      "companyName": "QA Test Company Ltd",
      "subjectType": "MEMBER",
      "…": "7 more field(s)"
    }
  ],
  "page": 1,
  "pageSize": 20,
  "totalItems": 1,
  "totalPages": 1
}
```

</details>

### 9.2 Change request detail

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
GET /v1/admin/change-requests/{crId}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "id": "455d8934-be48-4932-9806-13aec17b5591",
  "memberId": 131,
  "memberName": "Asha Persaud",
  "companyNumber": "QA1",
  "companyName": "QA Test Company Ltd",
  "subjectType": "MEMBER",
  "subjectName": "Asha Persaud",
  "dependentId": null,
  "changes": [
    {
      "field": "firstName",
      "current": "Asha",
      "requested": "Aasha"
    }
  ],
  "…": "7 more field(s)"
}
```

</details>

### 9.3 View the supporting document

Returns the file as Base64. Viewing it is itself recorded in the activity log.

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
GET /v1/admin/change-requests/{crId}/document
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "fileName": "national-id.pdf",
  "mimeType": "application/pdf",
  "byteSize": 45,
  "contentBase64": "<base64 file>"
}
```

</details>

### 9.4 Approve it

The member's first name is now Aasha.

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
POST /v1/admin/change-requests/{crId}/approve

{
  "note": "Matches the national ID"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "id": "455d8934-be48-4932-9806-13aec17b5591",
  "memberId": 131,
  "memberName": "Aasha Persaud",
  "companyNumber": "QA1",
  "companyName": "QA Test Company Ltd",
  "subjectType": "MEMBER",
  "subjectName": "Asha Persaud",
  "dependentId": null,
  "changes": [
    {
      "field": "firstName",
      "current": "Asha",
      "requested": "Aasha"
    }
  ],
  "…": "7 more field(s)"
}
```

</details>

### 9.5 The employee raises a second request

*As:* the employee's `cardToken`

```http
POST /v1/card/change-requests

{
  "dependentId": null,
  "requestedFirstName": null,
  "requestedLastName": null,
  "requestedDateOfBirth": "1988-04-21",
  "requestedRelationship": null,
  "employeeNote": "Date of birth is wrong",
  "document": {
    "documentType": "BIRTH_CERTIFICATE",
    "fileName": "birth.pdf",
    "mimeType": "application/pdf",
    "contentBase64": "JVBERi0xLjQKMSAwIG9iajw8Pj5lbmRvYmoKdHJhaWxlcjw8Pj4KJSVFT0YK"
  }
}
```

**Expect:** `200 OK` — **save** `id` → `{crId2}`

<details><summary>Response (trimmed)</summary>

```json
{
  "id": "a9c50e9f-dfd6-41db-bd3f-663e19e6845d",
  "subjectType": "MEMBER",
  "subjectName": "Aasha Persaud",
  "requestedFirstName": null,
  "requestedLastName": null,
  "requestedDateOfBirth": "1988-04-21",
  "requestedRelationship": null,
  "employeeNote": "Date of birth is wrong",
  "status": "PENDING",
  "…": "4 more field(s)"
}
```

</details>

### 9.6 Reject it

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
POST /v1/admin/change-requests/{crId2}/reject

{
  "note": "The certificate does not match the requested date"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "id": "a9c50e9f-dfd6-41db-bd3f-663e19e6845d",
  "memberId": 131,
  "memberName": "Aasha Persaud",
  "companyNumber": "QA1",
  "companyName": "QA Test Company Ltd",
  "subjectType": "MEMBER",
  "subjectName": "Aasha Persaud",
  "dependentId": null,
  "changes": [
    {
      "field": "dateOfBirth",
      "current": "1988-04-12",
      "requested": "1988-04-21"
    }
  ],
  "…": "7 more field(s)"
}
```

</details>


## 10. More card lookups: shared phone, two companies, lockout

*In the portal:* http://localhost:3000/

### 10.1 Shared phone in one company: code first, then choose the record

*As:* no sign-in needed

```http
POST /v1/lookup

{
  "identifier": "+5925550123"
}
```

**Expect:** `200 OK` — **save** `verificationId` and `devCode`

<details><summary>Response (trimmed)</summary>

```json
{
  "status": "CODE_SENT",
  "message": "If this contact is on file, a 6-digit code has been sent.",
  "verificationId": "b56140d6-1808-455d-9a60-d6a13549dd7a",
  "maskedDestination": "•••-••23",
  "lookupRef": null,
  "options": null,
  "devCode": "700810"
}
```

</details>

### 10.2 Verify: several records → SELECT

*As:* no sign-in needed

```http
POST /v1/otp/verify

{
  "verificationId": "<verificationId>",
  "code": "<devCode>"
}
```

**Expect:** `200 OK` — **save** `options[0].ref` → `optionRef`

<details><summary>Response (trimmed)</summary>

```json
{
  "status": "SELECT",
  "cardToken": null,
  "expiresAt": null,
  "confirm": null,
  "options": [
    {
      "ref": "<token>",
      "label": "W•••• A•••, born 19••-08"
    },
    "… 4 more"
  ],
  "message": null
}
```

</details>

### 10.3 Choose one record → CARD

*As:* no sign-in needed

```http
POST /v1/otp/select

{
  "verificationId": "<verificationId>",
  "optionRef": "<options[0].ref>"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "status": "CARD",
  "cardToken": "<token>",
  "expiresAt": "2026-09-30T08:17:02.258Z",
  "confirm": {
    "firstName": "Wendy",
    "maskedIdentifier": "•••-••23",
    "companyName": "Beharry Foods Ltd"
  },
  "options": null,
  "message": null
}
```

</details>

### 10.4 Same email in two companies

*As:* no sign-in needed

```http
POST /v1/lookup

{
  "identifier": "shared.contact@bhi-demo.test"
}
```

**Expect:** `200 OK` — **save** `verificationId` and `devCode`

<details><summary>Response (trimmed)</summary>

```json
{
  "status": "CODE_SENT",
  "message": "If this contact is on file, a 6-digit code has been sent.",
  "verificationId": "9974a137-c236-4c9a-80f8-f42bf28b64d1",
  "maskedDestination": "s•••••••••••••@b•••••••.test",
  "lookupRef": null,
  "options": null,
  "devCode": "955841"
}
```

</details>

### 10.5 Verify: MULTI_COMPANY (no card, an alert for NALICO)

*As:* no sign-in needed

```http
POST /v1/otp/verify

{
  "verificationId": "<verificationId>",
  "code": "<devCode>"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "status": "MULTI_COMPANY",
  "cardToken": null,
  "expiresAt": null,
  "confirm": null,
  "options": null,
  "message": "Your details were found in more than one company. Please contact your HR department."
}
```

</details>

### 10.6 Lock a session: start a lookup…

*As:* no sign-in needed

```http
POST /v1/lookup

{
  "identifier": "wendy.ali1001@bhi-demo.test"
}
```

**Expect:** `200 OK` — **save** `verificationId` → `{vid4}`

<details><summary>Response (trimmed)</summary>

```json
{
  "status": "CODE_SENT",
  "message": "If this contact is on file, a 6-digit code has been sent.",
  "verificationId": "19fcb483-3793-47b5-b9a2-5680b46253b2",
  "maskedDestination": "w••••••••••••@b•••••••.test",
  "lookupRef": null,
  "options": null,
  "devCode": "347834"
}
```

</details>

### 10.7 …and enter a wrong code three times (1)

*As:* no sign-in needed

```http
POST /v1/otp/verify

{
  "verificationId": "<verificationId>",
  "code": "<devCode>"
}
```

**Expect:** `400 Bad Request`

<details><summary>Response (trimmed)</summary>

```json
{
  "error": {
    "code": "CODE_INVALID",
    "message": "That code is not correct. 2 attempts left."
  }
}
```

</details>

### 10.8 (2)

*As:* no sign-in needed

```http
POST /v1/otp/verify

{
  "verificationId": "<verificationId>",
  "code": "<devCode>"
}
```

**Expect:** `400 Bad Request`

<details><summary>Response (trimmed)</summary>

```json
{
  "error": {
    "code": "CODE_INVALID",
    "message": "That code is not correct. 1 attempt left."
  }
}
```

</details>

### 10.9 (3) the session is now locked

*As:* no sign-in needed

```http
POST /v1/otp/verify

{
  "verificationId": "<verificationId>",
  "code": "<devCode>"
}
```

**Expect:** `423 Locked`

<details><summary>Response (trimmed)</summary>

```json
{
  "error": {
    "code": "SESSION_LOCKED",
    "message": "Too many incorrect attempts. Start the lookup again in a few minutes."
  }
}
```

</details>


## 11. Lookup alerts, verifications and the activity log

*In the portal:* /admin/lookup-alerts, /admin/verifications and /admin/audit

### 11.1 Multi-company lookup alerts

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
GET /v1/admin/lookup-alerts?status=OPEN
```

**Expect:** `200 OK` — **save** `[0].id` → `{alertId}`

<details><summary>Response (trimmed)</summary>

```json
[
  {
    "id": "9974a137-c236-4c9a-80f8-f42bf28b64d1",
    "lookupChannel": "EMAIL",
    "maskedContact": "s•••••••••••••@b•••••••.test",
    "matches": [
      "… 2 item(s)"
    ],
    "status": "OPEN",
    "resolvedBy": null,
    "…": "3 more field(s)"
  }
]
```

</details>

### 11.2 Resolve the alert

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
POST /v1/admin/lookup-alerts/{alertId}/resolve

{
  "note": "HR at both companies contacted"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "id": "9974a137-c236-4c9a-80f8-f42bf28b64d1",
  "lookupChannel": "EMAIL",
  "maskedContact": "s•••••••••••••@b•••••••.test",
  "matches": [
    {
      "companyNumber": "BF",
      "companyName": "Beharry Foods Ltd",
      "memberId": 21
    },
    "… 1 more"
  ],
  "status": "RESOLVED",
  "resolvedBy": "platform.admin@bhi-demo.test",
  "resolutionNote": "HR at both companies contacted",
  "resolvedAt": "2026-09-30T08:02:03.999Z",
  "createdAt": "2026-09-30T08:02:03.090Z"
}
```

</details>

### 11.3 Verification sessions

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
GET /v1/admin/verifications?pageSize=10
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "items": [
    {
      "id": "19fcb483-3793-47b5-b9a2-5680b46253b2",
      "lookupChannel": "EMAIL",
      "maskedDestination": "w••••••••••••@b•••••••.test",
      "companyCode": "BF",
      "status": "LOCKED",
      "attempts": 3,
      "…": "2 more field(s)"
    },
    "… 3 more"
  ],
  "page": 1,
  "pageSize": 10,
  "totalItems": 4,
  "totalPages": 1
}
```

</details>

### 11.4 Unlock the locked session

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
POST /v1/admin/verifications/{vid4}/reset-lock

{
  "reason": "Employee confirmed by phone"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "id": "19fcb483-3793-47b5-b9a2-5680b46253b2",
  "status": "PENDING",
  "attempts": 0,
  "expiresAt": "2026-09-30T08:07:04.035Z",
  "message": "Unlocked. Ask the member to enter the code they already received, or to request a new one."
}
```

</details>

### 11.5 Activity log (latest 5)

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
GET /v1/admin/audit?pageSize=5
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "items": [
    {
      "id": "0292d0ce-52f2-49bb-a8da-5cff26180b1f",
      "actor": "platform.admin@bhi-demo.test",
      "actorRole": "ROLE_PLATFORM_ADMIN",
      "action": "VERIFICATION_UNLOCKED",
      "entityType": "VERIFICATION",
      "entityId": "19fcb483-3793-47b5-b9a2-5680b46253b2",
      "…": "5 more field(s)"
    },
    "… 4 more"
  ],
  "page": 1,
  "pageSize": 5,
  "totalItems": 88,
  "totalPages": 18
}
```

</details>

### 11.6 Activity log filtered by action

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
GET /v1/admin/audit?action=MEMBER_CREATED&pageSize=5
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "items": [
    {
      "id": "5e45c3f8-2363-4f52-82e5-b67f261f7f7b",
      "actor": "hr@qa1.test",
      "actorRole": "ROLE_HR_ADMIN",
      "action": "MEMBER_CREATED",
      "entityType": "MEMBER",
      "entityId": "131",
      "…": "5 more field(s)"
    }
  ],
  "page": 1,
  "pageSize": 5,
  "totalItems": 1,
  "totalPages": 1
}
```

</details>


## 12. Monthly billing

*In the portal:* /admin/billing

### 12.1 Generate October's bill for QA1

Priced from each member's state at 00:00 on 1 October (Guyana time), with QA1's 80/20 split.

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
POST /v1/admin/billing/runs

{
  "month": "2026-10",
  "companies": [
    "QA1"
  ]
}
```

**Expect:** `200 OK` — **save** `results[0].runId`

<details><summary>Response (trimmed)</summary>

```json
{
  "month": "2026-10",
  "results": [
    {
      "companyNumber": "QA1",
      "status": "DRAFT",
      "runId": 1,
      "lines": 3,
      "issues": 0,
      "totals": "{…}",
      "…": "2 more field(s)"
    }
  ]
}
```

</details>

### 12.2 Generate October for every company

Recalculating replaces QA1's earlier draft (it becomes SUPERSEDED).

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
POST /v1/admin/billing/runs

{
  "month": "2026-10",
  "companies": "ALL"
}
```

**Expect:** `200 OK` — **save** QA1's `runId` → `{runId}`

<details><summary>Response (trimmed)</summary>

```json
{
  "month": "2026-10",
  "results": [
    {
      "companyNumber": "BA",
      "status": "DRAFT",
      "runId": 2,
      "lines": 25,
      "issues": 0,
      "totals": "{…}",
      "…": "2 more field(s)"
    },
    "… 7 more"
  ]
}
```

</details>

### 12.3 October's runs

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
GET /v1/admin/billing/runs?month=2026-10
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "runs": [
    {
      "billingRunId": 2,
      "companyNumber": "BA",
      "companyName": "Beharry Automotive Ltd",
      "billingMonth": "2026-10",
      "billingDate": "2026-09-30",
      "generatedAt": "2026-09-30T08:02:04.121Z",
      "…": "5 more field(s)"
    },
    "… 7 more"
  ]
}
```

</details>

### 12.4 One run in detail

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
GET /v1/admin/billing/runs/{runId}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "run": {
    "billingRunId": 8,
    "companyNumber": "QA1",
    "companyName": "QA Test Company Ltd",
    "billingMonth": "2026-10",
    "billingDate": "2026-09-30",
    "generatedAt": "2026-09-30T08:02:04.121Z",
    "…": "5 more field(s)"
  },
  "totalsByClassTier": [
    {
      "classCode": "A",
      "dependentBand": 3,
      "coverageBand": "EMP_PLUS_3PLUS",
      "coverageLabel": "Employee + 3 or more dependents",
      "headcount": 1,
      "totalPremium": "14000.00",
      "…": "2 more field(s)"
    },
    "… 2 more"
  ],
  "lines": [
    {
      "billingLineId": 117,
      "memberId": 131,
      "idType": "NATIONAL ID",
      "idNumber": "QA-100001",
      "memberName": "Aasha Persaud",
      "classCode": "A",
      "…": "9 more field(s)"
    },
    "… 2 more"
  ],
  "issues": []
}
```

</details>

### 12.5 Export the run as CSV

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
GET /v1/admin/billing/runs/{runId}/export.csv
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```csv
CompanyNumber,BillingMonth,RunStatus,MemberID,IDType,IDNumber,MemberName,ClassCode,ActiveDependentCount,CoverageBand,CoverageLabel,TotalPremium,CompanyPremium,EmployeePremium,RateEffectiveDate,PremiumRateID,RateSource
QA1,2026-10,DRAFT,131,NATIONAL ID,QA-100001,Aasha Persaud,A,3,EMP_PLUS_3PLUS,Employee + 3 or more dependents,14000.00,11200.00,2800.00,2026-10-01,4,STANDARD
QA1,2026-10,DRAFT,134,N
```

</details>

### 12.6 Finalise the run

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
POST /v1/admin/billing/runs/{runId}/finalise

{
  "reason": "October approved by QA1"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "billingRunId": 8,
  "companyNumber": "QA1",
  "companyName": "QA Test Company Ltd",
  "billingMonth": "2026-10",
  "billingDate": "2026-09-30",
  "generatedAt": "2026-09-30T08:02:04.121Z",
  "generatedBy": "platform.admin@bhi-demo.test",
  "status": "FINAL",
  "lineCount": 3,
  "…": "2 more field(s)"
}
```

</details>

### 12.7 A final month is not recalculated

The result for QA1 is `ALREADY_FINAL`.

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
POST /v1/admin/billing/runs

{
  "month": "2026-10",
  "companies": [
    "QA1"
  ]
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "month": "2026-10",
  "results": [
    {
      "companyNumber": "QA1",
      "status": "ALREADY_FINAL",
      "runId": 8,
      "lines": null,
      "issues": null,
      "totals": null,
      "…": "2 more field(s)"
    }
  ]
}
```

</details>


## 13. Who can see what

*In the portal:* sign in to the portal as each user

### 13.1 HR sees only its own company

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
GET /v1/admin/companies
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
[
  {
    "companyNumber": "QA1",
    "companyName": "QA Test Company Ltd",
    "active": true,
    "address1": "1 Main Street",
    "address2": null,
    "city": "Georgetown",
    "…": "6 more field(s)"
  }
]
```

</details>

### 13.2 HR cannot open another company's member

Out of scope reads as 404, so it does not even reveal that the member exists.

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
GET /v1/admin/companies/BF/members/1
```

**Expect:** `404 Not Found`

<details><summary>Response (trimmed)</summary>

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Member not found."
  }
}
```

</details>

### 13.3 HR cannot add classes

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
POST /v1/admin/classes

{
  "classCode": "E",
  "className": "Class E",
  "reason": "Not allowed"
}
```

**Expect:** `403 Forbidden`

<details><summary>Response (trimmed)</summary>

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have permission to perform this action."
  }
}
```

</details>

### 13.4 HR cannot see bills

*As:* QA1 HR administrator (`hr@qa1.test`)

```http
GET /v1/admin/billing/runs
```

**Expect:** `403 Forbidden`

<details><summary>Response (trimmed)</summary>

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have permission to perform this action."
  }
}
```

</details>

### 13.5 The client admin adds a second HR user for QA1

*As:* QA1 client admin (`client.admin@qa1.test`)

```http
POST /v1/admin/users

{
  "email": "hr2@qa1.test",
  "displayName": "QA1 HR 2",
  "role": "ROLE_HR_ADMIN",
  "companyScope": "QA1"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "user": {
    "id": "9ad6392a-1ee3-4b77-a936-08a19e327b84",
    "email": "hr2@qa1.test",
    "displayName": "QA1 HR 2",
    "role": "ROLE_HR_ADMIN",
    "roleLabel": "HR administrator",
    "companyScope": "QA1",
    "…": "2 more field(s)"
  },
  "temporaryPassword": "<shown once>"
}
```

</details>

### 13.6 …but not for another company

*As:* QA1 client admin (`client.admin@qa1.test`)

```http
POST /v1/admin/users

{
  "email": "hr3@qa1.test",
  "displayName": "QA1 HR 3",
  "role": "ROLE_HR_ADMIN",
  "companyScope": "BF"
}
```

**Expect:** `403 Forbidden`

<details><summary>Response (trimmed)</summary>

```json
{
  "error": {
    "code": "ROLE_NOT_GRANTABLE",
    "message": "You can create client admins and HR administrators for your own company only."
  }
}
```

</details>

### 13.7 The client admin sees QA1's bills only

*As:* QA1 client admin (`client.admin@qa1.test`)

```http
GET /v1/admin/billing/runs
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "runs": [
    {
      "billingRunId": 8,
      "companyNumber": "QA1",
      "companyName": "QA Test Company Ltd",
      "billingMonth": "2026-10",
      "billingDate": "2026-09-30",
      "generatedAt": "2026-09-30T08:02:04.121Z",
      "…": "5 more field(s)"
    }
  ]
}
```

</details>

### 13.8 Sign in as support (read-only)

*As:* no sign-in needed

```http
POST /v1/admin/auth/login

{
  "email": "support@bhi-demo.test",
  "password": "Demo@2026"
}
```

**Expect:** `200 OK` — **save** `token` → the support token

<details><summary>Response (trimmed)</summary>

```json
{
  "token": "<token>",
  "role": "ROLE_SUPPORT",
  "scope": null,
  "displayName": "Samir Support",
  "permissions": [
    "MEMBER_READ_SCOPED",
    "… 3 more"
  ],
  "mustChangePassword": false
}
```

</details>

### 13.9 Support cannot change a member

*As:* support (`support@bhi-demo.test`)

```http
PATCH /v1/admin/companies/QA1/members/{memberId}

{
  "occupation": "x",
  "reason": "Not allowed"
}
```

**Expect:** `403 Forbidden`

<details><summary>Response (trimmed)</summary>

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have permission to perform this action."
  }
}
```

</details>

### 13.10 Sign in as a Beharry company's client admin

Each company has its own client admin. This one belongs to Beharry Foods (BF).

*As:* no sign-in needed

```http
POST /v1/admin/auth/login

{
  "email": "client.foods@bhi-demo.test",
  "password": "Demo@2026"
}
```

**Expect:** `200 OK` — **save** `token` → the BF client admin token

<details><summary>Response (trimmed)</summary>

```json
{
  "token": "<token>",
  "role": "ROLE_CLIENT_ADMIN",
  "scope": "BF",
  "displayName": "Grace Foods Client Admin",
  "permissions": [
    "MEMBER_READ_SCOPED",
    "… 16 more"
  ],
  "mustChangePassword": false
}
```

</details>

### 13.11 It sees BF only, not its sister companies

The list holds BF alone. The other five Beharry companies are separate clients as far as the portal is concerned.

*As:* BF client admin (`client.foods@bhi-demo.test`)

```http
GET /v1/admin/companies
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
[
  {
    "companyNumber": "BF",
    "companyName": "Beharry Foods Ltd",
    "active": true,
    "address1": null,
    "address2": null,
    "city": null,
    "…": "6 more field(s)"
  }
]
```

</details>

### 13.12 …and cannot open a sister company's member

*As:* BF client admin (`client.foods@bhi-demo.test`)

```http
GET /v1/admin/companies/BA/members/1
```

**Expect:** `404 Not Found`

<details><summary>Response (trimmed)</summary>

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Member not found."
  }
}
```

</details>

### 13.13 Lookup alerts are for the super admin only

An alert names members of more than one company, so no company-level admin sees it.

*As:* BF client admin (`client.foods@bhi-demo.test`)

```http
GET /v1/admin/lookup-alerts
```

**Expect:** `403 Forbidden`

<details><summary>Response (trimmed)</summary>

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have permission to perform this action."
  }
}
```

</details>

### 13.14 The group admin role no longer exists

Not even a super admin can create one: the only roles are super admin, client admin, HR administrator, support and auditor.

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
POST /v1/admin/users

{
  "email": "group@qa1.test",
  "displayName": "Group Admin",
  "role": "ROLE_HR_GROUP_ADMIN",
  "companyScope": null
}
```

**Expect:** `400 Bad Request`

<details><summary>Response (trimmed)</summary>

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "Provide an email, a display name, a role, and its scope."
  }
}
```

</details>


## 14. Offboarding a company

*In the portal:* /admin/companies

### 14.1 Offboard QA1

QA1's records are kept but can no longer be changed, and its admins are deactivated.

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
POST /v1/admin/companies/QA1/offboard

{
  "reason": "Contract ended"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "companyNumber": "QA1",
  "companyName": "QA Test Company Ltd",
  "active": false,
  "address1": "1 Main Street",
  "address2": null,
  "city": "Georgetown",
  "contactName": "Priya Test",
  "contactPhone": "592-600-0000",
  "contactEmail": "office@qa1.test",
  "…": "3 more field(s)"
}
```

</details>

### 14.2 Changes to an offboarded company are refused

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
PATCH /v1/admin/companies/QA1/members/{memberId}

{
  "occupation": "x",
  "reason": "Should be refused"
}
```

**Expect:** `409 Conflict`

<details><summary>Response (trimmed)</summary>

```json
{
  "error": {
    "code": "COMPANY_INACTIVE",
    "message": "QA Test Company Ltd has been offboarded; its records can no longer be changed."
  }
}
```

</details>

### 14.3 Reactivate QA1

*As:* super admin (`platform.admin@bhi-demo.test`)

```http
POST /v1/admin/companies/QA1/reactivate

{
  "reason": "Contract renewed"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "companyNumber": "QA1",
  "companyName": "QA Test Company Ltd",
  "active": true,
  "address1": "1 Main Street",
  "address2": null,
  "city": "Georgetown",
  "contactName": "Priya Test",
  "contactPhone": "592-600-0000",
  "contactEmail": "office@qa1.test",
  "…": "3 more field(s)"
}
```

</details>


## 15. Help assistant and signing out

*In the portal:* http://localhost:3000/ (the help chat)

### 15.1 Help assistant (public)

*As:* no sign-in needed

```http
POST /v1/assistant/ask

{
  "message": "How do I get my card?"
}
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "reply": "To get your digital health card, click \"Find my card\" on this page, enter the email or …",
  "matched": true
}
```

</details>

### 15.2 Sign out of the card

*As:* the employee's `cardToken`

```http
POST /v1/session/logout
```

**Expect:** `200 OK`

<details><summary>Response (trimmed)</summary>

```json
{
  "ok": true
}
```

</details>

### 15.3 The card token no longer works

*As:* the employee's `cardToken`

```http
GET /v1/card
```

**Expect:** `401 Unauthorized`

<details><summary>Response (trimmed)</summary>

```json
{
  "error": {
    "code": "SESSION_EXPIRED",
    "message": "Your card session has ended. Verify again to view your card."
  }
}
```

</details>

---

## API coverage

Every route the API serves appears above at least once:

| Area | Routes |
|---|---|
| Health | `GET /healthz`, `GET /readyz` |
| Sign-in and account | `POST /v1/admin/auth/login`, `GET /v1/admin/me`, `GET /v1/admin/permissions`, `POST /v1/admin/users/me/password` |
| Dashboard | `GET /v1/admin/dashboard` |
| Companies | `GET/POST /v1/admin/companies`, `PATCH /v1/admin/companies/{n}`, `POST …/offboard`, `POST …/reactivate` |
| Admin users | `GET/POST /v1/admin/users`, `PATCH /v1/admin/users/{id}`, `POST …/reset-password` |
| Classes | `GET/POST /v1/admin/classes`, `PATCH /v1/admin/classes/{code}` |
| Rates | `GET/POST /v1/admin/rates`, `GET /v1/admin/rates/history`, `PATCH /v1/admin/rates/{id}` |
| Billing rules | `GET/POST /v1/admin/companies/{n}/billing-rules` |
| Members | `GET /v1/admin/members`, `POST /v1/admin/companies/{n}/members`, `GET/PATCH …/members/{id}`, `POST …/policy`, `POST …/deactivate`, `POST …/reactivate` |
| Dependants | `POST …/members/{id}/dependents`, `PATCH …/dependents/{id}`, `POST …/dependents/{id}/deactivate`, `POST …/reactivate` |
| Beneficiaries | `POST …/beneficiaries`, `PATCH …/beneficiaries/{id}`, `POST …/deactivate`, `POST …/reactivate` |
| Bulk import | `GET /v1/admin/import/layouts`, `POST /v1/admin/import`, `GET /v1/admin/companies/{n}/import-exceptions`, `POST …/import-exceptions/{id}/resolve` |
| Change requests | `GET /v1/admin/change-requests`, `GET …/{id}`, `GET …/{id}/document`, `POST …/approve`, `POST …/reject` |
| Lookup alerts | `GET /v1/admin/lookup-alerts`, `POST …/{id}/resolve` |
| Verifications | `GET /v1/admin/verifications`, `POST …/{id}/reset-lock` |
| Activity log | `GET /v1/admin/audit` |
| Billing | `GET/POST /v1/admin/billing/runs`, `GET …/{id}`, `GET …/{id}/export.csv`, `POST …/{id}/finalise` |
| Employee (public) | `POST /v1/lookup`, `POST /v1/otp/resend`, `POST /v1/otp/verify`, `POST /v1/otp/select`, `GET /v1/card`, `POST/GET /v1/card/change-requests`, `POST /v1/session/logout`, `POST /v1/assistant/ask` |

**Not run by the script:** `POST /v1/card/email` (emails the card as a PDF). With the real SMTP settings in `.env` it sends a real email, and the demo members' addresses (`@bhi-demo.test`) do not exist. To test it, add a member with your own email address, look up their card, then send `POST /v1/card/email` with the `cardToken` and no body: expect `200` and the PDF in your inbox.

## What to check in the portal as you go

- **Dashboard** (`/admin`): member counts, open lookup alerts, open import exceptions and draft bills change as you run sections 6–12.
- **Member page:** after 6.x, the member shows the class history change, the policy, dependants and beneficiaries, and inactive/active states with their reasons.
- **Activity log** (`/admin/audit`): every change above appears with its reason. Nothing is ever deleted.
- **Billing run page** (`/admin/billing/runs/{runId}`): totals by class and tier, the lines, and the Finalise button (disabled while any member is unpriced).
