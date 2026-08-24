#!/usr/bin/env bash
#
# Короткий вход в установку. Нужен ровно для одного:
#
# Настоящий установщик называется УСТАНОВКА-НА-СЕРВЕР.sh — по-русски, чтобы
# владелец понимал, что запускает. Но набрать это имя в консоли сервера
# нельзя: там английская раскладка и никакой вставки. А консоль в браузере
# (VNC) вставку не поддерживает вовсе — владелец набирает всё руками.
#
# Отсюда и этот файл: латиница, коротко, набирается вслепую.
#
#   curl -sL https://raw.githubusercontent.com/djaha12/Asher/HEAD/install.sh | bash -s diamonds.kg
#
# Всё, что он делает, — скачивает систему и запускает настоящий установщик.
# Ничего своего не решает: вся работа и все проверки живут там.

set -euo pipefail

DOMAIN="${1:-}"
REPO="${2:-https://github.com/djaha12/Asher.git}"
BRANCH="${3:-}"
WORK=/tmp/asher-установка

[ -n "$DOMAIN" ] || {
  printf '\n\033[31m%s\033[0m\n\n' "Укажите домен. Например:
  curl -sL https://raw.githubusercontent.com/djaha12/Asher/HEAD/install.sh | bash -s diamonds.kg" >&2
  exit 1
}
[ "$(id -u)" = 0 ] || {
  printf '\n\033[31m%s\033[0m\n\n' "Запускать от root." >&2
  exit 1
}

command -v git >/dev/null || {
  export DEBIAN_FRONTEND=noninteractive
  apt-get -o DPkg::Lock::Timeout=300 update -qq
  apt-get -o DPkg::Lock::Timeout=300 install -y -qq git
}

# Повторный запуск не должен спотыкаться об остатки прошлого.
rm -rf "$WORK"
clone_cmd=(git clone --quiet --depth 1)
[ -n "$BRANCH" ] && clone_cmd+=(--branch "$BRANCH")
"${clone_cmd[@]}" "$REPO" "$WORK"

exec bash "$WORK/УСТАНОВКА-НА-СЕРВЕР.sh" "$DOMAIN" "$REPO" "$BRANCH"
