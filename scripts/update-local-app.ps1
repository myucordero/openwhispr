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
    [switch]$SkipBuild
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

# --- build -------------------------------------------------------------------
if ($SkipBuild) {
    Warn "SkipBuild set - not rebuilding the packaged app."
} else {
    Step "building packaged app (npm run build:local:win)..."
    npm run build:local:win
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
