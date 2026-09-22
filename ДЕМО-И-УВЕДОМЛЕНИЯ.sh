#!/usr/bin/env bash
#
# Сервер для приложения на iPhone: демо-версия и ключ уведомлений.
#
# Запускает робот GitHub «Сервер для приложения»; можно и руками, от root:
#
#   bash ДЕМО-И-УВЕДОМЛЕНИЯ.sh diamonds.kg
#   bash ДЕМО-И-УВЕДОМЛЕНИЯ.sh diamonds.kg /root/AuthKey.p8 KEYID12345 TEAMID1234
#
# 1. Ключ уведомлений Apple (если передан). Кладётся в /etc/asher; службы
#    узнают о нём из маленького дополнительного файла настроек
#    (asher.service.d/apns.conf). Сами службы не переписываются — они
#    остаются такими, какими их поставил установщик.
#
# 2. Демо-версия. Apple пускает приложение в App Store, только если
#    проверяющий может в нём поработать. В рабочей системе — настоящие
#    клиенты и деньги магазина, показывать их чужому человеку нельзя. Поэтому
#    рядом работает вторая система с выдуманными данными: demo.<домен>,
#    вход admin / admin123. Код у неё общий с рабочей (и обновляется вместе
#    с ней), а данные свои — в /home/asher/demo. Папки с данными рабочей
#    системы службе демо-версии недоступны вовсе: даже ошибка в коде не даст
#    ей их прочесть. Каждый день данные демо-версии обновляются
#    (src/демо-сброс.js), а вошедших это не выкидывает.
#
# 3. Адрес demo.<домен> с https — если у домена уже есть такая запись.
#
# Повторный запуск безопасен: сделанное остаётся, меняется только то,
# что изменилось. Рабочая система перезапускается, только если сменился ключ.

set -euo pipefail

# Имена переменных латиницей: кириллические bash не принимает (см. ОБНОВИТЬ-НА-СЕРВЕРЕ.sh).
DOMAIN="${1:-}"
KEY_FILE="${2:-}"
KEY_ID="${3:-}"
TEAM_ID="${4:-}"

APP_DIR=/home/asher/app
APP_USER=asher
DEMO_DIR=/home/asher/demo
DEMO_PORT=3001
MAIN_PORT=3000
KEY_DIR=/etc/asher
UNITS=/etc/systemd/system
CADDY=/etc/caddy/Caddyfile

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
die() { printf '\n\033[31m%s\033[0m\n\n' "$1" >&2; exit 1; }

# Записать файл, только если содержимое другое. Ответ: 0 — записан, 1 — не менялся.
write_if_changed() {
  local target="$1"
  local body="$2"
  if [ -f "$target" ] && [ "$(cat "$target")" = "$body" ]; then
    return 1
  fi
  mkdir -p "$(dirname "$target")"
  printf '%s\n' "$body" >"$target"
  return 0
}

# Ждём, пока система на порту ответит. Ответ: 0 — ответила.
wait_ping() {
  local port="$1"
  for try in $(seq 1 30); do
    if curl -fsS --max-time 3 "http://127.0.0.1:$port/api/ping" 2>/dev/null | grep -q asher; then
      return 0
    fi
    sleep 1
  done
  return 1
}

[ "$(id -u)" = 0 ] || die "Запускать от root."
[ -n "$DOMAIN" ] || die "Укажите домен: bash $0 diamonds.kg"
DOMAIN="$(printf '%s' "$DOMAIN" | tr -d '[:space:]' | tr 'A-Z' 'a-z')"
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN%%/*}"
case "$DOMAIN" in
  "" | *[!a-z0-9.-]*) die "Странный домен: «$DOMAIN»." ;;
esac
[ -f "$APP_DIR/server.js" ] || die "В $APP_DIR нет системы — сначала установка (УСТАНОВКА-НА-СЕРВЕР.sh)."
[ -f "$APP_DIR/src/демо-сброс.js" ] || die "На сервере старая версия системы, в ней нет демо-версии.
  Сначала обновите систему (робот «Обновление сервера» или ОБНОВИТЬ-НА-СЕРВЕРЕ.sh)."
id "$APP_USER" >/dev/null 2>&1 || die "Нет пользователя $APP_USER — система ставилась не установщиком."

# ---------------------------------------------------------------------------
say "1/4. Ключ уведомлений Apple"

PUSH_CONF=""
if [ -n "$KEY_FILE" ]; then
  [ -f "$KEY_FILE" ] || die "Нет файла ключа: $KEY_FILE"
  printf '%s' "$KEY_ID" | grep -Eq '^[A-Z0-9]{10}$' \
    || die "Номер ключа (Key ID) — 10 латинских букв и цифр, а пришло: «$KEY_ID»."
  printf '%s' "$TEAM_ID" | grep -Eq '^[A-Z0-9]{10}$' \
    || die "Номер команды (Team ID) — 10 латинских букв и цифр, а пришло: «$TEAM_ID»."
  grep -q 'BEGIN PRIVATE KEY' "$KEY_FILE" || die "Файл не похож на ключ Apple (.p8)."
  install -d -m 750 -o root -g "$APP_USER" "$KEY_DIR"
  install -m 640 -o root -g "$APP_USER" "$KEY_FILE" "$KEY_DIR/apns.p8"
  # Ключ проверяем глазами самой системы: от её имени и её же Node.
  sudo -u "$APP_USER" node -e 'require("node:crypto").createPrivateKey(require("node:fs").readFileSync(process.argv[1]))' \
    "$KEY_DIR/apns.p8" 2>/dev/null || die "Ключ не читается — вероятно, испорчен при копировании."
  PUSH_CONF="[Service]
Environment=ASHER_APNS_KEY_FILE=$KEY_DIR/apns.p8
Environment=ASHER_APNS_KEY_ID=$KEY_ID
Environment=ASHER_APNS_TEAM_ID=$TEAM_ID"
  echo "   ключ $KEY_ID (команда $TEAM_ID) лежит в $KEY_DIR"
elif [ -f "$UNITS/asher.service.d/apns.conf" ]; then
  PUSH_CONF="$(cat "$UNITS/asher.service.d/apns.conf")"
  echo "   ключ поставлен раньше — оставляю как есть"
else
  echo "   ключа нет — уведомления на телефоны пока выключены (система работает и без них)"
fi

MAIN_CHANGED=0
DEMO_PUSH_CHANGED=0
if [ -n "$PUSH_CONF" ]; then
  if write_if_changed "$UNITS/asher.service.d/apns.conf" "$PUSH_CONF"; then MAIN_CHANGED=1; fi
  if write_if_changed "$UNITS/asher-demo.service.d/apns.conf" "$PUSH_CONF"; then DEMO_PUSH_CHANGED=1; fi
fi

if [ "$MAIN_CHANGED" = 1 ]; then
  systemctl daemon-reload
  systemctl restart asher
  if wait_ping "$MAIN_PORT"; then
    echo "   рабочая система перезапущена с ключом и отвечает"
  else
    # Магазин не должен остаться без кассы из-за уведомлений: убираем ключ и поднимаем как было.
    rm -f "$UNITS/asher.service.d/apns.conf"
    systemctl daemon-reload
    systemctl restart asher
    wait_ping "$MAIN_PORT" || true
    die "С ключом рабочая система не поднялась — ключ убран, система запущена как раньше.
  Причина в журнале: journalctl -u asher -n 50"
  fi
fi

# ---------------------------------------------------------------------------
say "2/4. Демо-версия"

if ss -lnt 2>/dev/null | awk '{print $4}' | grep -q ":$DEMO_PORT\$" && ! systemctl is-active --quiet asher-demo; then
  die "Порт $DEMO_PORT занят другой программой — демо-версии нужен именно он:
  $(ss -lntp 2>/dev/null | grep ":$DEMO_PORT " | head -1)"
fi
install -d -m 750 -o "$APP_USER" -g "$APP_USER" "$DEMO_DIR"

DEMO_UNIT="[Unit]
Description=Asher CRM demo (sample data for first-time visitors and App Store review)
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=PORT=$DEMO_PORT
Environment=NO_OPEN=1
Environment=ASHER_STRICT_PORT=1
Environment=ASHER_TRUST_PROXY=1
Environment=ASHER_DEMO=1
Environment=ASHER_DB=$DEMO_DIR/asher.db
Environment=ASHER_MEDIA=$DEMO_DIR/images
Environment=ASHER_SYNC_DIR=$DEMO_DIR/1c
Environment=ASHER_BACKUP_DIR=$DEMO_DIR/backups
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=$DEMO_DIR
InaccessiblePaths=-$APP_DIR/data -$APP_DIR/РЕЗЕРВНЫЕ-КОПИИ -$APP_DIR/1С-ОБМЕН

[Install]
WantedBy=multi-user.target"

# Ночной сброс: служба останавливается, данные обновляются, служба запускается
# снова — даже если обновление не удалось (trap), чтобы демо не осталось лежать.
RESET_SCRIPT="#!/usr/bin/env bash
# Ежедневное обновление данных демо-версии Asher. Ставит ДЕМО-И-УВЕДОМЛЕНИЯ.sh.
set -euo pipefail
trap 'systemctl start asher-demo' EXIT
systemctl stop asher-demo
cd $APP_DIR
sudo -u $APP_USER env ASHER_DEMO=1 ASHER_DB=$DEMO_DIR/asher.db ASHER_MEDIA=$DEMO_DIR/images node src/демо-сброс.js"

RESET_UNIT="[Unit]
Description=Asher CRM demo daily refresh

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/asher-demo-reset"

# 10:00 по UTC — ночь в Америке, где работает большая часть проверяющих Apple,
# и день в Бишкеке, когда демо-версией никто из своих не пользуется.
RESET_TIMER="[Unit]
Description=Asher CRM demo daily refresh

[Timer]
OnCalendar=*-*-* 10:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target"

DEMO_CHANGED=0
if write_if_changed "$UNITS/asher-demo.service" "$DEMO_UNIT"; then DEMO_CHANGED=1; fi
write_if_changed /usr/local/sbin/asher-demo-reset "$RESET_SCRIPT" || true
chmod 755 /usr/local/sbin/asher-demo-reset
write_if_changed "$UNITS/asher-demo-reset.service" "$RESET_UNIT" || true
write_if_changed "$UNITS/asher-demo-reset.timer" "$RESET_TIMER" || true
systemctl daemon-reload
systemctl enable asher-demo >/dev/null 2>&1
systemctl enable --now asher-demo-reset.timer >/dev/null 2>&1

if [ ! -f "$DEMO_DIR/asher.db" ]; then
  echo "   наполняю демо-версию выдуманными данными"
  /usr/local/sbin/asher-demo-reset || die "Не удалось наполнить демо-версию. Рабочую систему это не затрагивает."
elif [ "$DEMO_CHANGED" = 1 ] || [ "$DEMO_PUSH_CHANGED" = 1 ] || ! systemctl is-active --quiet asher-demo; then
  systemctl restart asher-demo
fi
wait_ping "$DEMO_PORT" || die "Демо-версия не запустилась. Причина: journalctl -u asher-demo -n 50
  Рабочую систему это не затрагивает."
echo "   демо-версия работает (внутри сервера, порт $DEMO_PORT)"
if ! systemctl show asher-demo -p InaccessiblePaths | grep -q "$APP_DIR/data"; then
  echo "   ВНИМАНИЕ: systemd не подтвердил, что папка данных рабочей системы закрыта для демо-версии."
fi

# ---------------------------------------------------------------------------
say "3/4. Адрес demo.$DOMAIN"

DEMO_HOST="demo.$DOMAIN"
MAIN_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || echo '')"
DEMO_IP="$(getent ahostsv4 "$DEMO_HOST" | awk 'NR==1{print $1}' || echo '')"
HTTPS_READY=0
if [ -z "$DEMO_IP" ]; then
  echo "   У домена ещё нет адреса $DEMO_HOST. Добавьте у регистратора домена запись:"
  echo "       Тип: A      Имя: demo      Значение: ${MAIN_IP:-<адрес этого сервера>}"
  echo "   и запустите этот скрипт (или робота) ещё раз — остальное он сделает сам."
elif [ -n "$MAIN_IP" ] && [ "$DEMO_IP" != "$MAIN_IP" ]; then
  echo "   $DEMO_HOST указывает на $DEMO_IP, а $DOMAIN — на $MAIN_IP."
  echo "   Поправьте запись demo у регистратора: значение должно быть $MAIN_IP."
else
  [ -f "$CADDY" ] || die "Нет $CADDY — Caddy ставит установщик."
  if grep -q "^$DEMO_HOST {" "$CADDY"; then
    echo "   $DEMO_HOST уже настроен"
  else
    cp "$CADDY" "$CADDY.до-демо"
    cat >>"$CADDY" <<CADDYBLOCK

$DEMO_HOST {
    reverse_proxy 127.0.0.1:$DEMO_PORT
    request_body {
        max_size 30MB
    }
}
CADDYBLOCK
    if ! caddy validate --config "$CADDY" --adapter caddyfile >/dev/null 2>&1; then
      cp "$CADDY.до-демо" "$CADDY"
      die "Caddy не принял новые настройки — вернул прежние. Рабочий сайт не затронут."
    fi
    if ! systemctl reload caddy; then
      cp "$CADDY.до-демо" "$CADDY"
      systemctl reload caddy || systemctl restart caddy || true
      die "Caddy не перечитал настройки — вернул прежние. Причина: journalctl -u caddy -n 50"
    fi
    echo "   $DEMO_HOST добавлен; сертификат https Caddy получит сам"
  fi
  # Первый сертификат выдаётся за полминуты-минуту — ждём до двух.
  for try in $(seq 1 24); do
    if curl -fsS --max-time 5 "https://$DEMO_HOST/api/ping" 2>/dev/null | grep -q asher; then
      HTTPS_READY=1
      break
    fi
    sleep 5
  done
fi

# ---------------------------------------------------------------------------
say "4/4. Итог"

if wait_ping "$MAIN_PORT"; then
  echo "   рабочая система: отвечает"
else
  echo "   ВНИМАНИЕ: рабочая система не ответила — посмотрите: journalctl -u asher -n 50"
fi
if [ -n "$PUSH_CONF" ]; then
  echo "   уведомления на телефоны: ключ установлен"
else
  echo "   уведомления на телефоны: ключа нет"
fi
if [ "$HTTPS_READY" = 1 ]; then
  echo "   демо-версия: https://$DEMO_HOST — вход admin / admin123"
else
  echo "   демо-версия: работает внутри сервера, снаружи пока не открывается (см. шаг 3)"
fi
echo
