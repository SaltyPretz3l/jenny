# Jenny dev cleanup -- terminates lingering Jenny processes so a re-launch
# starts clean. Safe to run when nothing is running.
#
# Only processes positively identified as Jenny's are stopped (see
# jenny-process-identity.ps1): Jenny / Jenny Shell / jenny-sidecar by image
# name, electron only when it runs from this checkout's node_modules, the
# packaged sidecar only next to a Jenny install, and python only when it runs
# the sidecar from this checkout's .venv. Same-named processes that belong to
# anything else (another Electron app, another Python) are reported as
# "skipped" and left alone.
#
# Ollama is a shared engine. By default only the daemon Jenny itself started
# (recorded in %APPDATA%\jenny\ollama-process.json, and only while that pid is
# still an Ollama process created no later than the recorded start) is stopped,
# with the children it created. Every other Ollama process is reported as
# "kept".
#
# Usage (from a shell):   powershell -NoProfile -File cleanup-jenny.ps1 [-DryRun] [-IncludeOllama] [-IncludeWsl]
# Usage (from Desktop):   double-click the "Jenny Cleanup" shortcut, which
#                         invokes cleanup-jenny.bat -> this script.
#
# -DryRun         print what would be stopped; stop nothing.
# -IncludeOllama  stop every Ollama process, not only the one Jenny started.
#                 Leave off if another tool shares your Ollama server.
# -IncludeWsl     also runs `wsl --shutdown`, which evicts the WSL VM that hosts
#                 Ollama on Windows. Leave off unless you actually want to free
#                 the WSL VM (it affects every other WSL workload too).

[CmdletBinding()]
param(
    [switch]$IncludeWsl,
    [switch]$IncludeOllama,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'jenny-process-identity.ps1')

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$profileRoot = if ($env:APPDATA) { Join-Path $env:APPDATA 'jenny' } else { $null }

Write-Host '==================================================' -ForegroundColor Cyan
Write-Host '  Jenny Cleanup -- stopping lingering Jenny processes' -ForegroundColor Cyan
Write-Host '==================================================' -ForegroundColor Cyan
if ($DryRun) {
    Write-Host '  (dry run -- nothing will be stopped)' -ForegroundColor Yellow
}
Write-Host ''

$script:killedAny = $false

function Stop-JennyProcess {
    param([int]$ProcessId, [string]$Label)
    if ($DryRun) {
        Write-Host ('  would   stop {0} (pid {1})' -f $Label, $ProcessId) -ForegroundColor Yellow
        return
    }
    try {
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
        Write-Host ('  killed  {0} (pid {1})' -f $Label, $ProcessId) -ForegroundColor Yellow
        $script:killedAny = $true
    } catch {
        Write-Host ('  failed  {0} (pid {1}): {2}' -f $Label, $ProcessId, $_.Exception.Message) -ForegroundColor Red
    }
}

# One snapshot of the machine. ExecutablePath is $null for processes we cannot
# inspect; those never count as Jenny's.
$allProcs = @()
try {
    $allProcs = @(Get-CimInstance Win32_Process -ErrorAction Stop)
} catch {
    Write-Host ('  failed  could not list processes: {0}' -f $_.Exception.Message) -ForegroundColor Red
}

function Get-ProcessesByImage {
    param([string]$ImageName)
    return @($allProcs | Where-Object { $_.Name -ieq ($ImageName + '.exe') })
}

# Image names spawned by Jenny in dev or packaged mode.
# - "Jenny" / "electron"        : Electron main + child render/utility procs
#                                 ("Jenny Shell" = pre-1.0 installs)
# - "sidecar" / "jenny-sidecar" : packaged Python sidecar (PyInstaller artifact)
$names = @(
    'Jenny',
    'Jenny Shell',
    'electron',
    'sidecar',
    'jenny-sidecar'
)

foreach ($name in $names) {
    $procs = Get-ProcessesByImage -ImageName $name
    if (-not $procs) {
        Write-Host ('  none    {0}' -f $name) -ForegroundColor DarkGray
        continue
    }
    foreach ($p in $procs) {
        if (Test-JennyOwnedProcess -Name $p.Name -ExecutablePath $p.ExecutablePath -CommandLine $p.CommandLine -RepoRoot $repoRoot) {
            Stop-JennyProcess -ProcessId $p.ProcessId -Label $name
        } else {
            Write-Host ('  skipped {0} (pid {1}) -- not a Jenny process' -f $name, $p.ProcessId) -ForegroundColor DarkGray
        }
    }
}

# Dev-mode sidecar runs as plain python.exe from this checkout's .venv; match by
# executable and command line so we never kill an unrelated Python process.
# Only python processes that look like a sidecar are listed.
Write-Host ''
Write-Host 'Scanning for dev-mode python sidecar...' -ForegroundColor Cyan
$sidecarLike = @(Get-ProcessesByImage -ImageName 'python' | Where-Object { Test-JennySidecarCommandLine -CommandLine $_.CommandLine })
if (-not $sidecarLike) {
    Write-Host '  none    Jenny sidecar python' -ForegroundColor DarkGray
} else {
    foreach ($p in $sidecarLike) {
        if (Test-JennyOwnedProcess -Name $p.Name -ExecutablePath $p.ExecutablePath -CommandLine $p.CommandLine -RepoRoot $repoRoot) {
            Stop-JennyProcess -ProcessId $p.ProcessId -Label 'python.exe -- Jenny sidecar'
        } else {
            Write-Host ('  skipped python.exe (pid {0}) -- sidecar command line, but not this checkout''s .venv' -f $p.ProcessId) -ForegroundColor DarkGray
        }
    }
}

# Ollama is a shared engine: stop only the daemon Jenny started unless
# -IncludeOllama is passed.
Write-Host ''
Write-Host 'Scanning for Ollama...' -ForegroundColor Cyan
$ollamaImages = @('ollama', 'ollama_llama_server', 'ollama app')
$ollamaProcs = @()
foreach ($image in $ollamaImages) {
    $ollamaProcs += Get-ProcessesByImage -ImageName $image
}
if (-not $ollamaProcs) {
    Write-Host '  none    ollama' -ForegroundColor DarkGray
} elseif ($IncludeOllama) {
    foreach ($p in $ollamaProcs) {
        Stop-JennyProcess -ProcessId $p.ProcessId -Label ($p.Name -replace '(?i)\.exe$', '')
    }
} else {
    $ownedRecord = $null
    if ($profileRoot) { $ownedRecord = Get-JennyOwnedOllamaRecord -ProfileRoot $profileRoot }
    $ownedProc = $null
    if ($ownedRecord) {
        $candidate = $ollamaProcs | Where-Object { $_.ProcessId -eq $ownedRecord.ProcessId } | Select-Object -First 1
        if (-not $candidate) {
            Write-Host ('  note    recorded Jenny Ollama pid {0} is not a running Ollama process; ignoring the record' -f $ownedRecord.ProcessId) -ForegroundColor DarkGray
        } elseif (-not (Test-JennyRecordedProcessMatch -ProcessCreated $candidate.CreationDate -RecordedStart $ownedRecord.StartedAt)) {
            Write-Host ('  note    recorded Jenny Ollama pid {0} now belongs to a process Jenny did not start; ignoring the record' -f $ownedRecord.ProcessId) -ForegroundColor DarkGray
        } else {
            $ownedProc = $candidate
        }
    }
    $treePids = @()
    if ($ownedProc) {
        $treePids = @(Get-JennyDescendantPids -Processes $allProcs -RootPid $ownedProc.ProcessId)
        foreach ($childPid in $treePids) {
            $child = $allProcs | Where-Object { $_.ProcessId -eq $childPid } | Select-Object -First 1
            $childLabel = if ($child) { $child.Name -replace '(?i)\.exe$', '' } else { 'child' }
            Stop-JennyProcess -ProcessId $childPid -Label $childLabel
        }
        Stop-JennyProcess -ProcessId $ownedProc.ProcessId -Label ($ownedProc.Name -replace '(?i)\.exe$', '')
    }
    foreach ($p in $ollamaProcs) {
        if ($ownedProc -and ($p.ProcessId -eq $ownedProc.ProcessId -or $treePids -contains $p.ProcessId)) { continue }
        Write-Host ('  kept    {0} (pid {1}) -- not started by Jenny (-IncludeOllama stops every Ollama)' -f ($p.Name -replace '(?i)\.exe$', ''), $p.ProcessId) -ForegroundColor DarkGray
    }
}

if ($IncludeWsl) {
    Write-Host ''
    if ($DryRun) {
        Write-Host 'Would shut down the WSL VM (wsl --shutdown).' -ForegroundColor Yellow
    } else {
        Write-Host 'Shutting down WSL VM (vmmemwsl)...' -ForegroundColor Cyan
        try {
            & wsl.exe --shutdown
            Write-Host '  wsl --shutdown issued' -ForegroundColor Yellow
        } catch {
            Write-Host ('  wsl --shutdown failed: {0}' -f $_.Exception.Message) -ForegroundColor Red
        }
    }
} else {
    Write-Host ''
    Write-Host '(skipping WSL shutdown -- pass -IncludeWsl to also evict the WSL VM)' -ForegroundColor DarkGray
}

Write-Host ''
if ($DryRun) {
    Write-Host 'Dry run complete. Nothing was stopped.' -ForegroundColor Green
} elseif ($script:killedAny) {
    Write-Host 'Done. Jenny is cleared. You can launch fresh.' -ForegroundColor Green
} else {
    Write-Host 'Done. Nothing was running -- already clean.' -ForegroundColor Green
}
Write-Host ''
