# Deploying to Azure — manual runbook

One Ubuntu VM. PostgreSQL, the API and the SMS gateway run as containers; nginx
runs on the host and is the only thing the internet can reach.

Companion to [DEPLOY-GCP.md](DEPLOY-GCP.md), which does the same job on a Google
VM with the API as a systemd unit instead of a container. The two share the same
nginx configuration, so anything you learn about one transfers.

There is also [DEPLOY-AZURE-APPSERVICE.md](DEPLOY-AZURE-APPSERVICE.md), which
puts the same containers on Azure App Service with a managed PostgreSQL server
and no VM at all. It costs a little more and gives up the machine you control
end to end; its phase 06 compares the two honestly. Note that App Service always
puts its own reverse proxy in front of nginx, which is exactly the arrangement
phase 00 below warns about — that runbook explains what has to be configured to
keep the rate limits meaning what they say.

Every command runs on the VM unless it says otherwise.

---

## 00 — The shape of it

```
                                 Azure VM
                    ┌──────────────────────────────────────────┐
Browser ──https:443─┼─▶ nginx (HOST)                           │
                    │    ├── /*       ─▶ /var/www/bhi-portal   │  static SPA
                    │    ├── /api/*   ─▶ 127.0.0.1:3001 ───────┼─▶ api container
                    │    └── rate limits applied HERE          │      │
                    │                                          │      ├─▶ db container
                    │   (containers, no public ports)          │      ├─▶ smtp.gmail.com:587
                    │    db  ·  migrate  ·  api  ·  sms ───────┼──────┴─▶ sms container ─▶ Twilio
                    └──────────────────────────────────────────┘
```

Three things about this drawing are load-bearing.

**The frontend is not a server.** It is a folder of files. Every call it makes is
a relative `/api/...` path to the same hostname, which is why the API never needs
a public port and must never get one.

**nginx runs on the host, not in a container.** The `web` container in
`compose.yaml` is HTTP-only and injects a `/__inbox` page for reading captured
verification codes — both correct for a laptop, both wrong here.

**nginx terminates TLS itself, with nothing in front of it.** This is not a
style choice. The rate limits in `deploy/nginx/bhi-portal-limits.conf` key on
`$binary_remote_addr`, and there is no `real_ip_header` directive anywhere in the
configuration. Put Caddy, a second nginx, or Azure Front Door in front and every
request appears to come from that proxy — so "5 admin logins per minute per
attacker" silently becomes "5 per minute for the whole internet", which locks out
your real administrators without stopping anybody. If you ever do add a proxy in
front, you must add `set_real_ip_from` and `real_ip_header X-Forwarded-For` at the
same time.

---

## 01 — Set a spending limit before creating anything

Azure budgets **email you; they do not stop charges**. Set one anyway — it is the
only warning you get.

1. **Resource group** — Portal → Resource groups → Create. Name `bhi-portal-rg`,
   pick a region close to your users and use it for everything that follows.
   Resources in the wrong region cost more to talk to each other.
2. **Budget** — Cost Management → Budgets → Add:

   | Field | Value |
   | --- | --- |
   | Scope | `bhi-portal-rg` |
   | Name | `bhi-portal-guard` |
   | Reset period | Monthly |
   | Amount | `50` USD |
   | Alerts | 50%, 90%, 100% of **actual** cost |
   | Email | your address |

**Cost:** roughly **$15–35/month** for a small VM plus its disk. These figures
are not checked against today's rates — confirm in the Azure pricing calculator.

---

## 02 — Static public IP and a hostname

The IP must not change, or DNS and your TLS certificate both break on reboot.

Portal → Public IP addresses → Create:

| Field | Value |
| --- | --- |
| Name | `bhi-portal-ip` |
| SKU | Standard |
| Assignment | **Static** |
| DNS name label | `bhi-portal` |

That label gives you a free working hostname:

```
bhi-portal.<region>.cloudapp.azure.com
```

Use it for the whole of this runbook. When the portal goes to real members,
ask for a subdomain of the insurer's own domain (`cards.<their-domain>`), point
an A record at this same IP, and follow phase 12 — a member sent a link to
`something.cloudapp.azure.com` has every reason to read it as phishing.

**Trap:** a Standard static IP is billed whether or not the VM is running.
Stopping the VM to save money does not stop this charge.

---

## 03 — The VM

Portal → Virtual machines → Create:

| Field | Value |
| --- | --- |
| Resource group | `bhi-portal-rg` |
| Name | `bhi-portal-vm` |
| Image | **Ubuntu Server 24.04 LTS** |
| Size | 2 vCPU / 4 GB (e.g. `Standard_B2s`) |
| Authentication | SSH public key |
| Public IP | `bhi-portal-ip` from phase 02 |
| Inbound ports | leave all **unticked** — phase 04 does this properly |
| OS disk | 30 GB Premium SSD |

**Why 4 GB.** The image build runs `pnpm install` and a Vite build. On 2 GB it
gets killed by the OOM reaper part-way through, which looks like a random
compiler crash. If you must use a 2 GB size, add swap first:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## 04 — Network security group

Portal → your VM → Networking → Inbound port rules. You want **exactly three**:

| Priority | Port | Source | Purpose |
| --- | --- | --- | --- |
| 100 | 22 | **My IP address** | SSH — never `Any` |
| 110 | 80 | Any | Certbot's HTTP-01 challenge, and the redirect to 443 |
| 120 | 443 | Any | The portal |

Nothing else. In particular **never** open:

- **3001** — the API, which has no rate limiting of its own. nginx is the only
  thing standing between the admin login endpoint and unlimited password guessing.
- **5432** — the database, which holds member names, dates of birth and ID numbers.

> **The Docker trap.** Docker writes its own iptables rules *ahead* of the NSG,
> so a container that publishes `3001:3001` is reachable from the internet even
> with no NSG rule allowing it. This is why `compose.prod.yaml` binds
> `127.0.0.1:3001:3001`. Do not remove that prefix.

---

## 05 — Docker

```bash
ssh azureuser@bhi-portal.<region>.cloudapp.azure.com

sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y ca-certificates curl git

sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
                        docker-buildx-plugin docker-compose-plugin

sudo usermod -aG docker $USER
```

Log out and back in for the group change, then confirm:

```bash
docker compose version
```

---

## 06 — Get the code onto the VM

```bash
sudo mkdir -p /opt/bhi-portal && sudo chown $USER:$USER /opt/bhi-portal
git clone <your-repo-url> /opt/bhi-portal
cd /opt/bhi-portal
```

Private repo: use a deploy key or a personal access token. If the repository is
not reachable from the VM, `scp -r` the working tree from your machine instead —
but exclude `node_modules`, or you will be waiting a long time.

---

## 07 — The production backend env file

This is where deployments go wrong. Start from the template, never from your
development `artifacts/api-server/.env`:

```bash
cp artifacts/api-server/.env.example artifacts/api-server/.env
```

The frontend env file (`artifacts/bhi-card-portal/.env`) is not needed here —
the production overlay does not start the `web` service.

Generate the three secrets on the VM and keep them out of your shell history:

```bash
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 24   # the database password, inside DATABASE_URL
```

Now edit `artifacts/api-server/.env`. These are the values that **must** change from the template or
from what you run locally:

| Key | Set to | Why it matters |
| --- | --- | --- |
| `DEMO_SEED` | `false` | **The most dangerous line in the file.** Left `true`, your production database is seeded with six demo administrators including `platform.admin@bhi-demo.test` whose password is documented publicly in this repository as `Demo@2026`. Anyone who has read the README can sign in as a platform admin. |
| `ADMIN_EMAIL` | a real address | With `DEMO_SEED=false` the API bootstraps exactly one administrator from these two values. Without them you have no way to log in at all. |
| `ADMIN_PASSWORD` | a strong password | As above. Change it after first sign-in. |
| `SESSION_SECRET` | `openssl rand -hex 32` | Signs every admin session and OTP token. The template's value literally reads `local-dev-only`. |
| `DATABASE_URL` | `postgresql://bhi_user:<password>@db:5432/bhi_portal` | The one database login. The Postgres container creates it from this URL on its first start. Host stays **`db`**, the compose service name, not `localhost`. The API runs every connection as the restricted `bhi_app` role, which the migrations create. |
| `SMTP_*` | an insurer-owned mailbox | A personal Gmail caps at roughly 500 messages/day, and members' verification codes and insurance cards would be sent from a private account. |
| `SMS_*`, `TWILIO_*` | production credentials | `TWILIO_FROM` must be a number the account actually owns, or every send fails with error 21606. |

Confirm these are already correct in the template and leave them alone:

| Key | Value | Why |
| --- | --- | --- |
| `NODE_ENV` | `production` | |
| `OTP_DEV_MODE` | `false` | `true` returns the verification code in the API response instead of sending it. |
| `TRUST_PROXY` | `1` | The API is behind nginx and needs `X-Forwarded-For` to log real client IPs. |
| `SMS_ALLOWED_COUNTRY` | `592` | The gateway refuses to send anywhere else. Emptying it allows any country. |
| `CARD_EMAIL_OVERRIDE` | unset | Set, it sends **every** member's card to one address. |

The `LOCAL_*` block at the bottom is ignored here — it only applies to
`pnpm run local`. Leave it.

Then lock the file down:

```bash
chmod 600 .env
```

---

## 08 — Start the containers

```bash
cd /opt/bhi-portal
docker compose -f compose.yaml -f compose.prod.yaml up -d --build api
```

Naming `api` is what leaves `web` and `mail` out: compose starts the service you
name plus its dependencies, which is `db` → `migrate` → `sms` → `api`. The
overlay's header explains why those two are excluded.

The first build takes several minutes. Then:

```bash
docker compose -f compose.yaml -f compose.prod.yaml ps
```

All four should be `healthy` or, for `migrate`, `exited (0)`. Migrations apply
automatically on every start — the `migrate` service re-runs the whole set, and
each migration is written to be idempotent.

Check the API directly, before nginx exists:

```bash
curl -s localhost:3001/api/healthz   # {"status":"ok"}
curl -s localhost:3001/api/readyz    # 200 = database reachable
```

`healthz` ok with `readyz` 503 means the API is fine and the database is not.
That diagnostic pair is why the two endpoints exist.

Confirm the bootstrap admin was created and the demo accounts were **not**:

```bash
docker compose -f compose.yaml -f compose.prod.yaml logs api | grep -i admin
```

If you see `bhi-demo.test` addresses, `DEMO_SEED` is still `true`. Fix `.env`,
then destroy the volume and start again — those accounts are already in the
database and will not disappear on their own:

```bash
docker compose -f compose.yaml -f compose.prod.yaml down -v
```

---

## 09 — The frontend files

The Vite build already ran inside the `web` image. Copy the result out rather
than installing a Node toolchain on the VM:

```bash
docker compose -f compose.yaml build web

sudo mkdir -p /var/www/bhi-portal
CID=$(docker create "$(docker compose -f compose.yaml config --images | grep -- '-web$')")
sudo docker cp "$CID:/var/www/bhi-portal/." /var/www/bhi-portal/
docker rm "$CID"

sudo chown -R www-data:www-data /var/www/bhi-portal
ls /var/www/bhi-portal        # index.html, assets/
```

Building the `web` image does not run it. You are using it as a build artefact
and taking only the static files, which is exactly what the host nginx serves.

---

## 10 — nginx and TLS

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

Install the shared pieces the site config requires by name — nginx refuses to
start if any is missing:

```bash
cd /opt/bhi-portal
sudo mkdir -p /etc/nginx/snippets
sudo cp deploy/nginx/proxy_params            /etc/nginx/proxy_params
sudo cp deploy/nginx/bhi-portal-headers.conf /etc/nginx/snippets/
sudo cp deploy/nginx/bhi-portal-limits.conf  /etc/nginx/conf.d/00-bhi-portal-limits.conf
```

The `00-` prefix matters: `limit_req_zone` is only valid at `http` level and must
be parsed before the site config that names its zones.

Now the site. Start from the **plain HTTP** config so certbot has something to
work with, and substitute your hostname:

```bash
export FQDN=bhi-portal.<region>.cloudapp.azure.com

sudo cp deploy/nginx/bhi-portal.conf /etc/nginx/sites-available/bhi-portal
sudo sed -i "s|server_name CHANGE_ME.example.com;|server_name ${FQDN};|" \
  /etc/nginx/sites-available/bhi-portal

sudo ln -sf /etc/nginx/sites-available/bhi-portal /etc/nginx/sites-enabled/bhi-portal
sudo rm -f /etc/nginx/sites-enabled/default

sudo nginx -t && sudo systemctl reload nginx
```

`bhi-portal.conf` already proxies to `127.0.0.1:3001` and serves
`/var/www/bhi-portal` — the two things phases 08 and 09 put in place. Check it
over plain HTTP:

```bash
curl -sI http://${FQDN}/            # 200
curl -s  http://${FQDN}/api/healthz # {"status":"ok"}
```

Then let certbot add TLS:

```bash
sudo certbot --nginx -d ${FQDN} --agree-tos -m you@example.com --redirect
```

It edits the site file in place: adds the 443 listener, the certificate paths,
and a permanent redirect from 80. Renewal is installed as a systemd timer —
verify it:

```bash
sudo certbot renew --dry-run
systemctl list-timers | grep certbot
```

> **Why not use `deploy/nginx/bhi-portal-ssl.conf`?** It is the reference for a
> hand-managed certificate and expects paths that do not exist until certbot has
> run at least once. Letting certbot edit the HTTP config is the same result with
> renewal wired up for you. Read the SSL file if you want to see the intended
> end state, or are issuing certificates some other way.

---

## 11 — Verify

Work down this list. Each line rules something out.

```bash
# TLS and the redirect
curl -sI http://${FQDN}/  | head -1        # 301
curl -sI https://${FQDN}/ | head -1        # 200

# API through nginx
curl -s https://${FQDN}/api/healthz        # {"status":"ok"}
curl -s https://${FQDN}/api/readyz         # 200

# The API must NOT be reachable from outside
curl -m 5 https://${FQDN}:3001/api/healthz # must fail
```

From your own machine, not the VM:

- **Admin login** — `https://<fqdn>/admin/login` with `ADMIN_EMAIL` /
  `ADMIN_PASSWORD`. Change the password immediately.
- **No demo accounts** — `platform.admin@bhi-demo.test` / `Demo@2026` must be
  rejected. If it works, go back to phase 08.
- **Email OTP** — look up a member with a real address; the code must arrive in
  that inbox, not in the container logs.
- **SMS OTP** — look up a member with a **Guyana** number you own. The gateway
  refuses anything that is not `+592`.
- **Rate limiting** — the important one, because it is the thing most easily
  lost:

  ```bash
  for i in $(seq 1 12); do
    curl -s -o /dev/null -w "%{http_code} " -X POST https://${FQDN}/api/v1/admin/auth/login \
      -H 'content-type: application/json' -d '{"email":"x@y.z","password":"wrong"}'
  done; echo
  ```

  You want `429`s to appear after the first few. All `401`s means the limits are
  not being applied — check that `00-bhi-portal-limits.conf` is in `conf.d` and
  that nothing is proxying in front of nginx.

---

## 12 — Moving to the real domain

When the insurer's subdomain is ready:

1. Ask for an **A record** → this VM's static IP.
2. Re-point nginx and reissue:

   ```bash
   export NEW=cards.example.com
   sudo sed -i "s|server_name .*;|server_name ${NEW};|" /etc/nginx/sites-available/bhi-portal
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d ${NEW} --agree-tos -m you@example.com --redirect
   ```

Nothing in the application needs to change — the frontend uses relative paths
throughout, which is what makes this a ten-minute job.

---

## 13 — Backups

The database is a container volume. **Nothing backs it up until you do**, and it
holds member names, dates of birth and identification numbers.

```bash
sudo mkdir -p /var/backups/bhi && sudo chown $USER /var/backups/bhi

cat > /opt/bhi-portal/backup.sh <<'EOF'
#!/bin/sh
set -eu
cd /opt/bhi-portal
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker compose -f compose.yaml -f compose.prod.yaml exec -T db \
  pg_dump -U bhi_user -d bhi_portal --format=custom \
  > "/var/backups/bhi/bhi_portal_${STAMP}.dump"
find /var/backups/bhi -name '*.dump' -mtime +14 -delete
EOF
chmod +x /opt/bhi-portal/backup.sh

# 02:30 UTC daily
( crontab -l 2>/dev/null; echo "30 2 * * * /opt/bhi-portal/backup.sh" ) | crontab -
```

Then do the part everyone skips:

```bash
/opt/bhi-portal/backup.sh
ls -lh /var/backups/bhi/
```

**Restore-test it.** An untested backup is not a backup. Restore the dump into a
throwaway database and confirm the member count matches:

```bash
docker compose -f compose.yaml -f compose.prod.yaml exec -T db \
  createdb -U bhi_user restore_test
docker compose -f compose.yaml -f compose.prod.yaml exec -T db \
  pg_restore -U bhi_user -d restore_test --no-owner < /var/backups/bhi/<file>.dump
docker compose -f compose.yaml -f compose.prod.yaml exec -T db \
  psql -U bhi_user -d restore_test -c "SELECT set_config('bhi.all', 'on', false); SELECT count(*) FROM bhi.member;"
docker compose -f compose.yaml -f compose.prod.yaml exec -T db \
  dropdb -U bhi_user restore_test
```

Copy the dumps off the VM as well — a disk snapshot in the same subscription is
not an off-site backup. Enable Azure Backup on the VM, or sync to a Storage
account.

---

## 14 — Day-to-day

```bash
cd /opt/bhi-portal
export C="-f compose.yaml -f compose.prod.yaml"

docker compose $C ps                    # status
docker compose $C logs -f api           # follow the API
docker compose $C logs sms              # SMS sends and refusals
docker compose $C restart api           # after an .env change

git pull                                # deploy a new version
docker compose $C up -d --build api
docker compose $C build web             # then redo phase 09 for the frontend

sudo tail -f /var/log/nginx/bhi-portal.access.log
```

An `.env` change needs `restart`, not `up -d` — compose only re-reads `env_file`
when the container is recreated. Use `up -d --force-recreate api` if a change
does not seem to take.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `502 Bad Gateway` | The API container is down, or `.env` is missing a required variable. `docker compose $C logs api`. |
| `readyz` 503, `healthz` ok | The database. Check the host in `DATABASE_URL` is `db`, then `docker compose run --rm migrate`. |
| Blank page, assets 404 | Phase 09 was skipped or copied to the wrong path. `ls /var/www/bhi-portal`. |
| No `429` under the login flood | `00-bhi-portal-limits.conf` is not in `conf.d`, or something is proxying in front of nginx. |
| Demo admins can sign in | `DEMO_SEED` was `true` on first start. `down -v` and start again — they are already in the volume. |
| Email OTP never arrives | Member has a fabricated `@bhi-demo.test` address; Gmail accepts and bounces later. Test with a real inbox. |
| SMS refused as not `+592` | Working as designed. The member's stored number is not Guyanese. |
| `nginx: [emerg] ... limit_req_zone` | The limits file landed in a `server` block. It must be in `conf.d`, which nginx includes inside `http`. |
| Build killed part-way | Out of memory. Add swap — see phase 03. |

---

## What this deployment does not have

Honest list, so none of it is a surprise later.

- **No high availability.** One VM. Reboot it and the portal is down for a minute.
- **No managed database.** Container plus volume. Phase 13 is your only safety net;
  Azure Database for PostgreSQL Flexible Server would give point-in-time restore.
- **No secret manager.** `.env` on disk at mode 600. Azure Key Vault would be the
  step up.
- **No application-level rate limiting.** nginx is the only defence, which is why
  phase 11 tests for it and phase 00 explains what breaks it.
- **No log aggregation.** Container logs and nginx files on one disk.
- **No staging environment.** You are deploying to production directly.
