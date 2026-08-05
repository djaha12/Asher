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

const { getSetting } = require('./src/db');
const auth = require('./src/auth');
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
  'stores', 'inventory', 'analytics', 'settings', 'importexport', 'sets'];
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

// защита от перебора пароля: после 10 неудач — пауза минута
const loginFails = new Map();
function loginAllowed(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return true;
  if (rec.count < 10) return true;
  return Date.now() - rec.last > 60000;
}
function noteLoginFail(ip) {
  const rec = loginFails.get(ip) || { count: 0, last: 0 };
  if (Date.now() - rec.last > 60000) rec.count = 0;
  rec.count++;
  rec.last = Date.now();
  loginFails.set(ip, rec);
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
};

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
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(index);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
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
      const ip = req.socket.remoteAddress || '?';
      if (!loginAllowed(ip)) throw new ApiError(429, 'Слишком много попыток. Подождите минуту.');
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const result = auth.login(body.username, body.password);
      if (!result) {
        noteLoginFail(ip);
        throw new ApiError(401, 'Неверный логин или пароль');
      }
      loginFails.delete(ip);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `asher_session=${result.session.token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}`,
      });
      res.end(JSON.stringify({
        user: result.user,
        store_name: getSetting('store_name'),
        locale: currentLocale(),
      }));
      return;
    }
    // Странице входа: показывать ли подсказку про стандартные логин и пароль.
    if (pathname === '/api/login-hint' && req.method === 'GET') {
      sendJson(res, 200, { default_admin: auth.defaultAdminActive() });
      return;
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      auth.destroySession(cookies.asher_session);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': 'asher_session=; HttpOnly; Path=/; Max-Age=0',
      });
      res.end('{"ok":true}');
      return;
    }
    if (pathname === '/api/me' && req.method === 'GET') {
      if (!session) throw new ApiError(401, 'Не авторизован');
      sendJson(res, 200, {
        user: { id: session.userId, username: session.username, name: session.name, role: session.role },
        store_name: getSetting('store_name'),
        currency: getSetting('currency'),
        locale: currentLocale(),
      });
      return;
    }

    // --- все остальные /api/* требуют сессию ---
    if (!session) throw new ApiError(401, 'Не авторизован');

    const route = routes.find(r => r.method === req.method && r.regex.test(pathname));
    if (!route) throw new ApiError(404, 'Не найдено');
    if (route.admin && session.role !== 'admin') {
      throw new ApiError(403, 'Доступно только администратору');
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
function openBrowser(url) {
  if (process.env.ASHER_OPEN !== '1') return;
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
 * На рабочем компьютере порт 3000 нередко занят другой программой. Вместо
 * падения с непонятной ошибкой берём следующий свободный и печатаем его.
 */
let portTries = 0;
server.on('error', e => {
  if (e.code === 'EADDRINUSE' && portTries < 10) {
    portTries++;
    if (portTries === 1) console.log(`  Порт ${PORT} занят другой программой, беру следующий свободный…`);
    server.listen(PORT + portTries);
    return;
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
