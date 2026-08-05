@echo off
rem Only ASCII here on purpose: Windows cmd may silently abort a batch file
rem that contains Cyrillic text. All Russian output lives in src/install-windows.js.
chcp 65001 >nul
title Asher CRM
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js ne ustanovlen. Seychas otkroetsya sait nodejs.org:
  echo  nazhmite zelenuyu knopku LTS, ustanovite i zapustite etot fail snova.
  echo.
  start https://nodejs.org/
  pause
  exit /b 1
)

node src/install-windows.js
