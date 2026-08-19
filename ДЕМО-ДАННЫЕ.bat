@echo off
rem Only ASCII here on purpose: Windows cmd may silently abort a batch file
rem that contains Cyrillic text. All Russian output lives in src/demo.js.
chcp 65001 >nul
title Asher CRM
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js ne ustanovlen - eto besplatnaya programma, vnutri kotoroy
  echo  rabotaet sistema. Seychas otkroetsya sait nodejs.org: nazhmite
  echo  zelenuyu knopku LTS, ustanovite i zapustite etot fail snova.
  echo.
  start https://nodejs.org/
  pause
  exit /b 1
)

node src/demo.js
