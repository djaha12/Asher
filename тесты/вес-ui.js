'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Вес изделия — до тысячной грамма, как показывают весы: «3.324».
 *
 * Поле веса принимало только две цифры после точки: на «3.324» телефон
 * отвечал «введите допустимое значение», и изделие не сохранялось. А там,
 * где вес показывается, — в карточке, на плитке, бирке и в паспорте — он
 * округлялся до сотых: «3,32 г» вместо записанных «3,324 г».
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-вес';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 300)); }
};
const ВЕРХ = '#modal-root > .modal-overlay:last-child';
const ТЕЛЕФОН = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
// Метка из букв: цифры метки процесса не должны совпасть с чужими артикулами.
const МЕТКА = 'ВЕС' + process.pid.toString(36).toUpperCase();
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

  const browser = await chromium.launch();
  const ошибки = [];
  const page = await (await browser.newContext(ТЕЛЕФОН)).newPage();
  page.on('pageerror', e => ошибки.push(e.message));
  await войти(page, 'admin', 'admin123');

  console.log('=== 1. Анкета: вес «3.324» принимается и сохраняется ===');
  await page.goto(BASE + '/#/products');
  await page.waitForSelector('#pf-add');
  await page.click('#pf-add');
  await page.waitForSelector('#prod-form');
  await page.waitForTimeout(400);
  await page.fill('#prod-form [name=sku]', МЕТКА + '-1');
  await page.fill('#prod-form [name=weight]', '3.324');
  check('поле веса не спорит с тремя цифрами после точки',
    await page.$eval('#prod-form [name=weight]', el => el.checkValidity()));
  await page.click(`${ВЕРХ} [data-act=save]`);
  await page.waitForSelector(`${ВЕРХ} #prod-gallery`, { timeout: 10000 }).catch(() => {});
  check('изделие сохранилось — открылась карточка', Boolean(await page.$(`${ВЕРХ} #prod-gallery`)));
  const изделие = ((await зов('GET', '/api/products?search=' + encodeURIComponent(МЕТКА + '-1'))).data.items || [])[0];
  check('записано ровно 3,324 г', изделие && изделие.weight === 3.324, изделие && изделие.weight);

  console.log('\n=== 2. Показ: вес не округляется до сотых ===');
  const вКарточке = await page.$$eval(`${ВЕРХ} .kv dt`, dts => {
    const dt = dts.find(x => x.textContent.trim() === 'Вес изделия');
    return dt ? dt.nextElementSibling.textContent : '';
  }).catch(() => '');
  check('в карточке — «3,324 г»', чисто(вКарточке) === '3,324 г', вКарточке);
  await снимок(page, { path: `${OUT}/карточка.png` });
  await page.click(`${ВЕРХ} [data-act=label]`);
  await page.waitForSelector('#one-preview', { timeout: 8000 }).catch(() => {});
  check('на бирке — «3,324 г»', чисто(await page.textContent('#one-preview').catch(() => '')).includes('3,324 г'),
    чисто(await page.textContent('#one-preview').catch(() => '')));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.click(`${ВЕРХ} [data-act=passport]`);
  await page.waitForSelector('#pp-preview .passport', { timeout: 8000 }).catch(() => {});
  check('в паспорте — «3,324 г»', чисто(await page.innerText('#pp-preview').catch(() => '')).includes('3,324 г'));
  for (let i = 0; i < 3 && await page.$('#modal-root .modal-overlay'); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  await page.goto(BASE + '/#/dashboard');
  await page.waitForTimeout(300);
  await page.goto(BASE + '/#/products');
  await page.waitForSelector('#pf-search');
  await page.fill('#pf-search', МЕТКА + '-1');
  await page.waitForTimeout(1200);
  check('на плитке каталога — «3,324 г»', чисто(await page.textContent('#prod-list')).includes('3,324 г'),
    чисто(await page.textContent('#prod-list')).slice(0, 200));

  console.log('\n=== 3. Приёмка: в строке вес с тремя знаками тоже принимается ===');
  await page.setViewportSize({ width: 1400, height: 950 });
  await page.goto(BASE + '/#/dashboard');
  await page.waitForTimeout(300);
  await page.goto(BASE + '/#/products');
  await page.waitForSelector('#pf-receipt');
  await page.click('#pf-receipt');
  await page.waitForSelector('#rc-rows [data-row] [name=weight]');
  await page.fill('#rc-rows [data-row] [name=weight]', '1.235');
  check('поле веса в строке приёмки принимает «1.235»',
    await page.$eval('#rc-rows [data-row] [name=weight]', el => el.checkValidity()));
  await page.keyboard.press('Escape');

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
