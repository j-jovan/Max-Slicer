@echo off
rem Builds Max Slicer for Windows (installer + portable exe in the release folder).
rem Needs Node.js 20 or newer: https://nodejs.org
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org and run this again. & pause & exit /b 1)
call npm install || (pause & exit /b 1)
call npm run dist:win || (pause & exit /b 1)
echo.
echo Done. The installer and portable exe are in the release folder.
explorer release
pause
