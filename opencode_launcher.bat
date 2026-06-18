@echo off
chcp 65001 >nul
title OpenCode Launcher

echo [0/2] Killing old processes on port 4096...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :4096') do (
    taskkill /F /PID %%a 2>nul
)
timeout /t 2 /nobreak >nul

echo [1/2] Starting OpenCode Server...
start "OpenCode serve" cmd /c "opencode serve"

timeout /t 5 /nobreak >nul

echo [2/2] Starting OpenCode Telegram Bot...
start "OpenCode telegram" cmd /c "opencode-telegram start --mode installed"

