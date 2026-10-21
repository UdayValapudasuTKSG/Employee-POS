# =============================================================================
# Phase 2 — build the three images and push them to ACR
# =============================================================================
#
#   .\deploy\azure\02-push-images.ps1
#   .\deploy\azure\02-push-images.ps1 -Tag v2      # override the commit-SHA tag
#
# WHY THIS BUILDS LOCALLY INSTEAD OF WITH `az acr build`
#
# Both Dockerfiles open with `# syntax=docker/dockerfile:1.7` and use
# `RUN --mount=type=cache` for the pnpm store. That is BuildKit syntax. ACR
# Tasks — which is what `az acr build` runs — uses the classic Docker builder,
# which does not understand `--mount` and fails with a parse error. Running
# BuildKit there means bootstrapping buildx from source inside a multi-step task
# YAML, which is a lot of moving parts to maintain for a build that takes four
# minutes locally.
#
# Docker Desktop uses BuildKit by default, so the Dockerfiles build here exactly
# as they do for `docker compose build`. The tradeoff is that your machine does
# the pnpm install and the Vite build, and uploads the layers.
#
# If you later want builds off your machine, GitHub Actions is the natural home:
# docker/build-push-action uses BuildKit natively, so the Dockerfiles need no
# changes at all.
# =============================================================================

param(
    [string]$Tag,
    # Skip the build and push whatever is already tagged locally. Useful when a
    # push failed on a slow connection and you do not want to rebuild.
    [switch]$PushOnly
)

$ErrorActionPreference = 'Stop'
if ($Tag) { $ImageTag = $Tag }
. "$PSScriptRoot\settings.ps1"

# --- preflight ---------------------------------------------------------------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "docker not found. Install Docker Desktop, or move this build to GitHub Actions."
}
docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
if (-not $?) {
    throw "The Docker daemon is not responding. Start Docker Desktop and wait for the whale icon to stop animating, then re-run."
}

Write-Host "Signing in to $AcrLoginServer" -ForegroundColor Cyan
az acr login --name $Acr --output none
if (-not $?) { throw "az acr login failed. Run 'az login' first." }

# Each entry is one image: the Dockerfile stage it comes from and the repository
# it lands in. All three share the api.Dockerfile except the frontend, because
# `mail` is the only target that is deliberately absent from this deployment —
# it is a development sink that captures verification codes instead of sending
# them, and here they are really sent.
$images = @(
    @{ Name = 'bhi-web'; File = 'docker/web.Dockerfile'; Target = 'web' },
    @{ Name = 'bhi-api'; File = 'docker/api.Dockerfile'; Target = 'api' },
    @{ Name = 'bhi-sms'; File = 'docker/api.Dockerfile'; Target = 'sms' }
)

Push-Location $RepoRoot
try {
    foreach ($img in $images) {
        $ref = "$AcrLoginServer/$($img.Name):$ImageTag"

        if (-not $PushOnly) {
            Write-Host "`nBuilding $ref  (target: $($img.Target))" -ForegroundColor Yellow
            # --platform is not optional. App Service runs linux/amd64; on an ARM
            # machine the default build produces an arm64 image that pulls fine
            # and then fails to start with "exec format error", which reads like
            # a corrupt image rather than a wrong architecture.
            docker build `
                --platform linux/amd64 `
                --file $img.File `
                --target $img.Target `
                --tag $ref `
                .
            if ($LASTEXITCODE -ne 0) { throw "Build failed for $($img.Name)" }
        }

        Write-Host "Pushing $ref" -ForegroundColor Yellow
        docker push $ref
        if ($LASTEXITCODE -ne 0) { throw "Push failed for $($img.Name)" }
    }
} finally {
    Pop-Location
}

Write-Host "`nPushed at tag $ImageTag :" -ForegroundColor Green
foreach ($img in $images) { Write-Host "  $AcrLoginServer/$($img.Name):$ImageTag" }
Write-Host "`nNext: .\deploy\azure\03-migrate-db.ps1"
