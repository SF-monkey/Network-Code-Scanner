@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js 18 or newer is required but was not found.
  echo Install it from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)
node control.js start %*
set "RC=%errorlevel%"
rem Keep the window open only when launched by double-click
echo %cmdcmdline% | find /i "%~nx0" >nul && pause
exit /b %RC%
