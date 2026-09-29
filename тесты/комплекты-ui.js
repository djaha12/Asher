'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Комплекты убраны.
 *
 * Владелец: «комплекты тоже убери». Раздела нет ни в меню, ни по адресу
 * (он ведёт на Главную), в общем поиске комплекты не показываются, в
 * карточке изделия нет строки «Комплект», и в описании прав продавца их нет.
 *
 * Комплект, собранный раньше, никому не мешает: изделие из него продаётся
 * в кассе как обычное.
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-комплекты';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 260)); }
};
// Метка из букв: цифры метки процесса не должны совпасть с чужими артикулами.
const МЕТКА = 'КМП' + process.pid.toString(36).toUpperCase();
const ВЕРХ = '#modal-root > .modal-overlay:last-child';
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
  await page.context().clearCookies();
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
  // Комплект из прежних времён: собран, пока раздел был.
  const серьги = (await зов('POST', '/api/products', { sku: `${МЕТКА}-1`, name: 'Серьги', retail_price: 60000 })).data.id;
  const кольцо = (await зов('POST', '/api/products', { sku: `${МЕТКА}-2`, name: 'Кольцо', retail_price: 40000 })).data.id;
  const комплект = (await зов('POST', '/api/sets', { name: `Гарнитур ${МЕТКА}`, sku: `${МЕТКА}-К`, price: 90000,
    product_ids: [серьги, кольцо] })).data;
  check('подготовка: комплект из прежних времён собран', Boolean(комплект && комплект.id), JSON.stringify(комплект));

  const browser = await chromium.launch();
  const page = await (await browser.newContext(ТЕЛЕФОН)).newPage();
  const ошибки = [];
  page.on('pageerror', e => ошибки.push(e.message));

  for (const [кто, логин, пароль] of [['владелец', 'admin', 'admin123'], ['продавец', 'anna', 'seller123']]) {
    console.log(`\n=== ${кто}: раздела «Комплекты» нет ===`);
    await войти(page, логин, пароль);
    // Меню одно на компьютер и телефон (кнопка «☰» показывает те же пункты).
    const меню = await page.$$eval('.nav-item[data-key]', els => els.map(e => e.dataset.key + ' ' + e.textContent.trim()));
    check('в меню нет', меню.length > 3 && !меню.some(x => x.startsWith('sets') || /Комплект/.test(x)), меню.join(' | '));
    await page.evaluate(() => { location.hash = '#/sets'; });
    await page.waitForTimeout(800);
    check('адрес раздела ведёт на Главную', !(await page.$('#sets-list'))
      && /Главная/.test(await page.textContent('#page-title').catch(() => '')), await page.textContent('#page-title').catch(() => ''));
  }

  console.log('\n=== Общий поиск: комплектов нет, изделия из них — есть ===');
  // На телефоне поле общего поиска спрятано под значок — смотрим на широком экране.
  await page.setViewportSize({ width: 1400, height: 950 });
  await page.goto(BASE + '/#/dashboard');
  await page.waitForTimeout(500);
  await page.fill('#gs-input', МЕТКА);
  await page.waitForTimeout(1500);
  const найдено = чисто(await page.innerText('#gs-results').catch(() => ''));
  check('группы «Комплекты» нет', !/Комплект/i.test(найдено), найдено.slice(0, 200));
  check('изделия из комплекта находятся', найдено.includes(`${МЕТКА}-1`) && найдено.includes(`${МЕТКА}-2`), найдено.slice(0, 200));
  await page.fill('#gs-input', '');
  await page.keyboard.press('Escape');
  await page.setViewportSize(ТЕЛЕФОН.viewport);

  console.log('\n=== Карточка изделия: строки «Комплект» нет ===');
  await page.goto(BASE + '/#/products/' + серьги);
  await page.waitForSelector(`${ВЕРХ} .kv`, { timeout: 10000 }).catch(() => {});
  const карточка = await page.$$eval(`${ВЕРХ} .kv dt`, dts => dts.map(d => d.textContent.trim())).catch(() => []);
  check('в карточке нет «Комплект»', карточка.length > 3 && !карточка.includes('Комплект'), карточка.join(', '));
  await снимок(page, { path: `${OUT}/карточка.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  console.log('\n=== Изделие из комплекта продаётся как обычное ===');
  await page.click('#btn-quick-sale');
  await page.waitForSelector('#pos-search');
  await page.fill('#pos-search', `${МЕТКА}-1`);
  await page.waitForTimeout(1200);
  const строка = await page.$('.search-results .sr-item[data-i]');
  if (строка) await строка.dispatchEvent('mousedown');
  await page.waitForSelector('.pos-item', { timeout: 8000 }).catch(() => {});
  check('в кассе «К оплате 60 000»', /К оплате\s*60 000/.test(чисто(await page.textContent('#pos-summary').catch(() => ''))),
    чисто(await page.textContent('#pos-summary').catch(() => '')));
  await page.click('[data-act=submit]');
  await page.waitForTimeout(1500);
  const продано = (await зов('GET', '/api/products/' + серьги)).data;
  check('продано', продано.status === 'sold', продано.status);
  for (let i = 0; i < 3 && await page.$('#modal-root .modal-overlay'); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  console.log('\n=== Настройки: в правах продавца комплектов нет ===');
  await войти(page, 'admin', 'admin123');
  await page.goto(BASE + '/#/settings');
  await page.waitForSelector('.tab[data-tab=users]', { timeout: 10000 });
  await page.click('.tab[data-tab=users]');
  await page.waitForSelector('#user-add', { timeout: 10000 }).catch(() => {});
  const права = чисто(await page.innerText('#set-body').catch(() => ''));
  check('описание продавца на месте и без «комплекты»', /Продавец — работает за прилавком/.test(права) && !/комплект/i.test(права),
    права.slice(0, 300));

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
