@echo off
title PolyAlpha-CopyBot - Installer
color 0B

echo ==================================================
echo       PolyAlpha-CopyBot - Installer
echo ==================================================
echo.

:: Check for Node.js
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo Please download and install Node.js from https://nodejs.org/
    pause
    exit
)

echo [INFO] Installing dependencies...
echo.
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install dependencies.
    pause
    exit
)

echo.
echo [INFO] Building the bot...
echo.
call npm run build
if %errorlevel% neq 0 (
    echo [ERROR] Failed to build the bot.
    pause
    exit
)

echo.
echo [SUCCESS] Installation complete!
echo You can now use start_bot.bat to run the bot.
echo.
pause