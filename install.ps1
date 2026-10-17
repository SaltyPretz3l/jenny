# Install released Jenny. Developer/source setup lives in setup.ps1.
# Run: irm https://raw.githubusercontent.com/SaltyPretz3l/jenny/main/install.ps1 | iex
function Install-Jenny {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $repo = 'https://github.com/SaltyPretz3l/jenny'
    $work = $null
    $lock = $null
    $oldTls = [Net.ServicePointManager]::SecurityProtocol
    function Assert-JennyClosed {
        if (Get-Process -Name Jenny -ErrorAction SilentlyContinue) {
            throw 'Close Jenny, then rerun this command. No running process was stopped.'
        }
    }
    function Invoke-JennyHttpsRequest([string]$Url, [string]$Destination) {
        $current = [Uri]$Url
        for ($hop = 0; $hop -lt 8; $hop++) {
            if (-not $current.IsAbsoluteUri -or $current.Scheme -ne 'https') {
                throw 'Refusing a non-HTTPS download or redirect.'
            }
            $request = @{ UseBasicParsing = $true; Uri = $current.AbsoluteUri;
                MaximumRedirection = 0; TimeoutSec = 1800;
                ErrorAction = 'SilentlyContinue'; ErrorVariable = 'requestErrors' }
            if ($Destination) { $request.OutFile = $Destination; $request.PassThru = $true }
            # Windows PowerShell emits the 302 response, then a nonterminating
            # MaximumRedirectExceeded error. Keep that response without following it.
            $requestErrors = @()
            $response = $null
            try { $response = Invoke-WebRequest @request }
            catch { $requestErrors += $_ }
            if (-not $response) {
                $failure = $requestErrors | Select-Object -Last 1
                $response = $failure.Exception.Response
                if (-not $response) { throw "HTTPS request failed: $($failure.Exception.Message)" }
            }
            $status = [int]$response.StatusCode
            if ($status -in @(301, 302, 303, 307, 308)) {
                $location = $response.Headers['Location']
                if (-not $location) { throw "HTTP $status returned no redirect location." }
                $current = [Uri]::new($current, [string]$location)
                continue
            }
            if ($status -lt 200 -or $status -ge 300) { throw "HTTP $status from $($current.Host)." }
            return $current.AbsoluteUri
        }
        throw 'Too many HTTPS redirects.'
    }
    function Get-JennyDownload([string]$Url, [string]$Destination) {
        for ($attempt = 0; $attempt -lt 3; $attempt++) {
            try { Invoke-JennyHttpsRequest $Url $Destination | Out-Null; return }
            catch {
                if ($attempt -eq 2) { throw "Download failed: $($_.Exception.Message)" }
                Start-Sleep -Seconds 2
            }
        }
    }
    try {
        $nativeArch = $env:PROCESSOR_ARCHITEW6432
        if (-not $nativeArch) { $nativeArch = $env:PROCESSOR_ARCHITECTURE }
        if ($env:OS -ne 'Windows_NT' -or $nativeArch -ne 'AMD64') {
            throw 'This installer requires Windows x64. See the Jenny releases page for other platforms.'
        }
        if (-not [Environment]::UserInteractive -or (Get-Process -Id $PID).SessionId -eq 0 -or $env:SSH_CONNECTION) {
            throw 'Run this command in PowerShell in your local Windows desktop session.'
        }
        Assert-JennyClosed
        # FileShare.None provides an automatically released per-user install lock.
        $lockPath = Join-Path $env:LOCALAPPDATA 'Jenny-install.lock'
        if ((Test-Path -LiteralPath $lockPath) -and ((Get-Item -LiteralPath $lockPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Refusing a linked installer lock file.'
        }
        $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
        $work = Join-Path ([IO.Path]::GetTempPath()) ('jenny-install-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $work | Out-Null
        [Net.ServicePointManager]::SecurityProtocol = $oldTls -bor [Net.SecurityProtocolType]::Tls12
        Write-Host 'Jenny: resolving the latest stable release...'
        $releaseUrl = Invoke-JennyHttpsRequest "$repo/releases/latest" ''
        $prefix = "$repo/releases/tag/"
        if (-not $releaseUrl.StartsWith($prefix, [StringComparison]::Ordinal)) {
            throw 'Unexpected release redirect.'
        }
        $tag = $releaseUrl.Substring($prefix.Length)
        if ($tag -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') {
            throw 'The latest release does not describe a stable release.'
        }
        $asset = 'Jenny-Setup-x64.exe'
        $base = "$repo/releases/download/$tag"
        $manifest = Join-Path $work 'SHA256SUMS-windows.txt'
        Get-JennyDownload "$base/SHA256SUMS-windows.txt" $manifest
        $entries = @(Get-Content -LiteralPath $manifest | Where-Object { $_ -match '\sJenny-Setup-x64\.exe\s*$' })
        if ($entries.Count -ne 1 -or $entries[0] -cnotmatch '^([0-9a-fA-F]{64})  Jenny-Setup-x64\.exe\s*$') {
            throw 'Missing, duplicate or malformed installer checksum.'
        }
        $expected = $Matches[1]
        $installer = Join-Path $work $asset
        Write-Host "Jenny: downloading $tag..."
        Get-JennyDownload "$base/$asset" $installer
        if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $expected) {
            throw 'Checksum mismatch. Nothing was installed.'
        }
        # A scripted download must retain the normal Windows trust prompt.
        Set-Content -LiteralPath $installer -Stream Zone.Identifier -Value "[ZoneTransfer]`r`nZoneId=3`r`nHostUrl=$base/$asset" -Encoding ASCII
        Assert-JennyClosed
        Write-Host 'Jenny: verified. Opening the one-click installer; Windows may ask you to approve this unsigned app.'
        # Start-Process -Wait waits for descendants too, including the opened app.
        $process = Start-Process -FilePath $installer -PassThru
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw "Installer exited with code $($process.ExitCode). Retry or download the installer manually." }
        # NSIS normally opens Jenny itself. Only launch if it has not done so.
        if (-not (Get-Process -Name Jenny -ErrorAction SilentlyContinue)) {
            $installed = Join-Path $env:LOCALAPPDATA 'Programs\Jenny\Jenny.exe'
            $apps = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -eq 'Jenny' -and $_.InstallLocation })
            if ($apps.Count -eq 1) { $installed = Join-Path $apps[0].InstallLocation 'Jenny.exe' }
            if (-not (Test-Path -LiteralPath $installed -PathType Leaf)) {
                throw 'Installer finished but Jenny could not be located. Open Jenny from the Start menu.'
            }
            Start-Process -FilePath $installed | Out-Null
        }
        Write-Host "Jenny: installed $tag. Choose your workspace and model in onboarding."
    } finally {
        [Net.ServicePointManager]::SecurityProtocol = $oldTls
        if ($work -and (Test-Path -LiteralPath $work)) {
            # Only the unique directory created above can be removed.
            $resolved = [IO.Path]::GetFullPath($work)
            $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
            if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
                [IO.Path]::GetFileName($resolved) -match '^jenny-install-[a-f0-9]{32}$') {
                Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        if ($lock) { $lock.Dispose() }
    }
}
Install-Jenny
