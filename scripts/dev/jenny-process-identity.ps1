# Jenny process identity -- pure decision functions, dot-sourced by
# cleanup-jenny.ps1. This file defines functions only: dot-sourcing it must not
# enumerate, stop or otherwise touch any process, so tests can call these with
# synthetic inputs.
#
#   . (Join-Path $PSScriptRoot 'jenny-process-identity.ps1')

function Get-JennyFullPath {
    # Absolute, separator-normalised path with no trailing separator, or $null
    # when the input is empty or not a valid path.
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    try {
        $full = [System.IO.Path]::GetFullPath($Path.Trim())
    } catch {
        return $null
    }
    $root = [System.IO.Path]::GetPathRoot($full)
    if ($full.Length -gt $root.Length) {
        $full = $full.TrimEnd('\', '/')
    }
    return $full
}

function Test-JennyPathUnder {
    # True when $Path is strictly inside $Root. Case-insensitive and
    # separator-safe: 'G:\repo2\x' is not under 'G:\repo'.
    param([string]$Path, [string]$Root)
    $fullPath = Get-JennyFullPath -Path $Path
    $fullRoot = Get-JennyFullPath -Path $Root
    if (-not $fullPath -or -not $fullRoot) { return $false }
    $prefix = $fullRoot.TrimEnd('\') + '\'
    return $fullPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-JennySidecarCommandLine {
    # True when a command line runs the Jenny sidecar (-m sidecar,
    # sidecar.server or sidecar\server.py).
    param([string]$CommandLine)
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    return [bool]($CommandLine -match '(^|\s)-m\s+sidecar([\s.]|$)|sidecar\.server|sidecar[\\/]server\.py')
}

function Test-JennyOwnedProcess {
    # True only for a process positively identified as Jenny's. Unknown or
    # uninspectable processes (no ExecutablePath where one is required) are not
    # Jenny's. -TestPath is an injectable leaf-file existence check for tests.
    param(
        [string]$Name,
        [string]$ExecutablePath,
        [string]$CommandLine,
        [string]$RepoRoot,
        [scriptblock]$TestPath = { param($p) Test-Path -LiteralPath $p -PathType Leaf }
    )
    if ([string]::IsNullOrWhiteSpace($Name)) { return $false }
    $image = ($Name.Trim() -replace '(?i)\.exe$', '').ToLowerInvariant()

    switch ($image) {
        { $_ -in @('jenny', 'jenny shell', 'jenny-sidecar') } {
            return $true
        }
        'electron' {
            if (-not $RepoRoot) { return $false }
            return (Test-JennyPathUnder -Path $ExecutablePath -Root (Join-Path $RepoRoot 'node_modules\electron'))
        }
        'sidecar' {
            $exe = Get-JennyFullPath -Path $ExecutablePath
            if (-not $exe) { return $false }
            if (-not $exe.EndsWith('\resources\sidecar\sidecar.exe', [System.StringComparison]::OrdinalIgnoreCase)) {
                return $false
            }
            # <install>\resources\sidecar\sidecar.exe -> <install>
            $installDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $exe))
            if (-not $installDir) { return $false }
            foreach ($app in @('Jenny.exe', 'Jenny Shell.exe')) {
                if (& $TestPath (Join-Path $installDir $app)) { return $true }
            }
            return $false
        }
        'python' {
            if (-not $RepoRoot) { return $false }
            if (-not (Test-JennyPathUnder -Path $ExecutablePath -Root (Join-Path $RepoRoot '.venv'))) { return $false }
            return (Test-JennySidecarCommandLine -CommandLine $CommandLine)
        }
        default {
            return $false
        }
    }
}

function ConvertTo-JennyUtcTime {
    # A UTC [datetime] from a [datetime] or an ISO 8601 string, or $null when
    # the value is missing or does not parse.
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [datetime]) { return $Value.ToUniversalTime() }
    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    $parsed = [System.DateTimeOffset]::MinValue
    $culture = [System.Globalization.CultureInfo]::InvariantCulture
    $styles = [System.Globalization.DateTimeStyles]::AssumeUniversal
    if ([System.DateTimeOffset]::TryParse($text, $culture, $styles, [ref]$parsed)) {
        return $parsed.UtcDateTime
    }
    return $null
}

function Get-JennyOwnedOllamaRecord {
    # The Ollama daemon Jenny itself started, from
    # <ProfileRoot>\ollama-process.json, as an object with ProcessId and
    # StartedAt (UTC, or $null when the record has no usable start time), or
    # $null. Only a record with app_owned true and a positive integer pid
    # counts. Pids get reused, so the caller must still confirm the live
    # process with Test-JennyRecordedProcessMatch.
    param([string]$ProfileRoot)
    if ([string]::IsNullOrWhiteSpace($ProfileRoot)) { return $null }
    $statePath = Join-Path $ProfileRoot 'ollama-process.json'
    try {
        if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $null }
        $record = Get-Content -LiteralPath $statePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return $null
    }
    if ($null -eq $record) { return $null }
    if (($record.app_owned -isnot [bool]) -or (-not $record.app_owned)) { return $null }
    $recorded = $record.pid
    if (($recorded -isnot [int]) -and ($recorded -isnot [long])) { return $null }
    if ($recorded -le 0) { return $null }
    return [pscustomobject]@{
        ProcessId = [int]$recorded
        StartedAt = (ConvertTo-JennyUtcTime -Value $record.startedAt)
    }
}

function Get-JennyOwnedOllamaPid {
    # The recorded pid alone, or $null. See Get-JennyOwnedOllamaRecord.
    param([string]$ProfileRoot)
    $record = Get-JennyOwnedOllamaRecord -ProfileRoot $ProfileRoot
    if ($null -eq $record) { return $null }
    return $record.ProcessId
}

function Test-JennyRecordedProcessMatch {
    # True only when a live process can be the one the record describes: Jenny
    # writes the record right after the spawn, so the process must have been
    # created no later than the recorded start (plus a small tolerance). A
    # process created after that holds a reused pid. Missing or unparseable
    # times never match.
    param($ProcessCreated, $RecordedStart, [int]$ToleranceSeconds = 5)
    $created = ConvertTo-JennyUtcTime -Value $ProcessCreated
    $recorded = ConvertTo-JennyUtcTime -Value $RecordedStart
    if ($null -eq $created -or $null -eq $recorded) { return $false }
    return ($created -le $recorded.AddSeconds($ToleranceSeconds))
}

function Get-JennyDescendantPids {
    # Pids of every descendant of $RootPid in a process snapshot (objects with
    # ProcessId, ParentProcessId and CreationDate), deepest first, so a caller
    # can stop children before parents. Does not include $RootPid itself.
    # Windows never updates ParentProcessId when a parent exits and reuses
    # pids, so a child counts only when it was created no earlier than its
    # parent; a process without a readable creation time is not a descendant.
    param([object[]]$Processes, [int]$RootPid)
    $byParent = @{}
    $created = @{}
    foreach ($p in @($Processes)) {
        $created[[string]$p.ProcessId] = ConvertTo-JennyUtcTime -Value $p.CreationDate
        $parentKey = [string]$p.ParentProcessId
        if (-not $byParent.ContainsKey($parentKey)) { $byParent[$parentKey] = @() }
        $byParent[$parentKey] += [int]$p.ProcessId
    }
    $ordered = New-Object System.Collections.Generic.List[int]
    $seen = @{ ([string]$RootPid) = $true }
    $queue = New-Object System.Collections.Generic.Queue[int]
    $queue.Enqueue($RootPid)
    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        $children = $byParent[[string]$current]
        if (-not $children) { continue }
        $parentCreated = $created[[string]$current]
        foreach ($child in $children) {
            if ($seen.ContainsKey([string]$child)) { continue }
            $childCreated = $created[[string]$child]
            if ($null -eq $parentCreated -or $null -eq $childCreated -or $childCreated -lt $parentCreated) { continue }
            $seen[[string]$child] = $true
            $ordered.Add($child)
            $queue.Enqueue($child)
        }
    }
    $result = $ordered.ToArray()
    [array]::Reverse($result)
    return $result
}
