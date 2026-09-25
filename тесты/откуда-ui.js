'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * «Откуда пришёл» глазами человека.
 *
 * Владелец просил так: пункт «откуда пришёл», и сразу под ним — Instagram,
 * WhatsApp, сарафанное радио. Проверяем ровно это и там, где клиента
 * заводят на самом деле, — в кассе, при живом покупателе у прилавка:
 * кнопки видны сразу, выбор — одно нажатие, повторное нажатие снимает
 * выбор, а выбранное доезжает до базы. Потом — что владелец видит это
 * в карточке, в списке, в фильтре и в аналитике, и что на телефоне кнопки
 * не вылезают за край экрана.
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-откуда';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 200)); }
};
const ИМЯ = 'Бермет Источникова ' + Date.now().toString().slice(-6).replace(/\d/g, d => 'абвгдежзик'[d]);

async function войти(page, логин, пароль) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('#login-username', логин);
  await page.fill('#login-password', пароль);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
}

const найти = (page, имя) => page.evaluate(async q =>
  (await api.get('/api/customers?search=' + encodeURIComponent(q))).items, имя);

(async () => {
  const browser = await chromium.launch();
  const ошибки = [];

  console.log('=== Продавец заводит клиента в кассе и отмечает, откуда он ===');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => ошибки.push(e.message));
  await войти(page, 'anna', 'seller123');

  await page.click('#btn-quick-sale');
  await page.waitForSelector('#pos-customer');
  await page.fill('#pos-customer', ИМЯ);
  await page.waitForTimeout(1200);
  const завести = await page.$('.search-results .sr-item[data-new]');
  check('касса предлагает завести клиента', Boolean(завести));
  await завести.dispatchEvent('mousedown');
  await page.waitForSelector('#nc-form');

  const подписи = await page.$$eval('#nc-form .src-picker .chip', b => b.map(x => x.textContent.trim()));
  check('под пунктом «Откуда пришёл» сразу кнопки', подписи.length >= 3, подписи);
  check('первыми — Instagram, WhatsApp, сарафанное радио',
    JSON.stringify(подписи.slice(0, 3)) === JSON.stringify(['Instagram', 'WhatsApp', 'Сарафанное радио']), подписи);
  check('пункт так и назван',
    /Откуда пришёл/.test(await page.textContent('#nc-form .src-field > span')));
  check('сразу ничего не выбрано — не угадываем за продавца',
    (await page.$$('#nc-form .src-picker .chip.active')).length === 0);

  const кнопка = подпись => page.locator('#nc-form .src-picker .chip', { hasText: подпись });
  const выбрано = () => page.inputValue('#nc-form [name=source]');
  await кнопка('Instagram').click();
  check('нажали Instagram — он выбран', (await выбрано()) === 'instagram'
    && await кнопка('Instagram').evaluate(b => b.classList.contains('active')), await выбрано());
  await кнопка('Instagram').click();
  check('нажали ещё раз — выбор снят', (await выбрано()) === ''
    && (await page.$$('#nc-form .src-picker .chip.active')).length === 0, await выбрано());
  await кнопка('Instagram').click();
  await кнопка('Сарафанное радио').click();
  check('выбрать можно только одно', (await выбрано()) === 'referral'
    && (await page.$$('#nc-form .src-picker .chip.active')).length === 1, await выбрано());
  // Кнопки перекрашиваются плавно: без паузы снимок ловит середину перехода,
  // и на картинке не видно, что выбрано.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await снимок(page, { path: `${OUT}/касса-новый-клиент.png` });

  await page.fill('#nc-form [name=phone]', '0700 123 987');
  await page.click('[data-act=ok]');
  await page.waitForTimeout(1500);
  check('окно клиента закрылось, чек на месте', !(await page.$('#nc-form')) && Boolean(await page.$('#pos-customer')));
  let найден = (await найти(page, ИМЯ))[0];
  check('клиент заведён с источником «сарафанное радио»', найден && найден.source === 'referral', JSON.stringify(найден));
  await page.keyboard.press('Escape');
  await ctx.close();

  console.log('\n=== Владелец видит источник в списке, карточке и фильтре ===');
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  const page2 = await ctx2.newPage();
  page2.on('pageerror', e => ошибки.push(e.message));
  await войти(page2, 'admin', 'admin123');
  await page2.goto(BASE + '/#/customers');
  await page2.waitForSelector('#cf-source');
  check('в списке клиентов есть фильтр «Откуда»',
    (await page2.$$eval('#cf-source option', o => o.map(x => x.value))).includes('referral'));
  await page2.selectOption('#cf-source', 'referral');
  await page2.fill('#cf-search', ИМЯ);
  await page2.waitForTimeout(1200);
  const строки = await page2.$$eval('#cust-list tbody tr', r => r.map(x => x.textContent));
  check('отфильтрованный список нашёл клиента', строки.length === 1 && строки[0].includes(ИМЯ), строки);
  check('в строке видно, откуда он', строки.length === 1 && строки[0].includes('Сарафанное радио'), строки);
  await page2.selectOption('#cf-source', 'tiktok');
  await page2.waitForTimeout(1200);
  check('чужой фильтр его прячет', !(await page2.textContent('#cust-list')).includes(ИМЯ));
  await page2.selectOption('#cf-source', '');
  await page2.waitForTimeout(1200);

  await page2.click('#cust-list tbody tr');
  await page2.waitForSelector('.modal [data-act=edit]');
  const карточка = await page2.textContent('.modal-body');
  check('в карточке клиента — «Откуда пришёл: Сарафанное радио»',
    /Откуда пришёл\s*Сарафанное радио/.test(карточка), карточка.slice(0, 200));
  await page2.click('.modal [data-act=edit]');
  await page2.waitForSelector('#cust-form');
  check('в редакторе отмечен сохранённый источник',
    (await page2.$$eval('#cust-form .src-picker .chip.active', b => b.map(x => x.textContent.trim()))).join() === 'Сарафанное радио');
  await page2.locator('#cust-form .src-picker .chip', { hasText: 'WhatsApp' }).click();
  await page2.click('.modal [data-act=save]');
  await page2.waitForTimeout(1200);
  найден = (await найти(page2, ИМЯ))[0];
  check('источник поменялся из редактора', найден && найден.source === 'whatsapp', JSON.stringify(найден));

  // Новый клиент из раздела «Клиенты» — тот же пункт.
  await page2.click('#cf-add');
  await page2.waitForSelector('#cust-form');
  check('и при заведении из раздела «Клиенты» пункт на месте',
    (await page2.$$('#cust-form .src-picker .chip')).length >= 3);
  await снимок(page2, { path: `${OUT}/новый-клиент.png` });
  await page2.keyboard.press('Escape');
  await page2.waitForTimeout(300);

  console.log('\n=== Аналитика: откуда приходят клиенты ===');
  await page2.goto(BASE + '/#/analytics');
  await page2.waitForFunction(() => /Откуда приходят клиенты/.test(document.body.textContent), null, { timeout: 15000 });
  const аналитика = await page2.textContent('#an-body');
  check('в аналитике есть раздел «Откуда приходят клиенты»', /Откуда приходят клиенты/.test(аналитика));
  check('в нём видно WhatsApp', /WhatsApp/.test(аналитика));
  await снимок(page2, { path: `${OUT}/аналитика.png`, fullPage: true });
  await ctx2.close();

  console.log('\n=== На телефоне кнопки не вылезают за край ===');
  const ctx3 = await browser.newContext({ viewport: { width: 375, height: 800 }, hasTouch: true });
  const page3 = await ctx3.newPage();
  page3.on('pageerror', e => ошибки.push(e.message));
  await войти(page3, 'anna', 'seller123');
  await page3.goto(BASE + '/#/customers');
  await page3.waitForSelector('#cf-add');
  await page3.click('#cf-add');
  await page3.waitForSelector('#cust-form .src-picker');
  const края = await page3.evaluate(() => {
    const ряд = document.querySelector('#cust-form .src-picker').getBoundingClientRect();
    const кнопки = [...document.querySelectorAll('#cust-form .src-picker .chip')].map(b => b.getBoundingClientRect());
    return { правый: Math.max(...кнопки.map(r => r.right)), ряд: ряд.right,
      экран: window.innerWidth, страница: document.documentElement.scrollWidth };
  });
  check('все кнопки в пределах экрана', края.правый <= края.экран && края.правый <= края.ряд + 1, JSON.stringify(края));
  check('страница не шире телефона', края.страница <= края.экран, JSON.stringify(края));
  await снимок(page3, { path: `${OUT}/телефон.png` });
  await ctx3.close();

  // Владелец смотрит аналитику с телефона чаще, чем с компьютера. Деньги —
  // последняя колонка, и она первой уезжала бы за край.
  const ctx4 = await browser.newContext({ viewport: { width: 375, height: 800 }, hasTouch: true });
  const page4 = await ctx4.newPage();
  page4.on('pageerror', e => ошибки.push(e.message));
  await войти(page4, 'admin', 'admin123');
  await page4.goto(BASE + '/#/analytics');
  await page4.waitForFunction(() => /Откуда приходят клиенты/.test(document.body.textContent), null, { timeout: 15000 });
  const таблица = await page4.evaluate(() => {
    const карта = [...document.querySelectorAll('#an-body .card')].find(c => /Откуда приходят клиенты/.test(c.textContent));
    const ячейки = [...карта.querySelectorAll('td, th')].map(td => td.getBoundingClientRect().right);
    return { правый: Math.max(...ячейки), экран: window.innerWidth };
  });
  check('на телефоне выручка по источникам видна без прокрутки вбок',
    таблица.правый <= таблица.экран, JSON.stringify(таблица));
  await ctx4.close();

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
