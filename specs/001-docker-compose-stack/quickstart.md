# Quickstart & Validation: Containerised Portal Stack

**Date**: 2026-08-11 | **Plan**: [plan.md](./plan.md)

How to run the stack, and how to prove it satisfies the spec. Every scenario below maps to a success
criterion or a user story, and each is runnable on its own.

> **This stack is for developer machines only** (FR-033). The supported deployment path is the nginx +
> systemd install in [deploy/README.md](../../deploy/README.md).

## Prerequisites

- Docker Desktop with the WSL2 Linux engine. Nothing else — no Node, no PostgreSQL, no pnpm (FR-005, SC-003).
- Confirm: `docker compose version` prints v2 or later.

## First run

```powershell
Copy-Item .env.example .env
# Edit .env: set POSTGRES_PASSWORD and SESSION_SECRET to any local values
docker compose up -d --build
docker compose logs -f
```

Wait for every service to report ready. Then:

| What | URL |
|---|---|
| Employee card lookup | http://localhost:8080/ |
| Admin portal | http://localhost:8080/admin/login |
| Code inbox (email + SMS) | http://localhost:8080/__inbox |
| API health | http://localhost:8080/api/healthz |
| API readiness | http://localhost:8080/api/readyz |

Demo admin logins, password `Demo@2026` — synthetic accounts, seeded only because `DEMO_SEED=true`:

| Email | Role |
|---|---|
| platform.admin@bhi-demo.test | ROLE_PLATFORM_ADMIN (super admin), all companies |
| hr.foods@bhi-demo.test | ROLE_HR_ADMIN, BF only |
| support@bhi-demo.test | ROLE_SUPPORT |
| auditor@bhi-demo.test | ROLE_AUDITOR, read-only |

## Everyday commands

```powershell
docker compose up -d                    # start
docker compose logs -f api              # one service's logs
docker compose ps                       # what is running
docker compose down                     # stop, KEEPS data
docker compose up -d --build api web    # rebuild after a source change
```

**To reset the database — this destroys all local data:**

```powershell
docker compose down -v
```

`down` keeps your data. `down -v` deletes it. Two characters apart.

---

## Validation scenarios

### V1 — One command from a clean machine (US1, SC-001, SC-003)

1. On a machine with only Docker Desktop, clone the repository.
2. `Copy-Item .env.example .env`, fill in the two placeholder values.
3. `docker compose up -d --build`.
4. Open http://localhost:8080/admin/login and sign in as `platform.admin@bhi-demo.test`.

**Pass**: the admin portal loads with navigation available, in under 15 minutes from step 1, having
installed no database and no language runtime.

### V2 — Schema and migrations applied (US2)

```powershell
docker compose exec db psql -U bhi_user -d bhi_portal -c "\dt"
```

**Pass**: twelve tables — `admin_users`, `app_event_logs`, `audit_logs`, `beneficiaries`, `card_sessions`,
`change_request_documents`, `change_requests`, `companies`, `dependents`, `employee_members`,
`policy_memberships`, `verification_sessions`. And `GET /api/readyz` returns 200, not
`SCHEMA_OUT_OF_DATE`.

*(`deploy/LOCAL-DEV.md` said ten. It predates migration `004_change_requests.sql`; both documents are now
corrected.)*

### V3 — Data survives a restart (US2, SC-005)

1. Sign in, create a company through the admin portal.
2. `docker compose down`
3. `docker compose up -d`
4. Sign in again; open the companies list.

**Pass**: the company is still there.

### V4 — Migrations are idempotent and re-apply (US2)

```powershell
docker compose run --rm migrate     # against an already-migrated database
```

**Pass**: exits 0, changes nothing, no error.

Then add a no-op file `deploy/db/migrations/010_smoke.sql` containing a guarded statement, run
`docker compose up -d`, and confirm it applied. Remove it afterwards.

### V5 — Ordered startup, no crash loop (US3)

From cold — `docker compose down -v` then `docker compose up --build` in the foreground.

**Pass**: the log stream shows the database becoming healthy, then migrations, then the API starting. Zero
connection-refused errors from the API. Zero restarts. Every line names its service.

### V6 — Health and readiness are distinguishable (US3)

```powershell
curl.exe -i http://localhost:8080/api/healthz    # expect 200
curl.exe -i http://localhost:8080/api/readyz     # expect 200
docker compose stop db
curl.exe -i http://localhost:8080/api/healthz    # expect 200 — process alive
curl.exe -i http://localhost:8080/api/readyz     # expect 503 — database gone
docker compose start db
```

**Pass**: `healthz` stays 200 while `readyz` goes 503. That pair is the diagnostic and it must survive
containerisation.

### V7 — Full verification journey, no external provider (US4, SC-004)

1. Open http://localhost:8080/ and enter a seeded member's email.
2. Open http://localhost:8080/__inbox and read the code (appears within a couple of seconds).
3. Enter it.

**Pass**: the member's card is returned. No SMTP account, no SMS provider, no paid service configured
anywhere.

Get a member identifier from the API's `BHI demo credentials` startup log line, or:

```powershell
docker compose exec db psql -U bhi_user -d bhi_portal -c "SELECT email, phone FROM employee_members WHERE email IS NOT NULL LIMIT 5;"
```

### V8 — No code bypass (FR-046, SC-011)

Start a lookup, then enter `000000` instead of the real code.

**Pass**: rejected. The current `serve-local.mjs` accepts any six digits; this stack must not. Repeat until
lockout and confirm the attempt limit engages.

### V9 — Multi-member disambiguation (US4)

Enter `+592-555-0123`, shared by five BF members.

**Pass**: the non-disclosing selection step appears **before** any code is sent.

### V10 — Delivery unavailable fails closed (US4)

```powershell
docker compose stop mail
```

Attempt a lookup.

**Pass**: the portal reports that codes cannot be delivered. It does not imply one was sent. This is correct
production behaviour, not a bug.

### V11 — Configuration takes effect without a rebuild (US5, FR-022)

Change `ISSUER_SIGNATORY_NAME` in `.env`, then `docker compose up -d` (no `--build`).

**Pass**: the new name appears on the card. No image was rebuilt.

### V12 — Missing required value fails loudly (US5, FR-023)

Comment out `SESSION_SECRET` in `.env` and start.

**Pass**: startup fails naming `SESSION_SECRET`. It does not start with a generated or default secret.

### V13 — No secrets in the images (US5, SC-008, FR-020)

```powershell
docker compose build
docker run --rm --entrypoint sh <api-image> -c "find / -name '.env*' -not -path '*/node_modules/*' 2>/dev/null"
docker history --no-trunc <api-image>
```

**Pass**: no `.env`, no `.env.local`, no credential in any layer or build-history line. In particular
`deploy/api/.env.local` — which holds live Gmail and Twilio credentials — must be absent. Inspect the image,
not the `.dockerignore`.

### V14 — Rebuild cycle (US6, SC-013, FR-041, FR-042)

Change a visible string in the frontend, then:

```powershell
docker compose up -d --build web
```

**Pass**: the change is live, previously created records are intact, dependency installation was served from
cache, and the whole cycle took under 3 minutes.

### V15 — Windows host build (US6)

Run V1 on Windows.

**Pass**: images build and the stack runs with no toolchain installed on the host and no edits to any
committed file. *(Note: contrary to `deploy/LOCAL-DEV.md`'s Path B caveat, a host source build is no longer
blocked — see [research.md](./research.md) F-01. The claim being validated here is the no-toolchain,
no-edits one.)*

### V16 — RBAC suite (US7, SC-007)

The suite asserts on the inline `devCode`, so it needs dev-code mode:

```powershell
# in .env: OTP_DEV_MODE=true, and raise RATE_API so 79 assertions do not trip the limiter
docker compose up -d
$env:BASE_URL="http://127.0.0.1:8080/api"; node artifacts/api-server/scripts/rbac-test.mjs
```

**Pass**: `PASS 79  FAIL 0` against a freshly seeded database — the documented baseline. Restore
`OTP_DEV_MODE=false` and the default rate afterwards.

> This is the one scenario that needs Node on the host, because the suite runs there. It tests the stack; it
> is not part of it.

### V17 — Front-door parity (FR-043, FR-047, SC-012)

1. Confirm the generated config differs from `deploy/nginx/bhi-portal.conf` by exactly the five documented
   substitutions and nothing else.
2. `curl.exe -i http://localhost:8080/api/healthz` and check `X-Request-Id` is present.
3. Find that same id in both the `web` and `api` logs.
4. Confirm a POST over 12 MB to `/api/` is rejected by nginx with the same limit production uses.

**Pass**: all four. The correlation in step 3 is what FR-044 exists for.

### V18 — Port conflict is diagnosable (Edge case, SC-009)

Occupy 8080 — for example by starting the old stack with `pnpm run local` — then `docker compose up -d`.

**Pass**: the failure names port 8080 and the message or documentation points at `WEB_PORT`.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `port is already allocated` | Something holds `WEB_PORT`. The old `pnpm run local` front door is the usual culprit. Change `WEB_PORT` or stop it |
| API restarts repeatedly | Check `DATABASE_URL` — the host must be `db`, not `localhost`. This is the most common configuration error |
| `SCHEMA_OUT_OF_DATE` | Migrations did not apply. `docker compose logs migrate` |
| Portal loads, `/api` 502s | The API is not healthy. `docker compose logs api` |
| Portal loads blank | Frontend built without `BASE_PATH=/`. Rebuild `web` |
| Inbox 404s | `mail` is down, or the `/__inbox` substitution did not apply |
| `429` on a few quick lookups | Working as intended — production rate limits are in force. Raise `RATE_LOOKUP` for a test run |
| Data gone after a restart | `down -v` was run instead of `down` |
