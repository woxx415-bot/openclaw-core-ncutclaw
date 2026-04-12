@echo off
setlocal enabledelayedexpansion

:: NCUTclaw OpenClaw CLI Wrapper for Windows
:: Automatically sets the correct environment variables and paths
:: Usage: openclaw-win.cmd <command> [args...]

:: Read ncutclaw state dir
set "NCUTCLAW_STATE_DIR=%USERPROFILE%\.ncutclaw"
set "OPENCLAW_STATE_DIR=%NCUTCLAW_STATE_DIR%"

:: Find Node.js binary (prefer NCUTclaw's bundled Electron Node)
set "NODE_BIN="
where node >nul 2>nul && set "NODE_BIN=node"

if "%NODE_BIN%"=="" (
    echo [ncutclaw-openclaw] Error: Node.js not found
    echo Please ensure Node.js is installed or NCUTclaw is running.
    exit /b 1
)

:: Find openclaw entry point
set "OPENCLAW_ENTRY="
if exist "%NCUTCLAW_STATE_DIR%\..\NCUTclaw\openclaw-core\dist\index.js" (
    set "OPENCLAW_ENTRY=%NCUTCLAW_STATE_DIR%\..\NCUTclaw\openclaw-core\dist\index.js"
)
:: Fallback: check common install locations
if "%OPENCLAW_ENTRY%"=="" (
    for %%D in ("D:\NCUTclaw\openclaw-core\dist\index.js" "C:\NCUTclaw\openclaw-core\dist\index.js") do (
        if exist "%%~D" set "OPENCLAW_ENTRY=%%~D"
    )
)
if "%OPENCLAW_ENTRY%"=="" (
    echo [ncutclaw-openclaw] Error: OpenClaw core not found
    echo Expected at: %NCUTCLAW_STATE_DIR%\..\NCUTclaw\openclaw-core\dist\index.js
    exit /b 1
)

:: Block dangerous commands
set "CMD=%~1"
if /i "%CMD%"=="gateway" (
    set "SUBCMD=%~2"
    if /i "!SUBCMD!"=="run" goto :blocked
    if /i "!SUBCMD!"=="start" goto :blocked
    if /i "!SUBCMD!"=="stop" goto :blocked
    if /i "!SUBCMD!"=="restart" goto :blocked
    if /i "!SUBCMD!"=="install" goto :blocked
    if /i "!SUBCMD!"=="uninstall" goto :blocked
)
if /i "%CMD%"=="daemon" (
    set "SUBCMD=%~2"
    if /i "!SUBCMD!"=="start" goto :blocked
    if /i "!SUBCMD!"=="stop" goto :blocked
    if /i "!SUBCMD!"=="restart" goto :blocked
)
if /i "%CMD%"=="reset" goto :blocked
if /i "%CMD%"=="uninstall" goto :blocked

:: Execute the command
"%NODE_BIN%" "%OPENCLAW_ENTRY%" %*
exit /b %ERRORLEVEL%

:blocked
echo [ncutclaw-openclaw] BLOCKED: This command is forbidden.
echo OpenClaw service lifecycle is managed by NCUTclaw Electron.
echo Forbidden commands: gateway run/start/stop/restart, daemon start/stop/restart, reset, uninstall
exit /b 1
