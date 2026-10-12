@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.19 or newer from https://nodejs.org then try again.
  pause
  exit /b 1
)
if not exist node_modules\electron\dist\electron.exe (
  call npm ci
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node desktop\launch.mjs
if errorlevel 1 pause
