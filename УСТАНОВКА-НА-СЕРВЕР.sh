#!/usr/bin/env bash
#
# Установка Asher на сервер с доменом и https — одной командой.
#
# Запускать на ЧИСТОМ сервере Ubuntu 22.04/24.04 от root:
#
#   bash УСТАНОВКА-НА-СЕРВЕР.sh diamonds.kg
#
# Скрипт ставит Node.js, саму систему, службу автозапуска и Caddy, который
# сам получает и продлевает сертификат https. Ничего лишнего на сервере
# не появляется: базе не нужен ни отдельный сервер СУБД, ни внешние библиотеки.
#
# ВАЖНО: до запуска домен уже должен указывать на этот сервер (запись A).
# Иначе Caddy не сможет получить сертификат — проверку проходит тот, на кого
# указывает домен.

set -euo pipefail

DOMAIN="${1:-}"
REPO="${2:-https://github.com/djaha12/Asher.git}"
BRANCH="${3:-claude/jewelry-crm-app-sqicde}"
APP_DIR=/home/asher/app
APP_USER=asher

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
die() { printf '\n\033[31m%s\033[0m\n\n' "$1" >&2; exit 1; }

[ -n "$DOMAIN" ] || die "Укажите домен: bash УСТАНОВКА-НА-СЕРВЕР.sh diamonds.kg"
[ "$(id -u)" = 0 ] || die "Запускать от root: sudo bash УСТАНОВКА-НА-СЕРВЕР.sh $DOMAIN"

say "1/8. Проверяю, что домен $DOMAIN указывает на этот сервер"
SERVER_IP="$(curl -fsS --max-time 10 https://api.ipify.org || echo '')"
DOMAIN_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || echo '')"
if [ -z "$DOMAIN_IP" ]; then
  die "Домен $DOMAIN никуда не указывает.
  Зайдите к регистратору домена и добавьте запись:
      Тип: A      Имя: @      Значение: ${SERVER_IP:-<адрес этого сервера>}
  Обновление адреса занимает от нескольких минут до пары часов.
  После этого запустите скрипт заново."
fi
if [ -n "$SERVER_IP" ] && [ "$DOMAIN_IP" != "$SERVER_IP" ]; then
  die "Домен $DOMAIN указывает на $DOMAIN_IP, а этот сервер — $SERVER_IP.
  Поправьте запись A у регистратора и запустите скрипт заново."
fi
echo "   домен указывает сюда — можно продолжать"

say "2/8. Обновляю сервер и ставлю нужное"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git ufw >/dev/null

say "3/8. Ставлю Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v | sed 's/^/   Node.js /'

say "4/8. Ставлю Caddy — он выдаёт и продлевает сертификат https сам"
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

say "5/8. Разворачиваю систему в $APP_DIR"
id -u "$APP_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$APP_USER"
if [ -d "$APP_DIR/.git" ]; then
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
else
  sudo -u "$APP_USER" git clone --quiet --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
sudo -u "$APP_USER" mkdir -p "$APP_DIR/data"

say "6/8. Настраиваю автозапуск"
cat >/etc/systemd/system/asher.service <<UNIT
[Unit]
Description=Asher CRM
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=PORT=3000
Environment=NO_OPEN=1
# Обязательно: снаружи https через Caddy, внутрь идёт обычный http.
# Без этого в журнале вместо адресов посетителей будет 127.0.0.1,
# а защита от подбора пароля посчитает весь интернет одним посетителем.
Environment=ASHER_TRUST_PROXY=1
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
# Система пишет только в свою папку — остальной сервер ей не нужен.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=$APP_DIR

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now asher >/dev/null
sleep 2
systemctl is-active --quiet asher || die "Система не запустилась. Посмотрите: journalctl -u asher -n 50"

say "7/8. Включаю https для $DOMAIN"
cat >/etc/caddy/Caddyfile <<CADDY
$DOMAIN {
    reverse_proxy 127.0.0.1:3000
    # Фотографии изделий приезжают с телефонов целыми файлами.
    request_body {
        max_size 30MB
    }
}
CADDY
systemctl reload caddy || systemctl restart caddy

say "8/8. Закрываю всё лишнее снаружи"
ufw allow 22,80,443/tcp >/dev/null
ufw --force enable >/dev/null
# Порт 3000 наружу не открываем: до системы должны доходить только через https.

say "Проверяю, что домен открывается"
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://$DOMAIN/api/ping" | grep -q asher; then
    OK=1; break
  fi
  sleep 3
done

if [ "${OK:-}" = 1 ]; then
  cat <<DONE

  ======================================================================
   Готово. Система работает: https://$DOMAIN
  ======================================================================

  Что сделать прямо сейчас:

   1. Зайти под admin и СМЕНИТЬ ПАРОЛЬ — Настройки → Мой пароль.
   2. Проверить Настройки → Безопасность: все строки должны быть зелёными.
   3. Раздать продавцам новые карточки подключения:
      Настройки → Сотрудники → 📱 у каждого. В коде уже будет $DOMAIN.

  Перенести данные с компьютера магазина (выполнять НА КОМПЬЮТЕРЕ):

      scp data/asher.db root@$(curl -fsS https://api.ipify.org):$APP_DIR/data/asher.db
      scp -r data/images root@$(curl -fsS https://api.ipify.org):$APP_DIR/data/

   после копирования на сервере: systemctl restart asher

  Полезные команды на сервере:
      systemctl status asher      — как себя чувствует
      systemctl restart asher     — перезапустить
      journalctl -u asher -n 50   — что писала система
      cd $APP_DIR && sudo -u $APP_USER git pull && systemctl restart asher   — обновление

DONE
else
  die "Система запущена, но https://$DOMAIN пока не отвечает.
  Чаще всего это значит, что сертификат ещё выдаётся — подождите пару минут
  и откройте адрес в браузере. Если не поможет: journalctl -u caddy -n 50"
fi
