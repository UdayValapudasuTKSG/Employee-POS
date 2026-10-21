# Local database setup for the BHI Health Card Portal (Windows / PowerShell).
#
# Creates two roles and the bhi_portal database, loads schema.sql into it when
# it is empty, and runs every migration in ./migrations. Safe to re-run.
#
#   powershell -ExecutionPolicy Bypass -File deploy\db\setup-local.ps1
#
# You will be prompted once for the PostgreSQL superuser (postgres) password —
# the one set when PostgreSQL was installed.
#
# The two roles (specs/002-per-company-schema/research.md R5):
#   bhi_user  the one login (DATABASE_URL). Owns the tables, runs migrations.
#   bhi_app   no login of its own. The API connects as bhi_user and switches
#             every connection to bhi_app: no DELETE, append-only activity log,
#             subject to row-level security.
# Only a superuser can create roles, which is why both are made here.

param(
  [string]$PsqlPath = "",
  [string]$SuperUser = "postgres",
  [string]$DbHost = "127.0.0.1",
  [int]$DbPort = 5432,
  [string]$AppUser = "bhi_user",
  [string]$AppPassword = "bhi_local_dev",
  [string]$ApiRole = "bhi_app",
  [string]$DbName = "bhi_portal"
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- locate psql ------------------------------------------------------------
if ($PsqlPath -eq "") {
  $onPath = Get-Command psql -ErrorAction SilentlyContinue
  if ($null -ne $onPath) {
    $PsqlPath = $onPath.Source
  } else {
    $candidates = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\psql.exe" -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending
    if ($candidates.Count -eq 0) {
      throw "psql.exe not found. Install PostgreSQL 14+ or pass -PsqlPath."
    }
    $PsqlPath = $candidates[0].FullName
  }
}
Write-Host "Using psql: $PsqlPath"

# --- superuser password -----------------------------------------------------
$secure = Read-Host "PostgreSQL password for '$SuperUser'" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

function Invoke-Psql {
  param([string]$Database, [string[]]$PsqlArgs)
  $base = @("-v", "ON_ERROR_STOP=1", "-h", $DbHost, "-p", "$DbPort", "-U", $SuperUser, "-d", $Database)
  & $PsqlPath ($base + $PsqlArgs)
  if ($LASTEXITCODE -ne 0) { throw "psql failed (exit $LASTEXITCODE)" }
}

# --- 1. role + database -----------------------------------------------------
Write-Host "`n[1/4] Creating roles '$AppUser' and '$ApiRole' and database '$DbName'..."
$bootstrap = @"
DO `$`$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$AppUser') THEN
    CREATE ROLE $AppUser LOGIN PASSWORD '$AppPassword';
  ELSE
    ALTER ROLE $AppUser LOGIN PASSWORD '$AppPassword';
  END IF;
  -- NOSUPERUSER NOBYPASSRLS is the whole point of this role: row-level security
  -- is what keeps one company's data away from another's.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$ApiRole') THEN
    CREATE ROLE $ApiRole NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  ELSE
    ALTER ROLE $ApiRole NOSUPERUSER NOBYPASSRLS;
  END IF;
END
`$`$;
-- The login may switch to the restricted role; the API does on every connection.
GRANT $ApiRole TO $AppUser;
SELECT 'CREATE DATABASE $DbName OWNER $AppUser'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$DbName')\gexec
"@
$bootstrapFile = Join-Path $env:TEMP "bhi-bootstrap.sql"
# Written BOM-less on purpose. `Set-Content -Encoding utf8` means UTF-8 *with* a
# BOM on Windows PowerShell 5.1 — there is no utf8NoBOM before PowerShell 6 —
# and psql does not strip a BOM from a -f file. The first statement then arrives
# as "<BOM>DO $$" and fails with: syntax error at or near "ï»¿DO". This overload
# behaves the same on 5.1 and 7, which matters because package.json's local:db
# invokes `powershell` (5.1), not `pwsh`.
[System.IO.File]::WriteAllText($bootstrapFile, $bootstrap, (New-Object System.Text.UTF8Encoding $false))
Invoke-Psql -Database "postgres" -PsqlArgs @("-f", $bootstrapFile)
Remove-Item $bootstrapFile -Force

# --- 2. connect privilege (needs superuser) ---------------------------------
# bhi_user owns the database, so it can create schema bhi itself.
Write-Host "`n[2/4] Granting bhi_app the right to connect..."
Invoke-Psql -Database $DbName -PsqlArgs @(
  "-c", "GRANT CONNECT ON DATABASE $DbName TO $ApiRole;"
)

# --- 3. schema --------------------------------------------------------------
$appUrl = "postgresql://${AppUser}:${AppPassword}@${DbHost}:${DbPort}/${DbName}"
# schema.sql is a pg_dump (no IF NOT EXISTS), so it is loaded into an empty
# database only; an existing one is brought up to date by the migrations.
$hasSchema = "$(& $PsqlPath -d $appUrl -tAc "SELECT to_regnamespace('bhi') IS NOT NULL")".Trim()
if ($hasSchema -eq "t") {
  Write-Host "`n[3/4] Schema already present - skipping schema.sql"
} else {
  Write-Host "`n[3/4] Loading schema.sql..."
  & $PsqlPath -v ON_ERROR_STOP=1 -d $appUrl -f (Join-Path $here "schema.sql")
  if ($LASTEXITCODE -ne 0) { throw "Loading schema.sql failed (exit $LASTEXITCODE)" }
}

# --- 4. migrations ----------------------------------------------------------
Write-Host "`n[4/4] Applying migrations..."
Get-ChildItem (Join-Path $here "migrations\*.sql") | Sort-Object Name | ForEach-Object {
  Write-Host "  - $($_.Name)"
  & $PsqlPath -v ON_ERROR_STOP=1 -d $appUrl -f $_.FullName
  if ($LASTEXITCODE -ne 0) { throw "Migration $($_.Name) failed (exit $LASTEXITCODE)" }
}

# --- report -----------------------------------------------------------------
& $PsqlPath -d $appUrl -c "\dt bhi.*"
$bhiTables = & $PsqlPath -d $appUrl -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'bhi'"
$env:PGPASSWORD = ""
if ("$bhiTables".Trim() -ne "21") {
  throw "Expected the 21 tables in schema bhi, found '$bhiTables'. A migration did not apply."
}

Write-Host "`nDatabase ready. To run the API on this machine, set in artifacts/api-server/.env:"
Write-Host "LOCAL_DATABASE_URL=postgresql://${AppUser}:${AppPassword}@${DbHost}:${DbPort}/${DbName}"
