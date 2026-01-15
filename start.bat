@echo off
title Cloudpipe
cd /d "%~dp0"

echo.
echo ========================================
echo   CLOUDPIPE - Starting Services
echo ========================================
echo.

:: Start API servers in new window
start "Cloudpipe Servers" cmd /k "node index.js"

:: Wait for servers to start
timeout /t 3 >nul

:: Start tunnel in this window
node tunnel.js

pause
