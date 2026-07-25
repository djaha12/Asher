@echo off
chcp 65001 >nul
title Asher CRM — демо-данные
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Сначала установите Node.js — сейчас откроется сайт nodejs.org.
  echo  Нажмите зелёную кнопку, установите и запустите этот файл ещё раз.
  echo.
  start https://nodejs.org/
  pause
  exit /b 1
)

echo.
echo  Если у вас открыто чёрное окно СТАРТ — сначала закройте его!

echo.
echo  Этот файл наполняет систему ПРИМЕРАМИ для знакомства:
echo  152 изделия, клиенты, продажи, долги, две точки продаж.
echo.
echo  ВНИМАНИЕ: всё, что уже есть в системе, будет СТЁРТО.
echo  Не запускайте после того, как начали вести настоящий учёт!
echo.
set /p CONFIRM=" Наполнить примерами? Введите ДА и нажмите Enter: "
if /i not "%CONFIRM%"=="ДА" (
  echo  Отменено — ничего не изменилось.
  pause
  exit /b 0
)

node src/seed.js --reset
echo.
echo  Готово. Теперь запустите СТАРТ.bat
pause
