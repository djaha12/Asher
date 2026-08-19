const ВЫВОД = require('node:path').join(__dirname, '.вывод');
const { chromium } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-roles';
let ok = 0, fail = 0;
const check = (n, c, e) => c ? (ok++, console.log('  ok  ' + n))
  : (fail++, console.log('  FAIL ' + n, e === undefined ? '' : String(e).slice(0, 250)));

(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1.6 })).newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/status of 40[13]/.test(m.text())) errs.push(m.text()); });

  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.fill('#login-username', 'admin'); await p.fill('#login-password', 'admin123');
  await p.click('#login-form button[type=submit]');
  await p.waitForSelector('#app:not(.hidden)');

  console.log('=== Заводим сотрудника и подключаем его телефон ===');
  await p.goto(`${BASE}/#/settings`); await p.waitForTimeout(1300);
  await p.click('.tab[data-tab=users]'); await p.waitForTimeout(1300);

  const login = 'aigul' + String(Date.now()).slice(-5);
  await p.click('#user-add'); await p.waitForTimeout(800);
  await p.fill('[name=username]', login);
  await p.fill('[name=name]', 'Айгуль Осмонова');
  await p.fill('[name=password]', 'prilavok2026');
  const hint = await p.textContent('#role-hint');
  check('в форме объяснено, что видит продавец', /закупочн/i.test(hint), hint);
  await p.click('.modal-foot [data-act=ok]');
  await p.waitForTimeout(1500);

  const cardText = await p.$eval('.modal-body', el => el.innerText).catch(() => '');
  check('карточка подключения открылась сразу', /Что сделать на телефоне/.test(cardText),
    cardText.slice(0, 150));
  check('на карточке логин сотрудника', cardText.includes(login), cardText.slice(0, 200));
  check('на карточке есть QR', Boolean(await p.$('.phone-qr svg')));
  check('объяснено про «На экран Домой»', /экран/i.test(cardText) && /Установить приложение/.test(cardText));
  await p.screenshot({ path: `${OUT}/карточка-телефона.png` });
  await p.keyboard.press('Escape'); await p.waitForTimeout(600);

  console.log('\n=== Кнопка 📱 у каждого сотрудника ===');
  const phoneBtns = await p.$$('[data-user-phone]');
  check('кнопка подключения есть у всех сотрудников', phoneBtns.length >= 3, phoneBtns.length);
  await phoneBtns[0].click(); await p.waitForTimeout(1200);
  check('карточка открывается и из списка', Boolean(await p.$('.phone-qr svg')));
  const linkText = await p.$eval('#phone-card', el => el.innerText);
  check('в карточке показан адрес системы', /http:\/\//.test(linkText), linkText.slice(0, 120));
  await p.keyboard.press('Escape'); await p.waitForTimeout(500);

  console.log('\n=== Адрес, который не меняется ===');
  await p.click('.tab[data-tab=store]'); await p.waitForTimeout(1500);
  const storeText = await p.$eval('#set-body', el => el.innerText);
  check('показан адрес по имени компьютера', /не меняется/.test(storeText),
    storeText.split('\n').filter(l => /адрес/i.test(l)).slice(0, 3).join(' / '));

  console.log('\n=== Телефон открывает ссылку из QR ===');
  // Так это выглядит у продавца: перешёл по коду — логин уже стоит.
  const phone = await (await b.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  })).newPage();
  await phone.goto(`${BASE}/#login=${login}`, { waitUntil: 'networkidle' });
  await phone.waitForTimeout(1200);
  const prefilled = await phone.inputValue('#login-username');
  check('логин подставлен из ссылки', prefilled === login, prefilled);
  check('пароль пустой — его вводит сам сотрудник',
    (await phone.inputValue('#login-password')) === '');
  await phone.screenshot({ path: `${OUT}/телефон-вход.png` });

  await phone.fill('#login-password', 'prilavok2026');
  await phone.click('#login-form button[type=submit]');
  await phone.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
  check('вход с телефона по ссылке проходит', true);
  check('после входа ссылка стала обычной', /#\/dashboard/.test(await phone.evaluate(() => location.hash)),
    await phone.evaluate(() => location.hash));
  check('новый сотрудник — продавец', /Продавец/.test(await phone.textContent('#user-role')));
  await phone.waitForTimeout(1200);
  await phone.screenshot({ path: `${OUT}/телефон-главная.png` });

  // Продавец должен уметь работать сразу
  await phone.goto(`${BASE}/#/products`); await phone.waitForTimeout(1800);
  const cat = await phone.$eval('#page', el => el.innerText);
  check('каталог на телефоне открывается', cat.length > 40, cat.slice(0, 80));
  check('на телефоне нет закупочных цен', !/Закупочн|Наценка/i.test(cat));
  await phone.screenshot({ path: `${OUT}/телефон-каталог.png` });

  check('ошибок в браузере нет', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
