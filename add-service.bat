@echo off
title Cloudpipe - Add Service
cd /d "%~dp0"

echo.
echo ========================================
echo   CLOUDPIPE - Add New Service
echo ========================================
echo.
echo Edit config.json to add a new service:
echo.
echo   For PROXY (forward to another API):
echo   {
echo     "name": "my-proxy",
echo     "enabled": true,
echo     "type": "proxy",
echo     "target": "https://api.example.com",
echo     "subdomain": "myapi",
echo     "port": 8787
echo   }
echo.
echo   For CUSTOM (your own code):
echo   {
echo     "name": "my-api",
echo     "enabled": true,
echo     "type": "custom",
echo     "entry": "servers/custom/my-api.js",
echo     "subdomain": "myapi",
echo     "port": 8788
echo   }
echo.
echo Then copy servers/custom/example.js as template
echo.
pause
