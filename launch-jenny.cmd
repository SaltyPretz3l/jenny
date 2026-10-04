@echo off
setlocal
for %%I in ("%~dp0.") do set "REPO_ROOT=%%~fI"
set "ELECTRON_RUN_AS_NODE="
rem Cold-start attribution label; read by main.js only under JENNY_COLD_START_AUDIT.
set "JENNY_LAUNCH_PATH=public-cmd"
set "ELECTRON_EXE=%REPO_ROOT%\node_modules\electron\dist\electron.exe"

if defined JENNY_LAUNCHER_TEST_MODE (
  echo REPO_ROOT=%REPO_ROOT%
  echo ELECTRON_EXE=%ELECTRON_EXE%
  echo ELECTRON_RUN_AS_NODE=%ELECTRON_RUN_AS_NODE%
  if not exist "%ELECTRON_EXE%" (
    exit /b 1
  )
  exit /b 0
)

if not exist "%ELECTRON_EXE%" (
  >&2 echo Jenny launcher could not find the local Electron runtime.
  >&2 echo Expected: "%ELECTRON_EXE%"
  exit /b 1
)

rem Refresh the esbuild preload bundle (skipped when its stamp is current). A
rem missing or stale bundle boots a window whose shell API never loads.
where node >nul 2>nul
if errorlevel 1 (
  if not exist "%REPO_ROOT%\preload.bundle.js" (
    >&2 echo Jenny launcher needs Node.js on PATH to build preload.bundle.js.
    exit /b 1
  )
) else (
  node "%REPO_ROOT%\scripts\build\build-preload.js" >nul
  if errorlevel 1 (
    >&2 echo Jenny launcher failed to build the preload bundle.
    exit /b 1
  )
)

start "" /D "%REPO_ROOT%" "%ELECTRON_EXE%" "%REPO_ROOT%"
set "LAUNCH_EXIT=%ERRORLEVEL%"
if not "%LAUNCH_EXIT%"=="0" (
  >&2 echo Jenny launcher failed to start the local Electron runtime.
)
exit /b %LAUNCH_EXIT%
