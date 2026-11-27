@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found, so the stop script cannot run.
  pause
  exit /b 1
)
node control.js stop %*
set "RC=%errorlevel%"
echo %cmdcmdline% | find /i "%~nx0" >nul && pause
exit /b %RC%
