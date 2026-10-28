@echo off
rem Jenny command-line tool. Runs the installed Jenny.exe as Node on the CLI
rem entry inside app.asar. Kept in resources\bin so the .cmd never sits next
rem to Jenny.exe (.EXE wins over .CMD inside one directory).
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\Jenny.exe" --no-deprecation "%~dp0..\app.asar\cli\main.js" %*
endlocal & exit /b %ERRORLEVEL%
