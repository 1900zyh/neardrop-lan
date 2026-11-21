@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required on this server computer.
  echo Install Node.js, reopen this file, and try again.
  pause
  exit /b 1
)
node server.js --open
if errorlevel 1 pause
