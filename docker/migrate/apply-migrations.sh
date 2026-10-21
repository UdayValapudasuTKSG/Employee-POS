#!/bin/sh
# Apply every migration, in filename order, on every start.
#
# This mirrors step 4 of deploy/db/setup-local.ps1 and exists as its own service
# for one reason: /docker-entrypoint-initdb.d runs only against an empty data
# directory, so a migration added after the volume exists would never apply.
# Running the whole set every start is safe because each migration is written to
# be idempotent, and it means a first run and an upgrade run take the same path —
# the path most likely to be wrong, and therefore the one worth exercising
# constantly. (FR-008, FR-009)
#
# Connects with DATABASE_URL from artifacts/api-server/.env — the one database
# login. 002_roles_grants.sql creates the restricted bhi_app role the API runs as.
#
# ON_ERROR_STOP=1 means a partially applied migration fails the start rather than
# leaving the database in a state the API would then misreport.

set -eu

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "migrate: DATABASE_URL is not set in artifacts/api-server/.env — stopping." >&2
  exit 1
fi

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "migrate: no migrations directory at $MIGRATIONS_DIR" >&2
  exit 1
fi

# Sorted lexically, which is why a tenth migration must be named 010_, not 10_.
files=$(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' | sort)

if [ -z "$files" ]; then
  echo "migrate: no .sql files found in $MIGRATIONS_DIR — nothing to do"
  exit 0
fi

count=0
for f in $files; do
  name=$(basename "$f")
  echo "migrate: applying $name"
  if ! psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --quiet -f "$f"; then
    echo "migrate: FAILED on $name — stopping. The database error is above." >&2
    exit 1
  fi
  count=$((count + 1))
done

echo "migrate: $count migration(s) applied successfully"

# Every admin screen and the card lookup read these tables. A count other than
# 21 means a migration silently did less than it should, and the API would fail
# in confusing ways — stop here instead.
bhi_tables=$(psql "$DATABASE_URL" -tA -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'bhi'")
if [ "$bhi_tables" != "21" ]; then
  echo "migrate: expected the 21 tables in schema bhi, found '$bhi_tables' — stopping." >&2
  exit 1
fi
echo "migrate: schema bhi has its 21 tables"
