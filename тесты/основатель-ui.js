'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Панель основателя глазами основателя — и её отсутствие глазами бухгалтера.
 *
 * Сервер закрывает панель и журнал от бухгалтера, это проверено отдельно.
 * Здесь смотрим, что видит человек: основатель находит панель в меню и она
 * показывает команду, ленту и кнопки «завести»; бухгалтер пункта не видит,
 * прямая ссылка уводит его на главную, вкладки «Журнал действий» у него нет,
 * а в списке сотрудников строку основателя править нечем.
 */
const path = require('node:path');
const ВЫВОД = path.join(__dirname, '.вывод');
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-roles';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const check = (n, c, e) => c ? (ok++, console.log('  ok  ' + n))
  : (fail++, console.log('  FAIL ' + n, e === undefined ? '' : String(e).slice(0, 300)));

async function зов(cookie, метод, путь, тело) {
  const r = await fetch(BASE + путь, {
    method: метод,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: тело === undefined ? undefined : JSON.stringify(тело),
  });
  let data = null;
  try { data = await r.json(); } catch { /* пусто */ }
  return { status: r.status, data };
}

(async () => {
  // Бухгалтера заводим от имени основателя заранее — через API, не через экран:
  // экран заведения проверяется в другом наборе, здесь нужен готовый человек.
  const вход = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const cookie = (вход.headers.get('set-cookie') || '').split(';')[0];
  const stamp = Date.now().toString(36);
  const логин = `buhui${stamp}`;
  const созд = await зов(cookie, 'POST', '/api/users',
    { username: логин, name: 'Гульнара Бухгалтер', role: 'accountant', password: 'Schet-ui-2026' });
  check('бухгалтер заведён для проверки', созд.status === 200, JSON.stringify(созд.data));

  const b = await chromium.launch();
  const errs = [];
  const открыть = async () => {
    const ctx = await b.newContext({ viewport: { width: 1500, height: 980 }, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(e.message));
    p.on('console', m => { if (m.type() === 'error' && !/status of 40[13]/.test(m.text())) errs.push(m.text()); });
    return p;
  };
  const войти = async (p, логин, пароль) => {
    await p.goto(BASE, { waitUntil: 'networkidle' });
    await p.fill('#login-username', логин);
    await p.fill('#login-password', пароль);
    await p.click('#login-form button[type=submit]');
    await p.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
  };
  const текстСтраницы = p => p.$eval('#page', el => el.innerText).catch(() => '');
  const пункты = p => p.$$eval('#nav .nav-item', els => els.map(e => e.textContent.trim()));
  const вкладки = p => p.$$eval('.tab', els => els.map(e => e.textContent.trim()));

  console.log('=== Основатель ===');
  const p = await открыть();
  await войти(p, 'admin', 'admin123');
  check('роль подписана «Основатель»', /Основатель/.test(await p.textContent('#user-role')),
    await p.textContent('#user-role'));
  const nav = await пункты(p);
  check('в меню есть «Панель основателя»', nav.some(n => /Панель основателя/.test(n)), nav);

  await p.goto(`${BASE}/#/team`);
  await p.waitForTimeout(2200);
  const text = await текстСтраницы(p);
  check('панель открылась: команда', /Команда/.test(text), text.slice(0, 200));
  check('панель открылась: лента', /Лента действий/.test(text));
  check('панель открылась: учётные записи', /Учётные записи/.test(text));
  check('в команде видно бухгалтера', /Гульнара Бухгалтер/.test(text));
  check('роли подписаны словами', /Бухгалтер/.test(text) && /Продавец/.test(text));
  check('кнопка «завести продавца» на месте', await p.isVisible('[data-add=seller]'));
  await снимок(p, { path: `${OUT}/основатель-панель.png`, fullPage: true });

  await p.click('[data-person] >> nth=0');
  await p.waitForTimeout(1500);
  check('лента переключается на одного человека',
    /Лента действий — .+/.test(await p.textContent('#team-feed-title')),
    await p.textContent('#team-feed-title'));
  await p.click('#team-feed-all');
  await p.waitForTimeout(800);
  check('и обратно на всех', /все/.test(await p.textContent('#team-feed-title')));

  await p.click('[data-days="30"]');
  await p.waitForTimeout(1500);
  check('период переключается', /за 30 дней/.test(await текстСтраницы(p)));

  // Окно «завести продавца»: роль уже выбрана, пароль уже придуман.
  await p.click('[data-add=seller]');
  await p.waitForTimeout(700);
  const пароль = await p.inputValue('.modal-body [name=password]');
  check('пароль придуман заранее и без похожих знаков',
    /^[a-km-zA-HJ-NP-Z2-9]{4}-[a-km-zA-HJ-NP-Z2-9]{4}-[a-km-zA-HJ-NP-Z2-9]{4}$/.test(пароль), пароль);
  check('пароль показан открыто, не звёздочками',
    (await p.getAttribute('.modal-body [name=password]', 'type')) === 'text');
  check('роль выбрана — продавец', (await p.inputValue('.modal-body [name=role]')) === 'seller');
  const опции = await p.$$eval('.modal-body [name=role] option', els => els.map(e => e.textContent));
  check('основателю доступна и роль «Основатель»', опции.some(o => /Основатель/.test(o)), опции);
  await снимок(p, { path: `${OUT}/основатель-завести.png` });
  await p.click('.modal-foot [data-act=cancel]');
  await p.waitForTimeout(400);

  await p.goto(`${BASE}/#/settings`);
  await p.waitForTimeout(1500);
  const tabs = await вкладки(p);
  check('у основателя есть вкладка «Журнал действий»', tabs.some(t => /Журнал/.test(t)), tabs);

  console.log('\n=== Бухгалтер ===');
  const p2 = await открыть();
  await войти(p2, логин, 'Schet-ui-2026');
  check('роль подписана «Бухгалтер»', /Бухгалтер/.test(await p2.textContent('#user-role')),
    await p2.textContent('#user-role'));
  const nav2 = await пункты(p2);
  check('Финансы на месте', nav2.some(n => /Финанс/.test(n)), nav2);
  check('Аналитика на месте', nav2.some(n => /Аналитик/.test(n)), nav2);
  check('«Панели основателя» в меню нет', !nav2.some(n => /Панель основателя/.test(n)), nav2);

  await p2.goto(`${BASE}/#/team`);
  await p2.waitForTimeout(1500);
  check('прямая ссылка на панель уводит на главную', /#\/dashboard/.test(p2.url()), p2.url());
  check('панель не показана', !/Лента действий/.test(await текстСтраницы(p2)));

  await p2.goto(`${BASE}/#/settings`);
  await p2.waitForTimeout(1500);
  const tabs2 = await вкладки(p2);
  check('вкладки «Журнал действий» нет', !tabs2.some(t => /Журнал/.test(t)), tabs2);
  check('вкладка «Сотрудники» есть', tabs2.some(t => /Сотрудник/.test(t)), tabs2);
  await p2.click('.tab:has-text("Сотрудники")');
  await p2.waitForTimeout(1500);
  const строки = await p2.$$eval('#set-body tbody tr', trs => trs.map(tr => ({
    text: tr.innerText, edit: Boolean(tr.querySelector('[data-user-edit]')),
  })));
  const основатель = строки.find(r => /Основатель/.test(r.text));
  check('строка основателя видна', Boolean(основатель), строки.map(r => r.text.slice(0, 40)).join(' | '));
  check('но править её нечем', основатель && !основатель.edit);
  const продавец = строки.find(r => /Продавец/.test(r.text));
  check('продавца править можно', продавец && продавец.edit);
  await снимок(p2, { path: `${OUT}/бухгалтер-сотрудники.png` });

  await p2.click('#user-add');
  await p2.waitForTimeout(700);
  const опции2 = await p2.$$eval('.modal-body [name=role] option', els => els.map(e => e.textContent));
  check('роли «Основатель» в выборе нет', !опции2.some(o => /Основатель/.test(o)), опции2);
  check('роль «Бухгалтер» есть', опции2.some(o => /Бухгалтер/.test(o)), опции2);
  await p2.click('.modal-foot [data-act=cancel]');

  await p2.goto(`${BASE}/#/finance`);
  await p2.waitForTimeout(1800);
  check('финансы открываются бухгалтеру', (await текстСтраницы(p2)).trim().length > 20);
  await p2.goto(`${BASE}/#/products`);
  await p2.waitForTimeout(2000);
  await p2.click('#pf-view');
  await p2.waitForTimeout(1200);
  const шапки = await p2.$$eval('#prod-list th', els => els.map(e => e.textContent.trim()));
  check('в каталоге у бухгалтера есть колонка «Закупка»', шапки.some(h => /Закупк/i.test(h)), шапки);

  check('в браузере нет ошибок', errs.length === 0, errs.slice(0, 3).join(' | '));
  await b.close();

  // Уборка: отключаем, как отключают уволившегося.
  await зов(cookie, 'PUT', `/api/users/${созд.data.id}`, { active: false });

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
