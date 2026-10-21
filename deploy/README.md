# NALICO / BHI Health Card Portal — nginx deployment package

This folder contains everything needed to run the portal on your own Linux server behind nginx.

```
deploy/
├── web/       → built frontend (static HTML/CSS/JS) — served by nginx
├── api/       → built API server (single-file Node app)
├── db/        → schema.sql (PostgreSQL database schema)
├── nginx/     → bhi-portal.conf (nginx site config)
└── systemd/   → bhi-api.service (optional: run the API as a service)
```

## Prerequisites

- Ubuntu/Debian (or similar) server
- **Node.js 20+** (`node -v`)
- **PostgreSQL 14+**
- **nginx**

## 1. Set up the database

The API needs **one** setting, `DATABASE_URL`, in `.env`:

```
DATABASE_URL=postgresql://bhi_user:CHANGE_ME@localhost:5432/bhi_portal
```

That login owns the tables and runs the migrations. The API connects with it
but runs every connection as `bhi_app`, a role the migrations create: it cannot
delete anything, can only append to the activity log, and is subject to the
row-level security that keeps one company's data away from another's.
Characters such as `@ # / :` in the password must be URL-encoded
(`%40 %23 %2F %3A`).

```bash
sudo -u postgres psql <<'SQL'
CREATE USER bhi_user WITH PASSWORD 'CHANGE_ME';
CREATE DATABASE bhi_portal OWNER bhi_user;
-- The role the API runs as. NOSUPERUSER NOBYPASSRLS is the point of it.
CREATE ROLE bhi_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT bhi_app TO bhi_user;
SQL

# Load the schema (new installation only)
psql "postgresql://bhi_user:CHANGE_ME@localhost:5432/bhi_portal" -f db/schema.sql
```

`db/schema.sql` creates everything, in one schema, `bhi`: the client's BHI
tables and the portal's own tables, 20 in all. Then run **every** migration,
on a new installation and on every upgrade (each is idempotent — safe to
re-run). They grant `bhi_app` its rights and add the starting classes, so they
are needed on a new installation too:

```bash
for f in db/migrations/*.sql; do
  psql "postgresql://bhi_user:CHANGE_ME@localhost:5432/bhi_portal" -v ON_ERROR_STOP=1 -f "$f"
done
```

**Backups:** row-level security is forced on the `bhi` tables, for their owner
too, so `pg_dump` as `bhi_user` needs the all-companies scope:

```bash
PGOPTIONS="-c bhi.all=on" pg_dump --enable-row-security --format=custom \n  --file=bhi_portal.dump "postgresql://bhi_user:CHANGE_ME@localhost:5432/bhi_portal"
```

**No demo data is created in production.** The database starts empty; the
first administrator (the super admin) is created from `ADMIN_EMAIL` /
`ADMIN_PASSWORD` in `.env` (step 2), and rates, companies and members are
loaded in step 5.

## 2. Install the API server

Run these from the extracted `deploy/` folder:

```bash
sudo mkdir -p /opt/bhi-api
sudo cp -r api/. /opt/bhi-api/
sudo cp ../artifacts/api-server/.env.example /opt/bhi-api/.env   # from a repo checkout
sudo nano /opt/bhi-api/.env   # set DATABASE_URL, SESSION_SECRET, SMTP_*, PORT=3001

# Lock down the secrets file — it contains DB credentials and the session key
sudo chown -R www-data:www-data /opt/bhi-api
sudo chmod 600 /opt/bhi-api/.env
```

Test it manually:

```bash
cd /opt/bhi-api
set -a; source .env; set +a
node --enable-source-maps index.mjs
# → should log "Server listening" on port 3001
```

Run it permanently with systemd (again from the extracted `deploy/` folder):

```bash
sudo cp systemd/bhi-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bhi-api
systemctl status bhi-api
```

**If the service fails to start**, check the logs and the two paths it uses:

```bash
journalctl -u bhi-api -n 30 --no-pager   # shows the actual error
which node                               # where Node is installed
ls /opt/bhi-api/index.mjs                # the app file must exist here
```

- The unit runs `node` via `/usr/bin/env`, so it works with most installs.
  If Node was installed with **nvm**, systemd can't find it — edit
  `/etc/systemd/system/bhi-api.service` and replace the `ExecStart` line
  with the full path from `which node`, then run
  `sudo systemctl daemon-reload && sudo systemctl restart bhi-api`.
- If you installed the app somewhere other than `/opt/bhi-api`, update
  `WorkingDirectory`, `EnvironmentFile`, and `ExecStart` in the unit to match.
```

## 3. Install the frontend

```bash
sudo mkdir -p /var/www/bhi-portal
sudo cp -r web/. /var/www/bhi-portal/
```

## 4. Configure nginx

```bash
sudo cp nginx/bhi-portal.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/bhi-portal.conf /etc/nginx/sites-enabled/
# Optional: remove the default site
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Edit `server_name` in the config to your domain. The config:
- serves the static frontend from `/var/www/bhi-portal`
- proxies `/api/...` to the Node API on `127.0.0.1:3001`
- falls back to `index.html` for app routes (SPA)

Open `http://your-server/` — the portal should load.

## 5. Load your rates, companies and member data

Production starts with an empty database. All companies share one set of
tables (the `bhi` schema); row-level security keeps each company's records
visible only to its own users and NALICO's super admins.

**a) Load the standard rate card.** Every class (A, B, C, and any added
later) needs a rate for each of its four tiers — Employee only, +1, +2 and
more than two — before a member can be given that class. Put the client's
rates in `db/seed/premium_rates_standard.csv` (remove the `TEST VALUES` line)
and load them with the API's own login:

```bash
cd /opt/bhi-api
DATABASE_URL="postgresql://bhi_user:CHANGE_ME@localhost:5432/bhi_portal" \
  node load-standard-rates.mjs /path/to/premium_rates_standard.csv
```

It refuses the placeholder file in production and skips rows already there.
Rates can also be added later in the portal under **Rates** (super admin), and
a company can be given its own rates there.

**b) Onboard your companies** — sign in to the admin portal at
`http://your-server/admin/login` with your `ADMIN_EMAIL` account (the super
admin) and open **Companies → Onboard company**. Each company gets its one
client admin, who then manages that company's other users. A client admin
sees and manages its own company only; the super admin is the only role that
reaches every company.

**c) Import your members** — open **Import** and upload the carrier's workbook
(.xlsx) or paste CSV. Three sheet layouts are recognised, each from its own
header row, so a workbook containing several of them imports in one pass:

| Sheet | Joined to a member by |
| --- | --- |
| **Members** (22 columns) | matched on `IDType` + `IDNumber` |
| **Dependants** (14 columns) | `CompanyNumber` + `MemberIDType` + `MemberIDNumber` |
| **Beneficiaries** (16 columns) | `CompanyNumber` + `MemberIDType` + `MemberIDNumber` |

The old 8-column "short members" layout is no longer accepted: it has no ID
type or class. Each row's Company Number must be a company you can reach; an
import never creates a company.

A row missing a required value (Company Number, IDType, IDNumber, names,
ClassCode) or with a value too long for its column is not loaded. It is held in
the company's **Import exceptions** list; uploading the corrected row loads it,
restores any dependants and beneficiaries held with it, and clears it from the
list. An ID type and number can belong to only one person on the whole
platform: a row whose ID is registered to another company is refused.

The import previews every row first (dry run). The commit runs one transaction
per company, so a failure leaves that company exactly as it was.

After importing, an employee lookup by a member's email or phone sends them a
verification code (configure `SMTP_*` first).

## Updating the API bundle in this folder

`api/` holds a built copy of the API. After changing the server code, rebuild
it and copy the bundle — the API and the rate-card loader
(`load-standard-rates.mjs`):

```bash
pnpm --filter @workspace/api-server run build
cp -r artifacts/api-server/dist/. deploy/api/
```

## 6. HTTPS (recommended)

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## Troubleshooting

### The status code tells you which layer failed

Check it first — it decides where to look, and three of these never reach the
API at all, so its log will be silent about them.

| Code | Meaning |
| --- | --- |
| **502** | The API process is not running. nginx has nothing to proxy to |
| **504** | The API took over 60s (`proxy_read_timeout`) |
| **429** | A rate-limit zone in `bhi-portal-limits.conf` was hit |
| **403** | File permissions on `/var/www/bhi-portal` |
| **500** | nginx and the process are both fine; the request itself failed |

### Three commands

```bash
# 1. Is the process alive? (deliberately touches nothing else)
curl -i http://127.0.0.1:3001/api/healthz

# 2. Can it reach the database? 200 = yes, 503 = no
curl -i http://127.0.0.1:3001/api/readyz

# 3. Why did it fail, or why won't it start?
journalctl -u bhi-api -n 100 --no-pager
```

`healthz` answers without touching the database, so the pair separates the two
failures that look identical from a browser: **healthz ok + readyz 503** is the
database, **healthz ok + readyz ok** means the fault is in one route and its log
line has the stack trace. If `healthz` refuses the connection the process is
down, which is the 502 case — and the log says which:

- `Process exiting on uncaughtException` / `unhandledRejection` — it crashed,
  and the error above that line is the cause.
- `Shutting down (this was requested, not a crash)` — someone restarted it.
- Neither, and no `Server listening` — it never started. A missing `PORT` or
  `DATABASE_URL` is logged as a fatal naming what to set.

`./verify.sh your-domain.com` from the release folder runs these checks and
several more in one pass.

### Following one request through both logs

Every response carries an `X-Request-Id` header, and every error the portal
displays ends with `(reference: …)`. nginx and the API log the same value, so one
string from a user's screen finds both halves of the story — status, client and
timing from nginx, stack trace and failing SQL from the API:

```bash
grep <reference> /var/log/nginx/bhi-portal.access.log
journalctl -u bhi-api --grep <reference>
```

For this to work, `proxy_params` must include the `X-Request-Id` line and
`bhi-portal-limits.conf` must be in `/etc/nginx/conf.d/` (it defines the
`bhi_portal` log format the site config names). Without the header the API
generates its own id and only the correlation with nginx is lost.

### Error codes the API returns

These are in the JSON body as `error.code`, and the portal shows the message.

| Code | What to do |
| --- | --- |
| `SCHEMA_OUT_OF_DATE` | The migrations for this version were not run. Apply every file in `db/migrations/`, then restart |
| `DATABASE_UNAVAILABLE` | Postgres is unreachable or refusing connections. `psql "$DATABASE_URL" -c 'select 1'` |
| `NOT_FOUND` on a route that should exist | A trailing slash on `proxy_pass` is stripping the `/api` prefix, or the frontend build is newer than the API |
| `INTERNAL_ERROR` | Genuinely unexpected. The log line with the same reference has the stack trace |

## Notes

- **Cross-origin access (CORS)**: locked down by default. nginx serves the
  portal and proxies `/api` on the same origin, so the portal makes no
  cross-origin requests and a production server with `CORS_ALLOWED_ORIGINS`
  unset allows none — which is what you want. Set it only when a separate
  frontend origin genuinely needs access:
  `CORS_ALLOWED_ORIGINS=https://portal.example.com,https://staging.example.com`.
  Matching is exact on scheme, host and port; a subdomain of an allowed host is
  not allowed. `*` still works but logs a warning on every start. The API logs
  which policy is in force at startup, so it is never a guess.
- **Card issuer details**: the insurer name, address, telephone number, the
  officer who signs the card and the notices printed on it are all `ISSUER_*`
  / `CARD_*` variables in `.env` — see `artifacts/api-server/.env.example`. Nothing is baked into
  the build, so a different insurer deploys this portal without a code change,
  and anything left blank is omitted from the card rather than falling back to
  someone else's details. Correcting one is an edit plus a restart.
- **Card emails**: each member's card goes to the member. `CARD_EMAIL_OVERRIDE`
  diverts every card to one address instead — for demoing against seeded
  members whose fabricated addresses cannot receive mail. Leave it unset on a
  real server; while it is set the API warns on every start.
- **Verification codes**: real email/SMS delivery is now built into the
  server (this supersedes the earlier plan to keep it commented out).
  Employee card lookups send a one-time code by email (any SMTP provider)
  or SMS (a webhook to your SMS gateway). Fill in the `SMTP_*` (and
  optionally `SMS_WEBHOOK_*`) values in `.env` — see `artifacts/api-server/.env.example`. If no
  provider is configured, lookups return a clear "codes cannot be
  delivered" error instead of silently claiming a code was sent.
- **Demo/staging without an email provider**: set `OTP_DEV_MODE=true` in
  `.env` to show codes on screen so you can try the portal before wiring up
  SMTP. Never leave this enabled on a real production server — anyone who
  knows a member's email or phone number could read their card.
- **Network exposure**: the API binds to `127.0.0.1` (see `HOST` in `.env`),
  so nginx is the only public entry point. Keep it that way, or add a
  firewall rule if you change the bind address.
- **PostgreSQL version**: `db/schema.sql` was generated with PostgreSQL 16.
  Use PostgreSQL 14+ for the server; load the schema with a `psql` client
  version 14 or newer (the dump has been made portable — no
  version-specific commands remain).
- **First administrator**: no demo data or default accounts are created in
  production. On first start against an empty database, the API creates one
  super admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env`
  (set a strong unique password). Additional HR admins can then be added
  from the admin portal. `DEMO_SEED=true` (sample members + demo admin
  accounts with publicly known passwords) is for throwaway demo/staging
  databases only — never production.
- To update the app later: rebuild in the project, then re-copy `web/` and
  `api/index.mjs` and restart `bhi-api`.
