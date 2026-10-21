# =============================================================================
# Azure App Service deployment — names and sizes
# =============================================================================
#
# Dot-sourced by every 0N-*.ps1 script in this folder. Edit this file once; the
# scripts read it and never prompt.
#
# NOTHING SECRET LIVES HERE. This file is committed. Passwords, the session
# secret and the Twilio token go in the backend env file, artifacts/api-server/.env,
# which is gitignored — see artifacts/api-server/.env.example. Set ENV_FILE to
# point the scripts at a different file (a production copy, say).
#
# Two of these names are GLOBALLY unique across all of Azure, not just your
# subscription: $Acr and $AppName. If provisioning fails with "already in use",
# that is which one, and a suffix is the fix.
# =============================================================================

# --- where ------------------------------------------------------------------
# Everything in one region. Resources in different regions pay for the traffic
# between them and add latency to every database query the API makes.
$Location       = 'eastus'
$ResourceGroup  = 'bhi-portal-rg'

# --- names ------------------------------------------------------------------
# ACR: globally unique, LOWERCASE ALPHANUMERIC ONLY, 5-50 characters. No
# hyphens — the registry name becomes a DNS label and the API rejects them.
$Acr            = 'bhiportalacr'

# The web app. Globally unique; becomes https://<name>.azurewebsites.net.
$AppName        = 'bhi-portal'

$PlanName       = 'bhi-portal-plan'
$IdentityName   = 'bhi-portal-id'
$PgServer       = 'bhi-portal-db'
$PgDatabase     = 'bhi_portal'
$PgAdminUser    = 'bhiadmin'

# --- sizes ------------------------------------------------------------------
# B1 is 1 vCPU / 1.75 GB and holds all three containers, which are small: the
# API is a single esbuild bundle with no node_modules, the SMS gateway is one
# file of Node built-ins, and nginx serves static files. Move to B2 if bulk
# imports of large workbooks start being killed — that is the one operation
# that allocates in proportion to input size.
#
# Below B1 is not an option: Free and Shared tiers do not run custom containers.
$PlanSku        = 'B1'

# Burstable/B1ms is the smallest Flexible Server tier. 32 GB is the smallest
# disk; note that Azure lets you grow a disk but never shrink one.
$PgTier         = 'Burstable'
$PgSku          = 'Standard_B1ms'
$PgVersion      = '16'          # matches the version deploy/db/schema.sql was dumped from
$PgStorageGb    = 32

# --- container names inside the app -----------------------------------------
# `web` is the main container: it is the only one App Service sends external
# traffic to. The other two are reachable only from inside the app, over
# localhost, which is what makes this arrangement equivalent to the unpublished
# container network in compose.yaml.
$MainContainer  = 'web'
$ApiContainer   = 'api'
$SmsContainer   = 'sms'

$WebPort        = 80
$ApiPort        = 3001
$SmsPort        = 2527

# --- image tag --------------------------------------------------------------
# Overridden by 02-push-images.ps1 -Tag. A moving tag like `latest` makes "which
# build is running?" unanswerable, so the default is the short commit SHA.
if (-not $ImageTag) {
    $ImageTag = (git -C "$PSScriptRoot\..\.." rev-parse --short HEAD 2>$null)
    if (-not $ImageTag) { $ImageTag = 'v1' }
}

# --- derived (do not edit) ---------------------------------------------------
$AcrLoginServer = "$Acr.azurecr.io"
$RepoRoot       = (Resolve-Path "$PSScriptRoot\..\..").Path
$EnvFile        = if ($env:ENV_FILE) { (Resolve-Path $env:ENV_FILE).Path } else { Join-Path $RepoRoot 'artifacts\api-server\.env' }
$AppHostname    = "$AppName.azurewebsites.net"
$PgFqdn         = "$PgServer.postgres.database.azure.com"
