@echo off
cd /d "%~dp0"

echo === Building ...
call npm run build
if %errorlevel% neq 0 (
    echo Build failed
    pause
    exit /b 1
)
echo Build OK

echo === Finding global npm location ...
for /f "delims=" %%i in ('npm root -g') do set GLOBAL_NM=%%i
set TARGET=%GLOBAL_NM%\@grinev\opencode-telegram-bot\dist

if not exist "%TARGET%" (
    echo Error: cannot find %TARGET%
    pause
    exit /b 1
)

echo === Copying dist to %TARGET% ...
xcopy /E /Y dist "%TARGET%" >nul
echo Done.

echo === Stopping old bot ...
wmic process where "name='node.exe' and commandline like '%%opencode-telegram%%'" delete 2>nul
timeout /t 2 /nobreak >nul

echo === Starting bot ...
start "opencode-telegram" cmd /c "opencode-telegram start --mode installed"

echo Bot started in new window.
pause
