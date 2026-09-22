'use strict';
/*
 * Приложение для iPhone: то, что для него нужно от сервера.
 *
 *   • страницы политики и поддержки — без них App Store не принимает заявку;
 *   • уведомления на телефон — через поддельный сервер Apple, настоящий
 *     в проверках недоступен и не нужен: проверяется то, что уходит к Apple,
 *     и что система делает с ответом;
 *   • демо-версия для проверяющего — вход без разрешения устройства, пароль
 *     не меняется.
 *
 * Серверы свои: у рабочего — ключ для уведомлений и адрес поддельного Apple,
 * у демо — ASHER_DEMO=1. Общий сервер прогона ни того, ни другого не знает.
 */
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http2 = require('node:http2');
const net = require('node:net');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const РАБОТА = path.join(__dirname, '.вывод', 'приложение');
const БАЗА_ПОРТА = Number((process.env.BASE || '').match(/:(\d+)/)?.[1] || 3122);
const ПОРТ = БАЗА_ПОРТА + 61;
const ПОРТ_ДЕМО = БАЗА_ПОРТА + 62;
const ПОРТ_APPLE = БАЗА_ПОРТА + 63;
const BASE = `http://127.0.0.1:${ПОРТ}`;
const ДЕМО = `http://127.0.0.1:${ПОРТ_ДЕМО}`;

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(JSON.stringify(доп)).slice(0, 260)); }
};

// ---------- Поддельный сервер уведомлений Apple ----------

const пришло = [];            // { path, headers, body }
const пропавшие = new Set();  // адреса, на которые «Apple» отвечает 410
const apple = http2.createServer();
apple.on('stream', (stream, headers) => {
  let тело = '';
  stream.setEncoding('utf8');
  stream.on('data', ч => { тело += ч; });
  stream.on('end', () => {
    const адрес = String(headers[':path']).split('/').pop();
    пришло.push({ path: headers[':path'], headers, body: JSON.parse(тело || '{}'), адрес });
    if (пропавшие.has(адрес)) {
      stream.respond({ ':status': 410, 'content-type': 'application/json' });
      stream.end(JSON.stringify({ reason: 'Unregistered' }));
    } else {
      stream.respond({ ':status': 200 });
      stream.end();
    }
  });
});

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const КЛЮЧ_ФАЙЛ = path.join(РАБОТА, 'AuthKey_TESTKEY123.p8');

const окружение = {
  ...process.env,
  ASHER_DB: path.join(РАБОТА, 'asher.db'),
  ASHER_DATA: РАБОТА,
  ASHER_MEDIA: path.join(РАБОТА, 'images'),
  PORT: String(ПОРТ),
  NO_OPEN: '1',
  NO_PROXY: '*', no_proxy: '*',
  ASHER_APNS_HOST: `http://127.0.0.1:${ПОРТ_APPLE}`,
  ASHER_APNS_KEY_FILE: КЛЮЧ_ФАЙЛ,
  ASHER_APNS_KEY_ID: 'TESTKEY123',
  ASHER_APNS_TEAM_ID: 'TEAM987654',
  ASHER_APNS_TOPIC: 'kg.diamonds.crm',
};
const окружениеДемо = {
  ...process.env,
  ASHER_DB: path.join(РАБОТА, 'демо', 'asher.db'),
  ASHER_DATA: path.join(РАБОТА, 'демо'),
  ASHER_MEDIA: path.join(РАБОТА, 'демо', 'images'),
  PORT: String(ПОРТ_ДЕМО),
  NO_OPEN: '1',
  NO_PROXY: '*', no_proxy: '*',
  ASHER_DEMO: '1',
};

const живПорт = порт => new Promise(res => {
  const s = net.connect(порт, '127.0.0.1');
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('error', () => res(false));
  setTimeout(() => { s.destroy(); res(false); }, 300);
});

async function зов(база, метод, путь, { тело, устройство = 'test-device', cookie } = {}) {
  const headers = { 'X-Asher-Device': устройство };
  if (cookie) headers.Cookie = cookie;
  if (тело !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(база + путь, {
    method: метод, headers, body: тело === undefined ? undefined : JSON.stringify(тело),
  });
  const текст = await r.text();
  let data = null;
  try { data = JSON.parse(текст); } catch { /* страница, не JSON */ }
  return { status: r.status, data, текст, тип: r.headers.get('content-type') || '',
    cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

async function войти(база, логин, пароль, устройство) {
  const r = await зов(база, 'POST', '/api/login', { тело: { username: логин, password: пароль }, устройство });
  return { ...r, как: (метод, путь, тело) => зов(база, метод, путь, { тело, устройство, cookie: r.cookie }) };
}

const подождать = мс => new Promise(r => setTimeout(r, мс));
async function дождаться(условие, мс = 4000) {
  for (let i = 0; i < мс / 50; i++) { if (условие()) return true; await подождать(50); }
  return условие();
}

const b64 = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const АДРЕС = n => (n.toString(16).padStart(2, '0')).repeat(32);   // 64 шестнадцатеричных знака

let сервер = null, демо = null;

async function main() {
  fs.rmSync(РАБОТА, { recursive: true, force: true });
  fs.mkdirSync(path.join(РАБОТА, 'демо'), { recursive: true });
  fs.writeFileSync(КЛЮЧ_ФАЙЛ, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  await new Promise(r => apple.listen(ПОРТ_APPLE, '127.0.0.1', r));

  for (const env of [окружение, окружениеДемо]) {
    const s = spawnSync(process.execPath, [path.join('src', 'seed.js'), '--reset'], { cwd: ROOT, env, encoding: 'utf8' });
    if (s.status !== 0) { console.error(s.stderr || s.stdout); process.exit(2); }
  }
  сервер = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: окружение, stdio: 'ignore' });
  демо = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: окружениеДемо, stdio: 'ignore' });
  for (let i = 0; i < 100 && !(await живПорт(ПОРТ) && await живПорт(ПОРТ_ДЕМО)); i++) await подождать(200);

  console.log('=== 1. Страницы, которых требует App Store, открыты без входа ===');
  const политика = await зов(BASE, 'GET', '/privacy', { устройство: '' });
  check('политика конфиденциальности отвечает', политика.status === 200, политика.status);
  check('и это страница, а не приложение', /text\/html/.test(политика.тип) && /Политика конфиденциальности/.test(политика.текст));
  check('в ней название магазина', /Asher Diamonds/.test(политика.текст));
  check('в ней контакты из настроек магазина', /\+996 312 66-12-34/.test(политика.текст));
  check('есть часть на английском для проверяющего', /Privacy policy \(English summary\)/.test(политика.текст));
  check('сказано, что рекламы и слежки нет', /нет рекламы/.test(политика.текст) && /No advertising/.test(политика.текст));
  check('назван Apple как путь уведомлений', /Apple Push Notification service/.test(политика.текст));
  const поддержка = await зов(BASE, 'GET', '/support', { устройство: '' });
  check('поддержка отвечает', поддержка.status === 200 && /Поддержка/.test(поддержка.текст));
  check('поддержка ссылается на политику', /href="\/privacy"/.test(поддержка.текст));
  check('поддержка объясняет новый телефон', /Новый телефон просит разрешения/.test(поддержка.текст));

  const владелец = await войти(BASE, 'admin', 'admin123', 'owner-phone');
  check('владелец вошёл', владелец.status === 200, владелец.data);
  await владелец.как('PUT', '/api/settings', { store_email: 'shop@example.kg' });
  check('почта из настроек появилась на поддержке',
    /mailto:shop@example\.kg/.test((await зов(BASE, 'GET', '/support', { устройство: '' })).текст));
  await владелец.как('PUT', '/api/settings', { store_email: '', store_phone: '', store_address: '' });
  const пустая = await зов(BASE, 'GET', '/support', { устройство: '' });
  check('без контактов страница так и говорит, а не выдумывает',
    /контакты ещё не указаны/.test(пустая.текст), пустая.текст.slice(0, 200));
  await владелец.как('PUT', '/api/settings', { store_phone: '+996 312 66-12-34', store_address: 'Бишкек, ул. Киевская, 95' });
  check('название в разметке экранируется',
    await (async () => {
      await владелец.как('PUT', '/api/settings', { store_name: 'Магазин <b>"X"</b>' });
      const т = (await зов(BASE, 'GET', '/privacy', { устройство: '' })).текст;
      await владелец.как('PUT', '/api/settings', { store_name: 'Asher Diamonds' });
      return т.includes('Магазин &lt;b&gt;&quot;X&quot;&lt;/b&gt;') && !т.includes('<b>"X"</b>');
    })());

  console.log('\n=== 2. Телефон подписывается на уведомления только от своего имени ===');
  check('без входа подписаться нельзя',
    (await зов(BASE, 'POST', '/api/push/register', { тело: { token: АДРЕС(1) } })).status === 401);
  check('кривой адрес не принимается',
    (await владелец.как('POST', '/api/push/register', { token: 'не-адрес' })).status === 400);
  check('владелец подписал свой телефон',
    (await владелец.как('POST', '/api/push/register', { token: АДРЕС(1), env: 'sandbox' })).status === 200);
  const стВладельца = await владелец.как('GET', '/api/push/status');
  check('сервер знает, что уведомления подключены', стВладельца.data.configured === true, стВладельца.data);
  check('и что у владельца один телефон', стВладельца.data.mine === 1, стВладельца.data);
  check('владелец получает уведомления', стВладельца.data.receives === true);

  const логинБ = 'buh' + Date.now().toString(36);
  await владелец.как('POST', '/api/users', { username: логинБ, name: 'Бухгалтер', role: 'accountant', password: 'Schet-2026-ok' });
  const бухгалтер = await войти(BASE, логинБ, 'Schet-2026-ok', 'buh-phone');
  check('бухгалтер вошёл', бухгалтер.status === 200, бухгалтер.data);
  await бухгалтер.как('POST', '/api/push/register', { token: АДРЕС(2) });
  const продавец = await войти(BASE, 'anna', 'seller123', 'anna-phone');
  await продавец.как('POST', '/api/push/register', { token: АДРЕС(3) });
  check('продавцу уведомления не положены',
    (await продавец.как('GET', '/api/push/status')).data.receives === false);
  check('чужой телефон продавец отписать не может',
    (await продавец.как('POST', '/api/push/unregister', { token: АДРЕС(1) })).data.removed === 0);
  check('телефон владельца остался подписан',
    (await владелец.как('GET', '/api/push/status')).data.mine === 1);

  console.log('\n=== 3. Кто-то просится войти — владелец и бухгалтер узнают сразу ===');
  пришло.length = 0;
  const чужой = await войти(BASE, 'anna', 'seller123', 'stranger-pc');
  check('незнакомое устройство ждёт разрешения', чужой.data && чужой.data.pending_device === true, чужой.data);
  await дождаться(() => пришло.length >= 2);
  const адреса = пришло.map(п => п.адрес);
  check('уведомление ушло владельцу', адреса.includes(АДРЕС(1)), адреса);
  check('и бухгалтеру', адреса.includes(АДРЕС(2)), адреса);
  check('продавцу — нет', !адреса.includes(АДРЕС(3)), адреса);
  const п = пришло.find(x => x.адрес === АДРЕС(1));
  check('заголовок и текст о входе', п && п.body.aps.alert.title === 'Вход с нового устройства'
    && /Анна Соколова/.test(п.body.aps.alert.body) && п.body.aps.alert.body.includes(чужой.data.code), п && п.body);
  check('нажатие ведёт в «Безопасность»', п && п.body.route === '#/settings/security', п && п.body.route);
  check('звук включён', п && п.body.aps.sound === 'default');
  check('Apple получает тему приложения', п && п.headers['apns-topic'] === 'kg.diamonds.crm');
  check('вид — обычное уведомление', п && п.headers['apns-push-type'] === 'alert' && п.headers['apns-priority'] === '10');
  check('срок годности — сутки, не вечность',
    п && Number(п.headers['apns-expiration']) - Date.now() / 1000 > 23 * 3600
      && Number(п.headers['apns-expiration']) - Date.now() / 1000 < 25 * 3600);

  /*
   * Пропуск к Apple. Если он неправильный, Apple молча отвечает 403 на
   * каждое уведомление — и владелец просто никогда ничего не получит.
   */
  const [голова, тело, подпись] = String(п && п.headers.authorization || '').replace(/^bearer /, '').split('.');
  const г = JSON.parse(b64(голова || 'e30').toString());
  const т = JSON.parse(b64(тело || 'e30').toString());
  check('пропуск подписан ES256 нашим ключом', г.alg === 'ES256' && г.kid === 'TESTKEY123', г);
  check('в пропуске наша команда и свежее время',
    т.iss === 'TEAM987654' && Math.abs(т.iat - Date.now() / 1000) < 120, т);
  check('подпись пропуска сходится с ключом',
    Boolean(подпись) && crypto.verify('sha256', Buffer.from(голова + '.' + тело),
      { key: publicKey, dsaEncoding: 'ieee-p1363' }, b64(подпись)));

  console.log('\n=== 4. Проверочное уведомление ===');
  пришло.length = 0;
  const тест = await владелец.как('POST', '/api/push/test');
  check('проверочное отправлено на один телефон', тест.status === 200 && тест.data.sent === 1, тест.data);
  check('и пришло именно владельцу',
    пришло.length === 1 && пришло[0].адрес === АДРЕС(1) && пришло[0].body.aps.alert.title === 'Уведомления работают',
    пришло.map(x => x.адрес));

  console.log('\n=== 5. Удалённое приложение: адрес забывается сам ===');
  пропавшие.add(АДРЕС(2));
  пришло.length = 0;
  await войти(BASE, 'anna', 'seller123', 'stranger-pc-2');
  await дождаться(() => пришло.some(x => x.адрес === АДРЕС(2)));
  await подождать(200);
  check('Apple сказал «нет такого» — адрес бухгалтера забыт',
    (await бухгалтер.как('GET', '/api/push/status')).data.mine === 0);
  check('адрес владельца на месте', (await владелец.как('GET', '/api/push/status')).data.mine === 1);

  console.log('\n=== 6. Уволили — уведомления на его телефон прекращаются ===');
  пропавшие.delete(АДРЕС(2));
  await бухгалтер.как('POST', '/api/push/register', { token: АДРЕС(4) });
  const idБ = бухгалтер.data.user.id;
  await владелец.как('PUT', `/api/users/${idБ}`, { active: false });
  const база = new DatabaseSync(окружение.ASHER_DB, { readOnly: true });
  check('после отключения адресов у бухгалтера нет',
    Number(база.prepare('SELECT COUNT(*) AS c FROM push_tokens WHERE user_id = ?').get(idБ).c) === 0);

  console.log('\n=== 7. Аренда не записана — напоминание днём и один раз ===');
  const категория = 'Охрана-проверка-' + Date.now().toString(36);
  await владелец.как('POST', '/api/finance/regular', { category: категория, amount: 12000, day_of_month: 1 });
  await владелец.как('GET', '/api/dashboard?tz=360');
  check('часы магазина запомнены со страницы владельца',
    String(база.prepare(`SELECT value FROM settings WHERE key = 'store_tz'`).get()?.value) === '360');
  /*
   * Проверка расходов — отдельным процессом на той же базе, как её запускает
   * часовой таймер сервера, но с нужным нам «сейчас». Процесс асинхронный:
   * поддельный Apple живёт в этом же процессе, и синхронный запуск заморозил
   * бы его — уведомление ушло бы в пустоту.
   */
  const напомнить = когда => new Promise(resolve => {
    const ребёнок = spawn(process.execPath, ['-e',
      `require('./src/push').проверитьРасходы(new Date('${когда}')).then(n => { console.log('ушло:' + n); process.exit(0); })`],
    { cwd: ROOT, env: окружение });
    let вывод = '';
    ребёнок.stdout.on('data', ч => { вывод += ч; });
    ребёнок.stderr.on('data', ч => { вывод += ч; });
    ребёнок.on('close', () => {
      const n = Number((вывод.match(/ушло:(\d+)/) || [])[1] ?? -1);
      if (n < 0) console.log('     вывод проверки:', вывод.slice(-300));
      resolve(n);
    });
  });
  // Двадцать пятое число — у всякого правила «первого числа» срок уже подошёл.
  // Время по Бишкеку: 06:00 UTC = полдень, 20:00 UTC = два часа ночи.
  const днём = `2026-09-25T06:00:00Z`;
  пришло.length = 0;
  check('ночью напоминание не приходит', await напомнить('2026-09-25T20:30:00Z') === 0);
  const ушлоДнём = await напомнить(днём);
  check('днём приходит', ушлоДнём >= 1, ушлоДнём);
  check('и называет расход',
    пришло.some(x => x.body.aps.alert.title === `Не записан расход: ${категория}` && x.body.route === '#/finance'),
    пришло.map(x => x.body.aps.alert.title));
  пришло.length = 0;
  await напомнить(днём);
  check('второй раз за месяц не приходит',
    !пришло.some(x => x.body.aps.alert.title.includes(категория)), пришло.map(x => x.body.aps.alert.title));
  база.close();

  console.log('\n=== 8. Демо-версия для проверяющего ===');
  check('рабочая система не называет себя демо',
    (await зов(BASE, 'GET', '/api/login-hint')).data.demo === undefined);
  check('демо называет себя демо', (await зов(ДЕМО, 'GET', '/api/login-hint')).data.demo === true);
  const д1 = await войти(ДЕМО, 'admin', 'admin123', 'reviewer-iphone');
  const д2 = await войти(ДЕМО, 'admin', 'admin123', 'reviewer-ipad');
  check('в демо входят с любого телефона без разрешения', д1.status === 200 && д2.status === 200, [д1.status, д2.status]);
  const смена = await д1.как('POST', '/api/me/password', { password: 'Drugoi-parol-2026' });
  check('пароль в демо не меняется', смена.status === 400 && /демо/.test(смена.data.error), смена.data);
  check('и чужой тоже', (await д1.как('PUT', '/api/users/2', { password: 'Drugoi-parol-2026' })).status === 400);
  check('в рабочей системе новое устройство по-прежнему ждёт',
    (await войти(BASE, 'anna', 'seller123', 'another-stranger')).data.pending_device === true);

  console.log('\n=== 9. Учётку admin в демо не запереть ===');
  const отключить = await д1.как('PUT', '/api/users/1', { active: false });
  check('admin в демо не отключить', отключить.status === 400 && /демо/.test(отключить.data.error), отключить.data);
  const разжаловать = await д1.как('PUT', '/api/users/1', { role: 'seller' });
  check('и не разжаловать', разжаловать.status === 400 && /демо/.test(разжаловать.data.error), разжаловать.data);
  const выкинуть = await д1.как('POST', '/api/users/1/logout-all');
  check('и не выкинуть со всех устройств', выкинуть.status === 400 && /демо/.test(выкинуть.data.error), выкинуть.data);
  check('переименовать можно — это никого не запирает',
    (await д1.как('PUT', '/api/users/1', { name: 'Проверяющий' })).status === 200);
  check('остальных сотрудников в демо править можно',
    (await д1.как('PUT', '/api/users/2', { active: false })).status === 200);
  check('в рабочей системе запрета нет: основатель завершает свои сеансы как обычно',
    (await владелец.как('POST', '/api/users/1/logout-all')).status === 200);

  console.log('\n=== 10. Ночной сброс демо: данные свежие, вход остаётся ===');
  const сброс = env => spawnSync(process.execPath, [path.join('src', 'демо-сброс.js')], { cwd: ROOT, env, encoding: 'utf8' });
  const безДемо = { ...окружениеДемо };
  delete безДемо.ASHER_DEMO;
  check('без ASHER_DEMO=1 сброс отказывается', сброс(безДемо).status === 2);
  check('на рабочую базу сброс не идёт',
    сброс({ ...окружениеДемо, ASHER_DB: path.join(ROOT, 'data', 'asher.db') }).status === 2);
  await д1.как('PUT', '/api/settings', { store_name: 'Испорчено посетителем' });
  await д1.как('POST', '/api/push/register', { token: АДРЕС(9) });
  // За день посетитель удалил клиента — утром он должен вернуться.
  const клиенты = (await д1.как('GET', '/api/customers')).data;
  const всегоКлиентов = (клиенты.items || клиенты).length;
  демо.kill();
  for (let i = 0; i < 50 && await живПорт(ПОРТ_ДЕМО); i++) await подождать(100);
  const итог = сброс(окружениеДемо);
  check('сброс прошёл', итог.status === 0 && /сохранено входов — 2/.test(итог.stdout), итог.stdout + итог.stderr);
  демо = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: окружениеДемо, stdio: 'ignore' });
  for (let i = 0; i < 100 && !(await живПорт(ПОРТ_ДЕМО)); i++) await подождать(200);
  const я = await д1.как('GET', '/api/me');
  check('проверяющий остался в системе — входить заново не нужно', я.status === 200 && я.data.user.username === 'admin', я.data);
  check('второе устройство тоже', (await д2.как('GET', '/api/me')).status === 200);
  const настройки = (await д1.как('GET', '/api/settings')).data;
  check('название магазина снова «Diamonds»', настройки.store_name === 'Diamonds', настройки.store_name);
  const люди = (await д1.как('GET', '/api/users')).data.items;
  check('отключённый вчера сотрудник снова на месте', люди.find(u => u.id === 2).active === 1, люди);
  check('имя admin — снова как было', люди.find(u => u.id === 1).name !== 'Проверяющий', люди.find(u => u.id === 1));
  check('телефон проверяющего по-прежнему получает уведомления',
    (await д1.как('GET', '/api/push/status')).data.mine === 1);
  const клиентыПосле = (await д1.как('GET', '/api/customers')).data;
  check('наполнение то же самое, свежее', всегоКлиентов > 0 && (клиентыПосле.items || клиентыПосле).length === всегоКлиентов,
    [всегоКлиентов, (клиентыПосле.items || клиентыПосле).length]);

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
}

main()
  .catch(e => { console.error(e); fail++; })
  .finally(() => {
    for (const s of [сервер, демо]) { try { if (s) s.kill(); } catch { /* уже */ } }
    apple.close();
    setTimeout(() => process.exit(fail ? 1 : 0), 300);
  });
