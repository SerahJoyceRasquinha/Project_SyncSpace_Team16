@echo off
setlocal
title SyncSpace dev
rem ============================================================================
rem  SyncSpace - one-command dev launcher (Windows)
rem
rem  Run it from anywhere:
rem    - double-click dev.bat in Explorer
rem    - VS Code terminal (PowerShell):  .\dev.bat
rem    - cmd:                            dev.bat
rem
rem  1. installs backend / frontend / root deps (skipped when node_modules
rem     already exists, so re-runs start in seconds)
rem  2. starts `npm run dev` (backend + frontend via concurrently)
rem  3. a tiny background watcher waits for the Vite port to answer, then
rem     opens the app in a new Chrome tab (default browser as fallback).
rem     It connects by HOSTNAME, so it works whether Vite bound to
rem     IPv4 (127.0.0.1) or IPv6 (::1) - both happen on Windows.
rem
rem  Ctrl+C in this window stops both servers, exactly like `npm run dev`.
rem ============================================================================

rem always run relative to this script, no matter where it was launched from
cd /d "%~dp0"

set "PORT=5173"

where npm >nul 2>nul || (
  echo [ERROR] npm was not found on PATH. Install Node.js from https://nodejs.org and retry.
  pause
  exit /b 1
)

echo.
echo  SyncSpace - starting up
echo  -----------------------

if not exist "backend\node_modules" (
  echo  [1/4] Installing backend dependencies...
  call npm install --prefix backend || goto :fail
) else (
  echo  [1/4] Backend dependencies already installed - skipping
)

if not exist "frontend\node_modules" (
  echo  [2/4] Installing frontend dependencies...
  call npm install --prefix frontend || goto :fail
) else (
  echo  [2/4] Frontend dependencies already installed - skipping
)

if not exist "node_modules" (
  echo  [3/4] Installing root dependencies...
  call npm install || goto :fail
) else (
  echo  [3/4] Root dependencies already installed - skipping
)

echo  [4/4] Starting backend + frontend  (press Ctrl+C here to stop both)
echo         Chrome will open http://localhost:%PORT% as soon as Vite is ready...
echo.

rem --- write the browser-opener as a real .ps1 (no cmd quoting pitfalls) -----
set "PSWAIT=%TEMP%\syncspace-open-browser.ps1"
>  "%PSWAIT%" echo $port = %PORT%
>> "%PSWAIT%" echo $url = 'http://localhost:' + $port
>> "%PSWAIT%" echo for ($i = 0; $i -lt 240; $i++^) {
>> "%PSWAIT%" echo   $c = New-Object Net.Sockets.TcpClient
>> "%PSWAIT%" echo   try {
>> "%PSWAIT%" echo     $c.Connect('localhost', $port^)
>> "%PSWAIT%" echo     $c.Close(^)
>> "%PSWAIT%" echo     try { Start-Process chrome $url -ErrorAction Stop }
>> "%PSWAIT%" echo     catch { Start-Process $url }
>> "%PSWAIT%" echo     break
>> "%PSWAIT%" echo   } catch { $c.Close(^); Start-Sleep -Milliseconds 500 }
>> "%PSWAIT%" echo }

start "open-browser" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%PSWAIT%"

rem foreground: the actual dev servers, logs visible, Ctrl+C works
call npm run dev
goto :eof

:fail
echo.
echo  [ERROR] npm install failed - see the message above, fix it, and re-run dev.bat
pause
exit /b 1