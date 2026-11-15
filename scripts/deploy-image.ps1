# FeedZero — build, verify, and publish the self-host image.
#
# The loop this implements (see deploy/tnnlabs/README.md):
#
#   git merge main                 # pull upstream changes into the docker branch
#   pwsh ./scripts/deploy-image.ps1
#   # on the server:
#   docker compose -f deploy/tnnlabs/docker-compose.yml pull && ... up -d
#
# Nothing is pushed until the freshly built image has answered /api/health with
# the exact version and commit it was built from, served the SPA, and round-
# tripped a vault through the mounted volume. Those are the three failures a
# build can hide: a stale APP_VERSION, a broken static build, and a DATA_DIR
# that points somewhere the container cannot write (issues #212/#224).
#
# Usage:
#   pwsh ./scripts/deploy-image.ps1               # gates + build + local test + push
#   pwsh ./scripts/deploy-image.ps1 -NoPush       # everything except the push
#   pwsh ./scripts/deploy-image.ps1 -SkipTests    # skip vitest/tsc, still test the image
#   pwsh ./scripts/deploy-image.ps1 -SkipLocalTest -NoPush   # fastest build loop
#   pwsh ./scripts/deploy-image.ps1 -KeepContainer           # leave the test container up
#
# Credentials come from .env.deploy (gitignored; copy .env.deploy.example).
# The image path lives there too, and must name the registry explicitly so a
# misconfiguration cannot push to Docker Hub.

[CmdletBinding()]
param(
    # Build and test, but do not log in or push.
    [switch] $NoPush,
    # Skip `npm test` and both tsc projects. The image-level test still runs.
    [switch] $SkipTests,
    # Skip running the built image. Only useful for a fast syntax/build loop.
    [switch] $SkipLocalTest,
    # Leave the test container running for inspection (prints the docker rm).
    [switch] $KeepContainer,
    # Target platform of the server that pulls the image.
    [string] $Platform = 'linux/amd64',
    # Override IMAGE from .env.deploy.
    [string] $Image = '',
    # Host port used by the throwaway test container.
    [int] $TestPort = 3100,
    [string] $EnvFile = '.env.deploy'
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
Set-Location $RepoRoot

function Write-Step ([string] $Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Ok ([string] $Message) { Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn2 ([string] $Message) { Write-Host "    $Message" -ForegroundColor Yellow }
function Write-Detail ([string] $Message) { Write-Host "    $Message" -ForegroundColor DarkGray }

# Runs a native command and turns a non-zero exit into a terminating error, so
# a failed `docker push` can never be followed by a "done" message.
function Invoke-Native {
    param(
        [Parameter(Mandatory)] [scriptblock] $Command,
        [Parameter(Mandatory)] [string] $Description
    )

    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed (exit code $LASTEXITCODE)."
    }
}

function Test-Image {
    param(
        [Parameter(Mandatory)] [string] $Tag,
        [Parameter(Mandatory)] [string] $Version,
        [Parameter(Mandatory)] [string] $ShortSha,
        [Parameter(Mandatory)] [int] $Port,
        [switch] $Keep
    )

    $container = "feedzero-deploy-test-$PID"
    $dataDir = Join-Path ([System.IO.Path]::GetTempPath()) ("feedzero-deploy-test-" + [guid]::NewGuid().ToString('N'))
    $baseUrl = "http://127.0.0.1:$Port"
    # 64 lowercase hex characters — the vault-id shape the handler accepts.
    $vaultId = 'a' * 64

    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    & docker rm -f $container 2>$null | Out-Null

    try {
        Invoke-Native -Description 'docker run' -Command {
            & docker run -d --name $container `
                -p "127.0.0.1:${Port}:3000" `
                -e 'DATA_DIR=/data' `
                -e 'SYNC_STORAGE=filesystem' `
                -e 'SELF_HOSTED=1' `
                -v "${dataDir}:/data" `
                $Tag
        } | Out-Null

        $deadline = (Get-Date).AddSeconds(90)
        $health = $null
        while ((Get-Date) -lt $deadline) {
            $running = & docker inspect --format '{{.State.Running}}' $container 2>$null
            if ($running -eq 'false') { break }

            try {
                $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 5
                break
            }
            catch {
                Start-Sleep -Seconds 2
            }
        }

        if (-not $health) {
            Write-Detail '--- container logs ---'
            & docker logs $container 2>&1 | Select-Object -Last 40 | ForEach-Object { Write-Detail "$_" }
            throw "Container never answered /api/health on port $Port."
        }

        if (-not $health.ok) {
            throw "/api/health reported ok=$($health.ok) (maintenance mode?)."
        }
        if ($health.version -ne $Version) {
            throw "health reports version '$($health.version)', expected '$Version' — APP_VERSION was not baked into the image."
        }
        if ($health.commit -ne $ShortSha) {
            throw "health reports commit '$($health.commit)', expected '$ShortSha' — GIT_COMMIT_SHA was not baked into the image."
        }
        Write-Ok "health: version $($health.version), commit $($health.commit)"

        $index = Invoke-WebRequest -Uri "$baseUrl/" -TimeoutSec 10 -UseBasicParsing
        if ($index.StatusCode -ne 200 -or $index.Content -notmatch '<title>FeedZero</title>') {
            throw 'The SPA index did not render at / (static build missing from the image?).'
        }
        Write-Ok 'SPA served at /'

        $payload = @{
            vaultId = $vaultId
            vault   = @{ ciphertext = 'deploy-probe' }
        } | ConvertTo-Json -Depth 5
        $put = Invoke-RestMethod -Method Put -Uri "$baseUrl/api/sync" -ContentType 'application/json' -Body $payload -TimeoutSec 10
        if (-not $put.ok) { throw 'Vault PUT failed.' }

        $get = Invoke-RestMethod -Method Get -Uri "$baseUrl/api/sync?vaultId=$vaultId" -TimeoutSec 10
        if ($get.vault.ciphertext -ne 'deploy-probe') {
            throw 'Vault GET did not return what was stored.'
        }
        if (-not (Test-Path (Join-Path $dataDir "vaults/$vaultId.json"))) {
            throw "Vault was not persisted to the mounted volume ($dataDir/vaults) — check DATA_DIR and the volume owner."
        }
        Write-Ok 'Vault PUT/GET round-trip persisted to the mounted volume'
    }
    finally {
        if ($Keep) {
            Write-Warn2 "Left $container running on port $Port (data: $dataDir)."
            Write-Warn2 "Remove it with: docker rm -f $container"
        }
        else {
            & docker rm -f $container 2>$null | Out-Null
            Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
        }
    }
}

# ── Preconditions ──────────────────────────────────────────────────────────
Write-Step 'Checking Docker'
& docker version --format '{{.Server.Version}}' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Docker is not running, or `docker` is not on PATH.'
}

$pkg = Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
$fullSha = (git rev-parse HEAD).Trim()
$shortSha = (git rev-parse --short=7 HEAD).Trim()

$dirty = @(git status --porcelain)
if ($dirty.Count -gt 0) {
    Write-Warn2 "Working tree has uncommitted changes — the image will not match $shortSha exactly."
    $dirty | Select-Object -First 5 | ForEach-Object { Write-Detail "$_" }
}

# ── Resolve the plan ───────────────────────────────────────────────────────
Write-Step "Resolving image plan (version $version, commit $shortSha)"

$planArgs = @(
    'scripts/lib/deploy-image.mjs',
    '--version', $version,
    '--sha', $fullSha,
    '--deploy-env', $EnvFile
)
if ($Image) { $planArgs += @('--image', $Image) }
if ($NoPush) { $planArgs += '--no-auth' }

$stderrFile = [System.IO.Path]::GetTempFileName()
try {
    $planJson = & node @planArgs 2> $stderrFile
    $planError = Get-Content $stderrFile -Raw
}
finally {
    Remove-Item $stderrFile -Force -ErrorAction SilentlyContinue
}
if ($LASTEXITCODE -ne 0) {
    throw "Cannot resolve the image plan: $(("$planError").Trim())"
}

$plan = $planJson | ConvertFrom-Json
Write-Ok "image: $($plan.image)"
foreach ($tag in $plan.tags) { Write-Detail $tag }

# ── Local gates ────────────────────────────────────────────────────────────
if ($SkipTests) {
    Write-Warn2 'Skipping npm test and tsc (-SkipTests).'
}
else {
    Write-Step 'Running unit tests and type checks'
    Invoke-Native -Description 'npm test' -Command { npm test }
    Invoke-Native -Description 'tsc (app)' -Command { npx tsc --noEmit }
    Invoke-Native -Description 'tsc (scripts)' -Command { npx tsc --noEmit -p tsconfig.scripts.json }
    Write-Ok 'Unit tests, type checks and deployment contracts pass'
}

# ── Build ──────────────────────────────────────────────────────────────────
Write-Step "Building the $Platform image"
$buildArgs = @(
    'build',
    '--platform', $Platform,
    '--build-arg', "APP_VERSION=$version",
    '--build-arg', "GIT_COMMIT_SHA=$fullSha"
)
foreach ($tag in $plan.tags) { $buildArgs += @('-t', $tag) }
$buildArgs += '.'

Invoke-Native -Description 'docker build' -Command { & docker @buildArgs }
Write-Ok "Built $($plan.tags[0])"

# ── Verify the image ───────────────────────────────────────────────────────
if ($SkipLocalTest) {
    Write-Warn2 'Skipping the container test (-SkipLocalTest).'
}
else {
    Write-Step "Testing the image on port $TestPort"
    Test-Image -Tag $plan.tags[0] -Version $version -ShortSha $shortSha -Port $TestPort -Keep:$KeepContainer
}

# ── Publish ────────────────────────────────────────────────────────────────
if ($NoPush) {
    Write-Step 'Local build complete (-NoPush) — nothing was pushed'
    return
}

Write-Step "Pushing to $($plan.registry)"
$plan.password | & docker login $plan.registry --username $plan.username --password-stdin
if ($LASTEXITCODE -ne 0) {
    throw 'docker login failed — check REGISTRY_USERNAME and REGISTRY_PASSWORD in .env.deploy.'
}

foreach ($tag in $plan.tags) {
    Invoke-Native -Description "docker push $tag" -Command { & docker push $tag }
    Write-Ok "pushed $tag"
}

Write-Step 'Verifying what the registry now serves'
$inspect = & docker buildx imagetools inspect "$($plan.image):latest"
if ($LASTEXITCODE -ne 0) {
    throw "The registry has no $($plan.image):latest after the push."
}
$digestMatch = [regex]::Match(("`n" + ($inspect -join "`n")), 'Digest:\s+(sha256:[0-9a-f]+)')
if ($digestMatch.Success) {
    Write-Ok "latest -> $($digestMatch.Groups[1].Value)"
}

Write-Host ''
Write-Host 'Published. On the server:' -ForegroundColor Cyan
Write-Host '  docker compose -f deploy/tnnlabs/docker-compose.yml pull'
Write-Host '  docker compose -f deploy/tnnlabs/docker-compose.yml up -d'
Write-Host "  curl -s https://feedzero.tnnlabs.space/api/health   # expect commit $shortSha" -ForegroundColor DarkGray
