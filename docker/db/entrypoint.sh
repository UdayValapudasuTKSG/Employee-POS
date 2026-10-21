#!/bin/sh
# Starts the compose stack's Postgres with the login and database named in
# DATABASE_URL (artifacts/api-server/.env), so the env file holds them once:
#
#   DATABASE_URL=postgresql://USER:PASSWORD@db:5432/DATABASE
#
# The official image creates that login (as its superuser) and the database the
# FIRST time it starts on an empty volume. Changing the URL later does not
# change an existing database's password — use ALTER ROLE, or a new volume.

set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "db: DATABASE_URL is not set in artifacts/api-server/.env — stopping." >&2
  exit 1
fi

# URL-decodes a string: %XX becomes the byte XX. Plain sh, for busybox.
url_decode() {
  rest=$1
  out=""
  while [ -n "$rest" ]; do
    case "$rest" in
      %[0-9A-Fa-f][0-9A-Fa-f]*)
        hex=${rest#%}
        hex=${hex%"${hex#??}"}
        out="$out$(printf "\\$(printf '%o' "0x$hex")")"
        rest=${rest#%??}
        ;;
      *)
        out="$out${rest%"${rest#?}"}"
        rest=${rest#?}
        ;;
    esac
  done
  printf '%s' "$out"
}

case "$DATABASE_URL" in
  postgresql://*:*@*/*|postgres://*:*@*/*) ;;
  *)
    echo "db: DATABASE_URL must look like postgresql://USER:PASSWORD@db:5432/DATABASE — stopping." >&2
    exit 1
    ;;
esac

rest=${DATABASE_URL#*://}
userinfo=${rest%%@*}
path=${rest#*@}
path=${path#*/}

POSTGRES_USER=$(url_decode "${userinfo%%:*}")
POSTGRES_PASSWORD=$(url_decode "${userinfo#*:}")
POSTGRES_DB=$(url_decode "${path%%\?*}")
export POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB

exec docker-entrypoint.sh postgres
