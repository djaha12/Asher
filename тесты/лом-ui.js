'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Старое золото убрано — совсем.
 *
 * Владелец: «графа старое золото не нужна» — и из кассы тоже: старое
 * золото в зачёт магазин не принимает. Поэтому его нет ни в меню, ни в
 * кассе, ни в Настройках (цены грамма лома), а адрес раздела ведёт на
 * Главную. Касса считает, как до зачёта: «К оплате» — вся сумма.
 *
 * Чек, по которому золото когда-то приняли, не теряется: в его карточке
 * по-прежнему зачёт по акту и кнопка печати акта.
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-лом';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 260)); }
};
const МЕТКА = 'ЛУИ' + process.pid;
const ТЕЛЕФОН = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const чисто = t => String(t || '').replace(/[  ]/g, ' ').replace(/\s+/g, ' ');

let cookie = '';
async function зов(метод, путь, тело) {
  const r = await fetch(BASE + путь, {
    method: метод, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: тело === undefined ? undefined : JSON.stringify(тело),
  });
  let data = null;
  try { data = await r.json(); } catch { /* пусто */ }
  return { status: r.status, data };
}

async function войти(page, логин, пароль) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('#login-username', логин);
  await page.fill('#login-password', пароль);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
}

(async () => {
  const вход = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  cookie = (вход.headers.get('set-cookie') || '').split(';')[0];
  // Чек из прежних времён: золото приняли в зачёт, пока касса это умела.
  await зов('PUT', '/api/settings', { scrap_price_585: '4000' });
  const кольцо = (await зов('POST', '/api/products', { sku: `${МЕТКА}-1`, name: 'Кольцо', retail_price: 50000 })).data.id;
  const клиентка = (await зов('POST', '/api/customers', { name: `Динара ${МЕТКА}` })).data.id;
  const старый = (await зов('POST', '/api/sales', { customer_id: клиентка, items: [{ product_id: кольцо }],
    payment_method: 'cash', scrap: [{ description: 'старое кольцо', fineness: 585, weight: '4,5' }] })).data;
  await зов('PUT', '/api/settings', { scrap_price_585: '' });
  await зов('POST', '/api/products', { sku: `${МЕТКА}-2`, name: 'Серьги', retail_price: 30000 });

  const browser = await chromium.launch();
  const page = await (await browser.newContext(ТЕЛЕФОН)).newPage();
  const ошибки = [];
  page.on('pageerror', e => ошибки.push(e.message));
  await page.addInitScript(() => { window.print = () => { window.__печать = (window.__печать || 0) + 1; }; });

  for (const [кто, логин, пароль] of [['владелец', 'admin', 'admin123'], ['продавец', 'anna', 'seller123']]) {
    console.log(`\n=== ${кто}: в меню нет «Старого золота» ===`);
    await войти(page, логин, пароль);
    // Меню одно на компьютер и телефон (кнопка «☰» показывает те же пункты).
    const меню = await page.$$eval('.nav-item[data-key]', els => els.map(e => e.dataset.key + ' ' + e.textContent.trim()));
    check('пункта нет', меню.length > 3 && !меню.some(x => x.startsWith('scrap') || /Старое золото/.test(x)), меню.join(' | '));
    await page.evaluate(() => { location.hash = '#/scrap'; });
    await page.waitForTimeout(800);
    check('адрес раздела ведёт на Главную', !(await page.$('#scrap-list')) && /Главная/.test(await page.textContent('#page-title').catch(() => '')),
      await page.textContent('#page-title').catch(() => ''));
    await page.click('#btn-logout').catch(() => {});
    await page.evaluate(() => localStorage.clear()).catch(() => {});
    await page.context().clearCookies();
  }

  console.log('\n=== Касса: кнопки нет, «К оплате» — вся сумма ===');
  await войти(page, 'anna', 'seller123');
  await page.click('#btn-quick-sale');
  await page.waitForSelector('#pos-search');
  check('кнопки «Старое золото в зачёт» нет', !(await page.$('#pos-scrap-add'))
    && !/Старое золото/.test(await page.textContent('#modal-root')));
  await page.fill('#pos-search', `${МЕТКА}-2`);
  await page.waitForTimeout(1200);
  const найдено = await page.$('.search-results .sr-item[data-i]');
  if (найдено) await найдено.dispatchEvent('mousedown');
  await page.waitForSelector('.pos-item');
  const итоги = чисто(await page.textContent('#pos-summary'));
  check('«К оплате 30 000», без зачёта и «К доплате»', /К оплате\s*30 000/.test(итоги) && !/зачёт|доплате/.test(итоги), итоги);
  check('без клиента оформить можно — долга нет', !(await page.isDisabled('[data-act=submit]')));
  await снимок(page, { path: `${OUT}/касса.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.click('#btn-logout').catch(() => {});
  await page.context().clearCookies();

  console.log('\n=== Настройки: цены грамма лома нет ===');
  await войти(page, 'admin', 'admin123');
  await page.goto(BASE + '/#/settings');
  await page.waitForSelector('#st-save', { timeout: 10000 }).catch(() => {});
  check('поля нет', !(await page.$('[name=scrap_price_585]')) && !/Старое золото/.test(await page.textContent('#page')));

  console.log('\n=== Чек, по которому золото приняли раньше, — на месте ===');
  await page.goto(BASE + '/#/sales/' + старый.id);
  await page.waitForSelector('.modal [data-act=scrap-act]', { timeout: 10000 }).catch(() => {});
  check('в карточке чека — зачёт по акту', /Старое золото в зачёт по акту Л-/.test(чисто(await page.textContent('.modal-body').catch(() => ''))));
  await page.click('.modal [data-act=scrap-act]').catch(() => {});
  check('акт печатается', (await page.evaluate(() => window.__печать)) === 1
    && /Акт приёма № Л-/.test(await page.textContent('#print-root')));

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
