?---
description: "Task list for the Containerised Portal Stack"
---

# Tasks: Containerised Portal Stack

**Input**: Design documents from `/specs/001-docker-compose-stack/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: No new unit tests. This feature adds no application behaviour, so there is nothing new to unit
test. What it does need is *acceptance validation* — the 18 scenarios in [quickstart.md](./quickstart.md),
referenced below as V1–V18 — plus the existing RBAC suite run against the stack (US7). The constitution's
testing gate is satisfied by the existing suite continuing to pass, not by new tests of unchanged code.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
- Every task names its file path

## A note on story independence

The template assumes user stories are independently deliverable. **These are not, and pretending otherwise
would produce a misleading plan.** This is layered infrastructure: US2 (database) must work before US3
(startup ordering) can be observed, and both must work before US1 (one command, portal loads) is testable at
all. The P1 phases are therefore ordered by dependency — US2 → US3 → US1 — rather than by number.

What *is* independently testable is each story's **guarantee**. Phase 2 builds the spine; each story phase
then hardens and proves one property of it. Every story phase ends with the quickstart scenarios that prove
its guarantee, and those can be run without the later phases existing.

---

## Phase 1: Setup

**Purpose**: Repository scaffolding. T001 is first for a security reason, not a stylistic one.

- [X] T001 Create `.dockerignore` at repository root excluding `**/.env`, `**/.env.local`, `**/.env.*.local`, `node_modules`, `**/node_modules`, `.git`, `release/`, `**/dist`, `specs/`, `.specify/` — **this must exist before any image is ever built**, because `deploy/api/.env.local` holds live Gmail and Twilio credentials and a build context copies everything it is not told to exclude (FR-020)
- [X] T002 [P] Create the `docker/` directory tree — `docker/nginx/`, `docker/db/initdb/`, `docker/migrate/` — per plan.md § Project Structure
- [X] T003 [P] Create `.env.example` at repository root, combining the stack variables (`WEB_PORT`, `COMPOSE_PROJECT_NAME`, `RATE_*`) with the existing API variable names from `deploy/api/.env.example`, placeholders only, per [contracts/configuration.md](./contracts/configuration.md) (FR-019)
- [X] T004 [P] Confirm `.gitignore` already ignores `.env` and un-ignores `.env.example` — it does today, so this is a verification, not an edit; record the result rather than changing the file

**Checkpoint**: Build context is safe. No image may be built before T001 is done.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The spine every story depends on — stack definition, database, migrations, API image.

**⚠️ CRITICAL**: No story phase can begin until this is complete.

- [X] T005 Create `compose.yaml` at repository root with the project name, one user-defined bridge network, and the `bhi-db-data` named volume, per [contracts/service-topology.md](./contracts/service-topology.md) (FR-001)
- [X] T006 Add the `db` service to `compose.yaml` — `postgres:16-alpine`, `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` from `.env`, volume mounted at `/var/lib/postgresql/data`, no published port (FR-002, FR-011, D-01)
- [X] T007 [P] Create `docker/db/initdb/00-extensions.sql` containing `CREATE EXTENSION IF NOT EXISTS pgcrypto;` (FR-007)
- [X] T008 Bind-mount `docker/db/initdb/00-extensions.sql` and `deploy/db/schema.sql` read-only into `/docker-entrypoint-initdb.d/` as `00-extensions.sql` and `10-schema.sql` in the `db` service — mounting the real schema directly avoids a wrapper file and keeps `deploy/db/` the single source (FR-007, D-02)
- [X] T009 [P] Create `docker/migrate/apply-migrations.sh` applying every `deploy/db/migrations/*.sql` in filename order with `psql -v ON_ERROR_STOP=1`, mirroring step 4 of `deploy/db/setup-local.ps1`; it must exit non-zero on the first failure and name the failing file (FR-007, FR-008, FR-009)
- [X] T010 Add the one-shot `migrate` service to `compose.yaml` — `postgres:16-alpine`, runs `apply-migrations.sh`, `restart: "no"`, migrations bind-mounted read-only (FR-009, D-02)
- [X] T011 Create `docker/api.Dockerfile` with three stages — dependency install (`corepack` + `pnpm install --frozen-lockfile`, layer keyed only on `pnpm-lock.yaml`, `pnpm-workspace.yaml` and the workspace `package.json` files), build (`pnpm --filter @workspace/api-server run build`), and a `node:22-bookworm-slim` runtime carrying only `dist/` and running as a non-root user (FR-037, FR-039, D-03)
- [X] T012 Add the `api` service to `compose.yaml` — built from `docker/api.Dockerfile`, `env_file: .env`, `PORT=3001`, `HOST=0.0.0.0`, `TRUST_PROXY=1`, `DATABASE_URL` pointing at host `db`, **no published port** (FR-017, D-08)
- [X] T013 Verify `docker compose config` parses and resolves every variable before any service is started

**Checkpoint**: `docker compose up -d db migrate api` brings up a database and a running API.

---

## Phase 3: User Story 2 — Database is created, migrated, and keeps its data (Priority: P1)

**Goal**: The developer never touches the database. It initialises itself, migrates on every start, and never
loses data except on an explicit reset.

**Independent Test**: Create a company through the portal, stop and start the stack, confirm it is still
there. Then reset and confirm it is gone.

- [X] T014 [US2] Add a `pg_isready -U bhi_user -d bhi_portal` healthcheck to the `db` service in `compose.yaml` with sensible interval, timeout, retries and start period — this is the only check that means "accepting connections" (FR-012)
- [X] T015 [US2] Make `migrate` depend on `db` with condition `service_healthy` in `compose.yaml` (FR-012)
- [X] T016 [US2] Verify V2 — `docker compose exec db psql -U bhi_user -d bhi_portal -c "\dt"` lists all ten expected tables and `/api/readyz` does not return `SCHEMA_OUT_OF_DATE` (FR-007)
- [X] T017 [US2] Verify V4 — `docker compose run --rm migrate` against an already-migrated database exits 0 and changes nothing (FR-008)
- [ ] T018 [US2] Verify V4 second half — add a temporary `deploy/db/migrations/010_smoke.sql`, restart, confirm it applies, then remove it (FR-009)
- [X] T019 [US2] Verify V3 — data survives `docker compose down` followed by `up -d` (FR-010, SC-005)
- [X] T020 [US2] Verify `docker compose down -v` destroys the volume and the next start re-initialises from scratch, and that plain `down` does not (FR-004)

**Checkpoint**: US2 guarantee holds — initialisation is automatic, migrations are idempotent and re-applied, data persists, only an explicit command destroys it.

---

## Phase 4: User Story 3 — The API waits for the database instead of crash-looping (Priority: P1)

**Goal**: Orderly startup with no connection errors and no restart loop, and a log stream that says which
service is doing what.

**Independent Test**: Cold start from `down -v` and watch the logs — orderly wait, then a clean API start,
zero connection-refused errors.

- [X] T021 [US3] Add a `GET /api/healthz` healthcheck to the `api` service in `compose.yaml`; use `healthz`, **not** `readyz`, so a database fault does not take the API out of the stack and the diagnostic pair is preserved (FR-013)
- [X] T022 [US3] Make `api` depend on `migrate` with condition `service_completed_successfully` in `compose.yaml` — the API must not start until migrations have finished, not merely until the container was created (FR-012)
- [X] T023 [US3] Verify V5 — cold start from `docker compose down -v` shows database → migrations → API in order, with zero connection-refused errors and zero restarts (FR-012)
- [X] T024 [US3] Verify V6 — with `db` stopped, `/api/healthz` stays 200 while `/api/readyz` returns 503 (FR-013)
- [X] T025 [US3] Verify every log line is attributed to its service in `docker compose logs`, and that a failing service names itself and its reason (FR-014, FR-015)
- [ ] T026 [US3] Verify no personal data, verification code, card payload, token or secret appears anywhere in the aggregated log output (FR-028, Constitution VII)

**Checkpoint**: US3 guarantee holds — ordering is enforced by real readiness conditions, and failures are diagnosable from the log stream.

---

## Phase 5: User Story 1 — Bring the whole portal up with one command (Priority: P1) 🎯 MVP

**Goal**: One command, and the portal loads. This is the story the feature exists for.

**Independent Test**: On a machine with only Docker Desktop, from a fresh clone, run one command and sign in
to the admin portal.

- [X] T027 [US1] Create `docker/nginx/render-config.sh` applying substitutions 1–4 to `deploy/nginx/bhi-portal.conf` — upstream `127.0.0.1:3001` → `api:3001` (three occurrences), `server_name` → `localhost`, access log → `/dev/stdout`, error log → `/dev/stderr` — reading the real file every build so drift is impossible (FR-043, FR-047, D-05)
- [X] T028 [US1] Extend `docker/nginx/render-config.sh` to substitute the three `rate=` values in `bhi-portal-limits.conf` from `RATE_LOOKUP`, `RATE_ADMIN_LOGIN` and `RATE_API`, defaulting to the production values (D-06)
- [X] T029 [US1] Create `docker/web.Dockerfile` — reuse the dependency stage, build the frontend with `PORT=5173` and `BASE_PATH=/` set (`vite.config.ts` throws without **both**, even for a build), then an `nginx:1.27-alpine` runtime with `dist/public` copied to `/var/www/bhi-portal` (FR-016, FR-037, D-04)
- [X] T030 [US1] In `docker/web.Dockerfile`, place `bhi-portal-limits.conf` in `/etc/nginx/conf.d/`, `bhi-portal-headers.conf` in `/etc/nginx/snippets/`, and `proxy_params` in `/etc/nginx/` — the site config names all three and nginx refuses to start without them (FR-043)
- [X] T031 [US1] Run `nginx -t` as a build step in `docker/web.Dockerfile` so an invalid generated config fails the build rather than the start (FR-014)
- [X] T032 [US1] Add the `web` service to `compose.yaml` — publishes `${WEB_PORT:-8080}` → 80, depends on `api` with condition `service_healthy` (FR-002, FR-016)
- [X] T033 [US1] Verify V1 — from a fresh clone with only Docker Desktop, `docker compose up -d --build` then sign in at `/admin/login` as `group.admin@bhi-demo.test` (SC-001, SC-003)
- [ ] T034 [US1] Verify the SPA fallback and asset caching work — refreshing `/admin/members` renders the shell rather than 404ing, and `/assets/` carries the immutable cache header (FR-016)
- [ ] T035 [US1] Verify V18 — with `WEB_PORT` occupied, the failure names the port; confirm the documentation points at the variable that changes it (SC-009)
- [ ] T036 [US1] Verify starting with no `.env` present fails immediately, naming the missing file and the command that creates it (US1 scenario 3)

**Checkpoint**: 🎯 **MVP complete.** One command brings up a working portal on the real production front door. US4–US7 add value on top; none of them is required for this to be worth using.

---

## Phase 6: User Story 4 — End-to-end verification with no external provider (Priority: P2)

**Goal**: The full employee journey — lookup, code, verify, card — works with nothing external configured.

**Independent Test**: From a freshly started stack, complete a lookup and retrieve a card using only the
local inbox.

- [X] T037 [US4] Add an optional bind-host environment variable to `deploy/local-delivery.mjs`, defaulting to `127.0.0.1`, replacing the hardcoded bind at line 245 (SMTP) and line 479 (HTTP inbox) — additive and default-preserving, so `pnpm run local`, `pnpm run local:mail` and the sink embedded in `serve-local.mjs` all behave identically (research.md F-02)
- [ ] T038 [US4] Verify the existing non-containerised paths still work after T037 — run `pnpm run local` and confirm the sink binds and captures exactly as before (regression guard on the one code change this feature makes)
- [X] T039 [US4] Add the `mail` service to `compose.yaml` — runtime stage of `docker/api.Dockerfile`, running `node deploy/local-delivery.mjs` with the bind host set to `0.0.0.0`, exposing 2525 and 2526, no published port (FR-045)
- [X] T040 [US4] Add substitution 5 to `docker/nginx/render-config.sh` — insert a `location /__inbox` block proxying to `mail:2526`, so the inbox is same-origin with the portal (FR-045, D-05)
- [X] T041 [US4] Make `web` depend on `mail` with condition `service_started` in `compose.yaml` (FR-012)
- [X] T042 [US4] Set the delivery defaults in `.env.example` — `SMTP_HOST=mail`, `SMTP_PORT=2525`, empty `SMTP_USER`/`SMTP_PASS`, `SMS_WEBHOOK_URL=http://mail:2526/sms`, `OTP_DEV_MODE=false`; **no Gmail host and no Twilio credentials**, unlike the current `deploy/api/.env.local` (FR-024, FR-025, D-07)
- [X] T043 [US4] Verify V7 — full lookup → inbox → verify → card journey with no external provider configured (SC-004)
- [X] T044 [US4] Verify V8 — entering `000000` is rejected, and repeated wrong codes trigger the attempt limit and lockout; the `OTP_ACCEPT_ANY` shortcut must be absent (FR-046, SC-011, Constitution II)
- [ ] T045 [US4] Verify V9 — the shared number `+592-555-0123` presents the non-disclosing disambiguation step **before** any code is sent (Constitution I)
- [X] T046 [US4] Verify V10 — with `mail` stopped, a lookup reports that codes cannot be delivered rather than implying one was sent (FR-026)

**Checkpoint**: US4 guarantee holds — the primary employee journey runs locally against the real verification path, with no bypass and no external account.

---

## Phase 7: User Story 5 — Configuration is data, and secrets stay out of the repository (Priority: P2)

**Goal**: Every value is configuration; no secret reaches the repository or an image.

**Independent Test**: Change a value, restart without rebuilding, see it take effect. Inspect the built
images and find no secret.

- [X] T047 [US5] Complete `.env.example` against [contracts/configuration.md](./contracts/configuration.md) — every required variable present, placeholders only, each group commented, with the `DATABASE_URL` host called out as `db` rather than `localhost` since that is the most likely copy-paste error (FR-018, FR-019)
- [ ] T048 [US5] Add the optional commented `DB_PORT` and `API_PORT` publishing overrides to `compose.yaml`, off by default, documenting the host-PostgreSQL and VS Code port conflicts that motivate the defaults (FR-021, FR-017)
- [ ] T049 [US5] Verify V11 — changing `ISSUER_SIGNATORY_NAME` and restarting without `--build` changes the card (FR-022)
- [ ] T050 [US5] Verify V12 — removing `SESSION_SECRET` fails startup naming that variable, with no generated or default fallback (FR-023)
- [X] T051 [US5] Verify V13 — inspect the **built images**, not the ignore list: no `.env` file, no `deploy/api/.env.local`, and no credential in any layer or `docker history` line (FR-020, SC-008, Constitution § Secrets)

**Checkpoint**: US5 guarantee holds — configuration is external, secrets are absent from images, and a missing value fails loudly.

---

## Phase 8: User Story 6 — Change source, rebuild, see it running (Priority: P2)

**Goal**: A short edit-rebuild-run cycle that does not lose data.

**Independent Test**: Change a source file, run one command, see the change live with records intact.

- [X] T052 [US6] Verify the dependency layer in `docker/api.Dockerfile` and `docker/web.Dockerfile` is keyed only on `pnpm-lock.yaml`, `pnpm-workspace.yaml` and the workspace `package.json` files, so a source-only change never reinstalls dependencies (FR-042)
- [ ] T053 [US6] Verify V14 — change a frontend string, `docker compose up -d --build web`, confirm the change is live, records intact, dependencies served from cache, whole cycle under 3 minutes (FR-041, SC-013)
- [ ] T054 [US6] Verify a source file with a deliberate compile error fails the build with the compiler's own message naming the file, and leaves the previously running stack intact rather than half-broken (US6 scenario 3)
- [ ] T055 [US6] Verify V15 on a Windows host — images build and the stack runs with no toolchain installed and no edits to any committed file (SC-010, FR-038)

**Checkpoint**: US6 guarantee holds — the rebuild cycle is short, cached, and non-destructive.

---

## Phase 9: User Story 7 — Existing automated tests pass against the stack (Priority: P3)

**Goal**: Behavioural equivalence, proven by the suite that already exists.

**Independent Test**: Run the RBAC suite against the stack and compare to the documented baseline.

- [ ] T056 [US7] Document the dev-code test configuration — `OTP_DEV_MODE=true` plus a raised `RATE_API`, since 79 assertions against the production 120 r/m with burst 40 is close enough to the ceiling to be flaky for reasons unrelated to what the suite measures (D-06)
- [ ] T057 [US7] Verify V16 — `node artifacts/api-server/scripts/rbac-test.mjs` against a freshly seeded stack reports `PASS 79  FAIL 0`, the documented baseline (SC-007)
- [ ] T058 [US7] Record any deviation from the baseline with its cause, and confirm the default (`OTP_DEV_MODE=false`) run differs only by the known devCode-dependent assertions

**Checkpoint**: US7 guarantee holds — the stack is behaviourally equivalent, not merely superficially similar.

---

## Phase 10: Polish, Documentation & Gates

**Purpose**: The documentation the spec requires, and the two constitutional gates this work must pass.

- [X] T059 [P] Rewrite `deploy/LOCAL-DEV.md` to document the containerised path — start, stop, reset, logs, port overrides — and state which of the two existing paths it supersedes and which remain valid (FR-031, FR-032)
- [X] T060 [P] Correct the stale Path B caveat in `deploy/LOCAL-DEV.md`: it claims the workspace prunes `win32-x64` binaries, but `pnpm-workspace.yaml` lines 78–81 say they are intentionally **not** pruned and the lockfile carries them (research.md F-01)
- [X] T061 [P] Add a prominent statement to `deploy/LOCAL-DEV.md` that this stack is for developer machines only, naming the nginx + systemd path in `deploy/README.md` as the supported deployment route (FR-033, FR-034)
- [X] T062 [P] Publish the FR-047 substitution table — the five documented differences between the local and production front-door configuration — in `deploy/LOCAL-DEV.md` or a sibling doc (FR-047, SC-012)
- [X] T063 [P] Add the troubleshooting table from [quickstart.md](./quickstart.md) to `deploy/LOCAL-DEV.md`, covering port conflicts, the `localhost`-instead-of-`db` error, stale schema, blank portal, inbox 404, and `429` under the real rate limits (FR-031)
- [ ] T064 Verify V17 — front-door parity: the generated config differs from `deploy/nginx/bhi-portal.conf` by exactly the five documented substitutions, `X-Request-Id` is present, the same id appears in both the `web` and `api` logs, and a >12 MB POST is rejected at the same limit production uses (FR-043, FR-044, SC-012)
- [X] T065 Verify FR-035 and FR-036 — `deploy/nginx/`, `deploy/api/`, `deploy/web/`, `deploy/systemd/` are unmodified, and `node deploy/make-release.mjs` still produces a release without the container runtime
- [ ] T066 Verify SC-006 — a second machine reproduces the same running stack from the same committed configuration with no machine-specific edits
- [ ] T067 **Security review gate** — this work touches disclosure surfaces (the front door), caching headers, and the verification delivery path. Constitution § Development Workflow requires explicit security review before merge. Not self-certifiable
- [ ] T068 **Data protection review gate** — confirm nothing changes what personal data is collected, displayed, cached, logged or transferred. Expected to be a formality, but required before merge and not self-certifiable

---

## Dependencies & Execution Order

### Phase dependencies

```text
Phase 1 (Setup) ──► Phase 2 (Foundational) ──► Phase 3 (US2) ──► Phase 4 (US3) ──► Phase 5 (US1) 🎯
                                                                                         │
                                          ┌──────────────────────────────────────────────┤
                                          ▼                  ▼                  ▼        ▼
                                    Phase 6 (US4)     Phase 7 (US5)     Phase 8 (US6)  Phase 9 (US7)
                                          └──────────────────┴──────────────────┴────────┘
                                                              ▼
                                                    Phase 10 (Polish & Gates)
```

- **T001 blocks everything.** No image may be built before the `.dockerignore` exists.
- **Phases 3 → 4 → 5 are strictly sequential.** Each observes a property of the previous one.
- **Phases 6–9 are genuinely parallel** once the MVP lands. They touch different files and prove different
  guarantees.
- **Phase 10** needs all desired stories complete; the two gates are last.

### Cross-story dependencies worth naming

| Task | Depends on | Why |
|---|---|---|
| T040 (`/__inbox` substitution) | T027 (`render-config.sh`) | Extends the same script |
| T039 (`mail` service) | T011 (`api.Dockerfile`) | Reuses its runtime stage |
| T044 (no-bypass check) | T043 (journey works) | Cannot test rejection before acceptance works |
| T057 (RBAC suite) | Phase 5 complete | The suite calls through the front door |
| T064 (parity check) | T027, T028, T040 | All five substitutions must exist |

### Parallel opportunities

- **Phase 1**: T002, T003, T004 in parallel after T001
- **Phase 2**: T007 and T009 in parallel with T005/T006
- **Phases 6–9**: all four in parallel with enough people
- **Phase 10**: T059–T063 in parallel (all documentation, T060–T063 all land in the same file so coordinate or sequence those three)

### Parallel example — after the MVP

```bash
# Four independent tracks once Phase 5 is done:
Track A: T037–T046  # US4 — delivery
Track B: T047–T051  # US5 — configuration and secrets
Track C: T052–T055  # US6 — rebuild cycle
Track D: T056–T058  # US7 — RBAC suite
```

---

## Implementation Strategy

### MVP — Phases 1 through 5

Setup → Foundational → US2 → US3 → US1. Delivers the whole point of the feature: one command brings up a
working portal on the real production front door, with a database that initialises itself and keeps its data.

**Stop and validate here.** Run V1, V2, V3, V5, V6. If those pass, the feature is already worth using even
with nothing else built.

### Increment 2 — US4

Delivery. Turns a working admin portal into a working *product* demo: the employee journey end to end. The
highest-value addition after the MVP, and the one that exercises the security boundary.

### Increment 3 — US5, US6, US7 in parallel

Hardening (secrets, config), developer experience (rebuild cycle), and proof of equivalence (RBAC suite).

### Increment 4 — Phase 10

Documentation and the two gates. **Not optional**: FR-031 through FR-034 are requirements, and the
constitution requires both reviews before merge.

---

## Notes

- 68 tasks. Every one cites the requirement or research decision it satisfies.
- **T001 first, always.** Live Gmail and Twilio credentials sit in `deploy/api/.env.local` inside the
  prospective build context. That file is gitignored and untracked — this is not a committed-secret
  incident — but a build context copies what it is not told to ignore, and T051 verifies the outcome by
  inspecting the image rather than trusting the list.
- Separately and outside this feature's scope: those Twilio credentials are live and were readable in plain
  text. Rotating them is sensible regardless of what this feature does.
- T037 is the only change to code outside `docker/` and the new root files. It is additive, default-
  preserving, and covered by a regression check in T038.
- `deploy/` is otherwise read-only to this feature. T065 verifies that.
- Commit after each task or logical group. Every checkpoint is a safe place to stop.
