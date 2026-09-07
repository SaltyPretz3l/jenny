# Jenny dev cleanup -- terminates lingering Jenny / Ollama / sidecar processes
# so a re-launch starts clean. Safe to run when nothing is running.
#
# Usage (from a shell):   powershell -NoProfile -File cleanup-jenny.ps1 [-IncludeWsl]
# Usage (from Desktop):   double-click the "Jenny Cleanup" shortcut, which
#                         invokes cleanup-jenny.bat -> this script.
#
# -IncludeWsl  also runs `wsl --shutdown`, which evicts the WSL VM that hosts
#              Ollama on Windows. Leave off unless you actually want to free
#              the WSL VM (it affects every other WSL workload too).

[CmdletBinding()]
param(
    [switch]$IncludeWsl
)

$ErrorActionPreference = 'Continue'

Write-Host '==================================================' -ForegroundColor Cyan
Write-Host '  Jenny Cleanup -- killing lingering runtimes' -ForegroundColor Cyan
Write-Host '==================================================' -ForegroundColor Cyan
Write-Host ''

# Image names spawned by Jenny in dev or packaged mode.
# - "Jenny" / "electron"        : Electron main + child render/utility procs
#                                 ("Jenny Shell" = pre-1.0 installs)
# - "ollama*"                   : Ollama CLI/server/runner/tray
# - "sidecar" / "jenny-sidecar" : packaged Python sidecar (PyInstaller artifact)
$names = @(
    'Jenny',
    'Jenny Shell',
    'electron',
    'ollama',
    'ollama_llama_server',
    'ollama app',
    'sidecar',
    'jenny-sidecar'
)

$killedAny = $false

foreach ($name in $names) {
    $procs = Get-Process -Name $name -ErrorAction SilentlyContinue
    if (-not $procs) {
        Write-Host ('  none    {0}' -f $name) -ForegroundColor DarkGray
        continue
    }
    foreach ($p in $procs) {
        try {
            Stop-Process -Id $p.Id -Force -ErrorAction Stop
            Write-Host ('  killed  {0} (pid {1})' -f $p.ProcessName, $p.Id) -ForegroundColor Yellow
            $killedAny = $true
        } catch {
            Write-Host ('  failed  {0} (pid {1}): {2}' -f $p.ProcessName, $p.Id, $_.Exception.Message) -ForegroundColor Red
        }
    }
}

# Dev-mode sidecar runs as plain python.exe; match by command line so we never
# kill an unrelated Python process.
Write-Host ''
Write-Host 'Scanning for dev-mode python sidecar...' -ForegroundColor Cyan
$pythonProcs = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue
$jennyPy = $pythonProcs | Where-Object {
    $_.CommandLine -match 'sidecar\.server|sidecar[\\/]server\.py'
}
if (-not $jennyPy) {
    Write-Host '  none    Jenny sidecar python' -ForegroundColor DarkGray
} else {
    foreach ($p in $jennyPy) {
        try {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
            Write-Host ('  killed  python.exe (pid {0}) -- Jenny sidecar' -f $p.ProcessId) -ForegroundColor Yellow
            $killedAny = $true
        } catch {
            Write-Host ('  failed  python.exe (pid {0}): {1}' -f $p.ProcessId, $_.Exception.Message) -ForegroundColor Red
        }
    }
}

if ($IncludeWsl) {
    Write-Host ''
    Write-Host 'Shutting down WSL VM (vmmemwsl)...' -ForegroundColor Cyan
    try {
        & wsl.exe --shutdown
        Write-Host '  wsl --shutdown issued' -ForegroundColor Yellow
    } catch {
        Write-Host ('  wsl --shutdown failed: {0}' -f $_.Exception.Message) -ForegroundColor Red
    }
} else {
    Write-Host ''
    Write-Host '(skipping WSL shutdown -- pass -IncludeWsl to also evict the WSL VM)' -ForegroundColor DarkGray
}

Write-Host ''
if ($killedAny) {
    Write-Host 'Done. Jenny is cleared. You can launch fresh.' -ForegroundColor Green
} else {
    Write-Host 'Done. Nothing was running -- already clean.' -ForegroundColor Green
}
Write-Host ''
