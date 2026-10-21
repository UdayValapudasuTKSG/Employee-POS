# Running the BHI Health Card Portal locally (Windows)

Three ways to run it.

**Path D (Docker)** is the one to use. One command, nothing installed on the
host but Docker Desktop, and it runs the *real* production nginx config so what
you test locally is what ships. **Path A** uses the prebuilt bundles in this
folder and needs Node + PostgreSQL on the host. **Path B** runs from source with
hot reload.

Ports used locally: **8080** front door, **3101** API, **2525** local SMTP,
**2526** code inbox, **5432** PostgreSQL. (Production uses 3001 for the API;
VS Code's extension host squats on 3001 on this machine, so the local API moves
to 3101.)

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm run local` | Start and supervise everything (API + front door + delivery sink) |
| `pnpm run local:stop` | Kill leftover dev servers — the fix for `EADDRINUSE` |
| `pnpm run local:watch` | Same as `local`, plus restart a service when its file changes |
| `pnpm run local:devcode` | Same, but OTP codes come back inline instead of being delivered — required by `rbac-test.mjs` |
| `pnpm run local:db` | Create/load the database (idempotent) |
| `pnpm run local:test` | RBAC suite (needs `local:devcode` running; set `BASE_URL`) |
| `pnpm run local:api` | Just the API |
| `pnpm run local:web` | Just the front door |
| `pnpm run local:mail` | Just the delivery sink |

`npm run …` works for all of these too — the `preinstall` pnpm guard only fires
on `install`, not on `run`. Or skip the package manager entirely:
`node deploy/start-local.mjs`.

---

## Path D — Docker (recommended)

> **Developer machines only.** This stack seeds demo accounts with publicly
> documented passwords and terminates no TLS. The supported deployment route is
> the nginx + systemd install in [README.md](README.md). Never deploy this.

Nothing on the host but Docker Desktop. No PostgreSQL, no Node, no pnpm, no
superuser password prompt, no manual schema load.

```powershell
Copy-Item artifacts/api-server/.env.example      artifacts/api-server/.env       # backend: set DATABASE_URL and SESSION_SECRET
Copy-Item artifacts/bhi-card-portal/.env.example artifacts/bhi-card-portal/.env  # frontend: ports, base URL, proxy
pnpm run stack:up
docker compose logs -f
```

| What | URL |
| --- | --- |
| Employee card lookup | http://localhost:8080/ |
| Admin portal | http://localhost:8080/admin/login |
| **Code inbox** (email + SMS) | http://localhost:8080/__inbox |
| API health / readiness | http://localhost:8080/api/healthz, `/api/readyz` |

Same demo logins as Path A — password `Demo@2026`.

### Commands

| Command | What it does |
| --- | --- |
| `docker compose up -d --build` | Start, building images if needed |
| `docker compose logs -f` | Follow every service, each line attributed |
| `docker compose ps` | What is running and whether it is healthy |
| `docker compose down` | Stop. **Keeps your data** |
| `docker compose down -v` | **DESTROYS the database.** The only command that does |
| `docker compose up -d --build api web` | Rebuild after a source change |
| `docker compose exec db psql -U bhi_user -d bhi_portal` | Database shell |

`down` and `down -v` differ by two characters and by everything else.

### What it runs

Five services on one private network. Only the front door is published.

| Service | Role | Published |
| --- | --- | --- |
| `db` | PostgreSQL 16 | no |
| `migrate` | Applies `db/migrations/*.sql` on every start, then exits | no |
| `api` | The API, built from `artifacts/api-server` | no |
| `mail` | Local SMTP sink + code inbox (`local-delivery.mjs`) | no |
| `web` | **The real production nginx**, serving the built frontend | `8080` |

Two things follow from that table:

**The API is unreachable from your host.** That is deliberate — it mirrors
production, where `HOST=127.0.0.1` makes nginx the only entry point. Here the
container network does the same job. Uncomment the `api` service's `ports:` in `compose.yaml` if you need
a direct client.

**The front door is the real one.** `docker/nginx/render-config.sh` reads
`nginx/bhi-portal.conf` on every build and applies five substitutions — it is not
a fork and not a template. So the rate limits, the `client_max_body_size 12m`,
the `X-Request-Id` correlation and the SPA fallback you exercise locally are the
ones that ship. The full list of differences is in that script's header.

### Verification codes

`OTP_DEV_MODE=false`, so the API runs its **real** delivery code — nodemailer over
SMTP, the webhook POST for SMS. The `mail` service is a real SMTP server and a
real webhook endpoint that capture the message instead of forwarding it. No
provider, no account, no cost.

Read the code at http://localhost:8080/__inbox.

**Unlike `serve-local.mjs`, any-6-digits does not work here.** That shortcut lives
in the local front door this stack replaces. You get the real hash comparison,
the real attempt counting and the real lockout — which is the point.

### Startup ordering

```text
db --healthy--> migrate --exit 0--> api --healthy--> web
```

Every gate is an observable check, never a sleep. The API cannot start before
migrations have finished, so `SCHEMA_OUT_OF_DATE` cannot happen from a race.

### Troubleshooting

| Symptom | Cause |
| --- | --- |
| `port is already allocated` | Something holds 8080 — usually `pnpm run local`. Change `WEB_PORT` in `artifacts/bhi-card-portal/.env`, or stop it |
| `api` restarts forever | The host in `DATABASE_URL` must be **`db`**, not `localhost`. This is the most common error in the file: `localhost` is correct for Path A and wrong here |
| `SCHEMA_OUT_OF_DATE` | `docker compose logs migrate` |
| Portal loads but `/api` 502s | The API is not healthy. `docker compose logs api` |
| Portal loads blank | Frontend built without `BASE_PATH=/`. `docker compose build --no-cache web` |
| Inbox 404s | `mail` is down, or the `/__inbox` substitution did not apply |
| `429` after a few quick lookups | Working as intended — the production rate limits are in force. Raise `RATE_LOOKUP` in `artifacts/bhi-card-portal/.env` for a test run |
| Data vanished | `down -v` was run instead of `down` |

### RBAC suite against the stack

The suite asserts on the inline `devCode`, so set `OTP_DEV_MODE=true` in `artifacts/api-server/.env`,
and raise `RATE_API` in `artifacts/bhi-card-portal/.env` — 79 assertions against the production 120r/m is close
enough to the ceiling to fail for reasons unrelated to what it measures.

```powershell
docker compose up -d
$env:BASE_URL="http://127.0.0.1:8080/api"; node artifacts/api-server/scripts/rbac-test.mjs
```

Expect `PASS 79  FAIL 0`. Restore both settings afterwards. This is the one thing
here that needs Node on the host — the suite runs there; it is not part of the
stack.

---

## Path A — prebuilt bundles on the host

### 1. One-time: create and load the database

```powershell
powershell -ExecutionPolicy Bypass -File deploy\db\setup-local.ps1
```

Prompts once for the `postgres` superuser password, then creates two roles and
the `bhi_portal` database, loads `deploy/db/schema.sql` into it when it is
empty, and applies every file in `deploy/db/migrations/`. Re-running it is safe.

| Role | Password (local only) | Used by |
|---|---|---|
| `bhi_user` | `bhi_local_dev` | the one login, in `DATABASE_URL` (host `127.0.0.1` when running on this machine): owns the tables, runs migrations |
| `bhi_app` | none (no login) | the role the API switches every connection to |

> The API connects with `DATABASE_URL` but runs every query as `bhi_app`, so
> row-level security applies even when that login is a superuser. The
> integration tests check this: they fail if a query would bypass it. See
> [specs/002-per-company-schema/research.md](../specs/002-per-company-schema/research.md) R4–R5.

Verify:

```powershell
$env:PGPASSWORD="bhi_local_dev"
& "C:\Program Files\PostgreSQL\15\bin\psql.exe" -h 127.0.0.1 -U bhi_user -d bhi_portal -c "\dt bhi.*"
```

Expect 21 tables, all in the one schema `bhi`: the client's 11 (company, member,
dependent, beneficiary, class, premium_rates, company_billing_rule, billing_run,
billing_line, enrollment_status_history, import_exception) and the portal's 10
(admin_users, activity_log, employee_sessions, change_requests,
policy_memberships, import_batch, import_exception_resolutions,
member_class_history, billing_run_issues, discount_coupons). `public` is empty.

### 2. Start everything — one command, one terminal

```powershell
pnpm run local          # or: node deploy/start-local.mjs
```

Starts three supervised services, waits until the API reports healthy, then
prints the URLs and demo logins. Ctrl+C stops all of them.

| Service | Port | File |
| --- | --- | --- |
| `api` | 3101 | `deploy/api/index.mjs` |
| `web` | 8080 + SMTP 2525 | `deploy/serve-local.mjs`, which embeds `local-delivery.mjs` |

The OTP delivery sink runs **inside** the web server, so there is no third
process to forget — if the frontend is up, email and SMS verification work.

**It keeps running.** A service that crashes is restarted automatically (with
backoff; it gives up after 5 restarts in 10s so a broken build doesn't spin).
With `--watch`, editing a service's file restarts just that service.

Before spawning anything it checks what actually goes wrong and says how to fix
it: PostgreSQL not accepting connections, or a port already taken (the
`EADDRINUSE` case), naming the command that finds the owning process.

It also reformats the API's production JSON logs into readable one-liners:

```
[mail] SMTP     127.0.0.1:2525
[api]  14:16:42 INFO  Server listening port=3101
[api]  14:16:42 INFO  BHI demo credentials adminPassword=Demo@2026 ...
[web]  Portal   http://localhost:8080/
```

First start against an empty database seeds the demo dataset (6 companies,
120 members, dependents, 5 admin accounts). The `BHI demo credentials` line
prints the admin logins plus a ready-to-use sample member email and phone.

Ports live in the two env files; a shell variable overrides WEB_PORT for one run:

```powershell
$env:WEB_PORT="8090"; node deploy/start-local.mjs   # front door (WEB_PORT in artifacts/bhi-card-portal/.env)
# API port: edit LOCAL_PORT in artifacts/api-server/.env
```

### 2b. Or run the pieces separately

Useful when you want to restart just one:

```powershell
pnpm run local:api    # backend  (port 3101)
pnpm run local:web    # frontend + delivery sink + inbox  (port 8080, SMTP 2525)
```

`serve-local.mjs` is the local stand-in for `deploy/nginx/bhi-portal.conf`: it
serves `deploy/web` with SPA fallback and reverse-proxies `/api/*` to the API.
The built frontend calls `/api/...` on its own origin, so the proxy is
required — opening `deploy/web/index.html` directly will not work.

`pnpm run local:mail` runs the delivery sink on its own (2525 + 2526) for
debugging it in isolation; set `DELIVERY_SINK=off` so the web server doesn't
also try to bind 2525.

### 3. Open it

| What | URL |
| --- | --- |
| Employee card lookup | http://localhost:8080/ |
| Admin portal | http://localhost:8080/admin/login |
| **Code inbox** (email + SMS) | http://localhost:8080/__inbox |
| API health check | http://localhost:8080/api/healthz |

**Demo admin logins** — password `Demo@2026` for all of them:

| Email | Role | Scope |
| --- | --- | --- |
| platform.admin@bhi-demo.test | ROLE_PLATFORM_ADMIN (super admin) | all companies |
| client.foods@bhi-demo.test | ROLE_CLIENT_ADMIN | BF only |
| hr.foods@bhi-demo.test | ROLE_HR_ADMIN | BF only |
| hr.auto@bhi-demo.test | ROLE_HR_ADMIN | BA only |
| support@bhi-demo.test | ROLE_SUPPORT | all companies |
| auditor@bhi-demo.test | ROLE_AUDITOR | read-only |
| client.admin@st.test | ROLE_CLIENT_ADMIN | ST only |
| hr@st.test | ROLE_HR_ADMIN | ST only |

### 4. Verifying by email and SMS

`OTP_DEV_MODE=false`, so lookups run the **real** delivery code — nodemailer
over SMTP for email, the webhook POST for SMS — exactly as in production. There
is no paid provider and no account: `deploy/local-delivery.mjs` is a real (tiny)
SMTP server and a real webhook endpoint that capture the message instead of
forwarding it.

1. Open http://localhost:8080/ and enter a member **email** → the API sends it
   over SMTP to `127.0.0.1:2525`.
   Or enter a member **phone** → the API POSTs `{to, body}` to
   `http://127.0.0.1:8080/__inbox/sms`.
2. Type **any 6 digits** — see below. Or read the real code from
   http://localhost:8080/__inbox (appears within ~2s, code in large type); the
   log line shows it too: `[otp] EMAIL -> devon…@bhi-demo.test  code=150322`.

### Any 6-digit code is accepted locally

For demos you don't have to fetch the real code — type `000000` and it verifies.

**This does not weaken the API.** The shortcut lives in
`deploy/serve-local.mjs`, which nginx replaces in production, so it is
physically absent from a real deployment. It works by swapping the code you
typed for the one the sink actually captured before forwarding the request — the
API still does its real sha256 comparison, attempt counting and lockout. Every
substitution is logged:

```
[otp] accepted any code: "000000" -> 500872
```

It is skipped when any of these is true:

| Condition | Effect |
| --- | --- |
| `OTP_ACCEPT_ANY=false` | Real code required locally too |
| Request sends `x-otp-strict: 1` | Real code required for that request |
| No code captured yet | Nothing to substitute — so `--devcode` mode is unaffected |

**Production is untouched.** `deploy/api/index.mjs` was not modified; a real
server verifies the real code, full stop.

Member identifiers: the API logs a ready-to-use email and phone at startup
(`BHI demo credentials`), or take them from the admin portal's Members list, or
query directly:

```powershell
$env:PGPASSWORD="bhi_local_dev"
& "C:\Program Files\PostgreSQL\15\bin\psql.exe" -h 127.0.0.1 -U bhi_user -d bhi_portal `
  -c "SELECT set_config('bhi.all', 'on', false); SELECT email, phone FROM bhi.member WHERE email IS NOT NULL LIMIT 5;"
```

`+592-555-0123` is shared by five BF members and exercises the disambiguation
(SELECT) flow before the SMS goes out.

**Sending for real.** No code change needed — just point the env file at a
provider. Any SMTP host works for email (Brevo, Gmail app password, SES, your
mail server). For SMS, `SMS_WEBHOOK_URL` is a provider-agnostic seam: point it
at any endpoint that accepts `POST {"to","body"}`.

**Twilio is not used and is not wired in.** It's a paid service (no free tier
for SMS beyond a trial credit), so per the project's preference it was left out;
the SMS webhook exists precisely so a provider can be bolted on later without
touching the API.

### 5. RBAC test suite (optional)

The suite asserts on the inline `devCode`, which real delivery deliberately
withholds — so start the stack in dev-code mode for this run:

```powershell
pnpm run local:devcode
# then, in another terminal:
$env:BASE_URL="http://127.0.0.1:8080/api"; node artifacts/api-server/scripts/rbac-test.mjs
```

Expect `PASS 79  FAIL 0` against a freshly seeded database. Running it against
the normal (`pnpm run local`) stack gives `PASS 74  FAIL 5` — the 5 failures are
all the devCode-dependent assertions, not real regressions.

---

## Path B — from source, with hot reload

### ~~Caveat: the workspace excludes Windows native binaries~~ — no longer true

This section used to say `pnpm-workspace.yaml` prunes the `win32-x64` native
binaries, so `pnpm install` on Windows produced an esbuild/rollup/tailwind
install with no runnable binary. **That was fixed and this note was not.**

`pnpm-workspace.yaml` now says the opposite, at the top of its `overrides` block:

> `win32-x64 entries intentionally NOT pruned: they are optional deps gated by OS,
> so Linux/Replit installs skip them anyway, while removing them here is what
> makes pnpm install (and therefore any build) work on Windows.`

Only `win32-arm64` and `win32-ia32` are still pruned, and `pnpm-lock.yaml` carries
`@esbuild/win32-x64`, `@rollup/rollup-win32-x64-msvc`,
`@tailwindcss/oxide-win32-x64-msvc` and `lightningcss-win32-x64-msvc`. A Windows
x64 source build works with no config change.

Two smaller Windows frictions in this path are still real, and are why Path D
exists — see the notes at the end of this section about the `export …` line in
the API's `dev` script and Vite's missing `/api` proxy.

### Then

```powershell
pnpm install

# Terminal 1 — API (build + run; rerun after each source change)
$env:DATABASE_URL="postgresql://bhi_user:bhi_local_dev@127.0.0.1:5432/bhi_portal"
$env:SESSION_SECRET="local-dev-only"; $env:PORT="3101"; $env:DEMO_SEED="true"; $env:OTP_DEV_MODE="true"
pnpm --filter @workspace/api-server run build
node --enable-source-maps artifacts/api-server/dist/index.mjs

# Terminal 2 — Vite dev server
$env:PORT="5173"; $env:BASE_PATH="/"
pnpm --filter @workspace/bhi-card-portal run dev
```

`artifacts/api-server` `package.json`'s `dev` script starts with
`export NODE_ENV=... &&`, which is `sh` syntax — it fails under PowerShell/cmd.
Run `build` and `start` separately as above, or `pnpm config set script-shell
"C:\\Program Files\\Git\\bin\\bash.exe"`.

**Vite needs a proxy.** `artifacts/bhi-card-portal/vite.config.ts` has no
`server.proxy` — on Replit the platform router maps `/api` to the API service.
Locally, add this to the config so the dev server can reach the API:

```ts
server: {
  port,
  strictPort: true,
  host: '0.0.0.0',
  allowedHosts: true,
  fs: { strict: true },
  proxy: {
    '/api': { target: 'http://127.0.0.1:3101', changeOrigin: true },
  },
},
```

Then open http://localhost:5173/.

---

## Rates, classes and billing locally

The demo seed (`DEMO_SEED=true`) loads the placeholder rate card from `deploy/db/seed/premium_rates_standard.csv` for classes A, B and C, so you can create members and generate bills. Without the demo seed, load the card yourself before adding members:

```powershell
$env:DATABASE_URL="postgresql://bhi_user:bhi_local_dev@127.0.0.1:5432/bhi_portal"
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/api-server run load:standard-rates
```

Demo logins (password `Demo@2026`):
- `platform.admin@bhi-demo.test` is the super admin. It sees **Companies**, **Classes**, **Rates** and **Billing**.
- `client.admin@st.test` is Sterling Test's client admin and sees only ST.
- `client.foods@bhi-demo.test` is Beharry Foods' client admin and sees only BF.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Cannot find module 'C:\home\runner\workspace\...\thread-stream-worker.mjs'` | `NODE_ENV` is not `production`. The prebuilt bundle's pretty-logger path was baked in on the build machine. Keep `NODE_ENV=production` in `artifacts/api-server/.env`; `DEMO_SEED` and `OTP_DEV_MODE` are set explicitly so demo behaviour is unaffected. |
| `EADDRINUSE :3101`, `:8080` or `:2525` | A previous run is still going — usually a terminal closed without Ctrl+C, or a parent killed in a way Windows didn't propagate to its children. Run **`pnpm run local:stop`**, then start again. It only kills this project's servers; anything else holding the port is reported and left alone (VS Code owns 3001 on this machine, for instance). |
| API silently listens on the wrong port | Node's `--env-file` does **not** override variables already in the shell. If `$env:PORT` is set in your session, it beats `.env`. Use `node deploy/start-local.mjs` (it passes the file's values explicitly) or clear the variable: `Remove-Item Env:PORT`. |
| `password authentication failed` | The password in `DATABASE_URL` disagrees with the one in `setup-local.ps1`. |
| `permission denied to set role "bhi_app"` | The `DATABASE_URL` login may not switch to `bhi_app`. Re-run `setup-local.ps1`, or as `postgres`: `GRANT bhi_app TO bhi_user;` |
| `permission denied for schema public` | PostgreSQL 15+ no longer grants CREATE on `public`. `setup-local.ps1` step 2 handles it — re-run it. |
| API reachable but portal shows "API unreachable" | Only `serve-local.mjs` is running. Start the API too, or use `pnpm run local`. |
| The lookup says a code was sent, but none arrives | The front door isn't running, so the sink that receives the code isn't either. Start it: `pnpm run local:web` (or `pnpm run local`). The lookup answers "code sent" whether or not delivery works, so that it never reveals whether a contact is on file; the failure is in the API log and in `bhi.activity_log` (kind `EVENT`, action `OTP_DELIVERY`, result `FAILED`). |
| `EADDRINUSE :2525` from the web server | A standalone `local:mail` is already holding the SMTP port. Stop it, or start the web server with `DELIVERY_SINK=off`. |
| Nothing arrives in the inbox | `OTP_DEV_MODE` is `true` (the code came back inline in the API response instead). Check the `delivery` line the launcher prints at startup. |
| `rbac-test.mjs` fails 5 assertions | Expected without `--devcode`. See step 5. |
