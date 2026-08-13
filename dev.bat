@echo off
setlocal EnableExtensions EnableDelayedExpansion
title SyncSpace - Dev Launcher

rem ============================================================================
rem  SyncSpace - one-click local dev launcher (Windows 10 / 11)
rem
rem  Just double-click this file. It will:
rem    1. Validate prerequisites (Node.js, npm, project layout).
rem    2. Install backend / frontend dependencies only if they are missing.
rem    3. Create frontend\.env from .env.example if it does not exist.
rem    4. Detect port conflicts / already-running instances and offer to fix.
rem    5. Start the BACKEND in its own window, then wait until it is actually
rem       answering on http://localhost:5000/api/health.
rem    6. Start the FRONTEND in its own window, then wait until Vite is serving.
rem    7. Open the app in Google Chrome (falls back to the default browser).
rem
rem  Each server runs in its own window so both logs stay visible. Close a
rem  window (or press Ctrl+C in it) to stop that server. This launcher window
rem  can be closed safely once everything is up - the servers keep running.
rem
rem  Everything is relative to THIS file, so it works from any clone location
rem  and tolerates spaces in folder names.
rem ============================================================================

rem --- always operate from the folder that contains this script --------------
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  Configuration (change here if your ports ever move)
rem ---------------------------------------------------------------------------
set "BACKEND_PORT=5000"
set "FRONTEND_PORT=5173"
set "APP_URL=http://localhost:%FRONTEND_PORT%"
set "HEALTH_URL=http://localhost:%BACKEND_PORT%/api/health"
set "BACKEND_DIR=%~dp0backend"
set "FRONTEND_DIR=%~dp0frontend"
set "SKIP_BACKEND="
set "SKIP_FRONTEND="

rem ---------------------------------------------------------------------------
rem  Colored output (ANSI). Uses PowerShell to emit a real ESC char.
rem ---------------------------------------------------------------------------
set "ESC="
for /f %%A in ('powershell -NoProfile -Command "[char]27" 2^>nul') do set "ESC=%%A"
if defined ESC (
  set "C_RESET=%ESC%[0m"
  set "C_BOLD=%ESC%[1m"
  set "C_RED=%ESC%[91m"
  set "C_GREEN=%ESC%[92m"
  set "C_YELL=%ESC%[93m"
  set "C_CYAN=%ESC%[96m"
) else (
  set "C_RESET=" & set "C_BOLD=" & set "C_RED=" & set "C_GREEN=" & set "C_YELL=" & set "C_CYAN="
)

echo.
echo   %C_BOLD%%C_CYAN%SyncSpace%C_RESET%  -  one-click dev launcher
echo   ---------------------------------------------

rem ===========================================================================
rem  1) PREREQUISITES
rem ===========================================================================
call :step "Checking prerequisites..."

where node >nul 2>nul
if errorlevel 1 (
  set "DIE_MSG=Node.js is not installed or not on your PATH."
  set "DIE_FIX=Install the LTS build from https://nodejs.org , then reopen dev.bat."
  goto :fatal
)
call :ok "Node.js found."

where npm >nul 2>nul
if errorlevel 1 (
  set "DIE_MSG=npm is not installed or not on your PATH."
  set "DIE_FIX=npm ships with Node.js - reinstall Node.js from https://nodejs.org ."
  goto :fatal
)
call :ok "npm found."

if not exist "%BACKEND_DIR%\" (
  set "DIE_MSG=The 'backend' folder was not found next to dev.bat."
  set "DIE_FIX=Keep dev.bat in the project root that contains the 'backend' and 'frontend' folders."
  goto :fatal
)
call :ok "backend folder found."

if not exist "%FRONTEND_DIR%\" (
  set "DIE_MSG=The 'frontend' folder was not found next to dev.bat."
  set "DIE_FIX=Keep dev.bat in the project root that contains the 'backend' and 'frontend' folders."
  goto :fatal
)
call :ok "frontend folder found."

if not exist "%BACKEND_DIR%\package.json" (
  set "DIE_MSG=backend\package.json is missing."
  set "DIE_FIX=The backend project looks incomplete. Re-clone or restore the repository."
  goto :fatal
)
if not exist "%FRONTEND_DIR%\package.json" (
  set "DIE_MSG=frontend\package.json is missing."
  set "DIE_FIX=The frontend project looks incomplete. Re-clone or restore the repository."
  goto :fatal
)
call :ok "package.json present in both projects."

rem ===========================================================================
rem  2) ENVIRONMENT FILES
rem     No variables are mandatory: the backend runs in memory-only mode with
rem     safe defaults. We just make sure frontend\.env exists when an example
rem     is provided, so deployment config has a home later.
rem ===========================================================================
call :step "Checking environment files..."

if exist "%FRONTEND_DIR%\.env" (
  call :ok "frontend\.env present."
) else if exist "%~dp0.env.example" (
  copy /y "%~dp0.env.example" "%FRONTEND_DIR%\.env" >nul 2>nul
  if exist "%FRONTEND_DIR%\.env" (
    call :warn "frontend\.env was missing - created it from .env.example."
  ) else (
    call :warn "Could not create frontend\.env from .env.example - continuing with defaults."
  )
) else (
  call :info "No .env needed - safe defaults are built in."
)
call :info "No mandatory env vars. Set MONGO_URI in a backend .env only if you want persistence."

rem ===========================================================================
rem  3) DEPENDENCIES  (install only when node_modules is absent)
rem ===========================================================================
call :step "Checking dependencies..."

if exist "%BACKEND_DIR%\node_modules" (
  call :ok "Backend dependencies already installed."
) else (
  call :info "Installing backend dependencies - first run may take a minute..."
  pushd "%BACKEND_DIR%"
  call npm install
  set "RC=!ERRORLEVEL!"
  popd
  if not "!RC!"=="0" (
    set "DIE_MSG=Installing backend dependencies failed."
    set "DIE_FIX=Check your internet connection and the npm errors above, then re-run dev.bat."
    goto :fatal
  )
  call :ok "Backend dependencies installed."
)

if exist "%FRONTEND_DIR%\node_modules" (
  call :ok "Frontend dependencies already installed."
) else (
  call :info "Installing frontend dependencies - first run may take a minute..."
  pushd "%FRONTEND_DIR%"
  call npm install
  set "RC=!ERRORLEVEL!"
  popd
  if not "!RC!"=="0" (
    set "DIE_MSG=Installing frontend dependencies failed."
    set "DIE_FIX=Check your internet connection and the npm errors above, then re-run dev.bat."
    goto :fatal
  )
  call :ok "Frontend dependencies installed."
)

rem ===========================================================================
rem  4) PORT / DUPLICATE-INSTANCE HANDLING
rem ===========================================================================
call :step "Checking ports and running instances..."

call :handle_port "backend"  %BACKEND_PORT%  SKIP_BACKEND
if errorlevel 2 goto :port_abort
call :handle_port "frontend" %FRONTEND_PORT% SKIP_FRONTEND
if errorlevel 2 goto :port_abort

goto :launch

:port_abort
set "DIE_MSG=Startup aborted because a required port was busy."
set "DIE_FIX=Close whatever is using the port, or choose Restart next time."
goto :fatal

rem ===========================================================================
rem  5) START SERVERS  (each in its own window) + READINESS CHECKS
rem ===========================================================================
:launch

rem ---- Backend ------------------------------------------------------------
call :step "Starting backend..."
if defined SKIP_BACKEND (
  call :info "Reusing the backend that is already running."
) else (
  start "SyncSpace Backend  [port %BACKEND_PORT%]" /D "%BACKEND_DIR%" cmd /k npm run dev
  call :info "Backend window opened. Waiting for it to respond on %HEALTH_URL% ..."
)

call :wait_ready "%HEALTH_URL%" 90
if errorlevel 1 (
  set "DIE_MSG=The backend did not become ready in time."
  set "DIE_FIX=Open the 'SyncSpace Backend' window and read its log. Common causes: a startup crash, or port %BACKEND_PORT% blocked by another app."
  goto :fatal
)
call :ok "Backend started successfully."

rem ---- Frontend -----------------------------------------------------------
call :step "Starting frontend..."
if defined SKIP_FRONTEND (
  call :info "Reusing the frontend that is already running."
) else (
  start "SyncSpace Frontend  [port %FRONTEND_PORT%]" /D "%FRONTEND_DIR%" cmd /k npm run dev
  call :info "Frontend window opened. Waiting for Vite to serve %APP_URL% ..."
)

call :wait_ready "%APP_URL%" 90
if errorlevel 1 (
  set "DIE_MSG=The frontend dev server did not become ready in time."
  set "DIE_FIX=Open the 'SyncSpace Frontend' window and read its log. Common causes: a Vite error, or port %FRONTEND_PORT% blocked by another app."
  goto :fatal
)
call :ok "Frontend started successfully."

rem ===========================================================================
rem  6) OPEN THE APP IN CHROME (fallback: default browser)
rem ===========================================================================
call :step "Opening application in Chrome..."

set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if defined CHROME (
  start "" "%CHROME%" "%APP_URL%"
  call :ok "Opened %APP_URL% in Chrome."
) else (
  call :warn "Chrome not found in the usual locations - opening your default browser instead."
  start "" "%APP_URL%"
)

rem ===========================================================================
rem  7) SUCCESS SUMMARY
rem ===========================================================================
call :step "Project launched successfully."
echo.
echo    %C_GREEN%Backend %C_RESET%  -^>  http://localhost:%BACKEND_PORT%    ^(window: "SyncSpace Backend"^)
echo    %C_GREEN%Frontend%C_RESET%  -^>  %APP_URL%    ^(window: "SyncSpace Frontend"^)
echo.
echo    Both servers run in their own windows - close a window or press Ctrl+C
echo    in it to stop that server. You can close THIS launcher window safely.
echo.
pause
exit /b 0

rem ===========================================================================
rem  SUBROUTINES
rem ===========================================================================

:step
echo.
echo %C_BOLD%%C_CYAN%:: %~1%C_RESET%
exit /b 0

:ok
echo    %C_GREEN%[ OK ]%C_RESET% %~1
exit /b 0

:warn
echo    %C_YELL%[WARN]%C_RESET% %~1
exit /b 0

:info
echo    %C_CYAN%[ .. ]%C_RESET% %~1
exit /b 0

rem --- handle_port <name> <port> <skipVarName> : 0 = proceed, 2 = abort -------
:handle_port
call :check_port %~2
if not defined PID_ON_PORT (
  call :ok "Port %~2 (%~1) is free."
  exit /b 0
)
call :warn "Port %~2 (%~1) is in use by %PROC_NAME% [PID %PID_ON_PORT%]."
echo         %C_CYAN%[R]%C_RESET% Restart it   stop that process and start fresh
echo         %C_CYAN%[U]%C_RESET% Use it       assume %~1 is already running
echo         %C_CYAN%[A]%C_RESET% Abort
choice /c RUA /n /m "         Choose R / U / A: "
set "CH=!ERRORLEVEL!"
if "!CH!"=="3" exit /b 2
if "!CH!"=="2" (
  set "%~3=1"
  call :info "Keeping the existing %~1 on port %~2."
  exit /b 0
)
call :free_port %PID_ON_PORT%
call :ok "Freed port %~2."
exit /b 0

rem --- check_port <port> : sets PID_ON_PORT + PROC_NAME if a LISTENING socket
rem     is bound to that port, otherwise clears them ----------------------------
:check_port
set "PID_ON_PORT="
set "PROC_NAME="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /c:":%~1 "') do set "PID_ON_PORT=%%p"
if not defined PID_ON_PORT (
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /c:":%~1"') do set "PID_ON_PORT=%%p"
)
if not defined PID_ON_PORT exit /b 1
set "PROC_NAME=unknown"
for /f "tokens=1 delims=," %%n in ('tasklist /fi "PID eq %PID_ON_PORT%" /fo csv /nh 2^>nul') do set "PROC_NAME=%%~n"
exit /b 0

rem --- free_port <pid> : force-stop a process tree -----------------------------
:free_port
taskkill /PID %~1 /F /T >nul 2>nul
>nul ping -n 2 127.0.0.1
exit /b 0

rem --- wait_ready <url> <timeoutSeconds> : exit 0 when the URL answers, else 1 -
:wait_ready
powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='%~1'; $deadline=(Get-Date).AddSeconds(%~2); while((Get-Date) -lt $deadline){ try{ $r=Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop; if([int]$r.StatusCode -ge 200 -and [int]$r.StatusCode -lt 500){ exit 0 } }catch{}; Start-Sleep -Milliseconds 500 }; exit 1"
exit /b %ERRORLEVEL%

rem --- fatal error exit --------------------------------------------------------
:fatal
echo.
echo    %C_RED%%C_BOLD%[ERROR]%C_RESET% %C_RED%%DIE_MSG%%C_RESET%
echo           %DIE_FIX%
echo.
echo    Nothing was left half-started. Fix the issue above and run dev.bat again.
echo.
pause
exit /b 1
