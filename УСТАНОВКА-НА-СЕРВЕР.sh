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
# Ветка, с которой живёт магазин. По умолчанию — основная ветка репозитория:
# её git выбирает сам при клоне. Это важно, а не мелочь: рабочие ветки несут
# незаконченное, а на сервере магазина должно быть только то, что слито
# в основу и прогнано проверками целиком. Свою ветку можно передать третьим
# доводом, если очень нужно.
BRANCH="${3:-}"
APP_DIR=/home/asher/app
APP_USER=asher

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
die() { printf '\n\033[31m%s\033[0m\n\n' "$1" >&2; exit 1; }

[ -n "$DOMAIN" ] || die "Укажите домен: bash УСТАНОВКА-НА-СЕРВЕР.sh diamonds.kg"
[ "$(id -u)" = 0 ] || die "Запускать от root: sudo bash УСТАНОВКА-НА-СЕРВЕР.sh $DOMAIN"

# Домен владелец копирует из письма или из адресной строки, а значит он может
# приехать как «https://diamonds.kg», «DIAMONDS.KG/» или с пробелом. Всё это
# ушло бы прямиком в настройки Caddy и сломало бы https молча, поэтому
# приводим к простому виду сразу.
DOMAIN="$(printf '%s' "$DOMAIN" | tr -d '[:space:]' | tr 'A-Z' 'a-z')"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN%%/*}"
DOMAIN="${DOMAIN#www.}"
case "$DOMAIN" in
  *.*) : ;;
  *) die "«$1» не похоже на домен. Нужно имя целиком, например: diamonds.kg" ;;
esac
echo "   домен: $DOMAIN"

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
  # Не обрываем: адреса законно расходятся, когда сервер стоит за NAT или
  # балансировщиком хостинга. Обрыв в таком случае был бы отказом работать
  # при полностью правильной настройке. Говорим прямо и даём остановиться.
  echo "   ВНИМАНИЕ: домен указывает на $DOMAIN_IP, а внешний адрес сервера — $SERVER_IP."
  echo "   Если это разные машины — прервите скрипт (Ctrl+C) и поправьте запись A."
  echo "   Если ваш хостинг ставит серверы за общим адресом (NAT, балансировщик),"
  echo "   расхождение нормально — тогда просто подождите."
  echo "   Продолжаю через 20 секунд..."
  sleep 20
else
  echo "   домен указывает сюда ($SERVER_IP) — можно продолжать"
fi

say "2/8. Обновляю сервер и ставлю нужное"
export DEBIAN_FRONTEND=noninteractive

# На только что созданном сервере первые минуты Ubuntu занят собой: докачивает
# обновления, доводит настройку. Пока он держит установщик пакетов, любая наша
# команда падала бы — и скрипт обрывался на ровном месте, в первые же секунды.
# Просим сам apt подождать своей очереди: до 5 минут.
apt() { apt-get -o DPkg::Lock::Timeout=300 "$@"; }

if ! apt update -qq; then
  die "Не удалось обновить список пакетов.
  Чаще всего сервер ещё занят своей первичной настройкой (это 1-5 минут после
  создания) или у него нет выхода в интернет.
  Подождите пару минут и запустите скрипт заново."
fi
apt install -y -qq curl ca-certificates gnupg git ufw >/dev/null

# Файл подкачки — страховка, а не замена памяти.
#
# Системе хватает 111 МБ в самый тяжёлый момент (замерено на базе за три года
# работы и 313 МБ фотографий), так что гигабайта достаточно с запасом. Но когда
# память на сервере всё-таки кончается, Linux не тормозит и не предупреждает —
# он молча убивает самый прожорливый процесс. То есть кассу, посреди рабочего
# дня. Подкачка даёт пережить короткий всплеск: она в сотни раз медленнее
# памяти, зато магазин продолжает торговать.
#
# swappiness=10: пользоваться ею только когда деваться некуда, а не постоянно.
if [ -z "$(swapon --show 2>/dev/null)" ] && [ ! -f /swapfile ]; then
  if fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none 2>/dev/null; then
    chmod 600 /swapfile
    if mkswap /swapfile >/dev/null 2>&1 && swapon /swapfile 2>/dev/null; then
      grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
      sysctl -qw vm.swappiness=10 2>/dev/null || true
      grep -q 'vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
      echo "   файл подкачки на 2 ГБ создан"
    else
      # Бывает на серверах типа OpenVZ: подкачку там не создать. Это не повод
      # обрывать установку — система работает и без неё.
      rm -f /swapfile
      echo "   файл подкачки создать не вышло — не страшно, системе хватает памяти"
    fi
  fi
else
  echo "   файл подкачки уже есть"
fi

say "3/8. Ставлю Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt install -y -qq nodejs >/dev/null
fi
node -v | sed 's/^/   Node.js /'

say "4/8. Ставлю Caddy — он выдаёт и продлевает сертификат https сам"
if ! command -v caddy >/dev/null; then
  # --batch --yes: без них gpg на повторном запуске спрашивает «перезаписать?»
  # и завершается с ошибкой, обрывая установку.
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt update -qq
  apt install -y -qq caddy >/dev/null
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
  # Ветку не назвали — обновляем ту, на которой сервер уже стоит.
  # (Имена переменных здесь латиницей не для красоты: кириллические имена
  # bash не принимает вовсе — «syntax error» на ровном месте.)
  branch_now="${BRANCH:-$(sudo -u "$APP_USER" git -C "$APP_DIR" rev-parse --abbrev-ref HEAD)}"
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch --quiet origin "$branch_now"
  sudo -u "$APP_USER" git -C "$APP_DIR" checkout --quiet -B "$branch_now" "origin/$branch_now"
else
  # Без --branch git берёт основную ветку репозитория — то, что нужно магазину.
  clone_cmd=(git clone --quiet)
  [ -n "$BRANCH" ] && clone_cmd+=(--branch "$BRANCH")
  if ! sudo -u "$APP_USER" GIT_TERMINAL_PROMPT=0 "${clone_cmd[@]}" "$REPO" "$APP_DIR" 2>/tmp/asher-clone.err; then
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
# На домашнем компьютере занятый порт — мелочь: система молча берёт следующий.
# На сервере это ловушка: Caddy стучится строго в 3000, служба живёт на 3001,
# и сайт отдаёт «502» при полностью исправной системе. Здесь пусть лучше
# не запустится с понятной записью в журнале.
Environment=ASHER_STRICT_PORT=1
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
systemctl enable asher >/dev/null
# Именно restart, а не «enable --now»: тот запускает только остановленную службу.
# При повторном запуске скрипта (обновление системы) старая версия продолжала бы
# работать, а скрипт бодро отчитывался бы об успехе.
systemctl restart asher
sleep 2
systemctl is-active --quiet asher || die "Система не запустилась. Посмотрите: journalctl -u asher -n 50"

# Пока система видна только изнутри сервера — меняем стандартный пароль.
# Через минуту она будет открыта всему интернету, а admin/admin123 знает
# каждый, кто хоть раз видел эту систему. Просить «сменить потом» нельзя:
# между установкой и переносом данных может пройти день.
NEW_PASS=""
if sudo -u "$APP_USER" env ASHER_DB="$APP_DIR/data/asher.db" \
     node "$APP_DIR/src/пароль.js" admin >/tmp/asher-pass.txt 2>/dev/null; then
  NEW_PASS="$(cat /tmp/asher-pass.txt)"
  rm -f /tmp/asher-pass.txt
fi

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
# www обслуживаем, только если для него уже заведена запись — инструкция велит
# её завести. Без этой строки www.домен давал бы ошибку сертификата: самый
# пугающий экран для того, кто набрал адрес по привычке. А если записи нет,
# добавлять блок нельзя — Caddy будет впустую ломиться за сертификатом.
if getent ahostsv4 "www.$DOMAIN" >/dev/null 2>&1; then
  cat >>/etc/caddy/Caddyfile <<CADDY

www.$DOMAIN {
    redir https://$DOMAIN{uri} permanent
}
CADDY
  echo "   www.$DOMAIN тоже настроен — будет перебрасывать на основной адрес"
fi
if ! systemctl reload caddy 2>/dev/null && ! systemctl restart caddy; then
  die "Caddy не запустился. Посмотрите причину: journalctl -u caddy -n 50"
fi

say "8/8. Закрываю всё лишнее снаружи"
# Порт входа на сервер (SSH) узнаём у самого сервера, а не считаем, что он 22.
# Часть хостингов переносит его — и брандмауэр, открывший только 22, запер бы
# владельца снаружи собственного сервера, без единой возможности войти.
SSH_PORTS="$(ss -lntp 2>/dev/null | awk '/sshd/ {split($4,a,":"); print a[length(a)]}' | sort -u)"
[ -n "$SSH_PORTS" ] || SSH_PORTS=22
for p in $SSH_PORTS; do ufw allow "$p/tcp" >/dev/null 2>&1 || true; done
echo "   вход на сервер (SSH) оставлен открытым на порту: $(echo $SSH_PORTS | tr '\n' ' ')"
ufw allow 80,443/tcp >/dev/null 2>&1 || true
# Порт 3000 наружу не открываем: до системы должны доходить только через https.
# Ошибку брандмауэра не считаем смертельной: на части хостингов он вообще
# недоступен, и обрывать из-за этого готовую установку было бы глупо.
if ! ufw --force enable >/dev/null 2>&1; then
  echo "   ВНИМАНИЕ: включить брандмауэр не удалось — вероятно, хостинг им управляет сам."
  echo "   Убедитесь в его панели, что снаружи открыты только 80, 443 и вход на сервер."
fi

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

if [ -n "$NEW_PASS" ]; then
  cat <<PASS

  ЗАПИШИТЕ ПАРОЛЬ — он показан один раз и больше нигде не хранится:

        логин:  admin
        пароль: $NEW_PASS

  Стандартный admin123 больше не работает: система теперь открыта из интернета,
  и этот пароль знает каждый, кто хоть раз её видел. Войдите с этим паролем
  и сразу смените его на свой — Настройки → Мой пароль.

  Потеряли — не беда, на сервере можно выдать новый:
      cd $APP_DIR && sudo -u $APP_USER node src/пароль.js admin
PASS
else
  cat <<PASS

  ВНИМАНИЕ: сменить стандартный пароль автоматически не удалось.
  Прямо сейчас войдите на https://$DOMAIN под admin / admin123 и смените его:
  Настройки → Мой пароль. Пока этого не сделано, войти может кто угодно.
PASS
fi

if [ "${OK:-}" != 1 ]; then
  cat <<WAIT

  ВНИМАНИЕ: https://$DOMAIN пока не ответил — но это ещё не значит, что сломано.

  Проверка идёт с самого сервера на собственный адрес, а так умеют не все сети:
  у части хостингов сервер не может «дозвониться» сам до себя снаружи, хотя
  посетителям всё открывается. Поэтому сначала просто откройте https://$DOMAIN
  в браузере на своём компьютере.

  Если и там не открывается — подождите 2-3 минуты (сертификат ещё выдаётся)
  и попробуйте снова. Если не помогает:
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
         scp -r data/images/. root@$PRINT_IP:$APP_DIR/data/images/

  4. Верните права и запустите:

         ssh root@$PRINT_IP "chown -R $APP_USER:$APP_USER $APP_DIR/data && systemctl start asher"

  Откройте https://$DOMAIN — изделия, продажи, клиенты и долги на месте.

  ----------------------------------------------------------------------
   ЧТО СДЕЛАТЬ СРАЗУ ПОСЛЕ ПЕРЕНОСА
  ----------------------------------------------------------------------

   1. СМЕНИТЬ ПАРОЛЬ. Это обязательно, и вот почему: вместе с базой на сервер
      переехали и пароли с компьютера магазина. Пароль, который скрипт
      придумал выше, стёрся вместе со старой базой — сейчас у admin снова тот
      пароль, что был в магазине. Если это стандартный admin123, войти может
      кто угодно из интернета.

      Проще всего выдать новый прямо на сервере:

         ssh root@$PRINT_IP "cd $APP_DIR && sudo -u $APP_USER node src/пароль.js admin"

      Команда напечатает новый пароль. Войдите с ним и поменяйте на свой:
      Настройки → Мой пароль.

   2. Проверить Настройки → Безопасность: все строки зелёные.
   3. Раздать продавцам новые карточки: Настройки → Сотрудники → 📱.
      В коде будет уже $DOMAIN, старые карточки с 192.168 не работают.

  Полезные команды на сервере:
      systemctl status asher      — как себя чувствует
      systemctl restart asher     — перезапустить
      journalctl -u asher -n 50   — что писала система
      cd $APP_DIR && sudo -u $APP_USER git pull && systemctl restart asher   — обновление

DONE
