$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $repoRoot 'scripts\uninstall.js') @args
exit $LASTEXITCODE
