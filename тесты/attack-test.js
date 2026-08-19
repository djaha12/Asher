'use strict';
/*
 * Проверка «со стороны улицы».
 *
 * Прошлый заход проверял то, что я сам построил. Здесь наоборот: пробуем
 * пролезть теми путями, под которые ничего не строилось — подмена полей в
 * запросе, чужие идентификаторы, скрипт в названии изделия, разведка логинов,
 * вытаскивание файлов, отказ в обслуживании.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3122';

let ok = 0, fail = 0, warn = 0;
const failures = [];
const warnings = [];
function check(name, cond, extra) {
  if (cond) { ok++; console.log('  ok  ' + name); }
  else {
    fail++; failures.push(name);
    console.log('  FAIL ' + name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300));
  }
}
function note(name, cond, extra) {
  if (cond) { ok++; console.log('  ok  ' + name); }
  else {
    warn++; warnings.push(name);
    console.log('  ??  ' + name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300));
  }
}

function session() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    async call(method, p, body, headers) {
      const res = await fetch(BASE + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(headers || {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      let data = null;
      let text = '';
      try { text = await res.text(); data = JSON.parse(text); } catch { /* не JSON */ }
      return { status: res.status, data, text, headers: res.headers };
    },
    get(p, h) { return this.call('GET', p, undefined, h); },
    post(p, b, h) { return this.call('POST', p, b, h); },
    put(p, b) { return this.call('PUT', p, b); },
    del(p) { return this.call('DELETE', p); },
  };
}

const admin = session();
const seller = session();
const stamp = Date.now();

async function main() {
  await admin.post('/api/login', { username: 'admin', password: 'admin123' });
  const sellerLogin = `atk${String(stamp).slice(-6)}`;
  const made = await admin.post('/api/users', {
    username: sellerLogin, name: 'Проверяющий продавец', password: 'vitrina-2026-x',
  });
  check('подготовка: продавец заведён', made.status === 200, made.data);
  await seller.post('/api/login', { username: sellerLogin, password: 'vitrina-2026-x' });
  check('подготовка: продавец вошёл', (await seller.get('/api/me')).status === 200);

  console.log('\n=== Продавец пробует стать администратором ===');
  const meId = (await seller.get('/api/me')).data.user.id;
  check('через свой профиль', (await seller.put('/api/users/' + meId, { role: 'admin' })).status === 403);
  check('через чужой профиль', (await seller.put('/api/users/1', { role: 'seller' })).status === 403);
  check('роль не подделать полем в запросе на вход',
    (await session().post('/api/login', { username: sellerLogin, password: 'vitrina-2026-x', role: 'admin' }))
      .data.user.role === 'seller');
  const stillSeller = (await seller.get('/api/me')).data.user.role;
  check('роль осталась прежней', stillSeller === 'seller', stillSeller);

  console.log('\n=== Продавец пробует достать закупочные другими путями ===');
  const anyProduct = (await admin.get('/api/products?limit=1')).data.items[0];
  const probes = [
    ['через выгрузку', '/api/export/products'],
    ['через отчёт склада', '/api/analytics/stock'],
    ['через прибыль', '/api/finance/pnl'],
    ['через расчёты с поставщиком', '/api/debts/suppliers'],
    ['через товар на реализации', '/api/debts/consignment'],
    ['через журнал', '/api/audit?search=закупочная'],
  ];
  for (const [what, url] of probes) {
    const r = await seller.get(url);
    check(`${what} — закрыто`, r.status === 403, r.status);
  }
  // Изделие целиком, включая историю и возврат поставщику
  const card = await seller.get('/api/products/' + anyProduct.id);
  const raw = JSON.stringify(card.data);
  check('в полной карточке нет ни одного закупочного поля',
    !/purchase_price|purchase_rate|purchase_currency|"cost"/.test(raw),
    (raw.match(/purchase\w*/g) || []).slice(0, 3));

  console.log('\n=== Чужой скрипт в данных ===');
  const evil = '<img src=x onerror=alert(1)>';
  const evilSku = `XSS-${stamp}`;
  const saved = await admin.post('/api/products', {
    sku: evilSku, name: evil, retail_price: 1000, description: '"><script>alert(2)</script>',
  });
  check('изделие с подозрительным названием сохраняется как текст', saved.status === 200, saved.data);
  const back = (await admin.get('/api/products/' + saved.data.id)).data;
  check('название вернулось ровно тем, чем было — без вырезаний и без исполнения',
    back.name === evil, back.name);
  const csp = (await fetch(BASE + '/')).headers.get('content-security-policy') || '';
  check('и выполнить его в браузере негде: скрипты только свои', /script-src 'self'/.test(csp));
  // Поиск с теми же символами не должен ронять систему
  const search = await admin.get('/api/products?search=' + encodeURIComponent("' OR 1=1 --"));
  check('кавычки в поиске не ломают запрос', search.status === 200, search.status);
  check('и не открывают весь каталог', search.data.total === 0, search.data.total);

  console.log('\n=== Разведка логинов ===');
  // Отвечать по-разному на «нет такого» и «пароль не тот» — значит подсказывать,
  // какие логины существуют. Проверяем и текст, и время ответа.
  const noUser = await session().post('/api/login', { username: 'takogo-net-' + stamp, password: 'chto-ugodno' });
  const badPwd = await session().post('/api/login', { username: sellerLogin, password: 'ne-tot-parol' });
  check('ответ одинаковый по тексту',
    JSON.stringify(noUser.data) === JSON.stringify(badPwd.data), [noUser.data, badPwd.data]);
  check('и одинаковый по коду', noUser.status === badPwd.status, [noUser.status, badPwd.status]);

  /*
   * Время ответа мерим по нескольку раз и берём медиану: одиночный замер
   * шумит сильнее самой разницы, которую ищем. Заметная разница означала бы,
   * что по времени можно перебрать, какие логины в системе есть.
   */
  const median = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const timeOf = async username => {
    const runs = [];
    for (let i = 0; i < 7; i++) {
      const t = Date.now();
      await session().post('/api/login', { username, password: 'zavedomo-ne-tot-' + i });
      runs.push(Date.now() - t);
    }
    return median(runs);
  };
  // Мерим по одноразовой учётной записи: настоящие промахи закрывают вход
  // по этому логину на минуту, и «админ» после замеров был бы недоступен.
  const tNo = await timeOf('takogo-tochno-net-' + stamp);
  const tBad = await timeOf(sellerLogin);
  note(`время ответа не выдаёт существующие логины (${tNo} мс против ${tBad} мс)`,
    Math.abs(tNo - tBad) <= Math.max(15, Math.min(tNo, tBad) * 0.4),
    { нет_такого: tNo, пароль_не_тот: tBad });

  console.log('\n=== Что система рассказывает до входа ===');
  // Из магазинной сети подсказка нужна — люди путают поля на странице входа.
  const hintData = await (await fetch(BASE + '/api/login-hint')).json().catch(() => ({}));
  check('в магазинной сети подсказка про стандартный пароль работает',
    typeof hintData.default_admin === 'boolean', hintData);
  check('но ничего лишнего кроме неё не отдаёт',
    Object.keys(hintData).length === 1, hintData);
  const ping = await (await fetch(BASE + '/api/ping')).json();
  check('в отклике нет ничего, кроме имени системы',
    Object.keys(ping).every(k => ['app', 'port'].includes(k)), ping);
  const notFound = await fetch(BASE + '/api/net-takogo');
  check('на несуществующий адрес — без подробностей об устройстве системы',
    !/at |\.js:\d|Error:/.test(await notFound.text()));

  console.log('\n=== Обращение по чужим и кривым номерам ===');
  const weird = ['0', '-1', '99999999', 'abc', '1 OR 1=1', '../../etc/passwd', '1;DROP TABLE products'];
  for (const id of weird) {
    const r = await seller.get('/api/products/' + encodeURIComponent(id));
    check(`изделие «${id}» — понятный отказ, не сбой`, r.status === 404 || r.status === 400, r.status);
  }
  const alive = await admin.get('/api/products?limit=1');
  check('каталог после этого цел', alive.status === 200 && alive.data.total > 0, alive.data && alive.data.total);

  console.log('\n=== Файлы системы ===');
  const files = ['/data/asher.db', '/../data/asher.db', '/media/../../data/asher.db',
    '/media/..%2f..%2fdata%2fasher.db', '/js/../../server.js', '/.git/config', '/package.json'];
  for (const f of files) {
    const r = await fetch(BASE + f, { headers: { Cookie: admin.cookie } });
    const body = await r.text();
    const leaked = /SQLite format|require\(|"dependencies"|\[core\]/.test(body);
    check(`«${f}» наружу не отдаётся`, !leaked, body.slice(0, 60));
  }

  console.log('\n=== Фотографии чужими путями ===');
  const media = ['../../data/asher.db', '..%2f..%2fdata%2fasher.db', '/etc/hostname', 'x/../../server.js'];
  for (const m of media) {
    const r = await fetch(BASE + '/media/' + m, { headers: { Cookie: admin.cookie } });
    const body = await r.text();
    check(`фото «${m}» — отказ`, !/SQLite format|require\(/.test(body), r.status);
  }

  console.log('\n=== Нагрузка и мусор ===');
  const huge = 'я'.repeat(200000);
  const big = await admin.post('/api/products', { sku: 'BIG-' + stamp, name: huge, retail_price: 1 });
  check('очень длинное название не роняет систему', big.status === 200 || big.status === 400, big.status);
  const badJson = await fetch(BASE + '/api/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: '{сломанный json',
  });
  check('битый запрос — понятный отказ', badJson.status >= 400 && badJson.status < 500, badJson.status);
  check('система жива после этого', (await admin.get('/api/me')).status === 200);

  console.log('\n=== Выгрузка в Excel ===');
  // Название, начинающееся со знака равенства, Excel считает формулой.
  await admin.post('/api/products', {
    sku: `FRM-${stamp}`, name: '=1+1+cmd|\' /C calc\'!A0', retail_price: 1000,
  });
  const csv = await (await fetch(BASE + '/api/export/products', { headers: { Cookie: admin.cookie } })).text();
  const line = csv.split('\n').find(l => l.includes(`FRM-${stamp}`)) || '';
  note('в выгрузке названия не становятся формулами Excel',
    !/[;,"]=1\+1/.test(line) && !/^=/.test(line), line.slice(0, 80));

  console.log('\n=== Выход из системы ===');
  const bye = session();
  await bye.post('/api/login', { username: sellerLogin, password: 'vitrina-2026-x' });
  const token = bye.cookie;
  await bye.post('/api/logout');
  const reuse = session();
  reuse.cookie = token;
  check('после выхода прежняя cookie мертва', (await reuse.get('/api/me')).status === 401);

  console.log(`\nИтого: ${ok} ok, ${fail} fail, ${warn} к доработке`);
  if (failures.length) console.log('Провалено:\n  - ' + failures.join('\n  - '));
  if (warnings.length) console.log('К доработке:\n  - ' + warnings.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
