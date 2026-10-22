# Deploying to Google Cloud — manual runbook

From an empty Google Cloud account to the portal running over HTTPS on one
Linux VM. Nothing here is automated.

`release/bhi-portal/DEPLOY.md` is the authority for everything from phase 07
onward — it is generated from the code, so it updates when the code does. This
file is the part *before* it: building the server on GCP, plus the GCP-specific
values filled into the runbook's steps.

| Choice | Value | Why |
| --- | --- | --- |
| Region | `us-east1` (South Carolina) | Closest US region to Guyana; also an Always Free region if you later downsize |
| Machine | `e2-small` (2 GB RAM) | Postgres + Node + nginx on 1 GB is genuinely tight |
| OS | Ubuntu 24.04 LTS | Ships PostgreSQL 16; runbook needs 14+ |
| Database | PostgreSQL on the same VM | Free, and keeps the DB on `127.0.0.1` as the security model intends |
| Hostname | `<name>.duckdns.org` | Free, and on the Public Suffix List — so Let's Encrypt works |
| Access | Browser SSH from the console | No `gcloud` CLI, no SSH keys to manage |

> **This portal handles employee health data.** A personal GCP account with a
> single unbacked-up VM is fine for a demo, a portfolio piece or a client
> preview. It is not an appropriate home for real member records — that needs a
> company-owned account, a managed database with point-in-time recovery, and a
> signed agreement about where the data lives. Deploy freely with the demo
> dataset; get sign-off before real data goes in.

---

## 00 — The shape of it

One VM runs three things. Only nginx is reachable from the internet.

```
Browser ──https──▶ nginx :443 ──┬── /*      ──▶ /var/www/bhi-portal  (static files)
  bhi-portal.duckdns.org        └── /api/*  ──▶ 127.0.0.1:3001       (Node API)
                                                        │
                                                        └──▶ 127.0.0.1:5432  (PostgreSQL)
```

The frontend is **not a server** — it is a folder of files. Every API call it
makes is a relative path (`/api/...`) to the same hostname, which is why the API
never needs a public port and must never get one.

---

## 01 — Put a spending limit on before anything else

Google Cloud has no hard spending cap. A budget does not stop charges, it emails
you. Set it before creating any resource.

1. **Create the project** — Console → project picker → *New project*, named
   `bhi-portal`, no organisation. Then **select it in the picker**. Putting
   resources in the wrong project is the most common beginner mistake.
2. **Confirm the credit** — Billing → Overview shows your $300 Welcome credit
   and days remaining (90 for new accounts). A VM cannot be created without a
   linked billing account, even while spending only credit.
3. **Set the budget** — Billing → Budgets & alerts → *Create budget*:

   | Field | Value |
   | --- | --- |
   | Name | `bhi-portal-guard` |
   | Projects | just `bhi-portal` |
   | Budget type | Specified amount |
   | Target amount | `50` USD/month |
   | Threshold rules | 50%, 90%, 100% — all "actual spend" |
   | Email alerts | tick *Billing admins and users* |

**Cost:** roughly **$15–20/month** for VM + disk, comfortably inside the $300
credit for the full 90 days. These figures were not verified against today's
rates — confirm in the [pricing calculator](https://cloud.google.com/products/calculator).

**Trap:** a reserved static IP is billed when it is *not* attached to a
*running* VM. Stopping the VM to save money therefore starts a charge you did
not have before. See phase 10.

---

## 02 — Reserve a static IP

A VM's public IP changes on every restart. Your hostname and TLS certificate
both point at an IP, so it must be fixed. Reserve it first and you can attach it
during VM creation.

Console → **VPC network → IP addresses → Reserve external static address**

| Field | Value |
| --- | --- |
| Name | `bhi-portal-ip` |
| Network Service Tier | Premium |
| IP version | IPv4 |
| Type | Regional |
| Region | `us-east1` — must match the VM's region exactly |

**Checkpoint:** the list shows `bhi-portal-ip` with an address like
`34.75.120.44`, status *Reserved*. Write it down — needed in phases 04 and 08.

---

## 03 — Create the VM

Console → **Compute Engine → VM instances → Create instance**. Enable the
Compute Engine API if prompted; it takes a minute the first time.

| Section | Field | Value |
| --- | --- | --- |
| Machine configuration | Name | `bhi-portal-vm` |
| | Region / Zone | `us-east1` / `us-east1-b` |
| | Series / Machine type | `E2` / `e2-small` |
| OS and storage | Operating system | Ubuntu |
| | Version | **Ubuntu 24.04 LTS** (x86/64) |
| | Boot disk | Balanced persistent disk, 20 GB |
| Networking | Firewall | tick **Allow HTTP traffic** and **Allow HTTPS traffic** |
| | External IPv4 address | select `bhi-portal-ip` |
| | Everything else | defaults |

Those two firewall tickboxes are what open ports 80 and 443. Miss them and the
portal is unreachable later with no error to explain why — nginx runs perfectly
and the browser simply times out.

Click **Create**, then **SSH** in the VM's row to open a browser terminal.
Everything below marked *on the VM* is typed there.

```bash
hostnamectl | head -3
free -h
# Static hostname: bhi-portal-vm
# Operating System: Ubuntu 24.04.x LTS
# Mem: total 1.9Gi
```

**Checkpoint:** `free -h` reports ~1.9 GB. If it says 970 Mi you built an
`e2-micro` — stop the VM, edit it, change the machine type, start it again.

---

## 04 — Free hostname with real HTTPS

Let's Encrypt will not issue for a bare IP in any way that is practical here, so
you need a hostname. You do not need to buy one.

At [duckdns.org](https://www.duckdns.org/), sign in with Google or GitHub and
create a subdomain — say `bhi-portal`, giving `bhi-portal.duckdns.org`. Paste
your static IP into **current ip** and click **update ip**.

```bash
dig +short bhi-portal.duckdns.org
# 34.75.120.44   ← must be YOUR static IP
```

Do not continue until this returns your IP — phase 08 fails without it.

**Why DuckDNS and not nip.io.** `nip.io` and `sslip.io` look easier — the IP *is*
the hostname, no signup. But they are not on the Public Suffix List, so every
user on earth shares one Let's Encrypt quota for them, and
[that quota does get exhausted](https://github.com/cunnie/sslip.io/issues/108).
`duckdns.org` is on the list, so your subdomain counts as your own domain with
its own quota.

When you later buy a real domain, only two things change: the DNS record, and
the hostname in the nginx config.

---

## 05 — Install Node, PostgreSQL and nginx

```bash
sudo apt update && sudo apt upgrade -y

# Node 22 LTS, system-wide from NodeSource.
# NOT nvm — systemd cannot find a node under your home directory, and the API
# runs as a systemd service. This is called out in systemd/bhi-api.service.
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

sudo apt install -y postgresql nginx certbot

node -v && psql --version && nginx -v
which node        # must be /usr/bin/node, not something under /home
```

**Checkpoint:** node `v22.x` (needs 20+), psql `16.x` (needs 14+), nginx prints
a version. If `which node` returns a path under `/home` you have an nvm install
and the service in phase 07 will fail with `203/EXEC`.

### Add swap

2 GB runs this fine, but a bulk member import is memory-hungry and Linux kills
the largest process when it runs out. Swap turns a crash into a slowdown.

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h   # Swap: 2.0Gi
```

---

## 06 — Get the release onto the VM

Nothing is compiled on the server. You upload one tarball of built files.

`release/bhi-portal.tar.gz` was built 5 August, the same day as the latest
commit, and no commit since has touched `artifacts/` or `lib/`. **It already
matches your committed code** — ship it as-is.

```bash
ls -la release/bhi-portal.tar.gz     # ~2.1 MB
```

### Rebuilding later

`deploy/make-release.mjs` only *copies* — it does not build. It reads from
`deploy/api/` and `deploy/web/`, which are staged by hand and are **not**
updated by `pnpm run build`. A fresh release is four steps:

```bash
pnpm run build
cp -r artifacts/api-server/dist/. deploy/api/
cp -r artifacts/bhi-card-portal/dist/public/. deploy/web/
node deploy/make-release.mjs
```

### Upload

In the browser SSH window: gear icon (top right) → **Upload file** → pick
`release/bhi-portal.tar.gz`. It lands in your home directory.

```bash
cd ~ && tar -xzf bhi-portal.tar.gz && cd bhi-portal && ls
# DEPLOY.md  client  db  nginx  server  systemd  verify.sh
```

You are now where `DEPLOY.md` expects you to be. That file is on the VM too —
`less DEPLOY.md`.

---

## 07 — Database, API, frontend, nginx

This is the real work. It follows `DEPLOY.md` sections 1–5.

### 7a — Create the database

Generate two secrets and keep them safe:

```bash
openssl rand -hex 24     # → DB password (hex avoids URL-breaking characters)
openssl rand -base64 48  # → SESSION_SECRET
```

Generate a third secret the same way for `bhi_app`, the API's own login. It has
no DELETE on the shared BHI tables, an insert-only audit log, and is subject to
the row-level security that keeps companies' data apart — which a superuser or
the table owner would bypass (specs/002-per-company-schema/research.md R5).

```bash
sudo -u postgres psql <<'SQL'
CREATE USER bhi_user WITH PASSWORD 'PASTE_DB_PASSWORD';
CREATE DATABASE bhi_portal OWNER bhi_user;
CREATE USER bhi_app WITH PASSWORD 'PASTE_APP_PASSWORD' NOSUPERUSER NOBYPASSRLS;
GRANT CONNECT ON DATABASE bhi_portal TO bhi_app;
SQL

psql "postgresql://bhi_user:PASTE_DB_PASSWORD@localhost:5432/bhi_portal" -f db/schema.sql
for f in db/migrations/*.sql; do
  psql "postgresql://bhi_user:PASTE_DB_PASSWORD@localhost:5432/bhi_portal" -v ON_ERROR_STOP=1 -q -f "$f"
done
psql "postgresql://bhi_user:PASTE_DB_PASSWORD@localhost:5432/bhi_portal" -c '\dt bhi.*'
```

Expect 22 tables, all in schema `bhi`.

A `#`, `@`, `/` or `:` in the password breaks `DATABASE_URL` — those characters
mean something inside a URL. `openssl rand -hex` only produces letters and
digits, which is why it is used above.

### 7b — Install the API

```bash
sudo mkdir -p /opt/bhi-api
sudo cp -r server/. /opt/bhi-api/
sudo cp server/.env.template /opt/bhi-api/.env
sudo nano /opt/bhi-api/.env
```

| Setting | Value | If wrong |
| --- | --- | --- |
| `PORT` | `3001` | nginx proxies to 3001; a mismatch is a 502 |
| `HOST` | `127.0.0.1` | `0.0.0.0` publishes the lookup endpoint to the internet |
| `TRUST_PROXY` | `1` | Every audit row blames `127.0.0.1` and the trail is useless |
| `DATABASE_URL` | `postgresql://bhi_app:APP_PASSWORD@localhost:5432/bhi_portal` | `readyz` returns 503. Naming `bhi_user` or `postgres` here makes the API refuse to start. |
| `SESSION_SECRET` | your 48-byte random string | the placeholder makes admin sessions forgeable |
| `NODE_ENV` | `production` | — |
| `ADMIN_EMAIL` | your email | becomes the first administrator |
| `ADMIN_PASSWORD` | a strong password | you change it after first sign-in |
| `DEMO_SEED` | `false` | `true` creates 120 fake members and admins with a publicly documented password |
| `OTP_DEV_MODE` | `false` | `true` shows codes on screen — anyone with a member's email opens their card |
| `CORS_ALLOWED_ORIGINS` | empty | empty = same-origin only, which is correct here |
| `ISSUER_*` | insurer name, address, phone, signatory | blank fields are silently omitted from the printed card |
| `SMTP_*` | see below | without a delivery channel every lookup returns 503 |

**Email.** Gmail works, but `SMTP_PASS` must be a Google **App Password**
(Google Account → Security → 2-step verification → App passwords), not your
account password, and `SMTP_FROM` must match `SMTP_USER` or Gmail rejects the
message. Gmail caps sending at a few hundred a day — move to a transactional
provider before real member volume.

```bash
sudo chown -R www-data:www-data /opt/bhi-api
sudo chmod 600 /opt/bhi-api/.env

cd /opt/bhi-api && set -a && . ./.env && set +a && node index.mjs
# {"msg":"Server listening","port":3001}
# {"msg":"Database reachable"}
# {"msg":"Bootstrapped initial platform administrator from ADMIN_EMAIL"}
# Anything at WARN here means something is misconfigured. Then Ctrl+C.
```

### 7c — Run it as a service

```bash
cd ~/bhi-portal
sudo cp systemd/bhi-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bhi-api
systemctl status bhi-api                     # active (running)

curl -i http://127.0.0.1:3001/api/healthz    # 200 {"status":"ok"}
curl -i http://127.0.0.1:3001/api/readyz     # 200 {"status":"ok","database":"up"}
```

If it will not start, `journalctl -u bhi-api -n 50 --no-pager` shows the real
reason — usually a wrong `node` path or a `DATABASE_URL` typo.

### 7d — Install the frontend

```bash
sudo mkdir -p /var/www/bhi-portal
sudo cp -r client/. /var/www/bhi-portal/
ls /var/www/bhi-portal      # assets  favicon.svg  index.html  robots.txt
```

### 7e — Configure nginx

Five files; four are installed once and never touched. Only the site configs
carry your hostname, and `sed` replaces it in all six places at once — safer
than editing by hand.

```bash
sudo cp nginx/bhi-portal-limits.conf /etc/nginx/conf.d/
[ -f /etc/nginx/proxy_params ] || sudo cp nginx/proxy_params /etc/nginx/
sudo mkdir -p /etc/nginx/snippets
sudo cp nginx/bhi-portal-headers.conf /etc/nginx/snippets/
sudo cp nginx/bhi-portal.conf nginx/bhi-portal-ssl.conf /etc/nginx/sites-available/

sudo sed -i 's/CHANGE_ME.example.com/bhi-portal.duckdns.org/g' \
  /etc/nginx/sites-available/bhi-portal.conf \
  /etc/nginx/sites-available/bhi-portal-ssl.conf

sudo ln -sf /etc/nginx/sites-available/bhi-portal.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo mkdir -p /var/www/html

sudo nginx -t && sudo systemctl reload nginx
```

**Checkpoint:** `http://bhi-portal.duckdns.org/` loads the employee lookup page.
Do not stop here — admin tokens and verification codes are readable in transit
until phase 08.

- Blank page → `root` points at the wrong folder.
- 502 on everything → the API is down; `systemctl status bhi-api`.
- nginx won't start, *unknown log_format* → `bhi-portal-limits.conf` did not
  reach `/etc/nginx/conf.d/`. It and the site config are a pair.

---

## 08 — Turn on HTTPS

The port-80 site already serves the ACME challenge from `/var/www/html`, which
is what certbot needs to prove you control the hostname.

```bash
sudo certbot certonly --webroot -w /var/www/html -d bhi-portal.duckdns.org
# Successfully received certificate.

sudo ln -sf /etc/nginx/sites-available/bhi-portal-ssl.conf \
            /etc/nginx/sites-enabled/bhi-portal.conf
sudo nginx -t && sudo systemctl reload nginx

systemctl list-timers | grep certbot     # renewal timer active
```

The `sed` in 7e already put your hostname into both `server_name` lines and all
three certificate paths in `bhi-portal-ssl.conf`. That config redirects port 80,
sets HSTS, staples OCSP, and keeps the ACME location open so renewals run
unattended.

**If certbot fails:**

| Error | Cause |
| --- | --- |
| Timeout during connect | The HTTP/HTTPS firewall tickboxes were missed in phase 03. Fix under VPC network → Firewall |
| DNS problem: NXDOMAIN | DuckDNS record has not propagated. Re-run the `dig` check |
| Too many certificates already issued | You are on `nip.io` rather than DuckDNS. Go back to phase 04 |

---

## 09 — Verify, then sign in

```bash
cd ~/bhi-portal && chmod +x verify.sh
./verify.sh bhi-portal.duckdns.org

sudo ss -tlnp | grep 3001
# 127.0.0.1:3001   ← correct. 0.0.0.0:3001 means fix HOST in .env now.
```

Open `https://bhi-portal.duckdns.org/admin/login`, sign in with `ADMIN_EMAIL` /
`ADMIN_PASSWORD`, and change the password immediately.

### Before you call it live

- [ ] `DEMO_SEED=false`
- [ ] `OTP_DEV_MODE=false`
- [ ] `SESSION_SECRET` is your generated value, not the placeholder
- [ ] `ADMIN_PASSWORD` changed after first sign-in
- [ ] `ss -tlnp | grep 3001` shows `127.0.0.1`, never `0.0.0.0`
- [ ] `TRUST_PROXY=1`
- [ ] HTTPS works and HTTP redirects
- [ ] `CARD_EMAIL_OVERRIDE` empty
- [ ] `CORS_ALLOWED_ORIGINS` empty or an exact list you control, never `*`
- [ ] `ISSUER_*` filled in
- [ ] SMTP configured and tested
- [ ] `pg_dump` backups scheduled (phase 10)

### Load real data

Companies go in by SQL; members, dependants and beneficiaries come in through
the admin portal's **Import** screen. Policies are added per member afterwards —
without one, a member can sign in but their card screen says *"No active policy
is on file."* Section 8 of `DEPLOY.md` covers all of it, including the two quirks
in the carrier's Beneficiaries sheet.

---

## 10 — Backups and keeping the bill down

### Nightly database dump

The audit trail is append-only by design. That guarantee is worthless without
backups.

```bash
sudo mkdir -p /var/backups/bhi && sudo chown www-data:www-data /var/backups/bhi
sudo crontab -e
```

```cron
30 2 * * * pg_dump "postgresql://bhi_user:PASSWORD@localhost:5432/bhi_portal" | gzip > /var/backups/bhi/$(date +\%F).sql.gz && find /var/backups/bhi -name '*.sql.gz' -mtime +14 -delete
```

A dump on the same disk as the database does not survive losing the disk. Add
**Compute Engine → Snapshots → Create snapshot schedule** on the boot disk,
daily, 14-day retention.

### Cost control

| Situation | What to do |
| --- | --- |
| Done for a few days | **Stop** the VM. Compute stops billing; disk and the now-idle static IP still bill |
| Done for weeks | Stop the VM *and* release the static IP under VPC network → IP addresses |
| Done entirely | **Shut down the project** under IAM & Admin → Settings. The only action that reliably stops every charge |
| Credit running out | Downsize to `e2-micro` — you are already in `us-east1`, an Always Free region. Keep the swap file |

### Deploying an update

```bash
cd ~/bhi-portal
# Run any NEW files in db/migrations/ first — each is idempotent
for f in db/migrations/*.sql; do
  psql "postgresql://bhi_user:PASSWORD@localhost:5432/bhi_portal" -f "$f"
done

sudo cp -r client/. /var/www/bhi-portal/
sudo cp server/index.mjs /opt/bhi-api/
sudo systemctl restart bhi-api
```

A `SCHEMA_OUT_OF_DATE` in any response means a migration was skipped. Run them
all and restart.

---

## 11 — When something breaks

Three commands locate almost anything. Ask them in this order.

```bash
curl -i http://127.0.0.1:3001/api/healthz   # 1. Is the process alive?
curl -i http://127.0.0.1:3001/api/readyz    # 2. Can it reach the database?
journalctl -u bhi-api -n 100 --no-pager     # 3. Why did it fail?
```

| Symptom | Cause |
| --- | --- |
| Browser times out, nginx looks fine | The HTTP/HTTPS firewall tickboxes. VPC network → Firewall |
| 502 on `/api/…` | API not running. `systemctl status bhi-api` |
| 502 on everything, portal included | Same cause — a dead API takes the static pages down too |
| `healthz` ok, `readyz` 503 | The database. Check `DATABASE_URL` and that Postgres runs |
| Service dies with `203/EXEC` | Wrong `node` path, or node under `/home` while `ProtectHome=true` |
| `password authentication failed` | `DATABASE_URL` disagrees with the password from 7a |
| Blank page, 404s for `/assets/*.js` | `root` points at the wrong folder |
| Every `/api` route 404s | A trailing slash on `proxy_pass` is stripping the `/api` prefix. There must not be one |
| Admin portal 404s on refresh | SPA fallback missing — the `try_files` line in `location /` |
| Lookup says codes cannot be delivered | No `SMTP_*` and no `SMS_WEBHOOK_URL`. Correct behaviour — configure a channel |
| Import fails on a large file | Raise `client_max_body_size` in the `/api/` block |
| VM feels frozen mid-import | Out of memory. Confirm swap with `free -h` |

Every response carries an `X-Request-Id`, and any error the portal shows ends
with `(reference: …)`. That string appears in both logs:

```bash
grep <reference> /var/log/nginx/bhi-portal.access.log
journalctl -u bhi-api --grep <reference>
```

---

## Not covered here

**Phone verification.** Needs the SMS gateway from section 3b of `DEPLOY.md`
(`bhi-sms.service`, `sms.env`, a Twilio or Vonage account). Email verification
alone needs nothing extra. Start with `SMS_PROVIDER=dryrun` to confirm the wiring
before spending money.
