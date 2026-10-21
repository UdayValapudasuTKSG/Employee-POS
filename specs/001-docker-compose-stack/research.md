# Phase 0 Research: Containerised Portal Stack

**Date**: 2026-08-11
**Spec**: [spec.md](./spec.md)

## Findings that correct the specification

Two assumptions carried into `spec.md` from `deploy/LOCAL-DEV.md` turned out not to match the repository as
it stands. Both are recorded here and both require a spec amendment before `/speckit-tasks`.

### F-01 — Windows source builds are no longer blocked (SC-010 is wrong)

**What the spec says**: SC-010 claims the portal "can be built and run from source on a Windows host, which
is currently not possible at all." `deploy/LOCAL-DEV.md` Path B states the workspace "sets every non-Linux
platform package to `-`" and names `esbuild>@esbuild/win32-x64`, `rollup>@rollup/rollup-win32-x64-msvc`
and `@tailwindcss/oxide>@tailwindcss/oxide-win32-x64-msvc` as excluded.

**What is actually true**: `pnpm-workspace.yaml` no longer prunes any `win32-x64` package, and says so
explicitly at lines 78–81:

> `win32-x64 entries intentionally NOT pruned: they are optional deps gated by OS, so Linux/Replit installs skip them anyway, while removing them here is what makes pnpm install (and therefore any build) work on Windows.`

Only `win32-arm64` and `win32-ia32` remain pruned. `pnpm-lock.yaml` carries the Windows x64 binaries —
`@esbuild/win32-x64@0.27.3`, `@rollup/rollup-win32-x64-msvc@4.62.3`,
`@tailwindcss/oxide-win32-x64-msvc@4.3.3`, `lightningcss-win32-x64-msvc@1.32.0`.

**Consequence**: `LOCAL-DEV.md` Path B's caveat is stale documentation. The container is not the only way to
build on Windows, and the feature must not be justified on that basis.

**What remains genuinely true**, and still justifies this feature:

| Real friction, still present | How the stack removes it |
|---|---|
| Requires PostgreSQL installed on the host, a superuser password prompt, and a manual setup script | Database is a service; initialisation is automatic |
| `artifacts/api-server`'s `dev` script opens with `export NODE_ENV=… &&`, which is `sh` syntax and fails under PowerShell | The build runs in a Linux container where that syntax is correct |
| `artifacts/bhi-card-portal/vite.config.ts` has no `server.proxy`, so the dev server cannot reach the API without hand-editing a committed file | The front door proxies `/api`, exactly as production does |
| Four processes across several terminals, plus port conflicts with VS Code (3001) and any host PostgreSQL (5432) | One command, one log stream, ports declared in one place |
| The local front door is `serve-local.mjs`, which nginx replaces in production — so the real site config is never exercised locally | The real site config is what runs |

**Decision**: replace SC-010 with a claim that is true. Proposed wording:

> **SC-010**: A developer can build and run the portal from source with no host toolchain, no host database, and no edits to committed files — none of which is possible today.

**Alternatives considered**: leaving SC-010 as written (rejected — it is false, and a success criterion that
cannot be honestly evaluated is worse than none); deleting it (rejected — the underlying value is real and
worth measuring).

### F-02 — The delivery sink hard-binds to loopback and cannot be reached across containers

**Finding**: `deploy/local-delivery.mjs` binds both listeners to `127.0.0.1` — the SMTP server at line 245
and the HTTP inbox at line 479. Neither host is configurable. In a container, `127.0.0.1` is the container's
own loopback, so the API container could not deliver to it and nginx could not proxy the inbox to it.

**Decision**: add an optional bind-host environment variable to `deploy/local-delivery.mjs`, defaulting to
`127.0.0.1` so every existing invocation (`pnpm run local`, `pnpm run local:mail`, and the sink embedded in
`serve-local.mjs`) behaves exactly as it does today. The compose stack sets it to `0.0.0.0`.

**Why this is not a violation of the spec's "no application changes" assumption**: `local-delivery.mjs` is
development tooling under `deploy/`, not application code. It ships in no release and runs on no server —
`make-release.mjs` packages `deploy/api`, `deploy/web`, `deploy/db` and `deploy/nginx`. The change is
additive and default-preserving. It should still be called out explicitly in `tasks.md` rather than smuggled
in, and the spec's assumption should be narrowed to say so.

**Alternatives considered**:
- Host networking for the mail service — not supported for Linux containers on Docker Desktop for Windows in
  the way this would need; rejected as non-portable.
- Running the sink inside the API container — rejected, contradicts FR-045 (separate service) and couples
  two lifecycles.
- A TCP forwarder sidecar bridging `0.0.0.0` to the sink's loopback — rejected as three moving parts to avoid
  a two-line change.

## Technology decisions

### D-01 — Database image: `postgres:16-alpine`

**Decision**: PostgreSQL 16, Alpine variant.

**Rationale**: `deploy/README.md` records that `db/schema.sql` was generated with PostgreSQL 16 and requires
a client of 14 or newer. Matching the generating version removes any restore ambiguity. Alpine keeps the
image small; the stack uses no locale-sensitive collation that would argue for the Debian variant.

**Alternatives**: `postgres:15` (matches the machine's existing host install per `LOCAL-DEV.md`, but not the
schema's generating version); `postgres:17` (newer than anything this schema has been tested against).

### D-02 — Database initialisation: image entrypoint for schema, a one-shot service for migrations

**Decision**: two mechanisms, mirroring `setup-local.ps1`'s own four steps.

1. The official image's `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` variables create the
   `bhi_user` role and `bhi_portal` database. This replaces step 1 of `setup-local.ps1` entirely.
2. `/docker-entrypoint-initdb.d/` scripts run **once**, on an empty data directory only: enable `pgcrypto`,
   then load `schema.sql`. This covers steps 2 and 3.
3. A separate one-shot `migrate` service runs on **every** start and applies
   `deploy/db/migrations/*.sql` in filename order with `ON_ERROR_STOP=1`. This covers step 4.

**Rationale**: `docker-entrypoint-initdb.d` alone cannot satisfy FR-009 — it never runs again once the volume
exists, so a migration added next week would never apply. Splitting them means first run and upgrade run take
the same migration path, which is the path most likely to be wrong and therefore the one worth exercising
constantly. The migrations are already documented as individually idempotent, so re-running the whole set
every start is safe and needs no version-tracking table.

**Note on privileges**: `pgcrypto` requires superuser. The user created by `POSTGRES_USER` is a superuser in
the official image, so `CREATE EXTENSION` succeeds and the `GRANT ALL ON SCHEMA public` / `ALTER SCHEMA
public OWNER` dance from `setup-local.ps1` step 2 is unnecessary — the role already owns the database.

**Alternatives**: putting migrations in `initdb.d` too (rejected — fails FR-009); a migration-tracking table
(rejected — the files are idempotent by design and adding state adds a way to be wrong); running migrations
from the API on boot (rejected — couples schema authority to application startup and makes a failed migration
look like a crash loop).

### D-03 — Application images: multi-stage build from source, Node 22 LTS

**Decision**: `node:22-bookworm-slim`, pnpm via corepack, three stages — dependency install, build, runtime.
Dependencies are installed in a layer keyed only on `pnpm-lock.yaml`, `pnpm-workspace.yaml` and the workspace
`package.json` files, so a source-only change never reinstalls them (FR-042).

**Rationale**: Node 22 is the current LTS and satisfies `deploy/README.md`'s "Node.js 20+". The Debian slim
base rather than Alpine because `esbuild`, `@tailwindcss/oxide`, `lightningcss` and `rollup` all ship glibc
prebuilt binaries; the musl variants are precisely what `pnpm-workspace.yaml` prunes
(`@tailwindcss/oxide-linux-x64-musl`, `@rollup/rollup-linux-x64-musl` are both `"-"`). An Alpine base would
have no usable binary for any of them.

**Alternatives**: `node:22-alpine` (rejected — the lockfile prunes every musl binary this build needs);
`node:20` (works, but 22 is LTS and nothing depends on 20); a single-stage build (rejected — ships the full
toolchain and `node_modules` in the runtime image for no benefit).

### D-04 — Two images or one

**Decision**: two application images from one Dockerfile with distinct targets — `api` (Node runtime) and
`web` (nginx runtime, with the frontend built in an earlier stage).

**Rationale**: they have different runtimes and different lifecycles. Sharing the dependency-install stage
between them means `pnpm install` runs once per build rather than twice.

**Build-time gotcha**: `artifacts/bhi-card-portal/vite.config.ts` throws unless **both** `PORT` and
`BASE_PATH` are set — including for `vite build`, where `PORT` is only consumed by the dev server. The build
stage must set `PORT=5173` and `BASE_PATH=/`. The config's own comment warns that a shell rewriting `/` into
a Windows path produces a silently blank page; inside a Linux container that class of failure cannot occur.

### D-05 — Front door: transform the real site config at build time

**Decision**: the `web` image build copies `deploy/nginx/bhi-portal.conf`, `bhi-portal-limits.conf`,
`bhi-portal-headers.conf` and `proxy_params` from the repository and applies a small, closed set of textual
substitutions. `deploy/nginx/` is **not** modified.

The complete set of differences — this list is the deliverable FR-047 asks for:

| # | Production | Local container | Why |
|---|---|---|---|
| 1 | `proxy_pass http://127.0.0.1:3001` (×3) | `proxy_pass http://api:3001` | The API is a separate container, not a loopback process |
| 2 | `server_name CHANGE_ME.example.com` | `server_name localhost` | No domain locally |
| 3 | `access_log /var/log/nginx/bhi-portal.access.log bhi_portal` | `access_log /dev/stdout bhi_portal` | FR-015 — attributed log output |
| 4 | `error_log /var/log/nginx/bhi-portal.error.log warn` | `error_log /dev/stderr warn` | Same |
| 5 | *(absent)* | `location /__inbox { proxy_pass http://mail:2526; }` inserted | FR-045 — inbox on the portal's origin |
| 6 | `rate=10r/m` / `5r/m` / `120r/m` | Same by default, overridable | See D-06 |

Everything else is byte-identical: the rate-limit zones and their burst values, `limit_conn bhi_conn 20`,
`client_max_body_size 12m`, `proxy_buffering off`, the deliberate absence of a trailing slash on
`proxy_pass`, the `/assets/` immutable caching, the dotfile deny, and the SPA `try_files` fallback.

**Rationale**: this is the only option that keeps one source of truth. The transform reads the real file on
every build, so a change to the production config is picked up automatically and drift is structurally
impossible.

**Alternatives**:
- `envsubst` templating via the nginx image's `/etc/nginx/templates/` — would require rewriting
  `deploy/nginx/bhi-portal.conf` to contain `${VAR}` placeholders, which FR-035 forbids.
- A hand-maintained second copy of the config — exactly what FR-047 rules out.
- `resolver` plus a variable in `proxy_pass` to avoid substitution 1 — changes nginx's DNS-resolution
  behaviour and its 502-on-unresolvable semantics; a real behavioural difference traded for a cosmetic gain.

### D-06 — Rate limits are kept, but the rates are overridable

**Decision**: the production rates are the default. The three `rate=` values in the generated
`bhi-portal-limits.conf` are substituted from environment variables so a test run can raise them.

**Rationale**: keeping the limits is the point of using the real config — a `429` that only appears in
production is the kind of surprise this feature exists to prevent. But the production rates will bite
locally: `bhi_lookup` allows 10 requests per minute with a burst of 3, so a fourth lookup inside a minute is
rejected, and the RBAC suite's 79 assertions against `bhi_api` at 120 r/m with a burst of 40 is close enough
to the ceiling to be flaky. Making the rate a value rather than a constant keeps the default honest and gives
the test run an explicit, visible override instead of a mystery failure.

**Alternatives**: dropping the limits locally (rejected — hides a whole class of production behaviour);
leaving them fixed (rejected — makes SC-007 unreliable for reasons unrelated to what it measures).

### D-07 — Delivery defaults: fully offline

**Decision**: the committed example configuration points email and SMS at the local sink.
`SMTP_HOST=mail`, `SMTP_PORT=2525`, empty `SMTP_USER`/`SMTP_PASS`,
`SMS_WEBHOOK_URL=http://mail:2526/sms`, `OTP_DEV_MODE=false`, `DEMO_SEED=true`.

**Rationale**: FR-024 requires the full journey to work with no external provider. Setting `OTP_DEV_MODE=false`
means the real nodemailer-over-SMTP and real webhook-POST paths execute — the sink is a real SMTP server and
a real webhook endpoint, so this exercises production code rather than a bypass. FR-046 is satisfied by
construction: the `OTP_ACCEPT_ANY` shortcut lives only in `serve-local.mjs`, which is not in this stack.

**Note**: this is deliberately different from the current `deploy/api/.env.local`, which points at real Gmail
SMTP and a real Twilio gateway. See the security finding below.

### D-08 — API network exposure

**Decision**: the API listens on `0.0.0.0:3001` inside its container and is **not** published to the host.
Only the front door publishes a port.

**Rationale**: FR-017 asks for the production posture, where `HOST=127.0.0.1` makes nginx the sole entry
point. The container equivalent is not `HOST=127.0.0.1` — that would make the API unreachable from the nginx
container and break the stack. The equivalent is binding all interfaces *within an unpublished network*: the
container network is not reachable from outside the host, so the front door remains the only way in. The
isolation boundary moves from the interface to the network, and the property FR-017 wants is preserved.
`TRUST_PROXY=1` stays set, since exactly one proxy sits in front.

**Escape hatch**: an optional, commented, off-by-default published port for the API, for debugging with a
direct client.

### D-09 — Configuration: one file at the repository root

**Decision**: a single `.env` at the repository root, copied from a committed `.env.example`. Compose uses it
for both its own interpolation (host ports, image tags) and as the API service's `env_file`.

**Rationale**: FR-018 requires the existing variable names from `deploy/api/.env.example`, which this
preserves. One file to copy is one thing to get wrong instead of two. `.gitignore` already ignores `.env`
and already un-ignores `.env.example` — no gitignore change is needed for this, which is a good sign the
convention already fits.

**Alternatives**: separate compose and application env files (rejected — two files, two copy steps, one more
way to have a mismatch); Docker secrets (rejected — meaningful for Swarm, theatre for a developer stack).

### D-10 — Command surface

| Intent | Command |
|---|---|
| Start (and build if needed) | `docker compose up -d --build` |
| Follow logs | `docker compose logs -f` |
| Stop, keep data | `docker compose down` |
| Reset — **destroys the database** | `docker compose down -v` |
| Rebuild after a source change | `docker compose up -d --build api web` |

**Rationale**: FR-003 and FR-004 require that stopping is safe and only an explicit command destroys data.
`down` and `down -v` differ by two characters, which is thin protection for a destructive action, so the
documentation must state the difference plainly and the quickstart must never show `-v` in a routine step.

## Security finding — act on this before the first build

`deploy/api/.env.local` contains live third-party credentials: a Gmail app password
(`SMTP_PASS`) and a Twilio account SID and auth token (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`).

The file is **not** in version control — `.gitignore` covers `.env.local` and `git ls-files` confirms it is
untracked. So this is not a committed-secret incident. But it is a live-credential-on-disk situation inside
the directory that is about to become a Docker build context, and Docker build contexts copy everything they
are not told to ignore. Baking that file into an image layer would violate FR-020 and Constitution
§ Security, Privacy and Platform Constraints ("No secret may appear in source control, a build artefact, a
container image, or a configuration file").

**Required mitigation, as a first-class task**: a `.dockerignore` that excludes at minimum `**/.env`,
`**/.env.local`, `**/.env.*.local`, `node_modules`, `.git`, `release/`, `**/dist`, `specs/`, `.specify/`.
It must exist before any image is built, and the acceptance check for FR-020 must inspect the built image
rather than trusting the file.

**Separately, and outside this feature's scope**: those Twilio credentials are live and were readable in
plain text. Rotating them is a good idea regardless of what this feature does. That is your call, not a
blocker for the plan.

**Unrelated minor defect noticed**: `deploy/api/.env.local` line 1 begins `f# Local development…` — a stray
leading `f`. Node's `--env-file` parser skips lines without `=`, so it is currently harmless, but it is a
typo in a file people edit by hand.

## Resolved unknowns

| Unknown | Resolution |
|---|---|
| PostgreSQL version | 16, matching the schema's generating version (D-01) |
| Node version | 22 LTS (D-03) |
| Base image libc | glibc — the lockfile prunes every musl native binary (D-03) |
| How migrations apply on an existing volume | One-shot `migrate` service every start (D-02) |
| How nginx reaches the API | Service name `api:3001` via one documented substitution (D-05) |
| How the inbox stays same-origin | nginx `location /__inbox` → `mail:2526` (D-05) |
| Whether the sink works in a container | Not as written — needs a bind-host variable (F-02) |
| Whether rate limits survive | Yes, with overridable rates (D-06) |
| Whether Windows source builds are blocked today | No — the docs are stale (F-01) |
