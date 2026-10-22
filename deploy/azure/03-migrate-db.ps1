# =============================================================================
# Phase 3 — load the schema and apply every migration
# =============================================================================
#
#   .\deploy\azure\03-migrate-db.ps1
#   .\deploy\azure\03-migrate-db.ps1 -KeepFirewallRule    # leave your IP allowed
#
# This is the job compose.yaml gives to its one-shot `migrate` service. App
# Service has no equivalent — there is no place to run a container that exits —
# so it runs from here, against the managed database, on demand.
#
# RUN THIS AGAIN AFTER EVERY NEW MIGRATION, before pushing the images that
# expect it. The API reports a stale schema as ordinary query failures.
#
# psql comes from the postgres:16-alpine image rather than a local install, so
# nothing has to be on PATH. It is the same psql the compose stack uses, which
# is the point: docker/migrate/apply-migrations.sh and this script apply the
# same files in the same order with the same ON_ERROR_STOP=1.
# =============================================================================

param(
    [switch]$KeepFirewallRule
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\settings.ps1"

docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
if (-not $?) { throw "The Docker daemon is not responding. Start Docker Desktop and re-run." }

if (-not (Test-Path $EnvFile)) { throw "$EnvFile not found. Copy artifacts/api-server/.env.example to it first." }
$pgPassword = (Select-String -Path $EnvFile -Pattern '^PG_ADMIN_PASSWORD=(.+)$').Matches.Groups[1].Value
if (-not $pgPassword) { throw "PG_ADMIN_PASSWORD is not set in $EnvFile" }

# --- open the door, narrowly ------------------------------------------------
# One rule, your address only, removed at the end. The database holds member
# names, dates of birth and identification numbers; a 0.0.0.0-255.255.255.255
# rule "just for the migration" is how those end up exposed for months.
$myIp = (Invoke-RestMethod -Uri 'https://api.ipify.org' -TimeoutSec 15).Trim()
if ($myIp -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { throw "Could not determine this machine's public IP (got '$myIp')" }
$ruleName = 'migration-client'

Write-Host "Allowing $myIp through the database firewall" -ForegroundColor Yellow
az postgres flexible-server firewall-rule create `
    --name $PgServer --resource-group $ResourceGroup `
    --rule-name $ruleName `
    --start-ip-address $myIp --end-ip-address $myIp `
    --output none
if (-not $?) { throw "Failed to add the firewall rule" }

try {
    $dbDir = Join-Path $RepoRoot 'deploy\db'
    $conn  = "host=$PgFqdn port=5432 dbname=$PgDatabase user=$PgAdminUser sslmode=require"

    function Invoke-Psql([string[]]$PsqlArgs) {
        docker run --rm `
            -e "PGPASSWORD=$pgPassword" `
            -v "${dbDir}:/sql:ro" `
            postgres:16-alpine `
            psql $conn -v ON_ERROR_STOP=1 @PsqlArgs
        return $LASTEXITCODE
    }

    Write-Host "`nConnecting to $PgFqdn" -ForegroundColor Cyan
    $version = docker run --rm -e "PGPASSWORD=$pgPassword" postgres:16-alpine `
        psql $conn -tAc 'SELECT version()'
    if ($LASTEXITCODE -ne 0) { throw "Could not connect. Check PG_ADMIN_PASSWORD and that the server finished provisioning." }
    Write-Host "  $version"

    # --- schema, only on an empty database ----------------------------------
    # deploy/db/schema.sql is a pg_dump: its CREATE TABLE statements carry no
    # IF NOT EXISTS, so a second run fails on the first table. The migrations
    # are written to be idempotent and are applied unconditionally; the schema
    # is not, so it is guarded.
    $exists = docker run --rm -e "PGPASSWORD=$pgPassword" postgres:16-alpine `
        psql $conn -tAc "SELECT to_regnamespace('bhi') IS NOT NULL"
    if ($LASTEXITCODE -ne 0) { throw "Failed to inspect the schema" }

    if ($exists.Trim() -eq 't') {
        Write-Host "`nSchema already present — skipping schema.sql" -ForegroundColor Cyan
    } else {
        Write-Host "`nApplying schema.sql" -ForegroundColor Yellow
        if ((Invoke-Psql @('-f', '/sql/schema.sql')) -ne 0) {
            throw "schema.sql failed — the database error is above."
        }
    }

    # The restricted role the API runs as, bhi_app, is created by the migrations
    # (002_roles_grants.sql), which also let the admin login switch to it.

    # --- migrations, all of them, every time --------------------------------
    # Sorted by filename, which is why a tenth migration must be named 010_ and
    # not 10_ — exactly the rule docker/migrate/apply-migrations.sh states.
    $migrations = Get-ChildItem -Path (Join-Path $dbDir 'migrations') -Filter '*.sql' | Sort-Object Name
    Write-Host "`nApplying $($migrations.Count) migration(s)" -ForegroundColor Yellow
    foreach ($m in $migrations) {
        Write-Host "  $($m.Name)"
        if ((Invoke-Psql @('-q', '-f', "/sql/migrations/$($m.Name)")) -ne 0) {
            throw "Migration $($m.Name) failed — the database error is above. Nothing after it was applied."
        }
    }

    # Companies are not loaded here: a super admin onboards each one in the
    # portal (Companies -> Onboard company), with its client admin.

    $bhiTables = docker run --rm -e "PGPASSWORD=$pgPassword" postgres:16-alpine `
        psql $conn -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='bhi'"
    if ("$bhiTables".Trim() -ne '22') {
        throw "Expected the 22 tables in schema bhi, found '$bhiTables'. A migration did not apply."
    }
    $tables = docker run --rm -e "PGPASSWORD=$pgPassword" postgres:16-alpine `
        psql $conn -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='bhi'"
    $companies = docker run --rm -e "PGPASSWORD=$pgPassword" postgres:16-alpine `
        psql $conn -q -tA -c "SELECT set_config('bhi.all', 'on', false); SELECT string_agg(company_number, ', ' ORDER BY company_number) FROM bhi.company WHERE active"
    Write-Host "`nDone. $($tables.Trim()) tables in public." -ForegroundColor Green
    Write-Host "Active companies: $($companies.Trim())" -ForegroundColor Green
}
finally {
    if ($KeepFirewallRule) {
        Write-Host "`nLeaving firewall rule '$ruleName' in place (-KeepFirewallRule)." -ForegroundColor Yellow
        Write-Host "Remove it when you are finished:"
        Write-Host "  az postgres flexible-server firewall-rule delete --name $PgServer --resource-group $ResourceGroup --rule-name $ruleName --yes"
    } else {
        Write-Host "`nRemoving the firewall rule" -ForegroundColor Yellow
        az postgres flexible-server firewall-rule delete `
            --name $PgServer --resource-group $ResourceGroup `
            --rule-name $ruleName --yes --output none 2>$null
    }
}

Write-Host "`nNext: .\deploy\azure\04-create-app.ps1"
