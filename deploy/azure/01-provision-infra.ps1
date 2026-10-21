# =============================================================================
# Phase 1 — resource group, managed identity, container registry, database
# =============================================================================
#
#   .\deploy\azure\01-provision-infra.ps1
#
# Creates everything the app needs to exist before it can start. Safe to re-run:
# every step checks for the resource first, so a failure part-way through is
# fixed by running the script again rather than by cleaning up by hand.
#
# The web app itself is NOT created here. It is created in phase 4, after the
# images exist and the database has a schema — an App Service that starts
# against an empty database logs a stream of failures that look like bugs.
#
# Takes 10-15 minutes, almost all of it the PostgreSQL server.
# =============================================================================

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\settings.ps1"

function Test-AzResource($Command) {
    # az returns a non-zero exit code AND writes to stderr for "not found",
    # which is not an error here — it is the question being answered.
    $ErrorActionPreference = 'SilentlyContinue'
    $null = Invoke-Expression "$Command 2>`$null"
    $found = $?
    $ErrorActionPreference = 'Stop'
    return $found
}

# --- 0. preflight ------------------------------------------------------------
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI not found. Install it with: winget install -e --id Microsoft.AzureCLI  (then open a new terminal)"
}

$account = az account show --output json 2>$null | ConvertFrom-Json
if (-not $account) { throw "Not signed in. Run: az login" }
Write-Host "Subscription: $($account.name) [$($account.id)]" -ForegroundColor Cyan

# The Postgres admin password. Read from the backend env file so it is written down in
# exactly one place — the same file phase 4 pushes into App Service settings.
if (-not (Test-Path $EnvFile)) {
    throw "$EnvFile not found — copy artifacts/api-server/.env.example to it and fill in the CHANGE_ME values first."
}
$pgPassword = (Select-String -Path $EnvFile -Pattern '^PG_ADMIN_PASSWORD=(.+)$').Matches.Groups[1].Value
if (-not $pgPassword -or $pgPassword -like '*CHANGE_ME*') {
    throw "PG_ADMIN_PASSWORD in $EnvFile is unset or still CHANGE_ME."
}

# --- 1. resource group -------------------------------------------------------
Write-Host "`n[1/4] Resource group $ResourceGroup" -ForegroundColor Yellow
az group create --name $ResourceGroup --location $Location --output none
if (-not $?) { throw "Failed to create resource group" }

# --- 2. managed identity -----------------------------------------------------
# The app pulls its three images with this identity instead of a registry
# username and password. No credential is stored in an app setting, and nothing
# has to be rotated.
Write-Host "`n[2/4] Managed identity $IdentityName" -ForegroundColor Yellow
az identity create --name $IdentityName --resource-group $ResourceGroup --location $Location --output none
$identity = az identity show --name $IdentityName --resource-group $ResourceGroup --output json | ConvertFrom-Json
Write-Host "  clientId: $($identity.clientId)"

# --- 3. container registry ---------------------------------------------------
Write-Host "`n[3/4] Container registry $Acr" -ForegroundColor Yellow
az acr create --name $Acr --resource-group $ResourceGroup --sku Basic --location $Location --output none
if (-not $?) { throw "Failed to create ACR. If the error says the name is taken, change `$Acr in settings.ps1 — registry names are globally unique." }

# Admin user stays DISABLED (the default). It is a shared password with push
# rights to every repository in the registry; the managed identity above and
# your own `az acr login` both work without it.
$acrId = az acr show --name $Acr --resource-group $ResourceGroup --query id --output tsv

Write-Host "  granting AcrPull to the managed identity"
az role assignment create `
    --assignee-object-id $identity.principalId `
    --assignee-principal-type ServicePrincipal `
    --role AcrPull `
    --scope $acrId `
    --output none 2>$null
# Re-running is expected to report the assignment already exists; that is fine.

# --- 4. PostgreSQL flexible server ------------------------------------------
Write-Host "`n[4/4] PostgreSQL flexible server $PgServer (this is the slow one)" -ForegroundColor Yellow

if (Test-AzResource "az postgres flexible-server show --name $PgServer --resource-group $ResourceGroup --output none") {
    Write-Host "  already exists, skipping create"
} else {
    # --public-access None: no firewall rule at all is opened here. Phase 3 opens
    # one for your own address to load the schema, and phase 4 opens the Azure
    # services rule the app needs. Creating with an open rule would leave the
    # database reachable during the window before either is set deliberately.
    az postgres flexible-server create `
        --name $PgServer `
        --resource-group $ResourceGroup `
        --location $Location `
        --admin-user $PgAdminUser `
        --admin-password $pgPassword `
        --tier $PgTier `
        --sku-name $PgSku `
        --version $PgVersion `
        --storage-size $PgStorageGb `
        --database-name $PgDatabase `
        --public-access None `
        --yes `
        --output none
    if (-not $?) { throw "Failed to create the PostgreSQL server" }
}

Write-Host "`nDone." -ForegroundColor Green
Write-Host "  registry  $AcrLoginServer"
Write-Host "  database  $PgFqdn/$PgDatabase"
Write-Host "`nNext: .\deploy\azure\02-push-images.ps1"
