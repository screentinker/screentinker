@echo off
REM ScreenTinker - Windows Kiosk Setup
REM Run as Administrator

set SERVER_URL=https://your-server-url
set PLAYER_URL=%SERVER_URL%/player

echo ==================================
echo   ScreenTinker Windows Player
echo ==================================
echo.

REM Create startup shortcut
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set SHORTCUT=%STARTUP%\ScreenTinker.url

echo [InternetShortcut] > "%SHORTCUT%"
echo URL=%PLAYER_URL% >> "%SHORTCUT%"

REM Create a VBS launcher for kiosk mode (Chrome)
set LAUNCHER=%USERPROFILE%\ScreenTinker.vbs
echo Set WshShell = CreateObject("WScript.Shell") > "%LAUNCHER%"
echo WshShell.Run """C:\Program Files\Google\Chrome\Application\chrome.exe"" --kiosk --autoplay-policy=no-user-gesture-required ""%PLAYER_URL%""", 1, False >> "%LAUNCHER%"

REM Replace startup shortcut with VBS launcher
copy /Y "%LAUNCHER%" "%STARTUP%\ScreenTinker.vbs" >nul

echo.
echo Setup complete!
echo.
echo The player will auto-start on next login.
echo To start now, open: %PLAYER_URL%
echo Or run: %LAUNCHER%
echo.
echo Press any key to launch the player now...
pause >nul
start chrome --kiosk --autoplay-policy=no-user-gesture-required "%PLAYER_URL%"
