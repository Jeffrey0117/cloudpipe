@echo off
title CloudPipe
cd /d "%~dp0"

echo.
echo   CloudPipe - Local Deploy Gateway
echo   ================================
echo.

echo [1/2] Starting server...
start /B node index.js

timeout /t 2 /nobreak >nul

echo [2/2] Starting tunnel...
C:\Users\jeffb\cloudflared.exe tunnel --config cloudflared.yml run cloudpipe

pause
