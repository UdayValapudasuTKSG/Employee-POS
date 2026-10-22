// Package a self-contained deployment folder for a Linux + nginx server.
//
//   node deploy/make-release.mjs
//
// Produces release/bhi-portal/ (and a .tar.gz) laid out the way a deployer
// expects, with a runbook, an .env template, a hardened nginx config and a
// post-deploy smoke test. Nothing in the repo is modified; regenerate any time.
//
//   release/bhi-portal/
//   ├── client/          static React build      → /var/www/bhi-portal
//   ├── server/          Node API (single file)  → /opt/bhi-api
//   │   └── .env.template
//   ├── db/              schema.sql + migrations
//   ├── nginx/           site config + rate-limit zones
//   ├── systemd/         bhi-api.service
//   ├── verify.sh        post-deploy checks
//   └── DEPLOY.md        the runbook
//
// The API listens on 127.0.0.1:3001 and is never exposed directly; nginx is the
// only public entry point. See the ports table in DEPLOY.md.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const RELEASE_NAME = process.argv[2] || 'bhi-portal';
const outRoot = path.join(repoRoot, 'release');
const out = path.join(outRoot, RELEASE_NAME);

// Production ports — single source of truth for every generated file.
const API_PORT = 3001;
const DB_PORT = 5432;
const WEB_DIR = '/var/www/bhi-portal';
const API_DIR = '/opt/bhi-api';

function copyDir(from, to, skip = () => false) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest, skip);
    else fs.copyFileSync(src, dest);
  }
}

function write(relPath, content) {
  const target = path.join(out, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

// --- start clean -----------------------------------------------------------

// Windows holds file handles briefly after a process exits (antivirus, indexer,
// a shell that just read the tree), so deleting a large tree can throw EBUSY or
// EPERM transiently. Retry before giving up.
function removeTree(dir, attempts = 5) {
  for (let i = 1; i <= attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch (err) {
      if (i === attempts) {
        console.error(
          `Could not remove ${dir} after ${attempts} attempts: ${err.code ?? err.message}\n` +
            'Close anything browsing that folder and run again.',
        );
        process.exit(1);
      }
      // Busy-wait briefly; this script is short-lived and single-purpose.
      const until = Date.now() + 250 * i;
      while (Date.now() < until);
    }
  }
}

removeTree(out);
fs.mkdirSync(out, { recursive: true });

// --- client: the built React app ------------------------------------------

const webSrc = path.join(here, 'web');
if (!fs.existsSync(path.join(webSrc, 'index.html'))) {
  console.error(`No built frontend at ${webSrc}/index.html`);
  process.exit(1);
}
copyDir(webSrc, path.join(out, 'client'));

// --- server: the bundled Node API -----------------------------------------

const apiSrc = path.join(here, 'api');
if (!fs.existsSync(path.join(apiSrc, 'index.mjs'))) {
  console.error(`No built API at ${apiSrc}/index.mjs`);
  process.exit(1);
}
// .env.example is replaced by .env.template below; .env.local is local-only.
copyDir(apiSrc, path.join(out, 'server'), (name) => name.startsWith('.env'));


// The SMS gateway adapter runs alongside the API as its own small service.
fs.copyFileSync(
  path.join(here, 'sms-gateway.mjs'),
  path.join(out, 'server', 'sms-gateway.mjs'),
);

// --- db --------------------------------------------------------------------

copyDir(
  path.join(here, 'db'),
  path.join(out, 'db'),
  (name) =>
    // setup-local.ps1 is for Windows dev only.
    name.endsWith('.ps1'),
);

// --- server/.env.template --------------------------------------------------

write(
  'server/.env.template',
  `# BHI Health Card Portal — production environment
# Copy to ${API_DIR}/.env, fill in every CHANGE_ME, then:
#   chown www-data:www-data ${API_DIR}/.env && chmod 600 ${API_DIR}/.env

# ---------------------------------------------------------------- networking
# The API listens here. 127.0.0.1 means it is NOT reachable from the internet —
# nginx proxies to it. Do not change HOST to 0.0.0.0.
PORT=${API_PORT}
HOST=127.0.0.1

# How many proxies sit between the member's browser and this API.
#
# REQUIRED behind nginx. Express trusts no proxy by default, so without this
# every audit row records the source address as 127.0.0.1 — nginx's own — and
# the audit trail cannot say where an action came from.
#
# 1 is correct for the standard deployment: one nginx, on this machine. Raise it
# only if you add another proxy in front (a load balancer, Cloudflare), and
# never set it higher than the number of proxies you control — each one you
# count is a hop whose X-Forwarded-For claim is taken as fact.
TRUST_PROXY=1

# Which OTHER origins may call this API from a browser.
#
# Leave this EMPTY. nginx serves the portal and proxies /api on the same
# origin, so the portal makes no cross-origin requests and empty means "none",
# which is the safe answer. Only fill it in if a separate frontend domain has
# to reach this API, and then list exact origins — matching is exact on
# scheme, host and port, and a subdomain of a listed host is NOT included:
#   CORS_ALLOWED_ORIGINS=https://portal.example.com,https://staging.example.com
# "*" works but lets any website on the internet read this API's responses.
CORS_ALLOWED_ORIGINS=

# ----------------------------------------------------------------- database
# Must match the user/password/database created in step 2 of DEPLOY.md.
DATABASE_URL=postgresql://bhi_user:CHANGE_ME_DB_PASSWORD@localhost:${DB_PORT}/bhi_portal

# ------------------------------------------------------------------- secrets
# Signs every session token. Generate with: openssl rand -hex 32
# Changing it later logs everyone out.
SESSION_SECRET=CHANGE_ME_RUN_openssl_rand_hex_32

# ------------------------------------------------------------------ hardening
# All three of these are required for a real deployment. Getting any of them
# wrong exposes member data.
#
# NOTE: never put a comment on the same line as a value in this file. systemd's
# EnvironmentFile= does not strip trailing comments the way a shell does, so
# "DEMO_SEED=false  # ..." sets the variable to the whole comment string.
NODE_ENV=production

# true would insert 120 fake members plus admin accounts whose password
# (Demo@2026) is publicly documented.
DEMO_SEED=false

# true would show verification codes on screen, letting anyone who knows a
# member's email address open their card.
OTP_DEV_MODE=false

# ------------------------------------------------------- first administrator
# Created automatically on first start, only while admin_users is empty.
# Change the password after signing in.
ADMIN_EMAIL=admin@yourdomain.com
ADMIN_PASSWORD=CHANGE_ME_STRONG_PASSWORD

# ------------------------------------------- verification code delivery
# REQUIRED: employee card lookups cannot work without at least one channel.
# With neither configured, a lookup returns 503 and tells the member to contact
# HR — it never pretends a code was sent.

# Email — any SMTP provider (your mail server, SES, Brevo, Gmail relay...)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM="NALICO <no-reply@yourdomain.com>"

# SMS — the bundled gateway (server/sms-gateway.mjs, systemd unit
# bhi-sms.service) turns this webhook into a real carrier send. Point the
# webhook at it and give both sides the same token.
# Leave the URL empty if members only look up by email.
SMS_WEBHOOK_URL=http://127.0.0.1:2527/sms
SMS_WEBHOOK_TOKEN=CHANGE_ME_SHARED_WITH_SMS_GATEWAY

# --------------------------------------------------------- what the card says
# The insurer's identity is configuration, not code, so this portal can be
# deployed for any insurer without a rebuild. Anything left blank is simply
# not printed on the card — never replaced with a default naming some other
# company. Fix a wrong value by editing here and restarting.
#
# QUOTE every value that contains a space, as below. systemd and node both
# strip the quotes; leaving them off breaks the manual "set -a && . ./.env"
# test in DEPLOY.md step 2, because the shell then treats the second word as
# a command.

# Trading name in the card header. When blank, the insurer name recorded on
# each member's own policy row is used instead.
ISSUER_NAME="CHANGE_ME Insurance Company Ltd."

# Street address, printed under the name on the card face.
ISSUER_ADDRESS=""

# Printed on the reverse. Include the "Tel" prefix you want shown.
ISSUER_PHONE=""

# The officer whose signature appears on the card. Both blank = no signature.
ISSUER_SIGNATORY_NAME=""
ISSUER_SIGNATORY_TITLE=""

# The red title on the card face. Defaults to "MEDICAL INSURANCE PLAN".
ISSUER_PLAN_TITLE=""

# The "property of" line on the reverse. Composed from ISSUER_NAME and
# ISSUER_ADDRESS when blank, which is usually right. Set it only if the card
# should use a short form of the name.
CARD_PROPERTY_NOTICE=""

# The conditions-of-use paragraph carried with the card and its PDF. The
# built-in default names no organisation and is usually fine.
CARD_BACK_NOTICE=""

# DEMO ONLY: send EVERY member's card to this one address instead of to them.
# Leave empty on a real server — while it is set, no member receives their own
# card and every card is disclosed to whoever owns that inbox. The API logs a
# warning on every start while it is set.
CARD_EMAIL_OVERRIDE=

# --- Employee discounts -------------------------------------------------------
# A member's coupon takes DISCOUNT_PERCENT off a KFC or Pizza Hut bill, up to
# DISCOUNT_MONTHLY_CAP_GYD of discount per calendar month (Guyana time), both
# brands together. Blank = the defaults shown.
DISCOUNT_PERCENT=10
DISCOUNT_MONTHLY_CAP_GYD=15000
DISCOUNT_COUPON_TTL_MINUTES=30

# One key per brand, given to that brand's POS vendor (docs/POS-DISCOUNT-API.md).
# Blank = that brand's tills cannot redeem. At least 24 characters:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
POS_API_KEY_KFC=
POS_API_KEY_PIZZA_HUT=
`,
);

// --- server/sms.env.template ----------------------------------------------

write(
  'server/sms.env.template',
  `# SMS gateway — the last mile between the portal and a carrier.
# Copy to ${API_DIR}/sms.env, fill in, then chmod 600.
#
# No inline comments on value lines: systemd's EnvironmentFile= keeps them.

SMS_GATEWAY_PORT=2527

# Must match SMS_WEBHOOK_TOKEN in .env — without it any local process can send
# messages at your expense.
SMS_GATEWAY_TOKEN=CHANGE_ME_SHARED_WITH_API

# Guyana. Member numbers stored as +592-xxx-xxxx already work; this only adds
# the country code to bare 7-digit local numbers.
SMS_DEFAULT_COUNTRY=592

# twilio | vonage | dryrun
# dryrun logs instead of sending — use it to prove the wiring before spending.
SMS_PROVIDER=dryrun

# --- twilio ---
# TWILIO_FROM must be an SMS-capable number you own, in E.164. Ask your
# provider whether alphanumeric sender IDs are supported for Guyana before
# promising the client a branded sender.
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM=
# Use a Messaging Service instead of a single number (optional):
# TWILIO_MESSAGING_SERVICE_SID=

# --- vonage ---
# VONAGE_API_KEY=
# VONAGE_API_SECRET=
# VONAGE_FROM=

# Logs the message text, which contains the verification code. Never enable
# this on a production server.
SMS_GATEWAY_LOG_BODY=false
`,
);

// --- nginx -----------------------------------------------------------------

// Copied, not generated. These used to be template literals here, which meant
// every `$uri` and `$binary_remote_addr` had to be escaped against JS
// interpolation and the real files in deploy/nginx/ slowly drifted out of step
// with the ones a deployer actually received. Editing plain .conf files with
// syntax highlighting and `nginx -t` is the better arrangement.
//
// They hardcode ${WEB_DIR} and 127.0.0.1:${API_PORT}; change those constants
// and the .conf files together.
copyDir(path.join(here, 'nginx'), path.join(out, 'nginx'));

// --- systemd ---------------------------------------------------------------

write(
  'systemd/bhi-api.service',
  `# BHI Health Card Portal API
#
#   cp systemd/bhi-api.service /etc/systemd/system/
#   systemctl daemon-reload && systemctl enable --now bhi-api

[Unit]
Description=BHI Health Card Portal API
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=www-data
WorkingDirectory=${API_DIR}
EnvironmentFile=${API_DIR}/.env
ExecStart=/usr/bin/node --enable-source-maps ${API_DIR}/index.mjs
Restart=on-failure
RestartSec=5

# Hardening.
# WARNING: ProtectHome makes /home invisible to this service, so an nvm-
# installed node under /home/<user>/.nvm CANNOT be used here — it fails with
# 203/EXEC. Install node system-wide (NodeSource) so /usr/bin/node exists, or
# remove ProtectHome. Check with: which node
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`,
);

write(
  'systemd/bhi-sms.service',
  `# BHI SMS gateway — receives the API's webhook and sends via a real carrier.
# Only needed if members look up by phone.
#
#   cp systemd/bhi-sms.service /etc/systemd/system/
#   systemctl daemon-reload && systemctl enable --now bhi-sms

[Unit]
Description=BHI Health Card Portal SMS gateway
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=${API_DIR}
EnvironmentFile=${API_DIR}/sms.env
ExecStart=/usr/bin/node ${API_DIR}/sms-gateway.mjs
Restart=on-failure
RestartSec=5

NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`,
);

// --- verify.sh -------------------------------------------------------------

write(
  'verify.sh',
  `#!/usr/bin/env bash
# Post-deploy checks. Run on the server after DEPLOY.md step 7.
#   ./verify.sh your-domain.com
set -uo pipefail

DOMAIN="\${1:-localhost}"
API_PORT=${API_PORT}
fail=0
ok()   { printf '  \\033[32mPASS\\033[0m  %s\\n' "\$1"; }
bad()  { printf '  \\033[31mFAIL\\033[0m  %s\\n' "\$1"; fail=1; }

echo "Checking \$DOMAIN"

# 1. API process up and answering locally
if curl -fsS "http://127.0.0.1:\$API_PORT/api/healthz" | grep -q '"ok"'; then
  ok "API responds on 127.0.0.1:\$API_PORT"
else
  bad "API not responding on 127.0.0.1:\$API_PORT  (journalctl -u bhi-api -n 40)"
fi

# 1b. API can actually reach its database.
#     /api/healthz deliberately touches nothing, so it answers perfectly well
#     while the database is unreachable — which is exactly what makes a 500 on
#     every admin screen look like a mystery. /api/readyz is the one that asks.
ready=\$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://127.0.0.1:\$API_PORT/api/readyz")
if [ "\$ready" = "200" ]; then
  ok "API can reach the database"
else
  bad "API cannot reach the database (/api/readyz gave \$ready) — check DATABASE_URL in .env; the reason is in journalctl -u bhi-api -n 20"
fi

# 2. API must NOT be publicly bound
if ss -tlnH "sport = :\$API_PORT" | grep -qE '0\\.0\\.0\\.0|\\[::\\]'; then
  bad "API is bound to all interfaces — set HOST=127.0.0.1 in .env and restart"
else
  ok "API bound to loopback only"
fi

# 3. Through nginx
for scheme in https http; do
  if curl -fsS -m 10 "\$scheme://\$DOMAIN/api/healthz" >/dev/null 2>&1; then
    ok "\$scheme://\$DOMAIN/api/healthz reachable"
    break
  fi
done

# 4. SPA shell served
code=\$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://\$DOMAIN/admin/login")
[ "\$code" = "200" ] && ok "SPA route /admin/login returns 200" \\
                     || bad "SPA route /admin/login returned \$code (check try_files)"

# 5. CORS must not be wide open. A response carrying "*" means any website can
#    read this API from a visitor's browser.
acao=\$(curl -s -o /dev/null -D - -m 10 "http://127.0.0.1:\$API_PORT/api/healthz" \\
        -H 'Origin: https://probe.invalid' | tr -d '\\r' \\
        | awk 'tolower(\$1) ~ /^access-control-allow-origin:/ {print \$2}')
if [ -z "\$acao" ]; then
  ok "CORS refuses unknown origins"
elif [ "\$acao" = "*" ]; then
  bad "CORS is wide open (\\"*\\") — set CORS_ALLOWED_ORIGINS to the origins you serve"
else
  bad "CORS echoed an unknown origin back (\$acao)"
fi

# 5b. Behind nginx without TRUST_PROXY, req.ip is nginx's own loopback address
#     and every audit row records 127.0.0.1 as the source.
if [ -f /opt/bhi-api/.env ] && grep -qE '^TRUST_PROXY=[^[:space:]]+' /opt/bhi-api/.env; then
  ok "TRUST_PROXY set — audit rows record the real client address"
else
  bad "TRUST_PROXY is unset — every audit row will record 127.0.0.1 as the source IP"
fi

# 6. The card must name an insurer. Unset ISSUER_NAME falls back to whatever is
#    on each policy row, which is easy to leave wrong on a fresh install.
if [ -f /opt/bhi-api/.env ] && grep -qE '^ISSUER_NAME=.+' /opt/bhi-api/.env; then
  ok "ISSUER_NAME is configured"
else
  bad "ISSUER_NAME is empty in .env — the card falls back to the policy row's insurer"
fi

# 7. A card redirect left on means no member ever receives their own card.
if [ -f /opt/bhi-api/.env ] && grep -qE '^CARD_EMAIL_OVERRIDE=.+' /opt/bhi-api/.env; then
  bad "CARD_EMAIL_OVERRIDE is set — every card goes to that address, not the member"
else
  ok "card emails go to members"
fi

# 8. No demo data
if command -v psql >/dev/null && [ -n "\${DATABASE_URL:-}" ]; then
  demo=\$(psql "\$DATABASE_URL" -tAc "SELECT count(*) FROM admin_users WHERE email LIKE '%@bhi-demo.test';")
  [ "\$demo" = "0" ] && ok "no demo admin accounts present" \\
                     || bad "\$demo demo admin(s) found — DEMO_SEED was true; remove them"

  # A member with no policy can sign in but cannot be shown a card. Common
  # right after a first import, since the sheets carry no policy columns.
  nopolicy=\$(psql "\$DATABASE_URL" -tAc "SELECT set_config('bhi.all', 'on', false); SELECT count(*) FROM bhi.member m LEFT JOIN bhi.policy_memberships p ON p.member_ref=m.member_id WHERE p.id IS NULL AND m.active;")
  [ "\$nopolicy" = "0" ] && ok "every active member has a policy" \\
                        || echo "  WARN  \$nopolicy active member(s) have no policy — they will see \\"No active policy is on file\\""
else
  echo "  SKIP  database checks (export DATABASE_URL and install psql to enable)"
fi

echo
[ "\$fail" = "0" ] && echo "All checks passed." || echo "Some checks FAILED (see above)."
exit \$fail
`,
);

// --- DEPLOY.md -------------------------------------------------------------

write(
  'DEPLOY.md',
  `# BHI Health Card Portal — deployment runbook

Everything needed to run the portal on one Linux server behind nginx.
**Nothing is compiled here** — \`client/\` and \`server/\` are already built.
There is no \`npm install\` step and no \`node_modules\` anywhere.

## Ports and hosts

| Component | Process | Listens on | Reachable from internet |
| --- | --- | --- | --- |
| **Frontend** | none — static files served by nginx | *no port of its own* | Yes, as \`https://your-domain.com/\` |
| **nginx** | \`nginx\` | \`0.0.0.0:80\` → \`0.0.0.0:443\` | **Yes — the only public entry point** |
| **Backend API** | \`node index.mjs\` (systemd \`bhi-api\`) | \`127.0.0.1:${API_PORT}\` | **No** |
| **SMS gateway** | \`node sms-gateway.mjs\` (systemd \`bhi-sms\`) | \`127.0.0.1:2527\` | **No** |
| **PostgreSQL** | \`postgres\` | \`127.0.0.1:${DB_PORT}\` | **No** |

The frontend is **not a server**. It is a folder of files. The browser loads it
from nginx, and every API call it makes is a relative path (\`/api/...\`) to the
**same** domain — so it never knows the API's port. nginx sees the \`/api/\`
prefix and forwards those requests to \`127.0.0.1:${API_PORT}\`; everything else is
served as a static file. That second hop is server-to-server and never appears
in the browser.

    Browser ──https──▶ nginx :443 ──┬── /api/*  ──▶ 127.0.0.1:${API_PORT}  (Node)
      your-domain.com               └── /*      ──▶ ${WEB_DIR} (files)

Keep the API on \`127.0.0.1\`. Binding it to \`0.0.0.0\` would publish an
unauthenticated-lookup endpoint straight to the internet.

## Layout of this folder

| Folder | Goes to | What it is |
| --- | --- | --- |
| \`client/\` | \`${WEB_DIR}\` | Built React app (\`index.html\` + \`assets/\`) |
| \`server/\` | \`${API_DIR}\` | Node API (one bundled file) + the SMS gateway |
| \`db/\` | — | \`schema.sql\` (new install) and \`migrations/\` (upgrades) |
| \`nginx/\` | \`/etc/nginx/...\` | Site config, rate-limit zones, proxy params |
| \`systemd/\` | \`/etc/systemd/system/\` | Service unit for the API |
| \`verify.sh\` | — | Post-deploy checks |

## Prerequisites

\`\`\`bash
node -v      # must be 20 or newer
psql --version   # 14 or newer
nginx -v
\`\`\`

Install node **system-wide** (e.g. NodeSource), not via nvm — see the warning
in \`systemd/bhi-api.service\`.

---

## 1. Create the database

\`\`\`bash
sudo -u postgres psql <<'SQL'
CREATE USER bhi_user WITH PASSWORD 'CHANGE_ME_DB_PASSWORD';
CREATE DATABASE bhi_portal OWNER bhi_user;
SQL

psql "postgresql://bhi_user:CHANGE_ME_DB_PASSWORD@localhost:${DB_PORT}/bhi_portal" -f db/schema.sql
\`\`\`

Expect 20 tables; the migrations below add two more. No superuser rights are needed for the schema itself — the
\`pgcrypto\` extension it enables is a trusted extension, installable by the
database owner.

**Upgrading an existing install instead?** Skip \`schema.sql\` and run the
migrations (each is idempotent):

\`\`\`bash
for f in db/migrations/*.sql; do
  psql "postgresql://bhi_user:PASSWORD@localhost:${DB_PORT}/bhi_portal" -f "\$f"
done
\`\`\`

## 2. Install the API

\`\`\`bash
sudo mkdir -p ${API_DIR}
sudo cp -r server/. ${API_DIR}/
sudo cp server/.env.template ${API_DIR}/.env
sudo nano ${API_DIR}/.env          # fill in every CHANGE_ME
sudo chown -R www-data:www-data ${API_DIR}
sudo chmod 600 ${API_DIR}/.env     # contains DB password + session secret
\`\`\`

Test it by hand before wiring up systemd:

\`\`\`bash
cd ${API_DIR} && set -a && . ./.env && set +a && node index.mjs
# expect: {"msg":"Server listening","port":${API_PORT}}
#         {"msg":"CORS: no cross-origin requests allowed — same-origin only..."}
#         {"msg":"Bootstrapped initial platform administrator from ADMIN_EMAIL"}
# Ctrl+C
#
# Anything logged at WARN here is telling you something is misconfigured —
# a card-email redirect still set, or CORS opened to "*".
\`\`\`

## 3. Run it as a service

\`\`\`bash
sudo cp systemd/bhi-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bhi-api
systemctl status bhi-api
\`\`\`

Logs: \`journalctl -u bhi-api -f\`. If it fails to start, that command shows the
real error; the usual causes are a wrong \`node\` path (\`which node\`) or a
\`DATABASE_URL\` typo.

*Prefer pm2?* \`pm2 start ${API_DIR}/index.mjs --name bhi-api && pm2 startup && pm2 save\`
— but pm2 does not read \`.env\` for you, so use \`--env\` or export the variables
first. systemd's \`EnvironmentFile\` handles it, which is why the unit is provided.

### 3b. SMS gateway (only if members look up by phone)

Employees who verify by **email** need nothing here. For **phone** verification
the API needs something that hands the message to a carrier — that is
\`server/sms-gateway.mjs\`.

\`\`\`bash
sudo cp server/sms.env.template ${API_DIR}/sms.env
sudo nano ${API_DIR}/sms.env        # SMS_PROVIDER + credentials
sudo chown www-data:www-data ${API_DIR}/sms.env && sudo chmod 600 ${API_DIR}/sms.env
sudo cp systemd/bhi-sms.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now bhi-sms
curl -s http://127.0.0.1:2527/healthz     # {"status":"ok","provider":"..."}
\`\`\`

\`SMS_GATEWAY_TOKEN\` in \`sms.env\` **must equal** \`SMS_WEBHOOK_TOKEN\` in \`.env\`.

Start with \`SMS_PROVIDER=dryrun\`: the whole path runs and the gateway logs what
it *would* have sent, so you can confirm the wiring before spending money. Then
switch to \`twilio\` or \`vonage\`.

Guyana numbers need **no DLT-style registration** (that is an India-only
requirement), so a normal provider account is enough. Two things to confirm with
your provider before go-live: coverage for **GTT and Digicel Guyana**, and
whether an alphanumeric sender ID is permitted — on many Caribbean routes it is
not, and codes arrive from a long number instead.

If the gateway is down or the carrier rejects a message, the API expires the
verification session and returns 503, telling the member to contact HR. It never
claims a code was sent when it was not.

## 4. Install the frontend

\`\`\`bash
sudo mkdir -p ${WEB_DIR}
sudo cp -r client/. ${WEB_DIR}/
\`\`\`

Serve it at the **domain root**. The build references \`/assets/...\` absolutely,
so a subpath (\`/portal/\`) will load a blank page.

## 5. Configure nginx (plain HTTP first)

\`nginx/\` holds five files. Four are installed once and never touched again;
only the site config carries your domain.

| File | Goes to | What it does |
| --- | --- | --- |
| \`bhi-portal-limits.conf\` | \`/etc/nginx/conf.d/\` | Rate-limit zones. Must be here — \`limit_req_zone\` is only valid at http level |
| \`proxy_params\` | \`/etc/nginx/\` | Headers sent to the API. Debian/Ubuntu ship this; overwrite only if missing |
| \`bhi-portal-headers.conf\` | \`/etc/nginx/snippets/\` | Security headers, included per location |
| \`bhi-portal.conf\` | \`/etc/nginx/sites-available/\` | The site, on port 80 |
| \`bhi-portal-ssl.conf\` | \`/etc/nginx/sites-available/\` | The site, on 443 — step 6 |

\`\`\`bash
sudo cp nginx/bhi-portal-limits.conf /etc/nginx/conf.d/
[ -f /etc/nginx/proxy_params ] || sudo cp nginx/proxy_params /etc/nginx/
sudo mkdir -p /etc/nginx/snippets
sudo cp nginx/bhi-portal-headers.conf /etc/nginx/snippets/
sudo cp nginx/bhi-portal.conf nginx/bhi-portal-ssl.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/bhi-portal.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default      # optional
sudo nano /etc/nginx/sites-available/bhi-portal.conf   # set server_name
sudo nginx -t && sudo systemctl reload nginx
\`\`\`

The portal should now load over plain HTTP. Do not stop here.

## 6. Enable HTTPS — before any real member data goes in

Admin session tokens travel in an \`Authorization\` header and verification
codes travel in request bodies. On plain HTTP both are readable in transit.

Obtain the certificate using the port-80 site from step 5, which already serves
the ACME challenge from \`/var/www/html\`:

\`\`\`bash
sudo apt install certbot
sudo certbot certonly --webroot -w /var/www/html -d your-domain.com
\`\`\`

Then put your domain into the TLS config — it appears in the two
\`server_name\` lines and the three certificate paths — and switch to it:

\`\`\`bash
sudo nano /etc/nginx/sites-available/bhi-portal-ssl.conf
sudo ln -sf /etc/nginx/sites-available/bhi-portal-ssl.conf /etc/nginx/sites-enabled/bhi-portal.conf
sudo nginx -t && sudo systemctl reload nginx
\`\`\`

\`bhi-portal-ssl.conf\` already redirects port 80, sets HSTS, staples OCSP and
keeps the ACME location open so \`certbot renew\` works unattended. Confirm the
renewal timer is active: \`systemctl list-timers | grep certbot\`.

*\`certbot --nginx\` is the alternative — it rewrites the port-80 config in
place. It gets you TLS in one command but produces a config nobody reviewed,
and it does not add HSTS, OCSP stapling or the cipher policy.*

## 7. Verify

\`\`\`bash
./verify.sh your-domain.com
\`\`\`

Then sign in at \`https://your-domain.com/admin/login\` with the \`ADMIN_EMAIL\`
account and change the password.

## 8. Load real data

1. **Companies** — one row per company; \`code\` appears on member records:

   \`\`\`bash
   psql "\$DATABASE_URL" <<'SQL'
   INSERT INTO companies (code, name) VALUES
     ('ACME', 'Acme Holdings Ltd'),
     ('ACML', 'Acme Logistics Ltd');
   SQL
   \`\`\`

2. **Members, dependants and beneficiaries** — admin portal → **Import**.
   Upload the carrier's workbook (.xlsx) or paste CSV. Four sheet layouts are
   recognised, each identified from its own header row, so a workbook holding
   several of them imports in one pass:

   | Sheet | Columns | Linked to a member by |
   | --- | --- | --- |
   | Members | 22 | matched on \`Company Number\` + \`IDNumber\` |
   | Dependants | 14 | \`CompanyNumber\` + \`MemberIDNumber\` |
   | Beneficiaries | 18 | \`CompanyNumber\` + \`MemberIDNumber\` |
   | Short members | 8 | for hand-built files |

   The Import screen lists the exact columns each layout expects and offers a
   header-only CSV template per layout, both generated by the server — so a
   downloaded template always matches what will be accepted.

   Members commit before dependants and beneficiaries, so one file can create
   a member and everyone attached to them. Re-importing the same file updates
   rather than duplicating. Every row is previewed and validated before
   anything is written.

   Two quirks of the carrier's Beneficiaries sheet worth knowing: \`LastName\`
   and \`FirstName\` appear **twice** (the first pair is the member's, the
   second the beneficiary's), and it has no Relationship column, so imported
   beneficiaries have none recorded until HR fills it in.

3. **Policies** — the import carries no policy columns, so a freshly imported
   member has none, and their card screen says *"No active policy is on file"*.
   Add one per member from **Members → (member) → Policy**. Without it the
   member can sign in but cannot be shown a card.

4. **More HR admins** — admin portal → **Admins**.

---

## Before you call it live

- [ ] \`DEMO_SEED=false\` — otherwise 120 fake members and admin accounts whose
      password is publicly documented (\`Demo@2026\`) are in your database
- [ ] \`OTP_DEV_MODE=false\` — otherwise verification codes appear on screen and
      anyone knowing a member's email can open their card
- [ ] \`SESSION_SECRET\` is a fresh random value, not the placeholder
- [ ] \`ADMIN_PASSWORD\` changed after first sign-in
- [ ] \`ss -tlnp | grep ${API_PORT}\` shows \`127.0.0.1\`, never \`0.0.0.0\`
- [ ] \`TRUST_PROXY=1\` — without it every audit row blames 127.0.0.1 and the
      trail cannot tell you who did what from where
- [ ] HTTPS working, HTTP redirects
- [ ] \`CARD_EMAIL_OVERRIDE\` empty — otherwise every member's card goes to one
      inbox instead of to them. The API logs a warning at startup while it is set
- [ ] \`CORS_ALLOWED_ORIGINS\` empty, or a list of exact origins you control —
      never \`*\`
- [ ] \`ISSUER_*\` filled in — the card prints what is set here and silently
      omits what is not, so a blank \`ISSUER_ADDRESS\` means a card with no address
- [ ] SMTP (and/or the SMS webhook) configured — without it employee lookups
      return 503 and no member can retrieve a card
- [ ] \`pg_dump\` backups scheduled. The audit trail is append-only by design;
      that guarantee is worthless without backups.

## Updating later

\`\`\`bash
sudo cp -r client/. ${WEB_DIR}/
sudo cp server/index.mjs ${API_DIR}/
sudo systemctl restart bhi-api
\`\`\`

Run any new files in \`db/migrations/\` first.

## Troubleshooting

### Start here: three commands that locate almost anything

The status code says which layer failed, so ask these in order.

\`\`\`bash
# 1. Is the API process alive? (touches nothing else — see routes/health.ts)
curl -i http://127.0.0.1:${API_PORT}/api/healthz

# 2. Can it reach the database? 200 = yes, 503 = no
curl -i http://127.0.0.1:${API_PORT}/api/readyz

# 3. Why did it fail, or why won't it start?
journalctl -u bhi-api -n 100 --no-pager
\`\`\`

| What you see | What it means |
| --- | --- |
| healthz ok, readyz ok | The fault is in one route. Find its line in \`journalctl\` |
| healthz ok, readyz 503 | The database. Check \`DATABASE_URL\`, that Postgres runs, and \`pg_hba.conf\` |
| healthz refuses the connection | The process is down; \`journalctl -u bhi-api -n 100\` has the reason |

### Following one request through both logs

Every response carries an \`X-Request-Id\`, and any error the portal shows ends
with \`(reference: …)\`. That string appears in nginx's log and in the API's, so
one reference gives the whole story — status and timing from nginx, stack trace
from the API:

\`\`\`bash
grep <reference> /var/log/nginx/bhi-portal.access.log
journalctl -u bhi-api --grep <reference>
\`\`\`

### By symptom

| Symptom | Cause |
| --- | --- |
| 502 Bad Gateway on \`/api/...\` | API not running. \`systemctl status bhi-api\`, \`journalctl -u bhi-api -n 40\`. A crash logs \`Process exiting on …\`; a restart logs \`Shutting down\`; neither means it never started |
| 502 on everything, portal included | Same cause. A dead API takes the static pages down too, because nginx proxies both |
| \`SCHEMA_OUT_OF_DATE\` in a response | The migrations for this version were not run. Apply every file in \`db/migrations/\`, then restart |
| \`DATABASE_UNAVAILABLE\` (503) | Postgres unreachable or refusing connections. \`psql "\$DATABASE_URL" -c 'select 1'\` |
| A 500 with no detail | Read the log line carrying the same reference as the response — it has the stack trace |
| 504 Gateway Timeout | A request took over 60s, usually a large import. Raise \`proxy_read_timeout\` |
| 429 on a screen that fires several requests | A zone in \`bhi-portal-limits.conf\` is too tight for the workload |
| nginx won't start: \`unknown log_format\` or zone not found | \`bhi-portal-limits.conf\` was not copied to \`/etc/nginx/conf.d/\`. It and the site config are a pair |
| Every \`/api\` route 404s with \`NOT_FOUND\` | A trailing slash on \`proxy_pass\` is stripping the \`/api\` prefix. There must not be one |
| Blank page, 404s for \`/assets/*.js\` | \`root\` points at the wrong folder, or the app is served from a subpath instead of the domain root |
| Service dies with \`203/EXEC\` | \`ExecStart\` node path wrong, or node is under \`/home\` while \`ProtectHome=true\` |
| \`password authentication failed\` in the logs | \`DATABASE_URL\` disagrees with the password from step 1 |
| Lookup says codes cannot be delivered | No \`SMTP_*\` and no \`SMS_WEBHOOK_URL\`. Correct behaviour — configure a channel |
| Admin portal 404s on refresh | SPA fallback missing; the \`location /\` \`try_files\` line handles it |
| CSV import fails on large files | Raise \`client_max_body_size\` in the \`/api/\` block |
`,
);

// --- tarball ---------------------------------------------------------------

let archive = null;
try {
  const tarName = `${RELEASE_NAME}.tar.gz`;
  execFileSync('tar', ['-czf', tarName, '-C', outRoot, RELEASE_NAME], {
    cwd: outRoot,
    stdio: 'ignore',
  });
  archive = path.join(outRoot, tarName);
} catch {
  // tar unavailable (or failed) — the folder itself is the deliverable.
}

// --- report ----------------------------------------------------------------

function sizeOf(dir) {
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    bytes += entry.isDirectory() ? sizeOf(full) : fs.statSync(full).size;
  }
  return bytes;
}
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

console.log(`Release built: ${path.relative(repoRoot, out)}  (${mb(sizeOf(out))})`);
for (const folder of ['client', 'server', 'db', 'nginx', 'systemd']) {
  const dir = path.join(out, folder);
  const count = fs.readdirSync(dir, { recursive: true }).length;
  console.log(`  ${folder.padEnd(9)} ${String(count).padStart(3)} files   ${mb(sizeOf(dir))}`);
}
console.log(`  DEPLOY.md  runbook`);
console.log(`  verify.sh  post-deploy checks`);
if (archive) {
  console.log(
    `\nArchive: ${path.relative(repoRoot, archive)}  (${mb(fs.statSync(archive).size)})`,
  );
  console.log('Copy that single file to the server, untar, and follow DEPLOY.md.');
}
console.log(`\nAPI port ${API_PORT} (loopback only) · nginx 80/443 · PostgreSQL ${DB_PORT}`);
