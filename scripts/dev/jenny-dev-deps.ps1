# Jenny dev Python dependency stamp -- pure helper functions, dot-sourced by
# launch-jenny-dev.ps1. This file defines functions only: dot-sourcing it must
# not install, launch or write anything.
#
#   . (Join-Path $PSScriptRoot 'jenny-dev-deps.ps1')

function Get-JennyPythonDepsFingerprint {
    # SHA-256 of <RepoRoot>\pyproject.toml plus the interpreter version string,
    # as '<hash>|<version>'. Returns $null when either input is unavailable, so
    # the caller falls back to running the install.
    param([string]$RepoRoot, [string]$PythonVersion)
    if ([string]::IsNullOrWhiteSpace($RepoRoot) -or [string]::IsNullOrWhiteSpace($PythonVersion)) {
        return $null
    }
    try {
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $RepoRoot 'pyproject.toml') -ErrorAction Stop).Hash
    } catch {
        return $null
    }
    return ('{0}|{1}' -f $hash, $PythonVersion.Trim())
}

function Test-JennyDepsStampCurrent {
    # True only when the stamp file exists, parses, and its fingerprint equals
    # $Fingerprint. A missing, unreadable or different stamp (or an empty
    # fingerprint) is false.
    param([string]$StampPath, [string]$Fingerprint)
    if ([string]::IsNullOrWhiteSpace($Fingerprint) -or [string]::IsNullOrWhiteSpace($StampPath)) {
        return $false
    }
    try {
        if (-not (Test-Path -LiteralPath $StampPath -PathType Leaf)) { return $false }
        $stamp = Get-Content -LiteralPath $StampPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return $false
    }
    if ($null -eq $stamp) { return $false }
    return ([string]$stamp.fingerprint -ceq $Fingerprint)
}
