#!/bin/sh
# Generate the container nginx configuration FROM the real production files.
#
# This is the single most important design decision in the stack. The production
# site config is not forked, copied by hand, or templated with placeholders — it is
# read as-is on every build and transformed by a closed, documented set of
# substitutions. A change to deploy/nginx/bhi-portal.conf is therefore picked up
# automatically and drift between local and production is structurally impossible.
# (FR-043, FR-047, SC-012)
#
# THE COMPLETE LIST OF DIFFERENCES. Adding one without documenting it defeats
# the point of the exercise.
#
#   1. proxy_pass upstream 127.0.0.1:3001 -> api:3001   (x3)
#         The API is a separate container, not a loopback process.
#   2. server_name CHANGE_ME.example.com -> localhost
#   3. access_log -> /dev/stdout   (keeps the bhi_portal format)
#   4. error_log  -> /dev/stderr
#   5. INSERT a `location /__inbox` block proxying to mail:2526
#         Puts the code inbox on the portal's own origin.
#         Suppressed by INBOX=off — see substitution 7.
#   6. rate= values substituted from the environment, defaulting to the
#         production numbers. Not a difference by default — an override seam.
#
# The next three exist for ONE deployment shape: a platform that puts its own
# reverse proxy in front of this container and gives you no way to remove it —
# Azure App Service, and anything else built the same way. All three are OFF
# unless their environment variable is set, so the compose stack and the
# nginx-on-the-host VM install render exactly what they rendered before.
#
#   7. INBOX=off SUPPRESSES substitution 5 entirely.
#         nginx resolves proxy_pass host names at config-parse time, so the
#         injected `proxy_pass http://mail:2526` is a startup failure — not a
#         404 — anywhere the mail sink does not exist. The sink is a development
#         thing; no production deployment has one.
#   8. REAL_IP_FROM set -> APPEND set_real_ip_from / real_ip_header /
#         real_ip_recursive to the limits file (http level, where the realip
#         module runs in the post-read phase — before limit_req is evaluated,
#         which is the whole point).
#
#         Without this, every rate limit in bhi-portal-limits.conf keys on the
#         platform proxy's address instead of the client's, so "5 admin logins
#         per minute per attacker" becomes "5 per minute for the entire
#         internet" — the exact failure docs/DEPLOY-AZURE.md warns about — and
#         every audit row records the proxy as the actor's source address.
#
#         REAL_IP_HEADER defaults to X-Client-IP, NOT X-Forwarded-For. On App
#         Service the front end writes X-Forwarded-For as `ip:port`, which the
#         realip module cannot parse (it silently keeps the proxy address, which
#         looks exactly like this substitution not being applied at all).
#         X-Client-IP carries the bare address and the front end overwrites it,
#         so a client cannot forge it.
#
#         SAFETY: set this ONLY to the addresses of a proxy you control. Naming
#         a range wider than the real proxy lets anything in that range choose
#         its own rate-limit bucket and its own audit-trail identity.
#   9. REAL_IP_FROM set -> proxy_params sends X-Forwarded-For $remote_addr
#         instead of $proxy_add_x_forwarded_for.
#
#         Once substitution 8 is in force $remote_addr IS the client, so this
#         hands the API a single clean address. Appending instead would forward
#         `1.2.3.4:5678, 1.2.3.4` — the platform's port-suffixed entry followed
#         by ours — and TRUST_PROXY=1 would make the API record the half with
#         the port glued on.
#
# Everything else is byte-identical, in particular:
#   - the deliberate ABSENCE of a trailing slash on proxy_pass (a slash strips
#     /api and every route 404s — the production file carries a comment saying so)
#   - client_max_body_size 12m, matched to the API's own limit
#   - proxy_buffering off, so card PDFs stream
#   - the rate-limit zones and their burst values
#   - /assets/ immutable caching, the dotfile deny, and the SPA try_files fallback

set -eu

SRC_DIR="${SRC_DIR:-/src/nginx}"
OUT_SITE="${OUT_SITE:-/etc/nginx/conf.d/bhi-portal.conf}"
OUT_LIMITS="${OUT_LIMITS:-/etc/nginx/conf.d/00-bhi-portal-limits.conf}"
OUT_PROXY_PARAMS="${OUT_PROXY_PARAMS:-/etc/nginx/proxy_params}"

API_UPSTREAM="${API_UPSTREAM:-api:3001}"
MAIL_UPSTREAM="${MAIL_UPSTREAM:-mail:2526}"
SERVER_NAME="${SERVER_NAME:-localhost}"

RATE_LOOKUP="${RATE_LOOKUP:-10r/m}"
RATE_ADMIN_LOGIN="${RATE_ADMIN_LOGIN:-5r/m}"
RATE_API="${RATE_API:-120r/m}"

# Substitution 7. Any value other than "off" leaves the inbox in.
INBOX="${INBOX:-on}"

# Substitutions 8 and 9. Empty = off, which is the default everywhere.
# Accepts a space- or comma-separated list of CIDRs / addresses.
REAL_IP_FROM="${REAL_IP_FROM:-}"
REAL_IP_HEADER="${REAL_IP_HEADER:-X-Client-IP}"

echo "render-config: reading production config from $SRC_DIR"

# --- limits: substitution 6 -----------------------------------------------
# Must land in conf.d, which nginx includes inside http{} — limit_req_zone and
# log_format are only valid at http level and nginx refuses to start if either
# appears inside a server block. The 00- prefix guarantees it is parsed before
# the site config that names its zones.
sed \
  -e "s|zone=bhi_lookup:10m      rate=10r/m|zone=bhi_lookup:10m      rate=${RATE_LOOKUP}|" \
  -e "s|zone=bhi_adminlogin:10m  rate=5r/m|zone=bhi_adminlogin:10m  rate=${RATE_ADMIN_LOGIN}|" \
  -e "s|zone=bhi_api:10m         rate=120r/m|zone=bhi_api:10m         rate=${RATE_API}|" \
  "$SRC_DIR/bhi-portal-limits.conf" > "$OUT_LIMITS"

# --- substitution 8: recover the client address behind a platform proxy ----
# Appended to the limits file rather than inserted into the server block for
# two reasons: these directives are valid at http level, and appending cannot
# break on an anchor comment moving.
if [ -n "$REAL_IP_FROM" ]; then
  {
    echo ""
    echo "# --- substitution 8 (docker/nginx/render-config.sh) --------------------"
    echo "# Added because REAL_IP_FROM is set: a platform reverse proxy sits in"
    echo "# front of this nginx, so \$binary_remote_addr is that proxy and every"
    echo "# limit_req zone above would otherwise be one shared bucket for the"
    echo "# whole internet. ABSENT from deploy/nginx/bhi-portal-limits.conf,"
    echo "# where nothing sits in front and trusting a header would be a hole."
    for cidr in $(echo "$REAL_IP_FROM" | tr ',' ' '); do
      echo "set_real_ip_from $cidr;"
    done
    echo "real_ip_header $REAL_IP_HEADER;"
    echo "real_ip_recursive on;"
  } >> "$OUT_LIMITS"
fi

# --- substitution 9: what the API is told the client address is ------------
# proxy_params is rendered rather than copied so this stays one code path: with
# REAL_IP_FROM unset the output is byte-identical to deploy/nginx/proxy_params.
if [ -n "$REAL_IP_FROM" ]; then
  sed \
    -e 's|proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;|proxy_set_header X-Forwarded-For   $remote_addr;|' \
    "$SRC_DIR/proxy_params" > "$OUT_PROXY_PARAMS"

  if grep -q 'proxy_add_x_forwarded_for' "$OUT_PROXY_PARAMS"; then
    echo "render-config: FAILED — REAL_IP_FROM is set but the X-Forwarded-For line" >&2
    echo "render-config: in proxy_params did not match and was left appending." >&2
    echo "render-config: the API would record the client address with a port glued on." >&2
    exit 1
  fi
else
  cat "$SRC_DIR/proxy_params" > "$OUT_PROXY_PARAMS"
fi

# --- site: substitutions 1-4 ----------------------------------------------
sed \
  -e "s|proxy_pass http://127.0.0.1:3001;|proxy_pass http://${API_UPSTREAM};|g" \
  -e "s|server_name CHANGE_ME.example.com;|server_name ${SERVER_NAME};|" \
  -e "s|access_log /var/log/nginx/bhi-portal.access.log bhi_portal;|access_log /dev/stdout bhi_portal;|" \
  -e "s|error_log  /var/log/nginx/bhi-portal.error.log warn;|error_log  /dev/stderr warn;|" \
  "$SRC_DIR/bhi-portal.conf" > "$OUT_SITE"

# --- substitution 5: insert the inbox location ----------------------------
# Anchored on the SPA fallback comment so the block lands inside the server{}
# block and before `location /`, which would otherwise swallow it.
#
# Skipped wholesale when INBOX=off (substitution 7): there is no mail sink to
# proxy to, and an unresolvable proxy_pass host stops nginx from starting.
if [ "$INBOX" != "off" ]; then
  awk -v upstream="$MAIL_UPSTREAM" '
    /# SPA fallback/ && !done {
      print "    # LOCAL ONLY (substitution 5) — the verification-code sink, on the"
      print "    # portal'\''s own origin so a captured code is one click away."
      print "    # Absent from production: deploy/nginx/bhi-portal.conf has no such block."
      print "    location /__inbox {"
      print "        proxy_pass http://" upstream ";"
      print "        include /etc/nginx/proxy_params;"
      print "    }"
      print ""
      done = 1
    }
    { print }
  ' "$OUT_SITE" > "$OUT_SITE.tmp" && mv "$OUT_SITE.tmp" "$OUT_SITE"

  # --- verify the insertion actually happened -----------------------------
  # A silent no-op here would produce a stack whose inbox 404s for a reason
  # nobody could see. Fail the build instead.
  if ! grep -q 'location /__inbox' "$OUT_SITE"; then
    echo "render-config: FAILED — the /__inbox anchor was not found in bhi-portal.conf." >&2
    echo "render-config: the production config's '# SPA fallback' comment has moved or changed." >&2
    exit 1
  fi
else
  # The opposite assertion. A stale inbox block reaching a deployment that asked
  # for none would be a proxy to a host that does not exist, which is a startup
  # failure rather than something anyone would notice in review.
  if grep -q 'location /__inbox' "$OUT_SITE"; then
    echo "render-config: FAILED — INBOX=off but an /__inbox block is present." >&2
    echo "render-config: deploy/nginx/bhi-portal.conf now carries one of its own." >&2
    exit 1
  fi
fi

# Assert all three API upstreams were rewritten to the value actually requested.
#
# Counting the result is right where grepping for the old loopback literal would
# be wrong: the build-time syntax check deliberately renders with a loopback
# upstream, because nginx resolves upstream host names at parse time and the
# compose network does not exist during a build. "127.0.0.1 is still present" is
# therefore a legitimate state, not a failure.
found=$(grep -c "proxy_pass http://${API_UPSTREAM};" "$OUT_SITE" || true)
if [ "$found" -ne 3 ]; then
  echo "render-config: FAILED — expected 3 rewritten API upstreams, found ${found}." >&2
  echo "render-config: the proxy_pass lines in bhi-portal.conf have changed shape." >&2
  exit 1
fi

echo "render-config: wrote $OUT_SITE, $OUT_LIMITS and $OUT_PROXY_PARAMS"
echo "render-config: upstream=$API_UPSTREAM inbox=$INBOX($MAIL_UPSTREAM) rates=$RATE_LOOKUP/$RATE_ADMIN_LOGIN/$RATE_API"
if [ -n "$REAL_IP_FROM" ]; then
  echo "render-config: real ip from [$REAL_IP_FROM] via header $REAL_IP_HEADER"
else
  echo "render-config: real ip recovery OFF (no proxy expected in front of this nginx)"
fi
