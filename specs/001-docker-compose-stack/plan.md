# Implementation Plan: Containerised Portal Stack

**Branch**: `001-docker-compose-stack` (spec directory; work is on `dev`) | **Date**: 2026-08-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-docker-compose-stack/spec.md`

## Summary

Bring the whole portal up with one command on Docker Desktop: PostgreSQL, the API, the real nginx front door,
and a local verification-code sink, wired together and initialised. Application images are built from source
in a multi-stage Linux build, so no toolchain is needed on the host. The front door runs the actual
production site config, transformed at build time by a closed set of five documented substitutions rather
than forked — so what is exercised locally is what ships.

Phase 0 turned up two things the spec got wrong, both from stale documentation. They are recorded in
[research.md](./research.md) as F-01 and F-02 and are summarised under *Spec amendments required* below.

## Technical Context

**Language/Version**: Node.js 22 LTS (runtime and build); PostgreSQL 16; nginx 1.27

**Primary Dependencies**: Docker Engine with Compose v2 (via Docker Desktop); pnpm 10 via corepack; the
existing workspace — Express 5, drizzle-orm, pino, nodemailer on the API side; React 19, Vite 7, Tailwind 4
on the frontend

**Storage**: PostgreSQL 16 in a named volume. Schema and nine migrations already exist under `deploy/db/`.

**Testing**: the existing `artifacts/api-server/scripts/rbac-test.mjs` suite (79 assertions in dev-code mode),
run against the containerised stack; plus manual acceptance walkthroughs in [quickstart.md](./quickstart.md)

**Target Platform**: Docker Desktop on Windows 11 with the WSL2 Linux engine. Linux containers only. The
same files work unchanged on Linux and macOS hosts, but only Windows is a supported target for this feature.

**Project Type**: Developer tooling / build and orchestration configuration for an existing web application.
No application behaviour changes.

**Performance Goals**: first start under 15 minutes including image build (SC-001); subsequent starts under
90 seconds (SC-002); rebuild-and-restart after a source change under 3 minutes with unchanged dependencies
(SC-013)

**Constraints**: no host-installed database or language runtime (FR-005); no secret in any image layer
(FR-020); the API not published to the host (FR-017); the production deployment assets under `deploy/`
unmodified (FR-035); no verification-code bypass (FR-046)

**Scale/Scope**: one developer machine, five services, one volume, the existing ~4,970-record capacity
profile is irrelevant here — the demo dataset is 6 companies and 120 members

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution v1.0.0, ratified 2026-08-06.

| Principle / Section | Applies? | Assessment | Status |
|---|---|---|---|
| I. Zero Disclosure Before Verification | Yes | The stack changes no endpoint, no response shape, and no error text. It *strengthens* local fidelity: FR-046 removes the `OTP_ACCEPT_ANY` shortcut, so the uniform-response and lockout behaviour is exercised locally for the first time. | ✅ Pass |
| II. Layered Identity Assurance | Yes | Verification logic untouched. D-07 sets `OTP_DEV_MODE=false`, so the real hash comparison, expiry, retry limit and lockout all run. Rate limiting survives at all three levels via the real nginx zones (D-06). | ✅ Pass |
| III. Archive-Only Records and Immutable Audit | Yes | No hard-delete path is introduced. `docker compose down -v` destroys a whole throwaway development volume — it is not a record-level delete path and cannot reach a real database. Audit writes are unaffected. | ✅ Pass |
| IV. Data Residency and Lawful Processing | Partially | No cloud processing, no data leaves the machine, no personal data involved — the dataset is synthetic. The constitutional mandate that services be "container-based and free of unnecessary managed-service coupling" is advanced by this work, not undercut. | ✅ Pass |
| V. Usable at the Point of Care | No | Mobile application scope. Not touched. | N/A |
| VI. Measurable Non-Functional Requirements | Yes | Every success criterion carries a number or a binary condition. **Guard**: SC-001/002/013 are developer-experience targets and must not be read as the production availability, RTO, RPO or p95 figures the constitution still records as open TODOs. Stated in the spec checklist and repeated here. | ✅ Pass |
| VII. Observability Without Exposure | Yes | FR-028 forbids personal data in the aggregated log stream. D-05 substitution 3/4 sends nginx logs to stdout/stderr in the `bhi_portal` format, which deliberately carries `$request_id` but drops referrer and user-agent. API logging is unchanged. **Watch item**: `SMS_GATEWAY_LOG_BODY` logs message text including the code — must stay `false`, and the sms-gateway is not in this stack at all. | ✅ Pass |
| § Secrets | Yes | **The one real risk.** `deploy/api/.env.local` holds live Gmail and Twilio credentials and sits inside the prospective build context. Mitigated by a mandatory `.dockerignore` that must exist before the first build, with acceptance verified by inspecting the built image, not the file list. See research.md § Security finding. | ⚠️ Pass with mandatory control |
| § Access / Authorisation | Yes | RBAC and server-side authorisation unchanged. Demo admin accounts have publicly documented passwords and are synthetic-only, gated by `DEMO_SEED`. | ✅ Pass |
| § Infrastructure as code | Yes | Everything is version-controlled configuration. **This stack is explicitly not the Terraform the constitution mandates for real environments** — FR-033 scopes it to developer machines and FR-034 requires the documentation to say so. | ✅ Pass |
| § Portability | Yes | Directly advanced: containerising the services is a step toward the "migration is a deployment change, not a rewrite" requirement. | ✅ Pass |
| § No production data outside production | Yes | `DEMO_SEED=true` with the synthetic dataset. FR-027 forbids enabling it against real data. | ✅ Pass |
| § Traceability | Yes | 47 numbered FRs; every task will cite one. | ✅ Pass |
| § Security review gate | Yes | This work touches disclosure surfaces (the front door), caching headers, and the verification delivery path. **It requires explicit security review before merge.** Called out as a task. | ⚠️ Gate required |
| § Data protection gate | Yes | Nothing changes what personal data is collected, displayed, cached, logged or transferred. Review is expected to be a formality, but is not self-certifiable. | ⚠️ Gate required |

**Gate result: PASS.** No violation requires justification, so Complexity Tracking is empty. Two process
gates (security review, data protection review) and one mandatory technical control (`.dockerignore` before
first build) are carried into `tasks.md`.

**Post-Phase-1 re-check**: re-evaluated after the design artifacts below were written. No principle moves.
The design added one code change not anticipated at gate time — the bind-host variable in
`deploy/local-delivery.mjs` (F-02) — which touches development tooling only, is additive, and preserves
existing behaviour by default. It does not engage any principle.

## Spec amendments required

`/speckit-tasks` should not run until these land, because tasks derived from them would encode a false
premise.

| # | Where | Change | Source |
|---|---|---|---|
| 1 | SC-010 | Replace with: *"A developer can build and run the portal from source with no host toolchain, no host database, and no edits to committed files — none of which is possible today."* The current wording claims Windows source builds are impossible; `pnpm-workspace.yaml` lines 78–81 and the lockfile show they are not. | research.md F-01 |
| 2 | FR-038 | Rewrite. It currently justifies the container by the native-binary exclusion. The true justification is that the build needs no host toolchain and runs the `sh`-syntax scripts in the shell they were written for. | research.md F-01 |
| 3 | Assumptions → "No application changes" | Narrow to permit one additive, default-preserving change to `deploy/local-delivery.mjs` (bind host), which is development tooling and ships in no release. | research.md F-02 |
| 4 | `deploy/LOCAL-DEV.md` | Path B's caveat is stale and should be corrected independently of this feature. | research.md F-01 |

## Architecture

Five services on one user-defined network. Only the front door publishes a port.

```text
                    host :8080
                        │
                ┌───────▼────────┐
                │      web       │  nginx 1.27
                │  (front door)  │  real bhi-portal.conf, 5 substitutions
                └───┬────────┬───┘  serves built frontend from /var/www/bhi-portal
              /api/ │        │ /__inbox
                ┌───▼────┐ ┌─▼──────┐
                │  api   │ │  mail  │  local-delivery.mjs
                │  :3001 │ │ :2525  │  SMTP sink
                │        │ │ :2526  │  inbox + SMS webhook
                └───┬────┘ └────────┘
                    │ SMTP :2525, POST :2526/sms
                    │
              ┌─────▼─────┐      ┌──────────┐
              │    db     │◄─────│ migrate  │  one-shot, every start
              │  :5432    │      │          │  applies deploy/db/migrations/*.sql
              └───────────┘      └──────────┘
                    │
              bhi-db-data (named volume)
```

**Startup ordering** (FR-012), each gate a real readiness condition, never a sleep:

```text
db  ──[healthcheck: pg_isready]──►  migrate  ──[exit 0]──►  api  ──[healthcheck: /api/healthz]──►  web
                                                             mail ─────────────────────────────────┘
```

## Project Structure

### Documentation (this feature)

```text
specs/001-docker-compose-stack/
├── plan.md                       # This file
├── spec.md                       # Feature specification
├── research.md                   # Phase 0 — decisions, findings, corrections
├── data-model.md                 # Phase 1 — services, volume, config as entities
├── quickstart.md                 # Phase 1 — runnable validation walkthrough
├── contracts/
│   ├── operator-commands.md      # The command surface
│   ├── service-topology.md       # Services, names, ports, dependencies, health
│   └── configuration.md          # Environment variable contract
├── checklists/
│   └── requirements.md           # Spec quality checklist
└── tasks.md                      # Phase 2 — NOT created by /speckit-plan
```

### Source Code (repository root)

New files this feature adds, and the existing tree they sit alongside:

```text
compose.yaml                      # NEW — the stack definition
.env.example                      # NEW — committed placeholders (.env is already gitignored)
.dockerignore                     # NEW — MANDATORY before any build (see Constitution Check)

docker/                           # NEW — everything the images need
├── api.Dockerfile                # deps → build → runtime, targets: api
├── web.Dockerfile                # deps → build → nginx runtime
├── nginx/
│   └── render-config.sh          # applies the 5 documented substitutions to deploy/nginx/*
└── db/
    └── initdb/
        ├── 00-extensions.sql     # CREATE EXTENSION pgcrypto
        └── 10-schema.sql         # thin wrapper that loads deploy/db/schema.sql
docker/migrate/
└── apply-migrations.sh           # one-shot: deploy/db/migrations/*.sql in filename order

deploy/                           # EXISTING — read by the build, otherwise untouched
├── db/schema.sql, db/migrations/ #   consumed by initdb + migrate
├── nginx/*.conf, proxy_params    #   consumed by render-config.sh, NOT modified
├── local-delivery.mjs            #   ONE additive change: bind host variable (F-02)
├── api/, web/                    #   prebuilt bundles — untouched, not used by this stack
└── LOCAL-DEV.md                  #   updated: new path documented, stale caveat corrected

artifacts/                        # EXISTING — the source the images build from
├── api-server/                   #   build.mjs → esbuild single-file bundle
└── bhi-card-portal/              #   vite build → dist/public
```

**Structure Decision**: a `docker/` directory at the repository root holds everything the images need, with
`compose.yaml`, `.env.example` and `.dockerignore` at the root where Compose and the build daemon expect
them. `deploy/` stays exactly as it is — the build reads from it and writes nothing to it, so the existing
nginx-and-systemd deployment path and `make-release.mjs` are unaffected (FR-035, FR-036). The one exception
is the additive bind-host change to `local-delivery.mjs`, which is development tooling.

## Implementation Phases

| Phase | Delivers | Gates on |
|---|---|---|
| **A. Foundation** | `.dockerignore`, `.env.example`, `compose.yaml` skeleton, `db` + `migrate` services | Nothing. `.dockerignore` is first, before any image is ever built. |
| **B. API image** | `docker/api.Dockerfile`, API service reaching a healthy `/api/healthz` against the containerised database | A |
| **C. Front door** | `docker/web.Dockerfile`, `render-config.sh`, frontend build, portal loading in a browser | B |
| **D. Delivery** | Bind-host change to `local-delivery.mjs`, `mail` service, `/__inbox` proxied, full lookup→code→verify→card flow | C |
| **E. Verification** | RBAC suite against the stack, image secret inspection, restart-persistence check, failure-message checks | D |
| **F. Documentation and gates** | `LOCAL-DEV.md` rewrite, the FR-047 substitution table, security review, data protection review | E |

Phases A–D are strictly sequential — each builds on a working predecessor. Within E the checks are
independent and can run in any order.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A secret is baked into an image layer | Low | **Severe** — constitutional violation | `.dockerignore` is the first task in Phase A; acceptance inspects the built image, not the file list |
| Production rate limits make the RBAC suite flaky | Medium | Medium — SC-007 unreliable | D-06 makes the three rates overridable; the default stays production-honest |
| `pnpm install --frozen-lockfile` fails in the Linux image | Low | High — blocks Phase B | The lockfile is Linux-first and this is the platform it was authored for; `minimumReleaseAge` is irrelevant with a frozen lockfile |
| Bind-mount file-watching or CRLF issues on the Windows host | Medium | Low | The build copies rather than bind-mounts; there is no hot-reload requirement in the spec |
| Someone runs `down -v` expecting `down` | Medium | Medium — lost local data | Documented explicitly; the quickstart never shows `-v` in a routine step |
| First build exceeds the 15-minute SC-001 budget on a slow machine | Low | Low | Dependency layer is cached and keyed only on lockfile inputs; the budget is for first run only |

## Complexity Tracking

No Constitution Check violations. Nothing to justify.
