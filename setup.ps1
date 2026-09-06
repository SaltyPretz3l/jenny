# Jenny setup — Windows entry point.
#
# Run from a PowerShell prompt in the repo root:
#     powershell -ExecutionPolicy Bypass -File .\setup.ps1
#
# Verifies prerequisites (offers winget installs with consent), runs
# `npm install`, then hands off to the cross-platform orchestrator
# (scripts/setup/setup.js) which creates the Python venv, ensures Ollama,
# pulls the default model, and launches Jenny.

[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$SkipModel,
  [switch]$NoLaunch,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Test-Have([string]$name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Update-SessionPath {
  # winget persists the updated PATH to the Machine/User registry, but the current process
  # keeps the PATH snapshot it started with -- so a freshly-installed tool is invisible to the
  # very next Get-Command check. Rebuild $env:PATH from the registry so subsequent checks (and
  # npm install) see the new binary without the friend having to open a fresh terminal.
  $machine = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine')
  $user = [System.Environment]::GetEnvironmentVariable('PATH', 'User')
  $env:PATH = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Install-WithWinget([string]$id, [string]$label) {
  if (-not (Test-Have 'winget')) {
    return
  }
  $proceed = $Yes
  if (-not $proceed) {
    $answer = Read-Host "Install $label with winget? [y/N]"
    $proceed = ($answer -match '^(y|yes)$')
  }
  if ($proceed) {
    Write-Host "Installing $label via winget..." -ForegroundColor Cyan
    # --accept-*-agreements keeps the install non-interactive (winget otherwise blocks on its
    # own source/package agreement prompt, which would hang an unattended -Yes run); --silent
    # suppresses winget's progress UI when the friend opted into non-interactive setup.
    $wingetArgs = @(
      'install', '--id', $id, '-e', '--source', 'winget',
      '--accept-package-agreements', '--accept-source-agreements'
    )
    if ($Yes) { $wingetArgs += '--silent' }
    winget @wingetArgs
    Update-SessionPath
  }
}

Write-Host "Jenny setup (Windows)" -ForegroundColor Cyan

if (-not (Test-Have 'node')) {
  Write-Host "Node.js 22.23.2+ (22.x) or 24.19.0+ (24.x) is required." -ForegroundColor Yellow
  Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js'
}
if (-not (Test-Have 'node')) {
  Write-Host "Node.js not found. Install it from https://nodejs.org then re-run .\setup.ps1" -ForegroundColor Red
  exit 10
}
$nodeVersionText = (& node --version).TrimStart('v')
$nodeVersion = $null
if (-not [System.Version]::TryParse($nodeVersionText, [ref]$nodeVersion)) {
  Write-Host "Could not determine the Node.js version." -ForegroundColor Red
  exit 10
}
$nodeSupported = (($nodeVersion.Major -eq 22) -and ($nodeVersion -ge [System.Version]'22.23.2')) -or
  (($nodeVersion.Major -eq 24) -and ($nodeVersion -ge [System.Version]'24.19.0'))
if (-not $nodeSupported) {
  Write-Host "Unsupported Node.js $nodeVersionText. Use 22.23.2+ (22.x) or 24.19.0+ (24.x)." -ForegroundColor Red
  exit 10
}
$npmMajor = 0
$npmVersionValid = (Test-Have 'npm') -and [int]::TryParse(
  ((& npm --version).Split('.')[0]),
  [ref]$npmMajor
)
if (-not $npmVersionValid -or $npmMajor -lt 10) {
  Write-Host "npm 10 or newer is required." -ForegroundColor Red
  exit 10
}

$userForward = @()
if ($Yes) { $userForward += '--yes' }
if ($SkipModel) { $userForward += '--skip-model' }
if ($NoLaunch) { $userForward += '--no-launch' }
if ($Rest) { $userForward += $Rest }
$argCheck = 'const { parseArgs } = require("./scripts/setup/setup"); const parsed = parseArgs(process.argv.slice(1)); if (parsed.errors.length) { console.error(parsed.errors.join(" ")); process.exit(10); }'
node -e $argCheck -- @userForward
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($userForward -contains '--help' -or $userForward -contains '-h') {
  node scripts/setup/setup.js @userForward
  exit $LASTEXITCODE
}

function Test-Python311 {
  if (Test-Have 'py') {
    & py -3.11 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' 2>$null
    if ($LASTEXITCODE -eq 0) { return $true }
    & py -3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' 2>$null
    if ($LASTEXITCODE -eq 0) { return $true }
  }
  if (Test-Have 'python') {
    & python -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' 2>$null
    if ($LASTEXITCODE -eq 0) { return $true }
  }
  return $false
}

if (-not (Test-Python311)) {
  Write-Host "Python 3.11+ is required." -ForegroundColor Yellow
  Install-WithWinget 'Python.Python.3.11' 'Python 3.11'
}
if (-not (Test-Python311)) {
  Write-Host "Python 3.11+ not found. Install it, then re-run .\setup.ps1" -ForegroundColor Red
  exit 10
}

if (-not (Test-Have 'git')) {
  Write-Host "git is recommended (updates + pre-commit hook)." -ForegroundColor Yellow
  Install-WithWinget 'Git.Git' 'Git'
}

Write-Host "Installing Node dependencies (npm install)..." -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) {
  Write-Host "npm install failed." -ForegroundColor Red
  exit 1
}

$forward = @('--bootstrapped-npm') + $userForward

node scripts/setup/setup.js @forward
exit $LASTEXITCODE
