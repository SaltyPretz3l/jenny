@echo off
REM Jenny (Dev) launcher -- double-click target.
REM Invokes launch-jenny-dev.ps1 with bypassed execution policy so the desktop
REM shortcut works regardless of the user's PowerShell policy. Forwards any
REM extra args (e.g. -IncludeWsl) straight through.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch-jenny-dev.ps1" %*
echo.
echo Press any key to close this window...
pause >nul
