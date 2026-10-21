# Contract: Service Topology

**Date**: 2026-08-11 | **Plan**: [../plan.md](../plan.md)

The wiring contract. Service names are DNS names on the stack network and are load-bearing — the API's
`DATABASE_URL`, the front door's `proxy_pass`, and the API's delivery URLs all address services by these
names.

## Services

| Service | Image | Command | Internal | Published | Restart |
|---|---|---|---|---|---|
| `db` | `postgres:16-alpine` | image default | 5432 | none | unless-stopped |
| `migrate` | `postgres:16-alpine` | `apply-migrations.sh` | — | none | **no** |
| `api` | built, target `api` | `node --enable-source-maps dist/index.mjs` | 3001 | none | unless-stopped |
| `mail` | built, runtime stage | `node deploy/local-delivery.mjs` | 2525, 2526 | none | unless-stopped |
| `web` | built, target `web` | nginx foreground | 80 | `${WEB_PORT:-8080}` | unless-stopped |

Exactly one published port. Everything else is reachable only from inside the stack network — which is what
preserves the production property that the front door is the sole entry point (FR-017, and see
[research.md](../research.md) D-08 for why `HOST=0.0.0.0` inside an unpublished container is the correct
translation of production's `HOST=127.0.0.1`).

## Dependency graph

```text
db ──healthy──► migrate ──completed_successfully──► api ──healthy──► web
                                                    mail ──started──┘
```

| Service | Waits for | Condition |
|---|---|---|
| `migrate` | `db` | `service_healthy` |
| `api` | `migrate` | `service_completed_successfully` |
| `web` | `api` | `service_healthy` |
| `web` | `mail` | `service_started` |
| `mail` | — | — |

Every condition is observable. A bare dependency — "container created" — does not satisfy FR-012 and is a
defect wherever it appears.

## Health checks

| Service | Check | Why this one |
|---|---|---|
| `db` | `pg_isready -U bhi_user -d bhi_portal` | The only check that means "accepting connections", which is the thing that is false for tens of seconds after the container starts |
| `api` | `GET /api/healthz` → 200 | Existing endpoint. Answers without touching the database, so it isolates process liveness |
| `web` | `nginx -t` at build; HTTP 200 on `/` at runtime | A config error fails the build rather than the start |

`GET /api/readyz` is deliberately **not** the API's health check. It returns 503 when the database is
unreachable, so using it would take the API out of the stack for a database fault. The pair is the
diagnostic tool (`healthz` ok + `readyz` 503 = database; both ok = one route's fault) and that distinction
must survive containerisation.

## Routing through the front door

| Path | Destination | Notes |
|---|---|---|
| `/api/v1/lookup` | `api:3001` | `limit_req zone=bhi_lookup burst=3 nodelay` |
| `/api/v1/admin/auth/login` | `api:3001` | `limit_req zone=bhi_adminlogin burst=2 nodelay` |
| `/api/` | `api:3001` | `burst=40`, `client_max_body_size 12m`, `proxy_buffering off` |
| `/__inbox`, `/__inbox/*` | `mail:2526` | **Added locally.** Substitution 5 |
| `/assets/` | static, `/var/www/bhi-portal` | 1-year immutable cache |
| `/.*` (dotfiles) | denied | |
| everything else | `index.html` | SPA fallback |

**`proxy_pass` has no trailing slash.** The API mounts its router at `/api`, so the prefix must be forwarded
intact. Adding a slash makes nginx strip it and every route 404s. The production config carries a comment
saying exactly this; the transform must not disturb it.

## Internal addresses

| Consumer | Variable | Value |
|---|---|---|
| `api` | `DATABASE_URL` | `postgresql://bhi_user:…@db:5432/bhi_portal` |
| `api` | `SMTP_HOST` / `SMTP_PORT` | `mail` / `2525` |
| `api` | `SMS_WEBHOOK_URL` | `http://mail:2526/sms` |
| `migrate` | `PGHOST` | `db` |
| `web` | upstream | `api:3001` (substitution 1) |
| `web` | inbox upstream | `mail:2526` (substitution 5) |

A `localhost` or `127.0.0.1` in any of these is a defect. It is also the most likely copy-paste error, since
every one of these values *is* a loopback address in the current non-containerised setup.

## Host ports

| Variable | Default | Maps to | Known conflicts |
|---|---|---|---|
| `WEB_PORT` | 8080 | `web:80` | The existing `pnpm run local` front door |
| `DB_PORT` | *(unpublished)* | `db:5432` | A host PostgreSQL install — the reason this is off by default |
| `API_PORT` | *(unpublished)* | `api:3001` | VS Code's extension host holds 3001 on this machine |

The two unpublished mappings exist as commented, documented overrides. Both defaults are off precisely
because `deploy/LOCAL-DEV.md` records both conflicts as real on this machine.

## Network

One user-defined bridge network, created by Compose. No host networking, no container-to-container port
publishing, no links. Service discovery is Compose's built-in DNS and nothing else.
