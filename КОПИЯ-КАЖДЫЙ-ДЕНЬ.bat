@echo off
rem Only ASCII here on purpose: Windows cmd may silently abort a batch file
rem that contains Cyrillic text. All Russian output lives in
rem src/backup-windows.ps1 - PowerShell handles Cyrillic just fine.
rem
rem PowerShell and not Node.js on purpose too: after the move to a server the
rem system no longer runs on this computer, so Node.js may be gone. PowerShell
rem ships with every Windows.
chcp 65001 >nul
title Kopiya kazhdyy den
cd /d "%~dp0"

if not exist "%~dp0src\backup-windows.ps1" (
  echo.
  echo  Fail src\backup-windows.ps1 ne nayden.
  echo  Zapuskayte etot fail iz papki s sistemoy, ne kopiruyte otdelno.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0src\backup-windows.ps1"
if errorlevel 1 pause
