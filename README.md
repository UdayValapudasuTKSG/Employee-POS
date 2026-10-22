# NALICO Health Card Portal

A digital health insurance card portal. Employees retrieve their card with a
one-time code sent to the email or phone their employer has on file. HR staff
manage members through a role- and company-scoped admin portal.

Built for the Beharry group, insured by NALICO (North American Life Insurance
Co. Ltd.) — but the insurer's name, address and card wording are configuration,
not code, so it deploys for any insurer without a rebuild.

---

## Deploy it

**One command produces everything a Linux + nginx server needs:**

```bash
node deploy/make-release.mjs
```

That writes `release/bhi-portal/` and `release/bhi-portal.tar.gz` (~2 MB). Copy
the tarball to the server, untar it, and follow the **`DEPLOY.md`** inside — a
step-by-step runbook from empty server to working portal, with a go-live
checklist and a troubleshooting table.

Nothing is compiled on the server. There is no `npm install` step and no
`node_modules` in the release.

```
release/bhi-portal/
├── client/       built React app          → /var/www/bhi-portal
├── server/       Node API, one file       → /opt/bhi-api
│   ├── .env.template        fill this in — every setting is documented
│   ├── sms-gateway.mjs      only needed for phone verification
│   └── sms.env.template
├── db/           schema.sql + migrations/
├── nginx/        site config, rate limits, proxy params
├── systemd/      service units for the API and SMS gateway
├── verify.sh     post-deploy checks — run it before calling it live
└── DEPLOY.md     the runbook
```

### How the pieces fit

nginx is the only thing exposed to the internet. It serves the built frontend
as static files and forwards `/api/*` to the Node API on loopback:

```
Browser ──https──▶ nginx :443 ──┬── /api/*  ──▶ 127.0.0.1:3001   (Node API)
   your-domain.com              └── /*      ──▶ /var/www/bhi-portal
```

The frontend is not a server — it is a folder of files. It calls `/api/...` on
its own origin, so it never knows the API's port. Keep the API on `127.0.0.1`.

### Or: build on the server from a clone

On an Ubuntu server with the repo cloned to `~/health_insurance_card`, Node,
pnpm, PostgreSQL and nginx installed, and a filled-in `.env` at the repo root
(start from `artifacts/api-server/.env.example`):

```bash
./deploy.sh
```

It installs dependencies, creates the database if missing, pushes the schema,
builds, installs the API as the `bhi-api` systemd service
([deploy/bhi-api.service](deploy/bhi-api.service)), copies the frontend to
`/var/www/html` and the nginx site ([deploy/nginx-bhi.conf](deploy/nginx-bhi.conf)),
then restarts nginx. Unlike the release package, this compiles on the server.

---

## Run it with Docker

The quickest way to a working stack on a developer machine — database, API,
nginx front door, and a mail/SMS sink that captures verification codes:

```powershell
Copy-Item artifacts/api-server/.env.example      artifacts/api-server/.env
Copy-Item artifacts/bhi-card-portal/.env.example artifacts/bhi-card-portal/.env
pnpm run stack:up          # docker compose --env-file artifacts/bhi-card-portal/.env up -d --build
```

| Address | What |
| --- | --- |
| http://localhost:3000/ | Employee card lookup |
| http://localhost:3000/admin/login | Admin portal |
| http://localhost:3000/__inbox | Captured verification codes |
| `127.0.0.1:3001` | API, direct |
| `127.0.0.1:5434` | PostgreSQL (for pgAdmin: host `localhost`, port `5434`, credentials from `DATABASE_URL`) |

Every start re-runs `deploy/db/migrations/*.sql`, so schema changes arrive
without a reset. `pnpm run stack:down` (or `docker compose down`) keeps the
data; `docker compose down -v` **destroys** it. After changing code, rebuild
the service you touched: `docker compose --env-file artifacts/bhi-card-portal/.env up -d --build api web`.

Developer machines only: the stack seeds demo accounts with publicly
documented passwords and terminates no TLS.

---

## Run it locally

Needs Node 20+ and PostgreSQL 14+.

```bash
# One-time: create and load the local database
pnpm run local:db          # Windows; see deploy/LOCAL-DEV.md for other platforms

# Start everything — API, front door, mail/SMS sink
pnpm run local
```

Then open http://localhost:8080/. Full detail, including how verification codes
are delivered locally, is in **[deploy/LOCAL-DEV.md](deploy/LOCAL-DEV.md)**.

| Command | What it does |
| --- | --- |
| `pnpm run local` | Start and supervise everything |
| `pnpm run local:stop` | Kill leftover dev servers — the fix for `EADDRINUSE` |
| `pnpm run local:devcode` | Same, but OTP codes come back inline instead of being sent |
| `pnpm run local:test` | RBAC suite (needs `local:devcode` running) |
| `pnpm run build` | Typecheck and build every package |
| `pnpm run release` | Package the deployable folder |

> `local:stop` only kills the child services. If changes seem not to take
> effect, the supervisor has respawned the old build — kill
> `node deploy/start-local.mjs` itself (`taskkill /PID <pid> /T /F`).

---

## How it is put together

A pnpm workspace. The OpenAPI contract is the source of truth: the React Query
hooks and the zod request schemas are both generated from it, so the client and
server cannot drift.

| Path | What lives there |
| --- | --- |
| [`lib/api-spec/`](lib/api-spec/) | `openapi.yaml` — the contract. `pnpm --filter @workspace/api-spec run codegen` regenerates the clients |
| [`lib/api-client-react/`](lib/api-client-react/) | Generated React Query hooks |
| [`lib/api-zod/`](lib/api-zod/) | Generated request/response schemas |
| [`lib/db/`](lib/db/) | Drizzle schema — one schema, `bhi`, with 22 tables: the client's BHI Enrollment Database tables (companies, members, dependants, beneficiaries, classes, rates, billing, status history, import exceptions) and the portal's own (admins, activity log, employee sessions, change requests, policies, import batches, class history, billing issues, discount coupons and their one-time codes) |
| [`artifacts/api-server/`](artifacts/api-server/) | Express 5 API |
| [`artifacts/bhi-card-portal/`](artifacts/bhi-card-portal/) | React + Vite frontend |
| [`deploy/`](deploy/) | Local dev stack, release packaging, nginx/systemd templates |

### What it does

**Employees** look up their card by email or phone → 6-digit code → 15-minute
card session showing the card face, dependants and beneficiaries. They can
print it, have it emailed as a PDF, or raise a change request with a supporting
document.

The card face follows the carrier's layout: insured name and ID, then
policyholder, class, policy number, date of birth and effective date, then each
dependant. The screen, the PNG download and the emailed PDF all draw from one
shared layout ([lib/card-design/](lib/card-design/)), so they always match. A
member with no policy on file gets "No active policy is on file" instead of a
card.

**Employee discounts.** From the same session, an employee generates a
single-use QR coupon for KFC or Pizza Hut: 10% off the bill, up to GYD 15,000 of
discount a month across both brands (configurable). The brand's till redeems it
through a keyed POS API ([docs/POS-DISCOUNT-API.md](docs/POS-DISCOUNT-API.md)),
which applies the monthly cap and records the redemption; a void gives the
allowance back. Codes are stored as hashes only, like OTPs.

**HR staff** manage members, dependants, beneficiaries and policies; bulk
import from the carrier's workbook, fixing held rows from the import-exceptions
list; review employee change requests; and read an append-only audit trail. The
members list marks each member with a policy icon (policy exists, expired, or
none).

Import matches rows to existing records by ID type + ID number. The preview
lists every row that **already exists** and which fields it would change, and
the commit is refused (`409 UPDATES_NOT_CONFIRMED`) until the admin ticks the
confirmation — so re-uploading an old file cannot quietly overwrite anyone.

**NALICO's super admins** onboard client companies (each with one client
admin, who manages that company's users), add
classes, maintain the rate card — standard rates for every company, and
company-specific ones — and produce and finalise each company's monthly bill.

What each administrator can see and do comes from a permission × role matrix
plus a scope: every company (super admin; support and auditor read-only), or
one company (client admin, HR administrator). The super admin is the only role
that can change more than one company.

All companies share one database and one schema. Row-level security in
PostgreSQL keeps each company's rows visible only inside its users' scope; the
API connects as `bhi_app`, a role that cannot bypass it (see
[deploy/README.md](deploy/README.md)).

### Rules the code deliberately keeps

These are load-bearing — read [replit.md](replit.md) before changing them.

- Cross-company access returns **404, never 403**, so the API never confirms a
  record exists outside your scope. Permission denials return 403 and are
  audited as `ACCESS_DENIED`.
- OTP codes and card tokens are stored as **sha256 hashes only**. Unknown
  identifiers get decoy sessions that can never verify.
- A lookup **always answers the same way** ("if this contact is on file, a code
  has been sent"), with a minimum response time, and the code is sent after the
  response. A failed send is logged (`bhi.activity_log`, kind `EVENT`, action `OTP_DELIVERY`), not
  shown to the caller: telling them would reveal that the contact is on file.
- **No `DELETE` anywhere.** Members, dependants and beneficiaries are
  deactivated (Active = false, with a date and reason), never deleted; every
  change is recorded in the status history. The audit trail is append-only.
- **Coverage ends at 65.** A member who has turned 65 cannot look up a card
  from their birthday on; a daily sweep deactivates them ("Aged out at 65") and
  recalculates draft bills. Create and import refuse members already 65.
- **A card is only ever the session's own.** The portal keys the cached card
  to the card session and drops it whenever a session starts or ends, so one
  person's card is never shown to the next person in the same browser.
- **Bills reflect 00:00 on the 1st (Guyana time).** A change counts from when it
  was recorded, so a late bill is still right. Finalised bills, and the rates
  they used, cannot change.
- Uploaded documents are typed by **sniffing magic bytes**, never the browser's
  declared type. SVG is excluded deliberately.

---

## Configuration, not code

Nothing about the insurer is compiled in. Every one of these is an environment
variable, documented in `server/.env.template` in the release:

| | |
| --- | --- |
| `ISSUER_*` | Name, address, phone, signatory, plan title on the card |
| `CARD_PROPERTY_NOTICE`, `CARD_BACK_NOTICE` | The notices printed on it |
| `CORS_ALLOWED_ORIGINS` | Allowlist. Empty = same-origin only, which is the norm |
| `SMTP_*`, `SMS_WEBHOOK_*` | Code delivery |
| `DISCOUNT_*`, `POS_API_KEY_*` | Employee discount rate, monthly cap, coupon lifetime, and each brand's POS key |
| `DEMO_SEED`, `OTP_DEV_MODE` | Both must be `false` in production |

Anything left blank is **omitted** from the card rather than replaced with a
default naming some other company.

---

## More documentation

| Document | For |
| --- | --- |
| `release/bhi-portal/DEPLOY.md` | Deploying to a server — generated by `make-release.mjs` |
| [docs/DEPLOY-GCP.md](docs/DEPLOY-GCP.md) | Building that server on Google Cloud, then running the runbook above |
| [docs/DEPLOY-AZURE.md](docs/DEPLOY-AZURE.md), [docs/DEPLOY-AZURE-APPSERVICE.md](docs/DEPLOY-AZURE-APPSERVICE.md) | Deploying on Azure (VM, or App Service) |
| [docs/ADMIN-TEST-WALKTHROUGH.md](docs/ADMIN-TEST-WALKTHROUGH.md) | Exercising every admin and super admin API in order, with example requests and responses |
| [deploy/LOCAL-DEV.md](deploy/LOCAL-DEV.md) | Running locally, and how OTP delivery works in dev |
| [docs/POS-DISCOUNT-API.md](docs/POS-DISCOUNT-API.md) | Integrating a KFC or Pizza Hut till with employee discount coupons |
| [docs/API-TESTING.md](docs/API-TESTING.md) | All 42 endpoints with `curl` examples and permissions |
| [deploy/README.md](deploy/README.md) | Manual deployment, if you are not using the release package |
| [replit.md](replit.md) | Architecture notes and the security rules above |
#   E m p l o y e e - P O S  
 