# Jenny Docker setup — Windows PowerShell 5.1+ entry point.
#
# The launcher intentionally owns no application state. It only validates the
# local Docker client/daemon and invokes the fixed easy Compose project.

param(
  [Parameter(Position = 0)]
  [string]$Command,
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]]$Rest,
  [Alias('h')]
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
$RepoDir = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$ComposeFile = Join-Path -Path $RepoDir -ChildPath 'compose.host.easy.yml'
$ComposeArgs = @('compose', '--project-directory', $RepoDir, '-f', $ComposeFile, '--project-name', 'jenny-host')
$ScriptPath = $PSCommandPath
$script:UnexpectedParameters = @($PSBoundParameters.Keys | Where-Object {
  $_ -notin @('Command', 'Rest', 'Help')
})
# PowerShell treats unknown dash-prefixed positional values as remaining
# arguments when a ValueFromRemainingArguments parameter is present. Fold one
# such value back into Command so unknown flags receive our bounded usage
# error instead of the generic "too many arguments" path.
if (-not $Command -and $Rest -and @($Rest).Count -eq 1) {
  $Command = [string]$Rest[0]
  $Rest = @()
}

function Show-Usage {
  @'
Jenny Docker setup

Usage:
  .\docker-setup.ps1             Initialize (if needed) and start Jenny.
  .\docker-setup.ps1 doctor      Check configuration and readiness without build/up.
  .\docker-setup.ps1 configure   Change setup while Jenny is stopped, then start it.
  .\docker-setup.ps1 help

Docker Compose 2.24.4+ and a running Linux Docker daemon are required.
The setup and configure commands require an interactive terminal.
'@ | Write-Host
}

function Write-LauncherError([string]$Message) {
  [Console]::Error.WriteLine("docker-setup: $Message")
}

function Write-Followups {
  [Console]::Out.WriteLine("  Diagnosis: & `"$ScriptPath`" doctor")
  [Console]::Out.WriteLine("  Logs: docker compose --project-directory `"$RepoDir`" -f `"$ComposeFile`" --project-name jenny-host logs --tail 100 jenny")
}

function Test-InteractiveTerminal {
  return -not ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected)
}

function Test-ComposeVersion([string]$VersionText) {
  $match = [regex]::Match($VersionText, '(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)')
  if (-not $match.Success) {
    return $false
  }
  $major = [int]$match.Groups['major'].Value
  $minor = [int]$match.Groups['minor'].Value
  $patch = [int]$match.Groups['patch'].Value
  if ($major -gt 2) {
    return $true
  }
  return ($major -eq 2 -and ($minor -gt 24 -or ($minor -eq 24 -and $patch -ge 4)))
}

function Get-DockerProbe([string[]]$Arguments) {
  # Windows PowerShell 5.1 promotes redirected native stderr to error records.
  # Inspect Docker's exit status ourselves and retain our actionable diagnostic.
  $ErrorActionPreference = 'Continue'
  $PSNativeCommandUseErrorActionPreference = $false
  $lines = @(& docker @Arguments 2>$null)
  return @{ Lines = $lines; Status = [int]$LASTEXITCODE }
}

function Test-Preflight {
  if (-not (Test-Path -LiteralPath $ComposeFile -PathType Leaf)) {
    Write-LauncherError "easy Compose file not found: $ComposeFile"
    return 10
  }
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-LauncherError 'Docker CLI was not found. Install Docker Desktop or Docker Engine, then retry.'
    return 10
  }

  $composeProbe = Get-DockerProbe @('compose', 'version', '--short')
  $composeStatus = $composeProbe.Status
  $composeOutput = ($composeProbe.Lines -join "`n").Trim()
  if (($composeStatus -ne 0) -or (-not (Test-ComposeVersion $composeOutput))) {
    Write-LauncherError "Docker Compose 2.24.4 or newer is required. Run 'docker compose version' to inspect the installed version."
    return 10
  }

  $daemonProbe = Get-DockerProbe @('info', '--format', '{{.OSType}}')
  $daemonStatus = $daemonProbe.Status
  $daemonOs = ($daemonProbe.Lines -join '').Trim()
  if ($daemonStatus -ne 0) {
    Write-LauncherError 'Docker daemon is unavailable. Start Docker Desktop or Docker Engine, then retry.'
    return 10
  }
  if ($daemonOs -ieq 'linux') {
    return 0
  }
  if ($daemonOs) {
    Write-LauncherError "A Linux Docker daemon is required; the current daemon reports '$daemonOs'."
  } else {
    Write-LauncherError 'A Linux Docker daemon is required; Docker did not report its operating system.'
  }
  return 10
}

function Invoke-Compose([string[]]$Arguments) {
  # Keep Docker's stdout/stderr attached to the caller. In particular, Compose
  # must see the real console for the interactive init/configure prompts.
  & docker @script:ComposeArgs @Arguments
  $script:LastComposeStatus = [int]$LASTEXITCODE
}

function Invoke-ComposeStep([string]$Label, [string[]]$Arguments) {
  Invoke-Compose $Arguments
  $status = $script:LastComposeStatus
  if ($status -ne 0) {
    Write-LauncherError "$Label failed (exit $status)."
    Write-Followups
  }
  $script:LastStepStatus = $status
}

function Get-JennyRunning {
  $probe = Get-DockerProbe -Arguments ($script:ComposeArgs + @('ps', '--services', '--filter', 'status=running', 'jenny'))
  $lines = $probe.Lines
  $status = $probe.Status
  if ($status -ne 0) {
    return @{ Ok = $false; Status = [int]$status; Running = $false }
  }
  foreach ($line in $lines) {
    if (([string]$line).Trim() -eq 'jenny') {
      return @{ Ok = $true; Status = 0; Running = $true }
    }
  }
  return @{ Ok = $true; Status = 0; Running = $false }
}

function Invoke-Main {
  $mode = 'setup'
  if ($script:UnexpectedParameters.Count -gt 0) {
    Write-LauncherError "unknown option '-$($script:UnexpectedParameters[0])'."
    Show-Usage
    exit 2
  }
  if ($Help) {
    if ($Command -or $Rest) {
      Write-LauncherError 'help cannot be combined with another command.'
      Show-Usage
      exit 2
    }
    Show-Usage
    exit 0
  }
  if ($Command) {
    $normalized = $Command.ToLowerInvariant()
    if ($normalized -in @('help', '-h', '--help')) {
      if ($Rest) {
        Write-LauncherError 'help cannot be combined with another command.'
        Show-Usage
        exit 2
      }
      Show-Usage
      exit 0
    }
    if ($normalized -in @('doctor', 'configure', 'setup')) {
      $mode = $normalized
    } else {
      Write-LauncherError "unknown command '$Command'. Use 'help' for usage."
      Show-Usage
      exit 2
    }
  }
  if ($Rest) {
    Write-LauncherError 'expected one command at most. Use ''help'' for usage.'
    Show-Usage
    exit 2
  }

  if (($mode -eq 'setup' -or $mode -eq 'configure') -and (-not (Test-InteractiveTerminal))) {
    Write-LauncherError "an interactive terminal is required for '$mode'; run it from a terminal, then retry."
    exit 11
  }
  $preflightStatus = Test-Preflight
  if ($preflightStatus -ne 0) {
    exit $preflightStatus
  }

  if ($mode -eq 'doctor') {
    Invoke-ComposeStep 'doctor' @('run', '--rm', '--no-deps', '-T', 'setup', 'doctor')
    exit $script:LastStepStatus
  }

  $probe = Get-JennyRunning
  if (-not $probe.Ok) {
    Write-LauncherError "could not determine whether Jenny is running (exit $($probe.Status))."
    Write-Followups
    exit $probe.Status
  }
  if ($probe.Running) {
    if ($mode -eq 'configure') {
      Write-LauncherError 'Jenny is already running; configure requires a stopped host. No changes were made.'
      Write-Followups
      exit 11
    }
    [Console]::Out.WriteLine('Jenny is already running; no build or restart is needed. Running doctor.')
    Invoke-ComposeStep 'doctor' @('run', '--rm', '--no-deps', '-T', 'setup', 'doctor')
    exit $script:LastStepStatus
  }

  Invoke-ComposeStep 'image build' @('build', 'jenny')
  $status = $script:LastStepStatus
  if ($status -ne 0) { exit $status }
  if ($mode -eq 'configure') {
    Invoke-ComposeStep 'interactive configure' @('run', '--rm', '--no-deps', 'setup', 'configure')
  } else {
    Invoke-ComposeStep 'interactive owner initialization' @('run', '--rm', '--no-deps', 'setup', 'init')
  }
  $status = $script:LastStepStatus
  if ($status -ne 0) { exit $status }
  Invoke-ComposeStep 'start' @('up', '--wait', '--wait-timeout', '120', '-d', 'jenny')
  $status = $script:LastStepStatus
  if ($status -ne 0) { exit $status }
  Invoke-ComposeStep 'status' @('run', '--rm', '--no-deps', '-T', 'setup', 'status')
  exit $script:LastStepStatus
}

Invoke-Main
