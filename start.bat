@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
title LAN File Transfer

echo.
echo   LAN File Transfer - starting up...
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH.
  echo         Install Node.js 22 or newer from https://nodejs.org
  echo         then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\express\package.json" goto :install
if not exist "node_modules\multer\package.json" goto :install
if not exist "node_modules\qrcode\package.json" goto :install
goto :run

:install
echo [1/2] Installing dependencies, please wait...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo [ERROR] npm install failed. Check your network and try again.
  echo.
  pause
  exit /b 1
)

:run
echo [2/2] Starting server, browser will open automatically...
echo.
set "AUTO_OPEN=1"
node --disable-warning=ExperimentalWarning server.js
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo Server stopped normally.
) else (
  echo [ERROR] Server exited with code %RC%.
  echo         If port 8787 is already in use, a server is already running:
  echo         just open http://127.0.0.1:8787 in your browser.
  echo         Otherwise read the error message shown above.
)
echo.
echo Press any key to close this window...
pause >nul
exit /b %RC%
