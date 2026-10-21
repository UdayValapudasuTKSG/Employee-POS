# =============================================================================
# Phase 4 — the App Service plan, the web app, its settings and its sidecars
# =============================================================================
#
#   .\deploy\azure\04-create-app.ps1
#   .\deploy\azure\04-create-app.ps1 -Tag v2      # roll to a different image tag
#
# Safe to re-run. Re-running after 02-push-images.ps1 is how you deploy a new
# build: it repoints all three containers at the new tag and restarts the app.
#
# THE SHAPE THIS CREATES
#
#   Internet ──https──▶ App Service front end   (terminates TLS, always there)
#                        │
#                        ▼   one app, three containers, one network namespace
#                        ├── web  :80    MAIN — the only one reachable from outside
#                        ├── api  :3001  sidecar, reached at 127.0.0.1:3001
#                        └── sms  :2527  sidecar, reached at 127.0.0.1:2527
#                                          │
#                                          ▼ Azure Database for PostgreSQL
#
# Sidecars share the main container's network namespace, so the compose stack's
# unpublished container network becomes plain loopback and nothing else changes.
# Only the main container receives external traffic — the API keeps having no
# public port, which is the property the whole design rests on.
# =============================================================================

param(
    [string]$Tag
)

$ErrorActionPreference = 'Stop'
if ($Tag) { $ImageTag = $Tag }
. "$PSScriptRoot\settings.ps1"

# --- read the backend env file (artifacts/api-server/.env) ------------------
if (-not (Test-Path $EnvFile)) { throw "$EnvFile not found. Copy artifacts/api-server/.env.example to it first." }

$secrets = @{}
foreach ($line in Get-Content $EnvFile) {
    if ($line -match '^\s*#') { continue }
    if ($line -match '^\s*$') { continue }
    if ($line -match '^([A-Z0-9_]+)=(.*)$') {
        # Verbatim, including any spaces and '&'. These are pushed through a
        # JSON file rather than the command line precisely so that values like
        # "30/31 Regent & Hincks Sts" survive intact.
        $secrets[$Matches[1]] = $Matches[2]
    }
}

$stillPlaceholder = $secrets.GetEnumerator() | Where-Object { $_.Value -like '*CHANGE_ME*' }
if ($stillPlaceholder) {
    throw "These are still CHANGE_ME in ${EnvFile}: $(($stillPlaceholder | ForEach-Object { $_.Key }) -join ', ')"
}

$identity = az identity show --name $IdentityName --resource-group $ResourceGroup --output json | ConvertFrom-Json
if (-not $identity) { throw "Managed identity $IdentityName not found — run 01-provision-infra.ps1 first." }

# --- 1. App Service plan -----------------------------------------------------
Write-Host "`n[1/6] App Service plan $PlanName ($PlanSku, Linux)" -ForegroundColor Yellow
az appservice plan create `
    --name $PlanName --resource-group $ResourceGroup `
    --location $Location --sku $PlanSku --is-linux `
    --output none
if (-not $?) { throw "Failed to create the App Service plan" }

# --- 2. the web app, sidecar-enabled ----------------------------------------
# --sitecontainers-app is not a detail that can be added later without pain: it
# sets LinuxFxVersion=sitecontainers, and an app created without it is a
# classic single-container app configured through DOCKER_REGISTRY_SERVER_* and
# WEBSITES_PORT app settings, none of which apply here.
Write-Host "`n[2/6] Web app $AppName" -ForegroundColor Yellow
$exists = az webapp show --name $AppName --resource-group $ResourceGroup --output none 2>$null; $exists = $?
if ($exists) {
    Write-Host "  already exists, reconfiguring"
} else {
    az webapp create `
        --name $AppName --resource-group $ResourceGroup --plan $PlanName `
        --sitecontainers-app `
        --output none
    if (-not $?) { throw "Failed to create the web app. If the name is taken, change `$AppName in settings.ps1 — it is globally unique." }
}

az webapp identity assign `
    --name $AppName --resource-group $ResourceGroup `
    --identities $identity.id --output none
if (-not $?) { throw "Failed to attach the managed identity" }

# --- 3. app settings ---------------------------------------------------------
# All containers in a Linux app share these, which is what lets the API and the
# SMS gateway agree on the shared token without it being written twice.
Write-Host "`n[3/6] Application settings" -ForegroundColor Yellow

# The password is URL-encoded here and ONLY here. Azure requires a password with
# punctuation in it, and an unencoded '@' or '/' inside a connection string ends
# the userinfo section early — which surfaces as "getaddrinfo ENOTFOUND" naming
# a host that is a fragment of your password.
#
# One login: the server admin. The API switches every connection to the
# restricted role bhi_app (created by the migrations), so it cannot delete member
# records or rewrite the audit log (Principle III) and row-level security applies.
if (-not $secrets['PG_ADMIN_PASSWORD']) { throw "PG_ADMIN_PASSWORD is not set in $EnvFile" }
$adminPasswordEncoded = [uri]::EscapeDataString($secrets['PG_ADMIN_PASSWORD'])
$databaseUrl = "postgresql://$PgAdminUser`:$adminPasswordEncoded@$PgFqdn`:5432/$PgDatabase`?sslmode=require"

# PowerShell 5.1 cannot use `if` as an expression inside a hashtable literal.
$logLevel = $secrets['LOG_LEVEL']
if (-not $logLevel) { $logLevel = 'info' }

$settings = [ordered]@{
    # --- database ------------------------------------------------------------
    # sslmode=require is not optional: a Flexible Server refuses plaintext
    # connections. node-postgres verifies the certificate against Node's bundled
    # roots, which already include the CA Azure uses, so no certificate file is
    # needed and none should be added.
    DATABASE_URL     = $databaseUrl

    # --- the API sidecar -----------------------------------------------------
    PORT             = "$ApiPort"
    # All interfaces within the app's own network namespace. Nothing outside the
    # app can reach this port — only the main container is routed to — so this
    # is the same isolation compose gets from an unpublished network.
    HOST             = '0.0.0.0'
    NODE_ENV         = 'production'

    # One proxy between the client and the API: the nginx in the main container.
    # nginx is what talks to the API, and it is told the client address by
    # substitution 9 in docker/nginx/render-config.sh. The App Service front end
    # is upstream of nginx, not of the API, so it is not a second hop here.
    TRUST_PROXY      = '1'

    # No demo companies, no demo members, no published demo password. Instead
    # the API bootstraps one platform administrator from ADMIN_EMAIL /
    # ADMIN_PASSWORD, once, on a database with no admin rows.
    DEMO_SEED        = 'false'
    # Real delivery. `true` would return the verification code in the HTTP
    # response instead of sending it — correct for the RBAC suite, catastrophic
    # here, since anyone could then read any member's code.
    OTP_DEV_MODE     = 'false'
    LOG_LEVEL        = $logLevel
    SESSION_SECRET   = $secrets['SESSION_SECRET']
    ADMIN_EMAIL      = $secrets['ADMIN_EMAIL']
    ADMIN_PASSWORD   = $secrets['ADMIN_PASSWORD']

    # --- the nginx main container -------------------------------------------
    # Loopback, because the API is a sidecar in the same network namespace.
    API_UPSTREAM     = "127.0.0.1:$ApiPort"
    SERVER_NAME      = $AppHostname

    # Substitution 7. There is no mail sink here — codes are really sent — and
    # nginx resolves proxy_pass host names at parse time, so leaving the inbox
    # in would stop nginx starting rather than merely 404.
    INBOX            = 'off'

    # Substitutions 8 and 9, and the reason the rate limits below mean anything.
    #
    # App Service always puts its own reverse proxy in front of the container.
    # Without this, $binary_remote_addr is that proxy for every request on
    # earth, so bhi_adminlogin stops being "5 login attempts per minute per
    # attacker" and becomes "5 per minute shared by the entire internet" — which
    # locks out real administrators without slowing an attacker down. The audit
    # trail degrades the same way, recording the proxy as the actor's source
    # address for every action.
    #
    # 169.254.0.0/16 is the link-local range the App Service front end talks to
    # the container from. Widening it further would let a client choose its own
    # rate-limit bucket and its own audit identity.
    REAL_IP_FROM     = '169.254.0.0/16'
    # NOT X-Forwarded-For: App Service writes that one as `ip:port`, which
    # nginx's realip module cannot parse — it silently keeps the proxy address,
    # which looks exactly like this setting being absent.
    REAL_IP_HEADER   = 'X-Client-IP'

    # The production numbers from deploy/nginx/bhi-portal-limits.conf, restated
    # so they can be raised without a rebuild.
    RATE_LOOKUP      = '10r/m'
    RATE_ADMIN_LOGIN = '5r/m'
    RATE_API         = '120r/m'

    # --- email ---------------------------------------------------------------
    SMTP_HOST        = $secrets['SMTP_HOST']
    SMTP_PORT        = $secrets['SMTP_PORT']
    SMTP_USER        = $secrets['SMTP_USER']
    SMTP_PASS        = $secrets['SMTP_PASS']
    SMTP_FROM        = $secrets['SMTP_FROM']

    # --- SMS -----------------------------------------------------------------
    # The API posts to the gateway over loopback and cares only about the status
    # code; the gateway normalises to E.164 and calls Twilio.
    SMS_WEBHOOK_URL      = "http://127.0.0.1:$SmsPort/sms"
    # The same secret under both names: the API sends SMS_WEBHOOK_TOKEN, the
    # gateway checks SMS_GATEWAY_TOKEN. A mismatch is a 401 on every send.
    SMS_WEBHOOK_TOKEN    = $secrets['SMS_WEBHOOK_TOKEN']
    SMS_GATEWAY_TOKEN    = $secrets['SMS_WEBHOOK_TOKEN']
    SMS_GATEWAY_PORT     = "$SmsPort"
    SMS_GATEWAY_BIND_HOST = '0.0.0.0'
    SMS_PROVIDER         = $secrets['SMS_PROVIDER']
    SMS_DEFAULT_COUNTRY  = $secrets['SMS_DEFAULT_COUNTRY']
    SMS_ALLOWED_COUNTRY  = $secrets['SMS_ALLOWED_COUNTRY']
    # Would write the verification code itself into the log stream.
    SMS_GATEWAY_LOG_BODY = 'false'
    TWILIO_ACCOUNT_SID   = $secrets['TWILIO_ACCOUNT_SID']
    TWILIO_AUTH_TOKEN    = $secrets['TWILIO_AUTH_TOKEN']
    TWILIO_FROM          = $secrets['TWILIO_FROM']

    # --- the card ------------------------------------------------------------
    ISSUER_NAME           = $secrets['ISSUER_NAME']
    ISSUER_ADDRESS        = $secrets['ISSUER_ADDRESS']
    ISSUER_PHONE          = $secrets['ISSUER_PHONE']
    ISSUER_SIGNATORY_NAME = $secrets['ISSUER_SIGNATORY_NAME']
    ISSUER_SIGNATORY_TITLE = $secrets['ISSUER_SIGNATORY_TITLE']
    CARD_PROPERTY_NOTICE  = $secrets['CARD_PROPERTY_NOTICE']

    # --- platform ------------------------------------------------------------
    # Without this the pull is anonymous and a private registry returns 401,
    # which App Service reports as a generic "image cannot be pulled".
    WEBSITES_ENABLE_APP_SERVICE_STORAGE = 'false'
}

# Optional values: present only when set, because an empty ISSUER_PLAN_TITLE is
# not the same as an unset one — lib/issuer.ts omits what is absent and would
# otherwise render an empty line on the card.
foreach ($optional in @('TWILIO_MESSAGING_SERVICE_SID', 'ISSUER_PLAN_TITLE', 'CARD_BACK_NOTICE', 'CARD_EMAIL_OVERRIDE',
                        'DISCOUNT_PERCENT', 'DISCOUNT_MONTHLY_CAP_GYD', 'DISCOUNT_COUPON_TTL_MINUTES',
                        'POS_API_KEY_KFC', 'POS_API_KEY_PIZZA_HUT')) {
    if ($secrets[$optional]) { $settings[$optional] = $secrets[$optional] }
}

# Pushed as a JSON file, not as --settings KEY=VALUE pairs. Several of these
# values contain spaces, '&' and '/' (the issuer address, the property notice,
# the connection string), and every shell-quoting scheme for them is one
# copy-paste away from being silently wrong.
$settingsJson = @()
foreach ($k in $settings.Keys) { $settingsJson += @{ name = $k; value = "$($settings[$k])"; slotSetting = $false } }
$settingsFile = Join-Path ([System.IO.Path]::GetTempPath()) "bhi-appsettings-$([guid]::NewGuid()).json"
try {
    $settingsJson | ConvertTo-Json -Depth 3 | Set-Content -Path $settingsFile -Encoding utf8
    az webapp config appsettings set `
        --name $AppName --resource-group $ResourceGroup `
        --settings "@$settingsFile" --output none
    if (-not $?) { throw "Failed to apply app settings" }
    Write-Host "  $($settings.Count) settings applied"
} finally {
    # It held the database password and the Twilio token.
    Remove-Item $settingsFile -Force -ErrorAction SilentlyContinue
}

# --- 4. the containers -------------------------------------------------------
Write-Host "`n[4/6] Containers at tag $ImageTag" -ForegroundColor Yellow

# All three in one spec file rather than three `create` calls. The spec is the
# only form that carries authType explicitly, and applying the set atomically
# means there is no moment where the app is half pointed at the new tag.
#
# authType UserAssigned + userManagedIdentityClientId is what makes the pull
# work against a registry with the admin user disabled. Without it the pull is
# anonymous and ACR answers 401, which App Service surfaces only as a generic
# "image cannot be pulled".
function New-ContainerSpec($Name, $Image, $Port, $IsMain) {
    return @{
        name       = $Name
        properties = @{
            image                       = "$AcrLoginServer/$Image`:$ImageTag"
            targetPort                  = "$Port"
            isMain                      = $IsMain
            authType                    = 'UserAssigned'
            userManagedIdentityClientId = $identity.clientId
        }
    }
}

$containers = @(
    (New-ContainerSpec $MainContainer 'bhi-web' $WebPort $true),
    (New-ContainerSpec $ApiContainer  'bhi-api' $ApiPort $false),
    (New-ContainerSpec $SmsContainer  'bhi-sms' $SmsPort $false)
)

$specFile = Join-Path ([System.IO.Path]::GetTempPath()) "bhi-sitecontainers-$([guid]::NewGuid()).json"
try {
    $containers | ConvertTo-Json -Depth 5 | Set-Content -Path $specFile -Encoding utf8
    az webapp sitecontainers create `
        --name $AppName --resource-group $ResourceGroup `
        --sitecontainers-spec-file $specFile `
        --output none
    if (-not $?) { throw "Failed to configure the containers" }
} finally {
    Remove-Item $specFile -Force -ErrorAction SilentlyContinue
}

foreach ($c in $containers) {
    Write-Host "  $($c.name) -> $($c.properties.image) on :$($c.properties.targetPort) (main: $($c.properties.isMain))"
}

# --- 5. hardening ------------------------------------------------------------
Write-Host "`n[5/6] Transport and health" -ForegroundColor Yellow

# Admin session tokens travel in an Authorization header. Without this, the
# plain-HTTP endpoint stays live and any redirect to it is readable in transit.
az webapp update --name $AppName --resource-group $ResourceGroup --https-only true --output none

az webapp config set `
    --name $AppName --resource-group $ResourceGroup `
    --min-tls-version 1.2 `
    --always-on true `
    --ftps-state Disabled `
    --health-check-path '/api/healthz' `
    --output none
if (-not $?) { throw "Failed to apply the transport settings" }

# healthz, NOT readyz — the same distinction compose.yaml draws. readyz returns
# 503 when the database is unreachable, so using it here would make App Service
# recycle the instance for a database fault and destroy the diagnostic pair
# (healthz ok + readyz 503 = the database, not the app).

az webapp log config `
    --name $AppName --resource-group $ResourceGroup `
    --docker-container-logging filesystem --output none 2>$null

# --- 6. let the app reach the database --------------------------------------
# Without VNet integration the app's outbound address is not fixed, so this is
# the Azure-services rule. It admits only traffic originating inside Azure, and
# the password is still required. Tightening it further means putting the app on
# a VNet and giving the database a private endpoint — the right next step once
# this is serving real members.
Write-Host "`n[6/6] Database firewall: allow Azure services" -ForegroundColor Yellow
az postgres flexible-server firewall-rule create `
    --name $PgServer --resource-group $ResourceGroup `
    --rule-name 'allow-azure-services' `
    --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0 `
    --output none 2>$null

Write-Host "`nRestarting" -ForegroundColor Yellow
az webapp restart --name $AppName --resource-group $ResourceGroup --output none

Write-Host "`nDeployed." -ForegroundColor Green
Write-Host "  https://$AppHostname"
Write-Host "  https://$AppHostname/admin/login"
Write-Host "`nFirst start pulls three images and can take a couple of minutes. Watch it:"
Write-Host "  az webapp log tail --name $AppName --resource-group $ResourceGroup"
Write-Host "`nThen run the checks in docs/DEPLOY-AZURE-APPSERVICE.md phase 5."
