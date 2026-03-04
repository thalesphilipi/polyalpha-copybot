@echo off
title PolyAlpha-CopyBot - Start
color 0A

echo ==================================================
echo       PolyAlpha-CopyBot - Windows Launcher
echo ==================================================
echo.

:: Check if Node.js is installed
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo Please download and install Node.js from https://nodejs.org/
    pause
    exit
)

:: Check if dist folder exists, if not, build
if not exist "dist" (
    echo [INFO] First run detected or build missing.
    echo [INFO] Building the bot...
    call npm run build
    if %errorlevel% neq 0 (
        echo [ERROR] Build failed. Please check the logs.
        pause
        exit
    )
)

echo [INFO] Starting the bot...
echo.
call npm start

pause