@echo off
title PolyAlpha-CopyBot - Updater
color 0E

echo ==================================================
echo       PolyAlpha-CopyBot - Updater
echo ==================================================
echo.

:: Check for Git
git --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Git is not installed!
    echo Please install Git from https://git-scm.com/
    pause
    exit
)

echo [INFO] Pulling latest changes from GitHub...
echo.
git pull
if %errorlevel% neq 0 (
    echo [ERROR] Failed to pull changes. Check your network or git status.
    pause
    exit
)

echo.
echo [INFO] Updating dependencies...
echo.
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] Failed to update dependencies.
    pause
    exit
)

echo.
echo [INFO] Rebuilding the bot...
echo.
call npm run build
if %errorlevel% neq 0 (
    echo [ERROR] Failed to rebuild.
    pause
    exit
)

echo.
echo [SUCCESS] Update complete!
echo You can now use start_bot.bat to run the updated bot.
echo.
pause