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
if [ -z "$SERVER_IP" ]; then
  # Не смогли узнать свой внешний адрес — значит и сравнить не с чем.
  # Говорим об этом прямо, а не делаем вид, что проверка прошла.
  echo "   ВНИМАНИЕ: не удалось узнать внешний адрес этого сервера."
  echo "   Домен указывает на $DOMAIN_IP — проверьте сами, что это адрес ЭТОГО сервера."
  echo "   Если нет — прервите скрипт (Ctrl+C) и поправьте запись A у регистратора."
  echo "   Продолжаю через 15 секунд..."
  sleep 15
elif [ "$DOMAIN_IP" != "$SERVER_IP" ]; then
  die "Домен $DOMAIN указывает на $DOMAIN_IP, а этот сервер — $SERVER_IP.
  Поправьте запись A у регистратора и запустите скрипт заново."
else
  echo "   домен указывает сюда ($SERVER_IP) — можно продолжать"
fi

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
# Приватный репозиторий по https не падает, а спрашивает логин и ждёт вечно.
# Запрещаем спрашивать: пусть лучше честно упадёт с понятным объяснением.
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=/bin/true
id -u "$APP_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$APP_USER"
if [ -f "$APP_DIR/server.js" ] && [ ! -d "$APP_DIR/.git" ]; then
  # Папку привезли вручную (архивом с GitHub) — обновлять нечего, работаем как есть.
  echo "   нашёл готовую папку $APP_DIR — беру её"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
elif [ -d "$APP_DIR/.git" ]; then
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
else
  if ! sudo -u "$APP_USER" GIT_TERMINAL_PROMPT=0 git clone --quiet --branch "$BRANCH" "$REPO" "$APP_DIR" 2>/tmp/asher-clone.err; then
    echo
    cat /tmp/asher-clone.err >&2
    die "Не удалось скачать систему с GitHub.
  Чаще всего это значит, что репозиторий закрытый — тогда сервер к нему не
  допускают. Что делать: на компьютере магазина скачайте архив системы
  (кнопка «Code → Download ZIP» на GitHub), распакуйте и отправьте папку
  на сервер:

      scp -r Asher-*/. root@ЭТОТ-СЕРВЕР:$APP_DIR/

  затем на сервере:  chown -R $APP_USER:$APP_USER $APP_DIR
  и запустите этот скрипт заново — он увидит готовую папку и продолжит."
  fi
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
# Занятый 80 или 443 — самая частая причина, по которой https не поднимается.
# Проверяем ДО того, как трогать настройки Caddy.
for port in 80 443; do
  busy="$(ss -lntp 2>/dev/null | awk -v p=":$port\$" '$4 ~ p {print $NF; exit}')"
  if [ -n "$busy" ] && ! echo "$busy" | grep -q caddy; then
    die "Порт $port уже занят другой программой: $busy
  Обычно это nginx или apache, поставленные хостингом заранее.
  Остановите её и запустите скрипт заново, например:
      systemctl disable --now nginx
      systemctl disable --now apache2"
  fi
done
# Существующие настройки Caddy сохраняем: вдруг на сервере уже что-то работает.
if [ -f /etc/caddy/Caddyfile ] && ! grep -q "$DOMAIN" /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.до-asher"
  echo "   прежние настройки Caddy сохранены в /etc/caddy/Caddyfile.до-asher"
fi
cat >/etc/caddy/Caddyfile <<CADDY
$DOMAIN {
    reverse_proxy 127.0.0.1:3000
    # Фотографии изделий приезжают с телефонов целыми файлами.
    request_body {
        max_size 30MB
    }
}
CADDY
if ! systemctl reload caddy 2>/dev/null && ! systemctl restart caddy; then
  die "Caddy не запустился. Посмотрите причину: journalctl -u caddy -n 50"
fi

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

PRINT_IP="${SERVER_IP:-АДРЕС-СЕРВЕРА}"

# Итог печатаем ВСЕГДА, даже если https ещё не поднялся: владельцу нужны
# команды переноса и диагностики, а не оборванный вывод.
cat <<DONE

  ======================================================================
   Система установлена. Адрес: https://$DOMAIN
  ======================================================================
DONE

if [ "${OK:-}" != 1 ]; then
  cat <<WAIT

  ВНИМАНИЕ: https://$DOMAIN пока не ответил.
  Чаще всего сертификат ещё выдаётся — подождите 2-3 минуты и откройте адрес
  в браузере. Если не открывается и дальше:
      journalctl -u caddy -n 50     — что с сертификатом
      journalctl -u asher -n 50     — что с самой системой
      getent hosts $DOMAIN          — куда указывает домен
  Остальные шаги ниже всё равно нужны.
WAIT
fi

cat <<DONE

  ----------------------------------------------------------------------
   ПЕРЕНОС ДАННЫХ С КОМПЬЮТЕРА МАГАЗИНА
  ----------------------------------------------------------------------

  Сейчас на сервере пустая система. Порядок важен — иначе часть продаж
  потеряется.

  1. На компьютере магазина ЗАКРОЙТЕ систему (чёрное окно) и убедитесь,
     что рядом с data\asher.db не осталось файла asher.db-wal. Если остался —
     значит окно закрыли крестиком, и в этом файле лежат последние операции:
     запустите СТАРТ ещё раз и закройте окно сочетанием Ctrl+C.

  2. Остановите систему на сервере, чтобы она не писала в базу во время замены:

         ssh root@$PRINT_IP "systemctl stop asher && rm -f $APP_DIR/data/asher.db-wal $APP_DIR/data/asher.db-shm"

  3. Скопируйте базу и фотографии (выполнять В ПАПКЕ С СИСТЕМОЙ на компьютере):

         scp data/asher.db root@$PRINT_IP:$APP_DIR/data/asher.db
         scp -r data/images root@$PRINT_IP:$APP_DIR/data/

  4. Верните права и запустите:

         ssh root@$PRINT_IP "chown -R $APP_USER:$APP_USER $APP_DIR/data && systemctl start asher"

  Откройте https://$DOMAIN — изделия, продажи, клиенты и долги на месте.

  ----------------------------------------------------------------------
   ЧТО СДЕЛАТЬ ПОСЛЕ ПЕРЕНОСА
  ----------------------------------------------------------------------

   1. Войти под admin и СМЕНИТЬ ПАРОЛЬ — Настройки → Мой пароль.
   2. Проверить Настройки → Безопасность: все строки зелёные.
   3. Раздать продавцам новые карточки: Настройки → Сотрудники → 📱.
      В коде будет уже $DOMAIN, старые карточки с 192.168 не работают.

  Полезные команды на сервере:
      systemctl status asher      — как себя чувствует
      systemctl restart asher     — перезапустить
      journalctl -u asher -n 50   — что писала система
      cd $APP_DIR && sudo -u $APP_USER git pull && systemctl restart asher   — обновление

DONE
