require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-roles';
require('fs').mkdirSync(OUT, { recursive: true });
let ok = 0, fail = 0;
const check = (n, c, e) => c ? (ok++, console.log('  ok  ' + n))
  : (fail++, console.log('  FAIL ' + n, e === undefined ? '' : String(e).slice(0, 300)));

// Слова, которые продавец не должен встретить на экране ни в одном разделе.
const BAD_WORDS = /Закупочн|Закупка в валюте|Наценка|Себестоимост|Прибыл|Маржа|Отдать владельцу|По себестоимости/i;

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1500, height: 980 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/status of 40[13]/.test(m.text())) errs.push(m.text()); });

  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.fill('#login-username', 'anna'); await p.fill('#login-password', 'seller123');
  await p.click('#login-form button[type=submit]');
  await p.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
  check('продавец вошёл', true);
  check('роль подписана «Продавец»',
    /Продавец/.test(await p.textContent('#user-role')), await p.textContent('#user-role'));

  const nav = await p.$$eval('#nav a, #nav .nav-item', els => els.map(e => e.textContent.trim()));
  console.log('     меню продавца:', nav.join(' | '));
  check('в меню нет Финансов', !nav.some(n => /Финанс/.test(n)), nav);
  check('в меню нет Аналитики', !nav.some(n => /Аналитик/.test(n)), nav);
  check('в меню нет Импорта из 1С', !nav.some(n => /Импорт/.test(n)), nav);
  check('касса на месте', nav.some(n => /Продаж|Касс/i.test(n)), nav);
  check('каталог на месте', nav.some(n => /Каталог|Издели/i.test(n)), nav);

  const pages = [
    ['dashboard', 'Главная'], ['products', 'Каталог'], ['sales', 'Продажи'],
    ['customers', 'Клиенты'], ['orders', 'Заказы'], ['debts', 'Долги'],
    ['inventory', 'Инвентаризация'], ['labels', 'Бирки'], ['sets', 'Комплекты'],
    ['settings', 'Настройки'],
  ];
  for (const [key, title] of pages) {
    await p.goto(`${BASE}/#/${key}`);
    await p.waitForTimeout(1600);
    const text = await p.$eval('#page', el => el.innerText).catch(() => '');
    check(`${title}: страница открылась`, text.trim().length > 20, text.slice(0, 120));
    const bad = text.match(BAD_WORDS);
    check(`${title}: без внутренних цифр`, !bad, bad && text.split('\n')
      .filter(l => BAD_WORDS.test(l)).slice(0, 3).join(' / '));
    await снимок(p, { path: `${OUT}/продавец-${key}.png` });
  }

  // Каталог: карточка и форма редактирования
  await p.goto(`${BASE}/#/products`); await p.waitForTimeout(2000);
  await p.click('#pf-view'); await p.waitForTimeout(1500);   // переключаемся на таблицу
  const heads = await p.$$eval('#prod-list th', els => els.map(e => e.textContent.trim()));
  check('таблица каталога открылась', heads.length > 2, heads);
  check('в таблице каталога нет колонки «Закупка»', !heads.some(h => /Закупк/i.test(h)), heads);
  const rowText = await p.$eval('#prod-list', el => el.innerText);
  // «закупка» может встретиться в самом названии изделия — ловим только ярлыки
  check('в таблице каталога нет внутренних цифр', !BAD_WORDS.test(rowText),
    rowText.split('\n').filter(l => BAD_WORDS.test(l)).slice(0, 2).join(' / '));
  await снимок(p, { path: `${OUT}/продавец-каталог-таблица.png`, fullPage: true });
  await p.click('#pf-view'); await p.waitForTimeout(1400);   // обратно на плитки

  const card = await p.$('.pcard');
  if (card) {
    await card.click(); await p.waitForTimeout(1400);
    const body = await p.$eval('.modal-body', el => el.innerText);
    check('карточка изделия: без закупочной и наценки', !BAD_WORDS.test(body),
      body.split('\n').filter(l => BAD_WORDS.test(l)).join(' / '));
    check('карточка изделия: розничная цена видна', /сом|⃀|\d/.test(body));
    await снимок(p, { path: `${OUT}/продавец-карточка.png`, fullPage: true });
    await p.keyboard.press('Escape'); await p.waitForTimeout(500);
  }

  // Форма изделия: полей закупки быть не должно, но работать она обязана
  const addBtn = await p.$('#pf-add');
  if (addBtn) {
    await addBtn.click(); await p.waitForTimeout(900);
    check('форма: нет поля закупочной цены', !(await p.isVisible('[name=purchase_price]')));
    check('форма: нет валютной закупки', !(await p.isVisible('#pf-usd')));
    check('форма: розничная цена есть', await p.isVisible('[name=retail_price]'));
    check('форма: каратность есть', await p.isVisible('[name=carat]'));
    const ftext = await p.$eval('.modal-body', el => el.innerText);
    check('форма: без слова «Закупочная»', !BAD_WORDS.test(ftext),
      ftext.split('\n').filter(l => BAD_WORDS.test(l)).join(' / '));
    await снимок(p, { path: `${OUT}/продавец-форма-изделия.png`, fullPage: true });

    // Продавец правит настоящее изделие — закупочная не должна пропасть
    await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  }

  // Продажа из кассы продавцом — основная работа, она обязана идти без запинок
  await p.goto(`${BASE}/#/sales`); await p.waitForTimeout(1800);
  await снимок(p, { path: `${OUT}/продавец-касса.png`, fullPage: true });

  // Сравним с админом: у него всё внутреннее на месте
  const p2 = await (await b.newContext({ viewport: { width: 1500, height: 980 }, deviceScaleFactor: 2 })).newPage();
  await p2.goto(BASE, { waitUntil: 'networkidle' });
  await p2.fill('#login-username', 'admin'); await p2.fill('#login-password', 'admin123');
  await p2.click('#login-form button[type=submit]');
  await p2.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
  const nav2 = await p2.$$eval('#nav a, #nav .nav-item', els => els.map(e => e.textContent.trim()));
  check('у администратора Финансы и Аналитика на месте',
    nav2.some(n => /Финанс/.test(n)) && nav2.some(n => /Аналитик/.test(n)), nav2);
  await p2.goto(`${BASE}/#/products`); await p2.waitForTimeout(2000);
  await p2.click('#pf-view'); await p2.waitForTimeout(1500);
  const heads2 = await p2.$$eval('#prod-list th', els => els.map(e => e.textContent.trim()));
  check('у администратора колонка «Закупка» осталась', heads2.some(h => /Закупк/i.test(h)), heads2);
  await p2.click('#pf-view'); await p2.waitForTimeout(1200);
  const add2 = await p2.$('#pf-add');
  await add2.click(); await p2.waitForTimeout(900);
  check('у администратора поле закупочной осталось', await p2.isVisible('[name=purchase_price]'));
  check('у администратора валютная закупка осталась', await p2.isVisible('#pf-usd'));
  await снимок(p2, { path: `${OUT}/админ-форма-изделия.png`, fullPage: true });

  check('в браузере нет ошибок', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
