#!/bin/bash
# Запуск Asher CRM на Mac: двойной щелчок по этому файлу.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Не найден Node.js — бесплатная программа, которая запускает систему."
  echo "  Сейчас откроется сайт nodejs.org: скачайте версию LTS, установите"
  echo "  как обычную программу и запустите этот файл ещё раз."
  echo
  open "https://nodejs.org/" 2>/dev/null
  read -r -p "  Нажмите Enter, чтобы закрыть... "
  exit 1
fi

if ! node -e "require('node:sqlite')" >/dev/null 2>&1; then
  echo
  echo "  Ваша версия Node.js устарела. Скачайте свежую (LTS) с nodejs.org,"
  echo "  установите поверх старой и запустите этот файл снова."
  echo
  open "https://nodejs.org/" 2>/dev/null
  read -r -p "  Нажмите Enter, чтобы закрыть... "
  exit 1
fi

echo
echo "  Запускаю Asher CRM..."
echo "  НЕ ЗАКРЫВАЙТЕ это окно, пока работаете с системой."
echo

# Браузер откроет сама система: только она знает, какой порт оказался свободен
export ASHER_OPEN=1
node server.js
