@echo off
title CloudPipe - Stop
cd /d "%~dp0"

echo.
echo   CloudPipe - Stopping Services
echo   =============================
echo.

echo [1/2] Stopping PM2 process...
pm2 stop cloudpipe
pm2 delete cloudpipe

echo [2/2] Done!
echo.

pause
