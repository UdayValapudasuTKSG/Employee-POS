# Contract: Configuration

**Date**: 2026-08-11 | **Plan**: [../plan.md](../plan.md)

One file: `.env` at the repository root, copied from the committed `.env.example`. Variable names are the
existing ones from `deploy/api/.env.example` (FR-018) — this feature invents as few as it can.

`.gitignore` already ignores `.env` and already un-ignores `.env.example`, so no gitignore change is needed
for the configuration file itself. The `.dockerignore` is a separate and mandatory matter — see the bottom
of this document.

## Variables

### Stack — new to this feature

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `WEB_PORT` | `8080` | no | Host port for the front door |
| `COMPOSE_PROJECT_NAME` | `bhi-portal` | no | Namespaces containers and the volume; lets two clones coexist |
| `DB_PORT` | *(unset)* | no | Publishes the database to the host. Off by default — a host PostgreSQL owns 5432 |
| `API_PORT` | *(unset)* | no | Publishes the API to the host for direct debugging. Off by default (FR-017) |
| `RATE_LOOKUP` | `10r/m` | no | nginx `bhi_lookup` zone rate |
| `RATE_ADMIN_LOGIN` | `5r/m` | no | nginx `bhi_adminlogin` zone rate |
| `RATE_API` | `120r/m` | no | nginx `bhi_api` zone rate |

Rate defaults equal the production values in `deploy/nginx/bhi-portal-limits.conf`. Raise them only for a
test run, and say so when you do (D-06).

### Database

| Variable | Example | Required | Notes |
|---|---|---|---|
| `POSTGRES_USER` | `bhi_user` | yes | Superuser in the official image, so `CREATE EXTENSION pgcrypto` works |
| `POSTGRES_PASSWORD` | *placeholder* | yes | Local only. Must not be a real credential in the committed example |
| `POSTGRES_DB` | `bhi_portal` | yes | |
| `DATABASE_URL` | `postgresql://bhi_user:…@db:5432/bhi_portal` | yes | **Host must be `db`.** `localhost` here is the most likely error in the whole file |

### API runtime — existing names

| Variable | Value in this stack | Required | Notes |
|---|---|---|---|
| `PORT` | `3001` | yes | Production value. The 3101 workaround was for a host port clash that containers do not have |
| `HOST` | `0.0.0.0` | yes | Differs from production's `127.0.0.1`. See D-08 — the isolation moves to the unpublished network and is not weakened |
| `TRUST_PROXY` | `1` | yes | Exactly one proxy in front. Without it every audit row records nginx's address instead of the caller's |
| `NODE_ENV` | `production` | yes | |
| `SESSION_SECRET` | *placeholder* | yes | Local only. Startup must fail if absent (FR-023) |
| `CORS_ALLOWED_ORIGINS` | *unset* | no | Leave unset. The portal is same-origin behind the front door, so the correct answer is to allow none |

**On `NODE_ENV=production`**: `deploy/api/.env.local` pins this because the *prebuilt bundle* has a
pino-pretty worker path baked in from the build machine. This stack builds from source inside the image, so
that specific constraint does not apply — but `production` remains correct here regardless, since demo
behaviour is controlled explicitly by `DEMO_SEED` and `OTP_DEV_MODE` rather than inferred from `NODE_ENV`.

### Seeding

| Variable | Value | Notes |
|---|---|---|
| `DEMO_SEED` | `true` | 6 companies, 120 members, dependants, 5 admin accounts. **Synthetic only.** Never against real data (FR-027) |
| `ADMIN_EMAIL` | *unset* | Not used while `DEMO_SEED=true` |
| `ADMIN_PASSWORD` | *unset* | Same |

The demo admin accounts use the publicly documented password `Demo@2026`. That is acceptable for a synthetic
throwaway database and unacceptable anywhere else — which is what FR-033 scoping this to developer machines
is for.

### Delivery — fully offline by default

| Variable | Value | Notes |
|---|---|---|
| `SMTP_HOST` | `mail` | The sink service |
| `SMTP_PORT` | `2525` | |
| `SMTP_USER` / `SMTP_PASS` | *empty* | The sink authenticates nothing |
| `SMTP_FROM` | `"NALICO (local) <no-reply@bhi-local.test>"` | |
| `SMS_WEBHOOK_URL` | `http://mail:2526/sms` | |
| `SMS_WEBHOOK_TOKEN` | *unset* | |
| `OTP_DEV_MODE` | `false` | **Keep false.** The real nodemailer and webhook paths execute; the sink captures. `true` returns the code inline and skips delivery |
| `CARD_EMAIL_OVERRIDE` | *unset* | Each member is emailed their own card |

This is deliberately different from the current `deploy/api/.env.local`, which points at real Gmail SMTP and
a real Twilio gateway. The committed example must contain neither (D-07).

### Card issuer

`ISSUER_NAME`, `ISSUER_ADDRESS`, `ISSUER_PHONE`, `ISSUER_SIGNATORY_NAME`, `ISSUER_SIGNATORY_TITLE`,
`ISSUER_PLAN_TITLE`, `CARD_PROPERTY_NOTICE`, `CARD_BACK_NOTICE`.

Copied verbatim from `deploy/api/.env.example`. Not secret. Blank means the field is omitted from the card,
never that a default is substituted — a wrong address is fixed by editing this file and restarting, with no
rebuild (FR-022).

## Rules

1. **Placeholders only in the example.** A real credential in `.env.example` is a constitutional violation
   (FR-019, FR-020).
2. **Fail loudly on a missing required value**, naming it. Never start with a weaker default (FR-023).
3. **No rebuild to change a value.** Every variable is read at container start (FR-022).
4. **Service names, not loopback**, in every internal address.
5. **No value reaches an image layer.** Configuration is injected at run time, never copied at build time
   (FR-020).

## The `.dockerignore` — mandatory before the first build

`deploy/api/.env.local` currently holds live Gmail and Twilio credentials. It is untracked and gitignored,
so it is not a committed-secret problem — but it sits inside the build context, and a build context copies
everything it is not told to exclude.

Minimum exclusions:

```text
**/.env
**/.env.local
**/.env.*.local
node_modules
**/node_modules
.git
release/
**/dist
specs/
.specify/
```

Acceptance for FR-020 is inspecting the **built image** — its layers and its build history — not reviewing
this list. A list can be right and the outcome still wrong.
