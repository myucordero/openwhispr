# Personal pipeline, native-Windows side: pull the pushed branch, refresh
# dependencies/runtime only when their lockfiles changed, rebuild the local
# packaged app (dist\win-unpacked), and keep the Start Menu shortcut healthy.
#
#   powershell -ExecutionPolicy Bypass -File C:\dev\openwhispr\scripts\update-local-app.ps1
#   ... -Branch feat/whisperx-reliable-notes   # explicit branch
#   ... -SkipBuild                             # pull + deps only
#
# Requires: Windows git + Node 24 + (for WhisperX) uv on PATH. Run from
# native PowerShell, never from WSL (dual-clone rule: Windows npm only).
param(
    [string]$RepoDir = "C:\dev\openwhispr",
    [string]$Remote = "origin",
    [string]$Branch = "",
    [switch]$SkipBuild,
    [switch]$ForceProvision
)

$ErrorActionPreference = "Stop"

function Step($msg) { Write-Host "[update-local-app] $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "[update-local-app] $msg" -ForegroundColor Yellow }

# --- clone if missing -------------------------------------------------------
if (-not (Test-Path (Join-Path $RepoDir ".git"))) {
    Step "cloning fork into $RepoDir..."
    git clone https://github.com/myucordero/openwhispr.git $RepoDir
    git -C $RepoDir remote add upstream https://github.com/OpenWhispr/openwhispr.git 2>$null
}

Set-Location $RepoDir

# --- stop a running app (win-unpacked files get overwritten by the build) ---
$unpackedExe = Join-Path $RepoDir "dist\win-unpacked\OpenWhispr.exe"
$running = Get-Process -Name "OpenWhispr" -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $unpackedExe }
if ($running) {
    Warn "OpenWhispr is running from win-unpacked - closing it for the rebuild."
    $running | Stop-Process
    Start-Sleep -Seconds 2
}

# --- sync -------------------------------------------------------------------
Step "fetching $Remote..."
git fetch $Remote --prune
if (-not $Branch) { $Branch = (git branch --show-current).Trim() }
if ((git branch --show-current).Trim() -ne $Branch) {
    Step "checking out $Branch..."
    git checkout $Branch
}
$dirty = git status --porcelain
if ($dirty) {
    throw "Windows clone has local changes - the dual-clone rule says code lives in WSL. Resolve manually:`n$dirty"
}
Step "pulling $Remote/$Branch (fast-forward only)..."
git pull --ff-only $Remote $Branch

# --- npm ci only when the lockfile changed ----------------------------------
$markerDir = Join-Path $RepoDir ".local-pipeline"
New-Item -ItemType Directory -Force -Path $markerDir | Out-Null
function HashFile($path) { (Get-FileHash -Algorithm SHA256 $path).Hash }
function MarkerStale($name, $file) {
    $marker = Join-Path $markerDir $name
    $current = HashFile $file
    if ((Test-Path $marker) -and ((Get-Content $marker -Raw).Trim() -eq $current)) { return $false }
    return $true
}
function MarkerWrite($name, $file) {
    Set-Content -Path (Join-Path $markerDir $name) -Value (HashFile $file)
}

if (MarkerStale "package-lock.sha256" "package-lock.json") {
    Step "package-lock.json changed -> npm ci (Windows node)..."
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    MarkerWrite "package-lock.sha256" "package-lock.json"
} else {
    Step "package-lock.json unchanged -> skipping npm ci"
}

# --- WhisperX runtime only when uv.lock changed ------------------------------
$uvLock = "tools\whisperx-sidecar\uv.lock"
if (Test-Path $uvLock) {
    if (MarkerStale "uv-lock.sha256" $uvLock) {
        Step "uv.lock changed -> repairing WhisperX runtime..."
        node scripts\setup-whisperx.js --repair
        if ($LASTEXITCODE -ne 0) { throw "WhisperX runtime repair failed" }
        MarkerWrite "uv-lock.sha256" $uvLock
    } else {
        Step "uv.lock unchanged -> skipping runtime repair"
    }
}

# --- provision native binaries (network) -------------------------------------
# resources/bin is gitignored and stable across builds, so the build's own
# prebuild hook re-downloading every binary from GitHub on every run just burns
# the 60-req/hr unauthenticated API limit (HTTP 403). Provision only when the
# required binaries are missing OR the download scripts changed (a version bump)
# - the same signal CI uses to key its resources/bin cache. Set
# $env:GITHUB_TOKEN for reliable first-time / post-bump provisioning.
$binDir = Join-Path $RepoDir "resources\bin"
$requiredBins = @(
    "whisper-server-win32-x64.exe",
    "llama-server-win32-x64.exe",
    "sherpa-onnx-ws-win32-x64.exe",
    "qdrant-win32-x64.exe"
)
$binsMissing = @($requiredBins | Where-Object { -not (Test-Path (Join-Path $binDir $_)) })

$downloadScripts = Get-ChildItem (Join-Path $RepoDir "scripts\download-*.js") | Sort-Object Name
$concatHashes = ($downloadScripts | ForEach-Object { (Get-FileHash -Algorithm SHA256 $_.FullName).Hash }) -join ""
$sha = [System.Security.Cryptography.SHA256]::Create()
$downloadHash = [System.BitConverter]::ToString(
    $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($concatHashes))).Replace("-", "")
$downloadMarker = Join-Path $markerDir "download-scripts.sha256"
$markerExists = Test-Path $downloadMarker
$markerMatches = $markerExists -and ((Get-Content $downloadMarker -Raw).Trim() -eq $downloadHash)

# Re-provision only when binaries are genuinely missing, forced, or a KNOWN
# marker changed (upstream bump). Absent marker + present binaries = trust the
# existing binaries and just seed the marker (no GitHub calls) - this keeps the
# first run after adopting the pipeline offline.
$needProvision = ($binsMissing.Count -gt 0) -or $ForceProvision -or ($markerExists -and -not $markerMatches)

if ($needProvision) {
    if ($binsMissing.Count -gt 0) {
        Step ("provisioning binaries (missing: {0})..." -f ($binsMissing -join ", "))
    } elseif ($ForceProvision) {
        Step "provisioning binaries (forced)..."
    } else {
        Step "provisioning binaries (download scripts changed - likely an upstream bump)..."
    }
    if (-not $env:GITHUB_TOKEN) {
        Warn "GITHUB_TOKEN not set - GitHub API is capped at 60 req/hr; set it if provisioning hits HTTP 403."
    }
    npm run prebuild:local:win
    if ($LASTEXITCODE -ne 0) { throw "binary provisioning (prebuild:local:win) failed" }
    Set-Content -Path $downloadMarker -Value $downloadHash
} elseif (-not $markerMatches) {
    Step "binaries present; seeding provisioning marker (no GitHub calls)"
    Set-Content -Path $downloadMarker -Value $downloadHash
} else {
    Step "native binaries present and download scripts unchanged -> skipping provisioning (no GitHub calls)"
}

# --- build (offline: skip the network prebuild; binaries already staged) ------
if ($SkipBuild) {
    Warn "SkipBuild set - not rebuilding the packaged app."
} else {
    Step "building packaged app (build:local:win, prebuild skipped)..."
    npm run build:local:win --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "build:local:win failed" }
}

# --- Start Menu shortcut ------------------------------------------------------
$lnkPath = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\OpenWhispr.lnk"
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
if ($lnk.TargetPath -ne $unpackedExe) {
    Step "pointing Start Menu shortcut at the local build..."
    $lnk.TargetPath = $unpackedExe
    $lnk.WorkingDirectory = (Split-Path $unpackedExe)
    $lnk.Save()
}

# --- summary ------------------------------------------------------------------
Step "doctor summary:"
node scripts\doctor-whisperx.js 2>$null | Select-String -Pattern "PASS|FAIL|WARN"
$head = (git log --oneline -1).Trim()
Step ("done. {0} at {1}" -f $Branch, $head)
if (Test-Path $unpackedExe) {
    $stamp = (Get-Item $unpackedExe).LastWriteTime
    Step "app: $unpackedExe (built $stamp) - launch it from the Start Menu (OpenWhispr)."
}
