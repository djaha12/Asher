'use strict';
/*
 * Asher — CRM для ювелирного магазина.
 * Запуск: node server.js  (Node.js >= 22.5, внешние зависимости не нужны)
 */
/*
 * Проверку версии делаем здесь, а не в ярлыке запуска: пакетный файл Windows
 * не может показать русский текст надёжно, а Node.js — может. Без этой
 * проверки человек увидел бы стек ошибки вместо понятного объяснения.
 */
try {
  require('node:sqlite');
} catch {
  console.error('\n  Ваша версия Node.js устарела — системе нужна 22.5 или новее.');
  console.error('  Скачайте свежую с nodejs.org (зелёная кнопка LTS), установите');
  console.error('  поверх старой и запустите СТАРТ снова.\n');
  process.exit(1);
}

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const { getSetting, видитВсё } = require('./src/db');
const auth = require('./src/auth');
const guard = require('./src/guard');
const changes = require('./src/changes');
const media = require('./src/api/images');
const { presetFor, LOCALE_KEYS } = require('./src/locale');
const { ApiError } = require('./src/api/util');

// Настройки локали одним объектом — интерфейс форматирует по ним суммы и телефоны.
function currentLocale() {
  const fallback = presetFor(getSetting('country'));
  const out = {};
  for (const key of LOCALE_KEYS) out[key] = getSetting(key) || String(fallback[key] ?? '');
  out.money_decimals = Number(out.money_decimals) || 0;
  out.phone_length = Number(out.phone_length) || 0;
  return out;
}

const PORT = Number(process.env.ASHER_PORT || process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const BODY_LIMIT = 25 * 1024 * 1024; // 25 МБ — с запасом для CSV-импорта

// ---------- Маршруты API ----------

const modules = ['products', 'images', 'customers', 'sales', 'orders', 'finance', 'debts',
  'stores', 'inventory', 'analytics', 'settings', 'importexport', 'sets', 'search', 'cash', 'receipts',
  'team'];
const routes = [];
for (const m of modules) {
  for (const r of require(`./src/api/${m}`).routes) {
    const names = [];
    const pattern = r.path.replace(/:[a-zA-Z_]+/g, seg => {
      names.push(seg.slice(1));
      return '([^/]+)';
    });
    routes.push({ ...r, regex: new RegExp(`^${pattern}$`), paramNames: names });
  }
}

// ---------- Утилиты HTTP ----------

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new ApiError(413, 'Файл слишком большой'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/*
 * Система за обратным прокси (так она стоит на хостинге: снаружи https, внутрь
 * идёт обычный http). Тогда адрес соединения — это адрес прокси, один и тот же
 * для всех, и по нему нельзя ни считать попытки входа, ни писать в журнал.
 * Настоящий адрес прокси кладёт в заголовок, но верить заголовку можно только
 * если мы точно знаем, что перед нами прокси: иначе его подделает кто угодно.
 */
const TRUST_PROXY = process.env.ASHER_TRUST_PROXY === '1';

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || '?';
}

/*
 * Пришли ли из домашней сети — из магазинного Wi-Fi, а не из интернета.
 * По этому различаем, что можно показывать до входа: подсказка «admin/admin123»
 * уместна за прилавком и недопустима на публичном адресе.
 */
function isLocalRequest(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) {
    // За прокси мы всегда «в интернете»: система выставлена наружу.
    return false;
  }
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1'
    || /^10\./.test(ip)
    || /^192\.168\./.test(ip)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    || /^169\.254\./.test(ip)
    || /^f[cd]/i.test(ip);          // локальные адреса IPv6
}

// Работаем ли по https — от этого зависят защитные заголовки и флаг у cookie.
function isSecure(req) {
  if (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') return true;
  return Boolean(req.socket.encrypted);
}

/*
 * Заголовки безопасности. Отдаём их на всё, включая страницу входа.
 *
 * CSP держит систему в её собственных файлах: даже если в названии изделия
 * окажется чужой скрипт, выполнить его браузеру будет негде. 'unsafe-inline'
 * для стилей оставлен намеренно — интерфейс расставляет размеры прямо в
 * разметке, а запрет ничего не даёт: стилем данные не украдёшь.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req) {
  const h = {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    // Камера нужна для сканирования — оставляем её себе, остальное закрываем.
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=()',
  };
  // Раз уж зашли по https — впредь только по нему, без «случайного» http.
  if (isSecure(req)) h['Strict-Transport-Security'] = 'max-age=31536000';
  return h;
}

// Cookie сессии. Secure — только когда соединение защищено: иначе браузер
// просто выбросит cookie, и в магазинной сети никто не сможет войти.
function sessionCookie(req, token) {
  const parts = [`asher_session=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Lax',
    `Max-Age=${30 * 86400}`];
  if (isSecure(req)) parts.push('Secure');
  return parts.join('; ');
}

// ---------- Статика ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  // Без этого типа телефон не считает страницу приложением и не предлагает
  // поставить значок на экран.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

/*
 * Название магазина — настройка, и слушаться её должно всё, что видит человек:
 * вкладка браузера, экран входа, имя значка на телефоне.
 *
 * Почему подстановкой на сервере, а не из JavaScript. Экран входа рисуется
 * до всякого входа, а название система узнаёт только после него — то есть
 * первое, что показывает система незнакомому человеку, было бы чужим именем.
 * Манифест же читает не наша страница, а сам телефон, и никакого JavaScript
 * там не выполняется вовсе.
 *
 * Разбор на «крупно» и «подстрочником» повторяет то, что делает showApp():
 * «Asher Diamonds» → крупно ASHER, мельче DIAMONDS. Одно слово — без
 * подстрочника.
 */
const ПОДСТАНОВКИ = /\{\{(НАЗВАНИЕ|КРАТКО|ПОДСТРОЧНИК|ОПИСАНИЕ)\}\}/g;

/*
 * Экранируем по месту, а не одинаково. Название вводит владелец, и кавычка
 * в нём — не выдумка: «Ювелирный "Алмаз"» набирают именно так. В html такая
 * кавычка закрыла бы content="…" в meta-теге, в json — разорвала бы строку
 * и телефон отверг бы манифест целиком, перестав предлагать значок.
 *
 * Одним способом на оба случая не обойтись: html-экранирование внутри json
 * даёт формально верный файл, но на значке телефона владелец прочитает
 * «Ювелирный &quot;Алмаз&quot;».
 */
function экранировать(значение, вид) {
  const s = String(значение);
  if (вид === 'json') return JSON.stringify(s).slice(1, -1);
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function подставитьНазвание(текст, вид) {
  const полное = String(getSetting('store_name') || 'Asher Diamonds').trim();
  const слова = полное.split(/\s+/);
  /*
   * Подпись — то, что видно СНАРУЖИ: под названием на экране входа и в описании
   * страницы, которое показывают поисковик и мессенджер, когда кто-то откроет
   * ссылку. Внутри системы она не появляется нигде.
   *
   * Зачем отдельная настройка, а не второе слово названия. Название печатается
   * на чеках и стоит в шапке у продавцов; дописать в него «в разработке» —
   * значит написать это и на чеке покупателю. А сказать заглянувшему, что
   * система ещё не открыта, иногда нужно. Это разные вещи, и настройки у них
   * разные.
   */
  const подпись = String(getSetting('site_note') || '').trim();
  const значения = {
    'НАЗВАНИЕ': полное,
    'КРАТКО': слова[0],
    // Пока подписи нет, под названием стоит остаток названия — как и раньше.
    'ПОДСТРОЧНИК': подпись || слова.slice(1).join(' '),
    'ОПИСАНИЕ': подпись
      ? `${полное} — ${подпись}`
      : `${полное} — учётная система ювелирного магазина`,
  };
  return текст.replace(ПОДСТАНОВКИ, (_, ключ) => экранировать(значения[ключ], вид));
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA: любые прочие адреса отдают index.html
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, index) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'], ...securityHeaders(req) });
        res.end(подставитьНазвание(index.toString('utf8'), 'html'));
      });
      return;
    }
    const тип = path.extname(file);
    /*
     * Подставляем только там, где подстановки есть: в html и манифесте.
     * Гонять через замену фотографии и шрифты незачем, а испортить —
     * можно: Buffer→строка→Buffer на двоичном файле его ломает.
     */
    const сНазванием = тип === '.html' || тип === '.webmanifest';
    res.writeHead(200, {
      'Content-Type': MIME[тип] || 'application/octet-stream',
      ...securityHeaders(req),
    });
    res.end(сНазванием
      ? подставитьНазвание(data.toString('utf8'), тип === '.webmanifest' ? 'json' : 'html')
      : data);
  });
}

// ---------- Фотографии изделий ----------
// Отдаются только вошедшим в систему: фотографии товара — такая же
// коммерческая информация, как цены.

function serveMedia(req, res, rel) {
  const session = auth.getSession(parseCookies(req).asher_session);
  if (!session) { res.writeHead(403); res.end('Forbidden'); return; }
  const file = media.safeMediaPath(rel);
  if (!file) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const type = media.mimeForFile(file);
    const headers = {
      'Content-Type': type,
      // Имя файла содержит uuid и никогда не переиспользуется — кэшируем надолго.
      'Cache-Control': 'private, max-age=31536000, immutable',
      // Браузер не должен угадывать тип сам: файл сюда кладёт пользователь.
      'X-Content-Type-Options': 'nosniff',
    };
    // Сертификат бывает PDF, а внутри PDF может лежать скрипт. Открываем его
    // в песочнице, чтобы чужой файл не получил доступ к системе от вашего имени.
    if (type === 'application/pdf') {
      headers['Content-Disposition'] = 'inline';
      headers['Content-Security-Policy'] = 'sandbox';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

// ---------- Сервер ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname.startsWith('/media/')) {
      serveMedia(req, res, pathname.slice('/media/'.length));
      return;
    }
    if (!pathname.startsWith('/api/')) {
      serveStatic(req, res, pathname);
      return;
    }

    const cookies = parseCookies(req);
    const session = auth.getSession(cookies.asher_session);

    // --- вход/выход/кто я ---
    if (pathname === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      // Сначала общий потолок — он отбивает поток, не тратя процессор на пароль.
      if (guard.globalOverload()) {
        throw new ApiError(429, 'Система сейчас перегружена попытками входа. Попробуйте через минуту.');
      }
      const wait = guard.retryAfter(ip, body.username);
      if (wait) {
        const mins = Math.ceil(wait / 60);
        throw new ApiError(429, mins > 1
          ? `Слишком много неудачных попыток. Попробуйте через ${mins} мин.`
          : 'Слишком много неудачных попыток. Попробуйте через минуту.');
      }
      const result = auth.login(body.username, body.password, {
        ip,
        deviceKey: req.headers['x-asher-device'] || '',
        deviceName: String(req.headers['user-agent'] || '').slice(0, 80),
      });
      if (!result) {
        guard.noteFail(ip, body.username);
        throw new ApiError(401, 'Неверный логин или пароль');
      }
      /*
       * Пароль верный, но устройство незнакомое.
       *
       * Счётчик неудач НЕ трогаем: пароль-то правильный, и это либо сам
       * сотрудник с нового телефона, либо тот, кому пароль достался. В обоих
       * случаях запирать логин бессмысленно — дальше экрана ожидания всё
       * равно никто не пройдёт, а сотруднику с новым телефоном мы бы только
       * помешали. Зато в журнале уже стоит отметка о попытке.
       */
      if (result.pending) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', ...securityHeaders(req) });
        res.end(JSON.stringify({
          pending_device: true,
          code: result.code || '',
          error: result.reason === 'нет-ключа'
            ? 'Это устройство не может подтвердить себя. Откройте систему в обычном браузере.'
            : 'Вход с нового устройства. Владелец должен его разрешить: Настройки → Безопасность.',
        }));
        return;
      }
      guard.noteSuccess(ip, body.username);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': sessionCookie(req, result.session.token),
        ...securityHeaders(req),
      });
      res.end(JSON.stringify({
        user: result.user,
        store_name: getSetting('store_name'),
        // Телефон магазина подставляется в сообщение клиенту о изделии.
        store_phone: getSetting('store_phone'),
        locale: currentLocale(),
      }));
      return;
    }
    /*
     * Экрану ожидания: разрешили уже это устройство или ещё нет.
     *
     * Отвечает одинаково и для несуществующего логина, и для незнакомого
     * устройства — иначе по этому запросу можно было бы перебирать, какие
     * логины в системе есть. Пароля здесь нет и быть не может: запрос лишь
     * говорит «ждите» или «готово», а входит приложение по-прежнему паролем.
     */
    if (pathname === '/api/login/device-status' && req.method === 'GET') {
      if (guard.globalOverload()) throw new ApiError(429, 'Слишком много запросов');
      sendJson(res, 200, auth.deviceStateByKey(
        url.searchParams.get('username'), req.headers['x-asher-device'] || ''));
      return;
    }
    /*
     * Отклик «я Asher» — по нему запускающаяся копия понимает, что система
     * уже работает, и не поднимает вторую на той же базе.
     */
    if (pathname === '/api/ping') {
      sendJson(res, 200, { app: 'asher', port: server.address() && server.address().port });
      return;
    }
    /*
     * Странице входа: показывать ли подсказку про стандартные логин и пароль.
     *
     * Подсказка нужна за прилавком — люди путают поля и вводят пароль в логин.
     * Но снаружи она означала бы объявление «сюда можно зайти как admin/admin123»
     * для любого, кто нашёл адрес. Поэтому из интернета отвечаем «нечего
     * показывать», даже если пароль и правда стандартный.
     */
    if (pathname === '/api/login-hint' && req.method === 'GET') {
      sendJson(res, 200, {
        default_admin: isLocalRequest(req) && auth.defaultAdminActive(),
        // Владельцу нужно знать, что стандартный пароль всё ещё стоит, даже
        // когда система в интернете, — эту строку читает страница «Безопасность»
        // после входа, а не страница входа.
      });
      return;
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      auth.destroySession(cookies.asher_session);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': 'asher_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0',
        ...securityHeaders(req),
      });
      res.end('{"ok":true}');
      return;
    }
    if (pathname === '/api/me' && req.method === 'GET') {
      if (!session) throw new ApiError(401, 'Не авторизован');
      sendJson(res, 200, {
        user: { id: session.userId, username: session.username, name: session.name, role: session.role },
        store_name: getSetting('store_name'),
        store_phone: getSetting('store_phone'),
        currency: getSetting('currency'),
        locale: currentLocale(),
      });
      return;
    }

    /*
     * Скачивание резервной копии по ключу — единственный ответ системы без
     * пароля, и потому написан здесь, отдельно, а не спрятан среди маршрутов.
     *
     * Зачем он вообще нужен. Копия, лежащая на том же диске, что и база,
     * не спасает ни от сбоя диска, ни от пропавшего сервера, ни от забытой
     * оплаты хостинга — а именно так учёт и теряют. Спасает копия в другом
     * месте, и снимать её должен компьютер по расписанию, а не человек по
     * памяти: люди забывают, и это свойство людей, а не их вина.
     *
     * Чем он не является. Это не пароль и не сотрудник: ключ открывает ровно
     * один адрес и не даёт ни смотреть, ни менять ничего другого.
     *
     * Подбор закрыт с двух сторон: сам ключ — 160 бит, а неудачные попытки
     * идут через ту же защиту, что и подбор пароля, поэтому долбить адрес
     * бесполезно ещё и по времени.
     */
    if (pathname === '/api/backup/download' && req.method === 'GET' && !session) {
      const копия = require('./src/копия');
      const ip = clientIp(req);
      const ждать = guard.retryAfter(ip, 'ключ-копий');
      if (ждать > 0) {
        res.setHeader('Retry-After', String(Math.ceil(ждать / 1000)));
        throw new ApiError(429, 'Слишком много попыток. Подождите и повторите.');
      }
      if (!копия.ключВерен(url.searchParams.get('key') || '')) {
        guard.noteFail(ip, 'ключ-копий');
        throw new ApiError(401, 'Неверный ключ для копий');
      }
      guard.noteSuccess(ip, 'ключ-копий');
      await копия.отдатьКопию(res, { userId: null, откуда: 'по ключу, автоматически' });
      return;
    }

    // --- все остальные /api/* требуют сессию ---
    if (!session) throw new ApiError(401, 'Не авторизован');

    /*
     * «Что изменилось». Этот запрос приложение делает чаще всех остальных
     * вместе взятых, поэтому отвечаем на него до общего разбора маршрутов
     * и не трогая базу: ответ целиком лежит в памяти и весит десятки байт.
     */
    if (pathname === '/api/changes' && req.method === 'GET') {
      sendJson(res, 200, changes.since(url.searchParams.get('since'),
        req.headers['x-asher-device'] || ''));
      return;
    }

    const route = routes.find(r => r.method === req.method && r.regex.test(pathname));
    if (!route) throw new ApiError(404, 'Не найдено');
    /*
     * Две ступени доступа. «admin» у маршрута означает внутреннюю кухню —
     * закупочные, прибыль, финансы, сотрудников: её видят основатель и
     * бухгалтер. «owner» — только основатель: панель с тем, что делают
     * остальные, и журнал действий. Бухгалтер имеет тот же доступ, что
     * основатель, за вычетом ровно этого.
     */
    if (route.admin && !видитВсё(session.role)) {
      throw new ApiError(403, 'Доступно только основателю и бухгалтеру');
    }
    if (route.owner && session.role !== 'owner') {
      throw new ApiError(403, 'Доступно только основателю');
    }

    const match = pathname.match(route.regex);
    const params = {};
    route.paramNames.forEach((n, i) => { params[n] = match[i + 1]; });
    const query = Object.fromEntries(url.searchParams.entries());

    let body = {};
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      const raw = (await readBody(req)).toString('utf8');
      if (raw) {
        try { body = JSON.parse(raw); }
        catch { throw new ApiError(400, 'Некорректный JSON'); }
      }
    }

    const ctx = { req, res, params, query, body, session };
    if (route.raw) {
      await route.handler(ctx); // маршрут сам пишет ответ (например, CSV)
      return;
    }
    const result = await route.handler(ctx);
    /*
     * Отмечаем изменение здесь, в одном месте на все маршруты, а не в каждом
     * обработчике по отдельности. Обработчиков десятки, и новые будут
     * появляться; отметку в них рано или поздно забыли бы поставить — и экран
     * у продавцов молча перестал бы обновляться на этом разделе, причём
     * заметили бы это очень нескоро.
     *
     * Считаем изменением любой успешный запрос, который не GET. Устройство,
     * сделавшее его, помечаем: ему повторная перерисовка не нужна.
     */
    if (req.method !== 'GET') {
      changes.bump(changes.разделПоАдресу(pathname), req.headers['x-asher-device'] || '');
    }
    sendJson(res, 200, result ?? { ok: true });
  } catch (e) {
    if (e instanceof ApiError) {
      sendJson(res, e.status, { error: e.message });
    } else {
      console.error(`[${new Date().toISOString()}]`, req.method, pathname, e);
      sendJson(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
  }
});

auth.cleanupSessions();
setInterval(() => auth.cleanupSessions(), 6 * 3600 * 1000).unref();

// Автообмен с 1С (папка «1С-ОБМЕН») и ежедневные резервные копии.
require('./src/sync').start();
// Снятие резервов, у которых вышел срок.
require('./src/reserve').start();

// Адреса в локальной сети — чтобы открыть систему с телефона по Wi-Fi магазина.
function lanAddresses(port) {
  const out = [];
  for (const list of Object.values(require('node:os').networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(`http://${iface.address}:${port}`);
    }
  }
  return out;
}

// Открыть браузер на странице входа. Только для запуска ярлыком (СТАРТ.bat):
// сам порт известен здесь, а не в ярлыке, поэтому и адрес открываем отсюда.
function openBrowser(url, force = false) {
  if (!force && process.env.ASHER_OPEN !== '1') return;
  const { spawn } = require('node:child_process');
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    // Ошибка запуска приходит СОБЫТИЕМ, а не исключением: без этого обработчика
    // отсутствие «открывалки» роняло бы весь сервер. Адрес и так напечатан ниже.
    child.on('error', () => {});
    child.unref();
  } catch { /* нет браузера — не беда */ }
}

/*
 * Кто занял порт: наша же система или посторонняя программа. Различать
 * обязательно — две копии Asher на одной базе мешают друг другу писать,
 * и в работе это выглядит как случайные ошибки на ровном месте.
 */
function askWhoIsThere(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 1500 }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/*
 * Порт занят. Если там уже работает Asher — вторую копию не поднимаем, а
 * открываем существующую: одна база, один хозяин. Если это чужая программа —
 * спокойно берём следующий свободный порт.
 *
 * На сервере это поведение вредно, поэтому там ставится ASHER_STRICT_PORT=1.
 * Снаружи стоит Caddy, он стучится строго в назначенный порт; если система
 * молча переедет на соседний, служба будет «активна», а сайт — отдавать «502»
 * при полностью исправной системе. Пусть лучше не запустится с понятной
 * записью в журнале, чем притворяется работающей.
 */
const STRICT_PORT = process.env.ASHER_STRICT_PORT === '1';
let portTries = 0;
server.on('error', async e => {
  if (e.code === 'EADDRINUSE' && STRICT_PORT) {
    const кто = await askWhoIsThere(PORT);
    console.error(`\n  Порт ${PORT} занят${кто && кто.app === 'asher'
      ? ' другой копией этой же системы — вторая не нужна.'
      : ' другой программой.'}`);
    console.error('  Освободите порт или задайте другой в PORT — на сервере порт не меняем сами,');
    console.error('  иначе снаружи система откажется открываться.\n');
    process.exit(1);
  }
  if (e.code === 'EADDRINUSE') {
    const busyPort = PORT + portTries;
    const who = await askWhoIsThere(busyPort);
    if (who && who.app === 'asher') {
      const url = `http://localhost:${busyPort}`;
      console.log(`\n  Система уже работает: ${url}`);
      console.log('  Второй раз запускать не нужно — открываю то, что уже работает.\n');
      openBrowser(url, true);
      setTimeout(() => process.exit(0), 1500);
      return;
    }
    if (portTries < 10) {
      portTries++;
      if (portTries === 1) console.log(`  Порт ${PORT} занят другой программой, беру следующий свободный…`);
      server.listen(PORT + portTries);
      return;
    }
  }
  console.error('\n  Не удалось запустить систему:', e.message, '\n');
  process.exit(1);
});

server.on('listening', () => {
  const port = server.address().port;
  // Настройки → «Открыть на телефоне» должны показывать реальный порт,
  // а не запрошенный: он мог смениться из-за занятости.
  process.env.ASHER_ACTUAL_PORT = String(port);
  const local = `http://localhost:${port}`;
  /*
   * Записываем занятый порт рядом с базой: ярлыки на Рабочем столе открывают
   * систему по этому файлу, а не по угаданному адресу. Иначе после смены
   * порта значок вёл бы в пустоту.
   */
  try {
    fs.writeFileSync(path.join(path.dirname(require('./src/db').DB_PATH), 'asher-port.txt'),
      String(port), 'utf8');
  } catch { /* не записалось — ярлык просто попробует обычный адрес */ }
  console.log(`\n  Asher CRM запущена`);
  console.log(`  НЕ ЗАКРЫВАЙТЕ это окно, пока работаете с системой — сворачивайте.`);
  console.log(`\n  На этом компьютере:  ${local}`);
  const lan = lanAddresses(port);
  if (lan.length) {
    console.log(`\n  С телефона или планшета (в той же сети Wi-Fi):`);
    for (const addr of lan) console.log(`     ${addr}`);
  }
  console.log('\n  Вход по умолчанию: admin / admin123 (смените пароль в Настройках!)\n');
  openBrowser(local);
});

server.listen(PORT);
