# Phase 1 Data Model: Containerised Portal Stack

**Date**: 2026-08-11 | **Plan**: [plan.md](./plan.md)

This feature introduces no application data. The database schema, its ten tables, and its nine migrations
are pre-existing and untouched. What follows models the *stack's own* entities — the things the
configuration declares and the implementation must get right.

## Entity: Service

One running component. Five instances.

| Field | Meaning |
|---|---|
| `name` | DNS name on the stack network. Other services address it by this and nothing else. |
| `image_source` | Built from a Dockerfile in this repository, or pulled by tag. |
| `internal_ports` | Reachable from sibling services on the stack network. |
| `published_ports` | Reachable from the host. Empty for everything but the front door. |
| `readiness_condition` | What "ready" means. Must be an observable check, never elapsed time. |
| `depends_on` | Predecessors and the condition each must reach. |
| `restart_policy` | Long-running services restart; one-shot services do not. |

### Instances

| name | image_source | internal | published | readiness_condition | depends_on | restart |
|---|---|---|---|---|---|---|
| `db` | `postgres:16-alpine` | 5432 | *(none by default; optional override)* | `pg_isready -U bhi_user -d bhi_portal` succeeds | — | unless-stopped |
| `migrate` | `postgres:16-alpine` | — | — | process exits 0 | `db` healthy | no |
| `api` | `docker/api.Dockerfile` | 3001 | *(none; optional debug override)* | `GET /api/healthz` returns 200 | `migrate` completed successfully | unless-stopped |
| `mail` | `docker/api.Dockerfile` (runtime stage, different command) | 2525 SMTP, 2526 HTTP | *(none)* | TCP accept on 2526 | — | unless-stopped |
| `web` | `docker/web.Dockerfile` | 80 | `${WEB_PORT:-8080}` → 80 | `nginx -t` passed at build; HTTP 200 on `/` | `api` healthy, `mail` started | unless-stopped |

**Validation rules**

- Exactly one service may publish a port by default. A second published port is a configuration error
  unless it is an explicitly documented debug override (FR-017).
- Every `depends_on` must name a condition. A bare dependency means "container created", which is not
  readiness and does not satisfy FR-012.
- `migrate` must not restart. A restarting one-shot service is an infinite loop.
- No service may be reachable from the host except through `web`.

## Entity: Persistent Volume

| Field | Value |
|---|---|
| `name` | `bhi-db-data` |
| `mounted_at` | `/var/lib/postgresql/data` in `db` |
| `survives` | `docker compose stop`, `down`, `restart`, image rebuild, host reboot |
| `destroyed_by` | `docker compose down -v` — and nothing else |

**Validation rules**

- No other service mounts it. The database owns its storage.
- Destruction must require a distinct command, never a flag on a routine one (FR-004).
- Its existence is what makes first-run initialisation a once-only event — see State Transitions.

## Entity: Configuration Profile

One `.env` at the repository root, copied from the committed `.env.example`. Variable names are the existing
ones from `deploy/api/.env.example` (FR-018). Full contract in
[contracts/configuration.md](./contracts/configuration.md).

| Group | Variables | Notes |
|---|---|---|
| Stack | `WEB_PORT`, `COMPOSE_PROJECT_NAME` | Consumed by Compose interpolation, not by the API |
| Database | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `DATABASE_URL` | `DATABASE_URL` must be derivable from the other three and point at host `db` |
| API | `PORT`, `HOST`, `TRUST_PROXY`, `NODE_ENV`, `SESSION_SECRET` | `HOST=0.0.0.0` — see D-08 for why this is not a weakening |
| Seeding | `DEMO_SEED`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` | `DEMO_SEED=true` by default; synthetic data only |
| Delivery | `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, `SMS_WEBHOOK_URL`, `OTP_DEV_MODE` | Point at `mail` by default; no external provider |
| Issuer | `ISSUER_*`, `CARD_*` | Card face content; blank means omitted, never defaulted |
| Rate limits | `RATE_LOOKUP`, `RATE_ADMIN_LOGIN`, `RATE_API` | Default to the production values; raisable for test runs (D-06) |

**Validation rules**

- The committed example carries placeholders only. A real credential in it is a constitutional violation.
- A missing required value fails the stack at startup with that value named — never a silent insecure
  default (FR-023).
- `DATABASE_URL` host must be `db`. A `localhost` or `127.0.0.1` here is the single most likely
  copy-paste error and should be checked for by name.
- `OTP_DEV_MODE=false` by default, so the real delivery path runs.
- No value in this file may appear in any image layer (FR-020).

## Entity: Initialisation Set

The SQL applied to bring an empty or outdated database to current. Sourced entirely from existing files.

| Stage | Source | Runs | Idempotent |
|---|---|---|---|
| Role and database | `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Once, on empty volume | By construction |
| Extension | `docker/db/initdb/00-extensions.sql` → `CREATE EXTENSION IF NOT EXISTS pgcrypto` | Once, on empty volume | Yes |
| Schema | `deploy/db/schema.sql` | Once, on empty volume | Not required — guarded by first-run only |
| Migrations | `deploy/db/migrations/*.sql`, filename order | **Every start** | Yes — each is documented as safe to re-run |

**Validation rules**

- Filename order is the contract. `001_…` through `009_…` sort correctly today; a tenth must be `010_`, not
  `10_`.
- Every file applies with `ON_ERROR_STOP=1`. A partially applied migration must fail the start, not proceed.
- A migration added after a volume exists must apply on the next start (FR-009). This is why migrations are
  a separate service and not an initdb script.
- The expected end state is the ten tables `deploy/LOCAL-DEV.md` lists: `admin_users`, `app_event_logs`,
  `audit_logs`, `beneficiaries`, `card_sessions`, `companies`, `dependents`, `employee_members`,
  `policy_memberships`, `verification_sessions`.

## Entity: Front Door Configuration

Generated at image build time from the real production files. Never hand-maintained.

| Field | Value |
|---|---|
| `sources` | `deploy/nginx/bhi-portal.conf`, `bhi-portal-limits.conf`, `bhi-portal-headers.conf`, `proxy_params` |
| `transform` | `docker/nginx/render-config.sh` |
| `substitution_count` | 5, closed set — enumerated in [research.md](./research.md) D-05 |
| `verified_by` | `nginx -t` during build; build fails if the result is invalid |

**Validation rules**

- The transform reads the production file every build. A second copy of the config in the repository is a
  defect (FR-047).
- Adding a sixth substitution requires updating the documented table. An undocumented difference is the
  failure mode this design exists to prevent.
- Anything not in the substitution list must be byte-identical to production — in particular the absence of
  a trailing slash on `proxy_pass` (a slash strips `/api` and every route 404s), `client_max_body_size 12m`,
  and `proxy_buffering off`.

## State Transitions

### Stack lifecycle

```text
        ┌──────────────┐
        │ not created  │
        └──────┬───────┘
               │ up --build
               ▼
        ┌──────────────┐  first run only: role, extension, schema
        │ initialising │  every run: migrations
        └──────┬───────┘
               │ all readiness conditions met
               ▼
   ┌───►┌──────────────┐
   │    │   running    │
   │    └──┬────────┬──┘
   │  down │        │ down -v
   │       ▼        ▼
   │  ┌─────────┐  ┌──────────────┐
   └──┤ stopped │  │ not created  │   ← volume destroyed, data gone
 up   │ (data   │  └──────────────┘
      │  kept)  │
      └─────────┘
```

`stopped → running` re-runs migrations and skips initialisation, because the volume exists. That asymmetry
is the whole point of splitting the two (D-02).

### Database volume

| From | Event | To |
|---|---|---|
| absent | first `up` | present, initialised, migrated |
| present | `up` | present, migrated (initialisation skipped) |
| present | `down` / `stop` | present, untouched |
| present | `down -v` | absent |
| present | image rebuild | present, untouched — images carry no data |

## Non-Entities

Recorded so the boundary is explicit:

- **Application data** — companies, members, dependants, policies, audit rows. Owned by the existing schema.
  This feature stores none of it and defines none of it.
- **Session and verification state** — `card_sessions`, `verification_sessions`. Existing tables, unchanged.
- **Container images** — build outputs, not entities. Reproducible from the repository; carrying state in
  one would be a defect.
