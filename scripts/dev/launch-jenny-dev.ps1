# Jenny (Dev) launcher -- consolidated cleanup -> dep refresh -> npm run dev.
# Safe to re-run; cleanup is no-op when nothing is running, and `npm install`
# is skipped entirely when the dependency stamp says nothing changed (npm's
# "no-op" install still resolves the whole tree, which is multi-second).
#
# Usage (from a shell):  powershell -NoProfile -File launch-jenny-dev.ps1
# Usage (from Desktop):  double-click the "Jenny (Dev)" shortcut, which
#                        invokes launch-jenny-dev.bat -> this script.
# -RefreshDeps  force `npm install` even when the dependency stamp matches.

[CmdletBinding()]
param(
    [switch]$IncludeWsl,
    [switch]$RefreshDeps
)

$ErrorActionPreference = 'Continue'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..\..')).Path

# Cold-start attribution: export the launcher's own start time and path label
# so main.js can measure launcher-to-main time (the cleanup/npm/esbuild work
# below is otherwise invisible to the in-app startup audit). Consumed only when
# JENNY_COLD_START_AUDIT is enabled; inert otherwise.
$env:JENNY_LAUNCHER_STARTED_AT_MS = [string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$env:JENNY_LAUNCH_PATH = 'dev'
$launchStopwatch = [System.Diagnostics.Stopwatch]::StartNew()

Write-Host '==================================================' -ForegroundColor Cyan
Write-Host '  Jenny (Dev) Launcher' -ForegroundColor Cyan
Write-Host ('  repo: {0}' -f $repoRoot) -ForegroundColor DarkGray
Write-Host '==================================================' -ForegroundColor Cyan
Write-Host ''

# --- Step 1/3: cleanup lingering runtimes -------------------------------------
Write-Host '[1/3] Cleaning lingering Jenny / Ollama / sidecar processes...' -ForegroundColor Cyan
$cleanupArgs = @()
if ($IncludeWsl) { $cleanupArgs += '-IncludeWsl' }
& (Join-Path $scriptDir 'cleanup-jenny.ps1') @cleanupArgs
Write-Host ('  cleanup took {0} ms' -f $launchStopwatch.ElapsedMilliseconds) -ForegroundColor DarkGray
Write-Host ''

# --- Step 2/3: refresh node deps ---------------------------------------------
# Dependency stamp: hash the two manifests plus the Node version/arch, and skip
# npm install when the stamp from the last SUCCESSFUL install matches. The
# stamp lives inside node_modules so wiping node_modules invalidates it
# automatically, and it is written only after a green install, so a failed or
# partial install can never satisfy the gate. Anything uncertain (missing
# manifest, unreadable stamp) falls back to running the install.
Write-Host '[2/3] Refreshing node deps (npm install)...' -ForegroundColor Cyan
Push-Location $repoRoot
$stampPath = Join-Path $repoRoot 'node_modules\.jenny-dev-install-stamp.json'
$depFingerprint = $null
try {
    $lockHash = (Get-FileHash -Algorithm SHA256 (Join-Path $repoRoot 'package-lock.json') -ErrorAction Stop).Hash
    $pkgHash = (Get-FileHash -Algorithm SHA256 (Join-Path $repoRoot 'package.json') -ErrorAction Stop).Hash
    $nodeVersion = ('{0}' -f (& node --version)).Trim()
    $depFingerprint = ('{0}|{1}|{2}|{3}' -f $lockHash, $pkgHash, $nodeVersion, $env:PROCESSOR_ARCHITECTURE)
} catch {
    $depFingerprint = $null
}
$skipInstall = $false
if (-not $RefreshDeps -and $depFingerprint -and (Test-Path $stampPath)) {
    try {
        $stamp = Get-Content $stampPath -Raw -ErrorAction Stop | ConvertFrom-Json
        if ($stamp.fingerprint -eq $depFingerprint) { $skipInstall = $true }
    } catch {
        $skipInstall = $false
    }
}
if ($skipInstall) {
    Write-Host 'Deps unchanged since the last successful install -- skipping npm install (-RefreshDeps forces one).' -ForegroundColor DarkGray
} else {
    try {
        & npm install --no-audit --no-fund
        $installExit = $LASTEXITCODE
    } catch {
        Write-Host ('npm install threw: {0}' -f $_.Exception.Message) -ForegroundColor Red
        Pop-Location
        exit 1
    }
    if ($installExit -ne 0) {
        Write-Host ('npm install failed (exit {0}). Aborting launch.' -f $installExit) -ForegroundColor Red
        Pop-Location
        exit 1
    }
    if ($depFingerprint) {
        try {
            @{ fingerprint = $depFingerprint; written_at = (Get-Date).ToUniversalTime().ToString('o') } |
                ConvertTo-Json | Out-File -FilePath $stampPath -Encoding utf8
        } catch {
            # Best effort: a missing stamp just means the next launch installs again.
        }
    }
}
Write-Host ('  preflight total {0} ms (cleanup + dep check/install)' -f $launchStopwatch.ElapsedMilliseconds) -ForegroundColor DarkGray
Write-Host ''

# --- Long-context Ollama tuning ----------------------------------------------
# Step 1 (cleanup) kills any standalone Ollama, so Jenny's own managed daemon
# wins the port and spawns fresh. Export the long-context knobs here so that
# spawned daemon inherits them (Jenny passes OLLAMA_* through to the child):
# Flash Attention + a quantized (q8_0) KV cache roughly halve the per-token KV
# footprint, which is what keeps 128K+ context from blowing past this 16GB GPU.
# Process-scoped on purpose -- nothing is written to the user/machine env. These
# mirror the in-code defaults in services/backend/ollama-env.js; set q4_0 instead
# of q8_0 for occasional 256K runs (quarters the KV cache, small quality cost).
$env:OLLAMA_FLASH_ATTENTION = '1'
$env:OLLAMA_KV_CACHE_TYPE = 'q8_0'
Write-Host ('Ollama long-context tuning: FLASH_ATTENTION={0} KV_CACHE_TYPE={1}' -f $env:OLLAMA_FLASH_ATTENTION, $env:OLLAMA_KV_CACHE_TYPE) -ForegroundColor DarkGray
Write-Host ''

# Keep the bounded sequential subagent batch available in ordinary desktop-dev
# launches. The user's Read-only subagents preference remains the outer gate,
# so disabling that Settings toggle still removes both subagent tools.
$env:JENNY_ENABLE_SUBAGENT_BATCH = '1'
Write-Host 'Subagent tools: batch gate enabled (subject to the Read-only subagents setting).' -ForegroundColor DarkGray
Write-Host ''

# --- Step 3/3: launch Electron via npm run dev (foreground / blocking) -------
Write-Host '[3/3] Launching Jenny (npm run dev) -- Ctrl+C in this window to stop.' -ForegroundColor Cyan
Write-Host ''
& npm run dev
$devExit = $LASTEXITCODE
Pop-Location

Write-Host ''
if ($devExit -eq 0) {
    Write-Host 'Jenny exited cleanly.' -ForegroundColor Green
} else {
    Write-Host ('Jenny exited with code {0}.' -f $devExit) -ForegroundColor Yellow
}
exit $devExit
