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

echo.
echo Restart the bot now!
pause
