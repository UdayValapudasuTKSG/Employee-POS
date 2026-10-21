# Deploying to Azure App Service

One Web App running three containers, plus a managed PostgreSQL server. No VM,
no SSH, no certbot.

Companion to [DEPLOY-AZURE.md](DEPLOY-AZURE.md), which puts the same stack on a
plain Ubuntu VM. **Read the comparison in phase 06 before choosing.** They are
not equivalent: the VM runbook gives you a machine you control end to end, and
this one trades some of that for never touching an operating system again.

Every command runs on your own machine, from the repository root, in PowerShell.

---

## 00 — The shape of it

```
                              Azure App Service
Browser ──https:443──▶ ┌─────────────────────────────────────────────┐
                       │ App Service front end   (terminates TLS)    │
                       │                │                            │
                       │                ▼  one app, three containers │
                       │   ┌──────────────────────────────────────┐  │
                       │   │ web  :80    MAIN — nginx             │  │
                       │   │   ├── /*      /var/www/bhi-portal    │  │  static SPA
                       │   │   ├── /api/*  127.0.0.1:3001 ────┐   │  │
                       │   │   └── rate limits applied HERE   │   │  │
                       │   │                                  ▼   │  │
                       │   │ api  :3001  sidecar ─────────────┐   │  │
                       │   │ sms  :2527  sidecar ◀────────────┤   │  │
                       │   └──────────────────────────────────┼───┘  │
                       └──────────────────────────────────────┼──────┘
                                                    ┌─────────┴────────┐
                                                    ▼                  ▼
                                    Azure PostgreSQL          smtp / Twilio
```

Four things about this drawing are load-bearing.

**Sidecars share one network namespace.** `api` and `sms` are reachable at
`127.0.0.1` from `web` and from each other, and from nowhere else — only the
main container receives external traffic. This is the same isolation the
unpublished container network gives the compose stack, arrived at differently.

**nginx is still the front door for the application.** It serves the SPA, proxies
`/api`, and owns every rate limit. Moving those into Azure would mean an
Application Gateway or Front Door, which is a second proxy and a much larger bill.

**There are two proxies in front of the API, not one.** The App Service front end
is always there and cannot be removed. That is why `REAL_IP_FROM` exists — see
phase 06.

**The frontend is not a server.** It is a folder of files inside the `web` image.
Every call it makes is a relative `/api/...` path to the same hostname, which is
why the API never needs a public port.

---

## 01 — Set a spending limit before creating anything

Azure budgets **email you; they do not stop charges**. Set one anyway.

Portal → Cost Management → Budgets → Add, scoped to `bhi-portal-rg`, monthly,
alerts at 50/90/100% of actual cost.

Rough monthly cost:

| Resource | Size | Approx. |
| --- | --- | --- |
| App Service plan | B1 Linux | $13 |
| Container registry | Basic | $5 |
| PostgreSQL flexible server | B1ms + 32 GB | $15–25 |
| | | **$33–43** |

These figures are not checked against today's rates — confirm in the Azure
pricing calculator. Note that the plan and the database bill whether or not
anyone uses the portal; only egress scales with traffic.

---

## 02 — What you need installed

| Tool | Check | If missing |
| --- | --- | --- |
| Azure CLI | `az version` | `winget install -e --id Microsoft.AzureCLI` then **open a new terminal** |
| Docker Desktop | `docker info` | Start it and wait for the whale to stop animating |
| Node | `node -v` | Only needed to generate secrets in phase 03 |

`psql` is **not** required. Phase 3 runs it out of the `postgres:16-alpine`
image, which is the same psql the compose stack's `migrate` service uses.

Then sign in, once:

```powershell
az login
az account set --subscription "<your subscription name>"
```

---

## 03 — Fill in the two configuration files

**`deploy/azure/settings.ps1`** — names and sizes. Committed, nothing secret.
Two names are globally unique across all of Azure and will need a suffix if
taken: `$Acr` and `$AppName`.

**`artifacts/api-server/.env`** — the backend env file: secrets and
per-deployment values. Gitignored *and* dockerignored. The scripts read it
directly; set `$env:ENV_FILE` to point them at a separate production copy.

```powershell
Copy-Item artifacts/api-server/.env.example artifacts/api-server/.env
```

Uncomment `PG_ADMIN_PASSWORD` in its Azure section, then replace every `CHANGE_ME`. Two of them want real randomness:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"         # SMS_WEBHOOK_TOKEN
```

The Postgres password must contain three of: uppercase, lowercase, digit,
punctuation. Write it raw — `04-create-app.ps1` URL-encodes it when it builds
`DATABASE_URL`, so a pre-encoded one would be encoded twice and fail to log in.

---

## 04 — Run the four scripts, in order

```powershell
.\deploy\azure\01-provision-infra.ps1     # ~15 min, mostly the database
.\deploy\azure\02-push-images.ps1         # ~5 min first time
.\deploy\azure\03-migrate-db.ps1          # ~1 min
.\deploy\azure\04-create-app.ps1          # ~3 min
```

All four are safe to re-run; each checks for what it creates. A failure part-way
through is fixed by running that script again, not by cleaning up by hand.

The order is not arbitrary. The app is created **last**, after the images exist
and the database has a schema, because an App Service that starts against an
empty database logs a stream of query failures that read like application bugs.

Why images are built locally rather than with `az acr build`: both Dockerfiles
use BuildKit cache mounts (`RUN --mount=type=cache`), and ACR Tasks runs the
classic Docker builder, which fails to parse them. The header comment in
`02-push-images.ps1` has the full reasoning and the GitHub Actions alternative.

---

## 05 — Verify

First start pulls three images; give it two or three minutes.

```powershell
az webapp log tail --name bhi-portal --resource-group bhi-portal-rg
```

Then work down this list. Each line proves something the one above it does not.

| # | Check | Expected |
| --- | --- | --- |
| 1 | `curl https://<app>.azurewebsites.net/api/healthz` | `200` — the API process is alive |
| 2 | `curl https://<app>.azurewebsites.net/api/readyz` | `200` — **and the database is reachable**. A 503 here with a 200 above means the DB firewall or `DATABASE_URL`, not the app |
| 3 | Open `https://<app>.azurewebsites.net/` | The portal renders, no blank page |
| 4 | Open `/admin/login`, sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` | The dashboard. If it rejects you, check the log for "the admin portal has no usable login" |
| 5 | `curl -i .../api/v1/lookup` **11 times** | The 11th is `429`. Proves the rate limits survived the platform proxy |
| 6 | From a **different network** (phone hotspot), one `/api/v1/lookup` | `200`, not `429`. **This is the real test of `REAL_IP_FROM`** — if it 429s, every client is sharing one bucket |
| 7 | An admin action, then check the audit trail's source address | Your public IP, not `169.254.x.x` |
| 8 | A phone-channel lookup for a real member | The SMS arrives. Twilio is live — this costs money |

Check 6 is the one to actually do. Checks 5 and 6 pass together only if the
realip configuration landed; 5 alone passes either way.

---

## 06 — What is different from the VM deployment

Read this before treating the two runbooks as interchangeable.

| | VM ([DEPLOY-AZURE.md](DEPLOY-AZURE.md)) | App Service (this) |
| --- | --- | --- |
| TLS | nginx, with certbot you renew | Azure, on `*.azurewebsites.net`, automatic |
| Proxies in front of nginx | none | one, always, unavoidable |
| Client IP | `$remote_addr`, straight from the socket | recovered from `X-Client-IP` |
| Database | a container, on your disk, your backups | managed, with point-in-time restore |
| Migrations | a one-shot compose service, every start | `03-migrate-db.ps1`, run by you |
| Verification-code sink | available | absent — `INBOX=off` |
| OS patching | yours | Azure's |
| Rough cost | $15–35 | $33–43 |

**The thing you must not get wrong.** `deploy/nginx/bhi-portal-limits.conf` keys
every rate limit on `$binary_remote_addr`, and on App Service that is the
platform's front end for every request on earth. Left alone, "5 admin logins per
minute per attacker" becomes "5 per minute shared by the entire internet" — which
locks out your real administrators without slowing an attacker down at all, and
fills the audit trail with `169.254.x.x` as the actor for every action.

`04-create-app.ps1` sets `REAL_IP_FROM=169.254.0.0/16` and
`REAL_IP_HEADER=X-Client-IP`, which makes `docker/nginx/render-config.sh` add the
realip directives (substitutions 8 and 9). Do not remove those settings, and do
not widen the range — anything inside it can choose its own rate-limit bucket and
its own audit identity.

`X-Client-IP` rather than `X-Forwarded-For` is deliberate: App Service writes the
latter as `ip:port`, which nginx's realip module cannot parse. It fails silently,
keeping the proxy address — indistinguishable from the setting being absent.

**What the VM runbook has that this cannot.** A single machine where `docker
compose logs -f` shows you everything at once, a database you can `pg_dump` over
SSH, and no dependency on a managed service's quirks. If those matter more than
never patching an OS, use that runbook instead.

---

## 07 — Deploying a new build

```powershell
.\deploy\azure\02-push-images.ps1        # tags with the current commit SHA
.\deploy\azure\03-migrate-db.ps1         # only if you added a migration
.\deploy\azure\04-create-app.ps1         # repoints the containers, restarts
```

Migrations go **before** the images that expect them, in both directions of
thinking: a new column the running code does not know about is harmless, and
code looking for a column that does not exist is not.

To roll back, re-run phase 4 with an older tag:

```powershell
.\deploy\azure\04-create-app.ps1 -Tag <older-sha>
```

This does not roll back the database. A migration that has to be undone needs a
migration that undoes it.

---

## 08 — When it does not come up

| Symptom | Where to look |
| --- | --- |
| Site shows "Application Error" | `az webapp log tail` — then `az webapp sitecontainers log --container-name web` for nginx specifically |
| `exec format error` | The image is arm64. `02-push-images.ps1` passes `--platform linux/amd64`; something bypassed it |
| Image cannot be pulled | The managed identity lost its `AcrPull` assignment, or `04-create-app.ps1` ran before `01-provision-infra.ps1` |
| `/api/healthz` 200, `/api/readyz` 503 | The database. Firewall rule, or `DATABASE_URL` — check for an unencoded `@` in the password |
| `getaddrinfo ENOTFOUND` naming part of your password | Exactly that: the password was pre-encoded, or contains a character that ended the userinfo section |
| nginx exits immediately | A config error. `INBOX` was left on with no mail sidecar is the usual cause |
| Everything 429s from every client | `REAL_IP_FROM` is not taking effect. See phase 06 |
| Admin login rejected | The bootstrap only runs on a database with **no** admin rows. Changing `ADMIN_EMAIL` later does nothing |

One Windows-specific trap: PowerShell 5.1 reads a `.ps1` file with no byte-order
mark as ANSI, which corrupts every non-ASCII character in it and produces parse
errors far from the real line. The scripts in `deploy/azure/` are saved as UTF-8
**with** BOM. Keep it that way if you edit them.

---

## 09 — Once it is serving real members

In rough order of value:

1. **A custom domain.** A member sent a link to `something.azurewebsites.net` has
   every reason to read it as phishing. Add a subdomain of the insurer's own
   domain and an App Service managed certificate (free).
2. **Take the database off the public internet.** Regional VNet integration on
   the app plus a private endpoint on the database replaces the
   allow-Azure-services firewall rule, which today admits any traffic originating
   anywhere in Azure — the password is what stops it, not the network.
3. **Secrets in Key Vault.** App settings are visible to anyone with Contributor
   on the resource group. Key Vault references move them behind a second door.
4. **Deployment slots.** A staging slot with its own settings turns a bad deploy
   into a swap back instead of a rebuild.
5. **Alerts.** At minimum: HTTP 5xx rate, and the health check failing.
6. **Rotate `SESSION_SECRET`** if it was ever pasted anywhere. It logs everyone
   out, which is the correct response.
