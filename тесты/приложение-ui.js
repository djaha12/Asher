'use strict';
/*
 * Страница внутри приложения для iPhone — глазами браузера.
 *
 * Настоящего iPhone в проверках нет, но приложение разговаривает со страницей
 * только через мост (ios/Diamonds/Bridge.swift): встраивает в неё сценарий
 * и принимает сообщения. Поэтому здесь в браузер встраивается тот же самый
 * сценарий, взятый прямо из файла приложения, а «приложение» по ту сторону —
 * заглушка, которая записывает сообщения и отвечает так, как отвечает iOS.
 *
 * Проверяется то, что без этого сломалось бы молча:
 *   • печать бирок — подготовленное для печати не должно исчезнуть раньше,
 *     чем AirPrint его заберёт, иначе на бумагу уйдёт пустой лист;
 *   • уведомления — объяснение перед системным вопросом, адрес телефона
 *     доходит до сервера, при выходе отписывается;
 *   • часы и батарея перекрашиваются вместе с темой;
 *   • ссылка на демо-версию видна только в приложении и только новичку;
 *   • в обычном браузере ничего из этого не появляется.
 */
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http2 = require('node:http2');
const net = require('node:net');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { chromium, снимок } = require('./браузер');

const ROOT = path.resolve(__dirname, '..');
const РАБОТА = path.join(__dirname, '.вывод', 'приложение-ui');
const БАЗА_ПОРТА = Number((process.env.BASE || '').match(/:(\d+)/)?.[1] || 3122);
const ПОРТ = БАЗА_ПОРТА + 71;
const ПОРТ_ДЕМО = БАЗА_ПОРТА + 72;
const ПОРТ_APPLE = БАЗА_ПОРТА + 73;
const BASE = `http://127.0.0.1:${ПОРТ}`;
const ДЕМО = `http://127.0.0.1:${ПОРТ_ДЕМО}`;
const СНИМКИ = path.join(__dirname, '.вывод', 'shots-app');
fs.mkdirSync(СНИМКИ, { recursive: true });

let ok = 0, fail = 0;
const check = (n, c, e) => c ? (ok++, console.log('  ok  ' + n))
  : (fail++, console.log('  FAIL ' + n, e === undefined ? '' : String(JSON.stringify(e)).slice(0, 260)));

// Поддельный Apple — чтобы проверочное уведомление было куда отправить.
const пришло = [];
const apple = http2.createServer();
apple.on('stream', (stream, headers) => {
  let тело = '';
  stream.setEncoding('utf8');
  stream.on('data', ч => { тело += ч; });
  stream.on('end', () => {
    пришло.push({ адрес: String(headers[':path']).split('/').pop(), body: JSON.parse(тело || '{}') });
    stream.respond({ ':status': 200 });
    stream.end();
  });
});

const КЛЮЧ = path.join(РАБОТА, 'key.p8');
const общее = { ...process.env, NO_OPEN: '1', NO_PROXY: '*', no_proxy: '*' };
const окружение = {
  ...общее,
  ASHER_DB: path.join(РАБОТА, 'asher.db'), ASHER_DATA: РАБОТА, ASHER_MEDIA: path.join(РАБОТА, 'images'),
  PORT: String(ПОРТ),
  ASHER_APNS_HOST: `http://127.0.0.1:${ПОРТ_APPLE}`, ASHER_APNS_KEY_FILE: КЛЮЧ,
  ASHER_APNS_KEY_ID: 'UIKEY12345', ASHER_APNS_TEAM_ID: 'UITEAM1234',
};
const окружениеДемо = {
  ...общее,
  ASHER_DB: path.join(РАБОТА, 'демо', 'asher.db'), ASHER_DATA: path.join(РАБОТА, 'демо'),
  ASHER_MEDIA: path.join(РАБОТА, 'демо', 'images'), PORT: String(ПОРТ_ДЕМО), ASHER_DEMO: '1',
};

const живПорт = порт => new Promise(res => {
  const s = net.connect(порт, '127.0.0.1');
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('error', () => res(false));
  setTimeout(() => { s.destroy(); res(false); }, 300);
});
const подождать = мс => new Promise(r => setTimeout(r, мс));

// Сценарий моста — ровно тот, что встраивает приложение, из его исходника.
const мост = (() => {
  const swift = fs.readFileSync(path.join(ROOT, 'ios', 'Diamonds', 'Bridge.swift'), 'utf8');
  const m = swift.match(/"""\n([\s\S]*?)\n\s*"""/);
  if (!m) throw new Error('Не нашёл сценарий моста в Bridge.swift');
  return m[1];
})();
const АДРЕС_ТЕЛЕФОНА = 'ab'.repeat(32);

// «iOS» по ту сторону моста: записывает просьбы и отвечает, как отвечает телефон.
const заглушка = `
  window.__сообщения = [];
  window.webkit = { messageHandlers: { asher: { postMessage: function (m) {
    window.__сообщения.push(JSON.parse(JSON.stringify(m)));
    if (m.type === 'print') setTimeout(function () { window.asherNative._printed(m.id); }, 700);
    if (m.type === 'push') setTimeout(function () { window.asherNative._token('${АДРЕС_ТЕЛЕФОНА}', 'sandbox'); }, 100);
  } } } };
`;

let сервер = null, демо = null;

(async () => {
  fs.rmSync(РАБОТА, { recursive: true, force: true });
  fs.mkdirSync(path.join(РАБОТА, 'демо'), { recursive: true });
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.writeFileSync(КЛЮЧ, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  await new Promise(r => apple.listen(ПОРТ_APPLE, '127.0.0.1', r));
  for (const env of [окружение, окружениеДемо]) {
    const s = spawnSync(process.execPath, [path.join('src', 'seed.js'), '--reset'], { cwd: ROOT, env, encoding: 'utf8' });
    if (s.status !== 0) { console.error(s.stderr || s.stdout); process.exit(2); }
  }
  сервер = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: окружение, stdio: 'ignore' });
  демо = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: окружениеДемо, stdio: 'ignore' });
  for (let i = 0; i < 100 && !(await живПорт(ПОРТ) && await живПорт(ПОРТ_ДЕМО)); i++) await подождать(200);

  const b = await chromium.launch();
  const errs = [];
  const окно = async (вПриложении) => {
    const ctx = await b.newContext({ viewport: { width: 1300, height: 900 } });
    if (вПриложении) {
      await ctx.addInitScript({ content: заглушка });
      await ctx.addInitScript({ content: мост });
    }
    const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(e.message));
    p.on('console', m => { if (m.type() === 'error' && !/status of 40[013]/.test(m.text())) errs.push(m.text()); });
    return p;
  };
  const сообщения = p => p.evaluate(() => window.__сообщения || []);
  const войти = async (p, база) => {
    await p.fill('#login-username', 'admin');
    await p.fill('#login-password', 'admin123');
    await p.click('#login-form button[type=submit]');
    await p.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
  };

  console.log('=== 1. Экран входа в приложении ===');
  const p = await окно(true);
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);
  check('страница поняла, что она в приложении', await p.evaluate(() => Boolean(window.asherNative && window.asherNative.app)));
  check('часы на тёмном экране входа — светлые',
    (await сообщения(p)).some(m => m.type === 'status' && m.style === 'light'), await сообщения(p));
  check('новичку в приложении видна ссылка на демо', await p.isVisible('#login-to-demo'));
  check('ссылка ведёт на поддомен demo',
    /^https:\/\/demo\./.test(await p.getAttribute('#login-to-demo', 'href')), await p.getAttribute('#login-to-demo', 'href'));
  check('плашки демо в рабочей системе нет', !(await p.isVisible('#login-demo')));
  await снимок(p, { path: path.join(СНИМКИ, 'вход-в-приложении.png') });

  console.log('\n=== 2. Уведомления: сначала объяснение, потом вопрос iPhone ===');
  await войти(p);
  await p.waitForSelector('.modal-head h2:has-text("Уведомления на телефон")', { timeout: 5000 }).catch(() => {});
  const окноУведомлений = await p.isVisible('.modal-head h2:has-text("Уведомления на телефон")');
  check('после входа основателю объяснили, о чём уведомления', окноУведомлений);
  check('системный вопрос ещё не задан — ждём «Разрешить»',
    !(await сообщения(p)).some(m => m.type === 'push'));
  await снимок(p, { path: path.join(СНИМКИ, 'уведомления-вопрос.png') });
  await p.click('.modal-foot [data-act=ok]');
  await p.waitForTimeout(600);
  check('по «Разрешить» приложение попросило разрешение у iPhone',
    (await сообщения(p)).some(m => m.type === 'push'));
  const статус = await p.evaluate(() => fetch('/api/push/status').then(r => r.json()));
  check('адрес телефона дошёл до сервера и привязан к основателю', статус.mine === 1, статус);
  check('после входа ссылка на демо больше не нужна',
    await p.evaluate(() => localStorage.getItem('asher-был-вход')) === '1');

  console.log('\n=== 3. Уведомление ведёт прямо в «Безопасность» ===');
  await p.evaluate(() => window.asherNative._open('#/settings/security'));
  await p.waitForTimeout(1500);
  check('открылась вкладка «Безопасность»',
    /Безопасность/.test(await p.textContent('.tab.active')), await p.textContent('.tab.active'));
  check('наверху — карточка уведомлений этого телефона',
    /Этот телефон получает уведомления/.test(await p.textContent('#push-card')));
  пришло.length = 0;
  await p.click('#push-test');
  await p.waitForTimeout(800);
  check('проверочное уведомление ушло в Apple',
    пришло.some(x => x.адрес === АДРЕС_ТЕЛЕФОНА && x.body.aps.alert.title === 'Уведомления работают'),
    пришло.map(x => x.body.aps && x.body.aps.alert.title));
  await снимок(p, { path: path.join(СНИМКИ, 'безопасность-уведомления.png') });

  console.log('\n=== 4. Часы перекрашиваются вместе с темой ===');
  const последний = async () => (await сообщения(p)).filter(m => m.type === 'status').pop();
  await p.evaluate(() => ui.applyTheme('dark'));
  check('тёмная тема — светлые часы', (await последний()).style === 'light', await последний());
  await p.evaluate(() => ui.applyTheme('light'));
  check('светлая тема — тёмные часы', (await последний()).style === 'dark', await последний());

  console.log('\n=== 5. Бирки печатаются, а не уходят пустым листом ===');
  await p.goto(`${BASE}/#/labels`);
  await p.waitForTimeout(1800);
  await p.click('#lb-all');
  await p.waitForTimeout(300);
  const доПечати = (await сообщения(p)).filter(m => m.type === 'print').length;
  await p.click('#lb-print');
  await p.waitForTimeout(400);
  check('печать ушла в приложение (AirPrint)',
    (await сообщения(p)).filter(m => m.type === 'print').length === доПечати + 1);
  check('пока AirPrint не ответил, бирки на месте',
    await p.$eval('#print-root', el => el.innerHTML.length > 100));
  await p.waitForTimeout(1500);
  check('ответил — место под печать убрано', await p.$eval('#print-root', el => el.innerHTML === ''));

  console.log('\n=== 6. Выход отписывает телефон ===');
  await p.click('#btn-logout');
  await p.waitForSelector('#login-screen:not(.hidden)', { timeout: 10000 });
  await p.waitForTimeout(400);
  const база = new DatabaseSync(окружение.ASHER_DB, { readOnly: true });
  check('после выхода уведомления основателя на этот телефон не идут',
    Number(база.prepare(`SELECT COUNT(*) AS c FROM push_tokens WHERE token = ?`).get(АДРЕС_ТЕЛЕФОНА).c) === 0);
  база.close();
  check('тому, кто уже входил, ссылка на демо не показывается', !(await p.isVisible('#login-to-demo')));

  console.log('\n=== 7. Демо-версия в приложении ===');
  const д = await окно(true);
  await д.goto(ДЕМО, { waitUntil: 'networkidle' });
  await д.waitForTimeout(600);
  check('в демо сразу видно, как войти', await д.isVisible('#login-demo')
    && /admin123/.test(await д.textContent('#login-demo')));
  check('и есть дорога обратно в рабочую систему', await д.isVisible('#login-demo-back'));
  check('подсказки для первого входа не дублируются', !(await д.isVisible('#login-hint')));
  await снимок(д, { path: path.join(СНИМКИ, 'демо-вход.png') });

  console.log('\n=== 8. В обычном браузере ничего этого нет ===');
  const о = await окно(false);
  await о.goto(BASE, { waitUntil: 'networkidle' });
  await о.waitForTimeout(500);
  check('браузер не притворяется приложением', await о.evaluate(() => window.asherNative === undefined));
  check('ссылки на демо в браузере нет', !(await о.isVisible('#login-to-demo')));
  await войти(о);
  await о.waitForTimeout(1200);
  check('вопроса об уведомлениях в браузере нет',
    !(await о.isVisible('.modal-head h2:has-text("Уведомления на телефон")')));
  await о.goto(`${BASE}/#/settings/security`);
  await о.waitForTimeout(1500);
  check('в браузере карточка объясняет, что уведомления — в приложении',
    /приходят в приложение Diamonds на iPhone/.test(await о.textContent('#push-card')));

  check('в браузере нет ошибок', errs.length === 0, errs.slice(0, 3));
  await b.close();
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
})()
  .catch(e => { console.error(e); fail++; })
  .finally(() => {
    for (const s of [сервер, демо]) { try { if (s) s.kill(); } catch { /* уже */ } }
    apple.close();
    setTimeout(() => process.exit(fail ? 1 : 0), 300);
  });
