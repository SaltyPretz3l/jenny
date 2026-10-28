# Real-install harness for the Windows one-command installer (row 47).
# CI only: this INSTALLS Jenny and starts it. Run it only on a disposable runner:
#   powershell -NoProfile -File scripts/packaging/install-native-windows.ps1
# Windows PowerShell 5.1 compatible. It never removes Mark-of-the-Web, never changes
# SmartScreen, and stops only processes positively identified by their executable path.
# -ProbeLog <shell.log> [-ProbeKnownRunIds a,b] runs only the readiness check against
# that log (1 s budget) for tests: prints run_id/boot_ms (exit 0), FAIL source=... (exit 2)
# or times out (exit 1). It installs nothing and writes no log file.
param([string]$ProbeLog = '', [string]$ProbeKnownRunIds = '')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$installScript = Join-Path $repoRoot 'install.ps1'
$logDir = Join-Path $repoRoot 'artifacts\logs'
$logPath = ''
$utf8 = New-Object System.Text.UTF8Encoding($false)
if (-not $ProbeLog) {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $logPath = Join-Path $logDir 'install-native-windows.log'
    [IO.File]::WriteAllText($logPath, '', $utf8)
}
# The window reveals at first paint since 2026-10-19 (ready-to-show / did-finish-load); the
# renderer-ready forms are earlier builds.
$successSources = @('ready-to-show', 'did-finish-load', 'renderer-ready', 'ready-to-show+renderer-ready', 'did-finish-load+renderer-ready')

$profileDir = Join-Path $env:APPDATA 'jenny'
$shellLog = Join-Path $profileDir 'logs\shell.log'
$ownerFile = Join-Path $profileDir 'profile-owner.json'
$configFile = Join-Path $profileDir 'shell-config.json'
$sessionsDir = Join-Path $profileDir 'sessions'
$uninstallKeys = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
$refusalText = 'Close Jenny, then rerun this command. No running process was stopped.'
$script:step = 'init'

function Write-Log([string]$Message) {
    $line = '{0} [{1}] {2}' -f (Get-Date).ToUniversalTime().ToString('o'), $script:step, $Message
    if ($logPath) { [IO.File]::AppendAllText($logPath, $line + "`n", $utf8) }
    Write-Host $line
}

function Stop-Step([string]$Message) {
    throw "step $($script:step) failed: $Message"
}

function Read-SharedText([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    $stream = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite, Delete')
    try {
        $reader = New-Object IO.StreamReader($stream, $utf8)
        return $reader.ReadToEnd()
    } finally {
        $stream.Dispose()
    }
}

function Get-KnownRunIds {
    $ids = @{}
    foreach ($match in [regex]::Matches((Read-SharedText $shellLog), '"run_id":"([^"]+)"')) {
        $ids[$match.Groups[1].Value] = $true
    }
    return $ids
}

# Both markers must come from one run that did not exist before this install, and the
# window.ready source must be a successful renderer start: the app also logs window.ready
# after did-fail-load or startup-timeout, which fails the check immediately.
function Wait-JennyReady([hashtable]$KnownRunIds, [int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $runs = @{}
        foreach ($line in ((Read-SharedText $shellLog) -split "`n")) {
            if ($line -notmatch '"event":"(window\.ready|backend\.managed_sidecar_initialized)"') { continue }
            try { $entry = $line | ConvertFrom-Json } catch { continue }
            if (-not $entry.run_id -or $KnownRunIds.ContainsKey($entry.run_id)) { continue }
            if (-not $runs.ContainsKey($entry.run_id)) { $runs[$entry.run_id] = @{ Ready = $null; Sidecar = $false } }
            if ($entry.event -eq 'window.ready') {
                if ($runs[$entry.run_id].Ready) { continue } # the first window.ready of a run decides
                $source = [string]$entry.data.source
                if ($successSources -notcontains $source) {
                    Stop-Step "renderer start failed: FAIL source=$source (run $($entry.run_id))"
                }
                $runs[$entry.run_id].Ready = $entry
            }
            else { $runs[$entry.run_id].Sidecar = $true }
        }
        foreach ($runId in $runs.Keys) {
            $run = $runs[$runId]
            if ($run.Ready -and $run.Sidecar) {
                return @{ RunId = $runId; StartupMs = [int]$run.Ready.data.startupMs }
            }
        }
        if ($TimeoutSec -le 1) { break }
        Start-Sleep -Seconds 2
    }
    Stop-Step "no new run logged both window.ready and backend.managed_sidecar_initialized within $TimeoutSec s ($shellLog)"
}

if ($ProbeLog) {
    $shellLog = $ProbeLog
    $known = @{}
    foreach ($id in ($ProbeKnownRunIds -split ',')) { if ($id) { $known[$id] = $true } }
    try {
        $probe = Wait-JennyReady $known 1
        Write-Output "run_id=$($probe.RunId) boot_ms=$($probe.StartupMs)"
        exit 0
    } catch {
        Write-Output $_.Exception.Message
        if ($_.Exception.Message -like '*FAIL source=*') { exit 2 }
        exit 1
    }
}

function Get-JennyInstall([string]$Tag) {
    $apps = @(Get-ItemProperty $uninstallKeys -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -eq 'Jenny' })
    if ($apps.Count -ne 1) { Stop-Step "expected one HKCU uninstall entry named Jenny, found $($apps.Count)" }
    $version = [string]$apps[0].DisplayVersion
    $location = ([string]$apps[0].InstallLocation).Trim('"')
    Write-Log "uninstall entry DisplayVersion=$version InstallLocation=$location"
    if ($version -ne $Tag.TrimStart('v')) { Stop-Step "DisplayVersion $version does not match $Tag" }
    if (-not $location) { Stop-Step 'uninstall entry has no InstallLocation' }
    $location = [IO.Path]::GetFullPath($location).TrimEnd('\')
    $exe = Join-Path $location 'Jenny.exe'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { Stop-Step "$exe is missing" }
    return @{ Location = $location; Exe = $exe }
}

function Get-ProcessesUnder([string]$Location) {
    $prefix = $Location + '\'
    return @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    })
}

function Get-JennyMain([hashtable]$Install) {
    $all = @(Get-ProcessesUnder $Install.Location | Where-Object { $_.ExecutablePath -eq $Install.Exe })
    $ids = @($all | ForEach-Object { $_.ProcessId })
    $roots = @($all | Where-Object { $ids -notcontains $_.ParentProcessId })
    if ($roots.Count -gt 1) { Stop-Step "found $($roots.Count) root Jenny.exe processes for $($Install.Exe)" }
    if ($roots.Count -eq 0) { return $null }
    return $roots[0]
}

function Wait-ProcessesGone([string]$Location, [int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if ((Get-ProcessesUnder $Location).Count -eq 0) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

# Close the main window first; force only PIDs whose executable lives in the install dir.
function Stop-Jenny([hashtable]$Install) {
    $main = Get-JennyMain $Install
    if ($main) {
        Write-Log "closing Jenny main window pid=$($main.ProcessId)"
        $proc = Get-Process -Id $main.ProcessId -ErrorAction SilentlyContinue
        if ($proc) {
            $proc.CloseMainWindow() | Out-Null
            if (-not $proc.WaitForExit(15000)) {
                Write-Log "pid=$($main.ProcessId) still running after 15 s; Stop-Process -Id"
                Stop-Process -Id $main.ProcessId -Force -ErrorAction SilentlyContinue
            }
        }
    }
    if (-not (Wait-ProcessesGone $Install.Location 30)) {
        foreach ($left in (Get-ProcessesUnder $Install.Location)) {
            Write-Log "stopping leftover pid=$($left.ProcessId) path=$($left.ExecutablePath)"
            Stop-Process -Id $left.ProcessId -Force -ErrorAction SilentlyContinue
        }
        if (-not (Wait-ProcessesGone $Install.Location 30)) { Stop-Step 'Jenny processes did not exit' }
    }
    Write-Log 'Jenny stopped'
}

# The documented form, in a child process so a throw inside install.ps1 cannot end the harness.
function Invoke-Install([string]$Label, [int]$TimeoutSec) {
    $outFile = Join-Path $logDir "install-native-windows-$Label.out.log"
    $errFile = Join-Path $logDir "install-native-windows-$Label.err.log"
    $quoted = $installScript.Replace("'", "''")
    $command = "try { Get-Content -Raw -LiteralPath '$quoted' | Invoke-Expression; exit 0 } " +
        "catch { [Console]::Out.WriteLine('INSTALL-ERROR: ' + `$_.Exception.Message); exit 1 }"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $shell = Join-Path $PSHOME 'powershell.exe'
    $started = Get-Date
    $proc = Start-Process -FilePath $shell -ArgumentList @('-NoProfile', '-EncodedCommand', $encoded) `
        -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    $null = $proc.Handle # Windows PowerShell 5.1 reports ExitCode only when the handle was read.
    if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
        Write-Log "install.ps1 ($Label) did not exit within $TimeoutSec s; a trust prompt may be waiting"
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Write-Log ("output: " + (Read-SharedText $outFile) + (Read-SharedText $errFile))
        Stop-Step "install.ps1 ($Label) timed out"
    }
    $proc.WaitForExit()
    $seconds = [Math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    $output = (Read-SharedText $outFile) + (Read-SharedText $errFile)
    Write-Log "install.ps1 ($Label) exit=$($proc.ExitCode) seconds=$seconds output:`n$output"
    return @{ ExitCode = $proc.ExitCode; Output = $output; Seconds = $seconds }
}

function Set-SeededSettings {
    if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) { Stop-Step "cannot seed settings: $configFile is missing" }
    $config = Read-SharedText $configFile | ConvertFrom-Json
    if (-not $config.windowUi) { $config | Add-Member -NotePropertyName windowUi -NotePropertyValue ([pscustomobject]@{}) }
    if ($null -ne $config.windowUi.appZoomPercent) { $config.windowUi.appZoomPercent = 125 }
    else { $config.windowUi | Add-Member -NotePropertyName appZoomPercent -NotePropertyValue 125 }
    if ($null -ne $config.use24HourTime) { $config.use24HourTime = $true }
    else { $config | Add-Member -NotePropertyName use24HourTime -NotePropertyValue $true }
    [IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json -Depth 32), $utf8)
    Write-Log 'seeded settings: windowUi.appZoomPercent=125, use24HourTime=$true'
}

function Test-SeededSettings([string]$Label) {
    $config = Read-SharedText $configFile | ConvertFrom-Json
    if ([int]$config.windowUi.appZoomPercent -ne 125 -or $config.use24HourTime -ne $true) {
        Stop-Step "seeded settings did not survive the $Label (zoom=$($config.windowUi.appZoomPercent) h24=$($config.use24HourTime))"
    }
    Write-Log "seeded settings survived the $Label"
}

function Get-ProfileSnapshot {
    if (-not (Test-Path -LiteralPath $ownerFile -PathType Leaf)) { Stop-Step "$ownerFile is missing" }
    if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) { Stop-Step "$configFile is missing" }
    $listing = '(absent)'
    if (Test-Path -LiteralPath $sessionsDir) {
        $root = (Resolve-Path -LiteralPath $sessionsDir).Path.TrimEnd('\') + '\'
        $names = @(Get-ChildItem -LiteralPath $sessionsDir -Recurse -Force | ForEach-Object {
            $name = $_.FullName.Substring($root.Length)
            if ($_.PSIsContainer) { $name } else { $name + '=' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
        } | Sort-Object)
        $listing = $names -join '|'
    }
    return @{ OwnerHash = (Get-FileHash -LiteralPath $ownerFile -Algorithm SHA256).Hash; Sessions = $listing }
}

$install = $null
$exitCode = 1
try {
    $script:step = 'a-precondition'
    $sessionId = (Get-Process -Id $PID).SessionId
    Write-Log "PSVersion=$($PSVersionTable.PSVersion) UserInteractive=$([Environment]::UserInteractive) SessionId=$sessionId OS=$([Environment]::OSVersion.VersionString)"
    # Disposable machines only: this installs and replaces Jenny on the current user profile.
    if ($env:GITHUB_ACTIONS -ne 'true' -and $env:JENNY_INSTALL_NATIVE_DISPOSABLE -ne '1') {
        Stop-Step 'refusing to run outside GitHub Actions; set JENNY_INSTALL_NATIVE_DISPOSABLE=1 only on a throwaway machine'
    }
    if (Get-Process -Name Jenny -ErrorAction SilentlyContinue) { Stop-Step 'a Jenny process is already running' }
    if (-not [Environment]::UserInteractive -or $sessionId -eq 0) {
        Stop-Step 'this runner session is not interactive; install.ps1 would refuse it'
    }
    if (-not (Test-Path -LiteralPath $installScript -PathType Leaf)) { Stop-Step "$installScript is missing" }

    $script:step = 'b-install'
    $known = Get-KnownRunIds
    $first = Invoke-Install 'first' 600
    if ($first.ExitCode -ne 0) { Stop-Step "install.ps1 exited $($first.ExitCode)" }
    if (-not ($first.Output -match 'Jenny: installed (v[0-9]+\.[0-9]+\.[0-9]+)\.')) { Stop-Step 'install.ps1 did not report the installed tag' }
    $tag = $Matches[1]
    Write-Log "installed tag=$tag in $($first.Seconds) s"

    $script:step = 'c-boot'
    $ready = Wait-JennyReady $known 120
    Write-Log "run_id=$($ready.RunId) startupMs=$($ready.StartupMs)"
    $install = Get-JennyInstall $tag

    $script:step = 'd-refusal'
    $main = Get-JennyMain $install
    if (-not $main) { Stop-Step 'Jenny is not running before the refusal check' }
    $refusal = Invoke-Install 'refusal' 300
    if ($refusal.ExitCode -eq 0) { Stop-Step 'install.ps1 succeeded while Jenny was running' }
    if (-not $refusal.Output.Contains($refusalText)) { Stop-Step 'install.ps1 output lacks the running-app refusal' }
    $alive = Get-Process -Id $main.ProcessId -ErrorAction SilentlyContinue
    if (-not $alive -or $alive.Path -ne $install.Exe) { Stop-Step "Jenny pid=$($main.ProcessId) did not survive the refusal" }
    Write-Log "refusal ok; pid=$($main.ProcessId) still running"

    $script:step = 'e-snapshot'
    $before = Get-ProfileSnapshot
    Write-Log "profile-owner.json sha256=$($before.OwnerHash) sessions=$($before.Sessions)"

    $script:step = 'f-stop'
    Stop-Jenny $install
    Set-SeededSettings
    $before = Get-ProfileSnapshot

    $script:step = 'g-rerun'
    $known = Get-KnownRunIds
    $rerun = Invoke-Install 'rerun' 600
    if ($rerun.ExitCode -ne 0) { Stop-Step "install.ps1 rerun exited $($rerun.ExitCode)" }
    $readyAgain = Wait-JennyReady $known 120
    Write-Log "rerun run_id=$($readyAgain.RunId) startupMs=$($readyAgain.StartupMs)"
    $install = Get-JennyInstall $tag
    Start-Sleep -Seconds 3
    $mainAgain = Get-JennyMain $install
    if (-not $mainAgain) { Stop-Step 'no Jenny main process is running after the rerun markers' }
    Write-Log "rerun main pid=$($mainAgain.ProcessId) alive after the markers"
    $after = Get-ProfileSnapshot
    Write-Log "profile-owner.json sha256=$($after.OwnerHash) sessions=$($after.Sessions)"
    if ($after.OwnerHash -ne $before.OwnerHash) { Stop-Step 'profile-owner.json changed across the rerun' }
    # The rerun boot may add files; every session entry (name=sha256) that existed before must survive unchanged.
    $afterEntries = $after.Sessions -split '\|'
    foreach ($name in ($before.Sessions -split '\|')) {
        if ($name -and $name -ne '(absent)' -and ($afterEntries -notcontains $name)) {
            Stop-Step "session file $name disappeared across the rerun"
        }
    }
    Test-SeededSettings 'rerun'
    $tempRoot = [IO.Path]::GetTempPath()
    $leftover = @(Get-ChildItem -LiteralPath $tempRoot -Directory -Filter 'jenny-install-*' -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'Jenny-Setup-x64.exe') })
    if ($leftover.Count -ne 0) { Stop-Step "installer left in $($leftover[0].FullName)" }

    $script:step = 'h-finish'
    Stop-Jenny $install
    $installSeconds = [int][Math]::Round($first.Seconds)
    $result = "RESULT platform=windows tag=$tag install_s=$installSeconds boot_ms=$($ready.StartupMs) refusal=ok rerun=ok preserved=ok"
    Write-Log $result
    $exitCode = 0
} catch {
    Write-Log "FAILED: $($_.Exception.Message)"
    if ($install) {
        try { Stop-Jenny $install } catch { Write-Log "cleanup stop failed: $($_.Exception.Message)" }
    }
}
exit $exitCode
