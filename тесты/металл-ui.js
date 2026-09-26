'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Белое золото 750 стоит само — глазами продавца и владельца, на телефоне.
 *
 * Раньше «Белое золото» и «750» в форме были серыми подсказками: поле
 * казалось заполненным, а изделие уходило «без металла». Теперь это
 * настоящие значения — в карточке и в строках приёмки. То, что уже заведено
 * без металла, владелец исправляет на Главной одной кнопкой.
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-металл';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 300)); }
};
const ВЕРХ = '#modal-root > .modal-overlay:last-child';
const чисто = t => String(t || '').replace(/[  ]/g, ' ').replace(/\s+/g, ' ');
const МЕТКА = 'МУИ' + process.pid;

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

  console.log('=== 1. Продавец: в новом изделии металл и проба уже стоят ===');
  const ctxП = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const продавец = await ctxП.newPage();
  продавец.on('pageerror', e => ошибки.push(e.message));
  await войти(продавец, 'anna', 'seller123');
  await продавец.goto(BASE + '/#/products');
  await продавец.waitForSelector('#pf-add');
  await продавец.click('#pf-add');
  await продавец.waitForSelector('#prod-form');
  await продавец.waitForTimeout(500);
  check('металл — «Белое золото» настоящим значением', await продавец.inputValue('#prod-form [name=metal]') === 'Белое золото',
    await продавец.inputValue('#prod-form [name=metal]'));
  check('проба — «750»', await продавец.inputValue('#prod-form [name=fineness]') === '750');
  await продавец.fill('#prod-form [name=sku]', МЕТКА + '-1');
  await продавец.click(`${ВЕРХ} [data-act=save]`);
  await продавец.waitForTimeout(1500);
  const заведено = (await зов('GET', '/api/products?search=' + encodeURIComponent(МЕТКА + '-1'))).data.items[0];
  check('сохранилось с белым золотом 750', заведено && заведено.metal === 'Белое золото' && заведено.fineness === '750',
    заведено && [заведено.metal, заведено.fineness]);
  const карточка = чисто(await продавец.textContent(`${ВЕРХ} .modal-body`).catch(() => ''));
  check('в карточке «Белое золото 750», металла в «Не заполнено» нет',
    /Белое золото 750/.test(карточка) && !/Не заполнено:[^.]*металл/.test(карточка), карточка.slice(0, 250));
  await продавец.keyboard.press('Escape');

  console.log('\n=== 2. Правка старого изделия металл не подменяет ===');
  const жёлтое = (await зов('POST', '/api/products', { sku: МЕТКА + '-ж', metal: 'Жёлтое золото', fineness: '585' })).data.id;
  const пустое = (await зов('POST', '/api/products', { sku: МЕТКА + '-п', weight: 1.5 })).data.id;
  await продавец.goto(BASE + '/#/products/' + пустое);
  await продавец.waitForSelector(`${ВЕРХ} [data-act=edit]`);
  await продавец.click(`${ВЕРХ} [data-act=edit]`);
  await продавец.waitForSelector('#prod-form');
  check('у заведённого без металла поле пустое — не делаем вид, что заполнено',
    await продавец.inputValue('#prod-form [name=metal]') === '');
  await продавец.keyboard.press('Escape');
  await продавец.waitForTimeout(300);
  await продавец.goto(BASE + '/#/products/' + жёлтое);
  await продавец.waitForSelector(`${ВЕРХ} [data-act=edit]`);
  await продавец.click(`${ВЕРХ} [data-act=edit]`);
  await продавец.waitForSelector('#prod-form');
  check('у жёлтого золота 585 — его металл и проба',
    await продавец.inputValue('#prod-form [name=metal]') === 'Жёлтое золото'
    && await продавец.inputValue('#prod-form [name=fineness]') === '585');
  await продавец.keyboard.press('Escape');

  console.log('\n=== 3. Продавцу кнопки исправления на Главной нет ===');
  await продавец.goto(BASE + '/#/dashboard');
  await продавец.waitForTimeout(1500);
  check('у продавца — без кнопки', !(await продавец.$('[data-fix-metal]')));
  await ctxП.close();

  console.log('\n=== 4. Владелец на телефоне: «Без металла» — одной кнопкой ===');
  const ctxВ = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const владелец = await ctxВ.newPage();
  владелец.on('pageerror', e => ошибки.push(e.message));
  await войти(владелец, 'admin', 'admin123');
  await владелец.goto(BASE + '/#/dashboard');
  await владелец.waitForSelector('[data-fix-metal]', { timeout: 10000 }).catch(() => {});
  const кнопка = await владелец.$('[data-fix-metal]');
  const текстКнопки = кнопка ? чисто(await кнопка.textContent()) : '';
  check('кнопка «Проставить «Белое золото 750»» видна', /Проставить «Белое золото 750»/.test(текстКнопки), текстКнопки);
  const виджет = чисто(await владелец.textContent('#app').catch(() => ''));
  check('число изделий — по-русски («1 изделие», «2 изделия»), не «1 изделий»',
    !/\b1 изделий\b|\b[234] изделий\b/.test(виджет), (виджет.match(/\d+ издели\S*/g) || []).join(', '));
  const ширина = await владелец.evaluate(() => document.documentElement.scrollWidth);
  check('на телефоне ничего не вылезает вбок', ширина <= 390, ширина);
  await снимок(владелец, { path: `${OUT}/главная-телефон.png` });
  if (кнопка) {
    await кнопка.click();
    await владелец.waitForSelector(`${ВЕРХ} [data-act=ok]`);
    const вопрос = чисто(await владелец.textContent(`${ВЕРХ} .modal-body`));
    check('перед правкой спрашиваем, и видно, что станет', /Проставить «Белое золото 750» всем изделиям без металла/.test(вопрос), вопрос);
    await владелец.click(`${ВЕРХ} [data-act=ok]`);
    await владелец.waitForTimeout(1500);
    check('сказали, сколько исправлено', /Готово: «Белое золото 750»/.test(await владелец.textContent('#toast-root').catch(() => '')));
    const теперь = (await зов('GET', '/api/products/' + пустое)).data;
    check('изделие без металла стало белым золотом 750', теперь.metal === 'Белое золото' && теперь.fineness === '750',
      [теперь.metal, теперь.fineness]);
    check('жёлтое золото 585 не тронуто', (await зов('GET', '/api/products/' + жёлтое)).data.metal === 'Жёлтое золото');
    check('строка «Без металла» с Главной ушла', !/Без металла/.test(чисто(await владелец.textContent('#app'))));
  }

  console.log('\n=== 5. Приёмка: в строках металл и проба стоят ===');
  await владелец.setViewportSize({ width: 1400, height: 950 });
  await владелец.goto(BASE + '/#/products');
  await владелец.waitForSelector('#pf-add');
  const приёмка = await владелец.$('#pf-receipt, [data-act=receipt], #btn-receipt');
  if (приёмка) {
    await приёмка.click();
    await владелец.waitForSelector('#rc-rows [data-row]');
    check('в строке приёмки — «Белое золото» и «750»',
      await владелец.inputValue('#rc-rows [data-row] [name=metal]') === 'Белое золото'
      && await владелец.inputValue('#rc-rows [data-row] [name=fineness]') === '750');
    check('строки с одним металлом не считаются изделиями', /Добавьте хотя бы одну строку/.test(await владелец.textContent('#rc-total')));
    await владелец.fill('#rc-rows [data-row] [name=weight]', '3.1');
    await владелец.waitForTimeout(200);
    check('вписали только вес — это уже изделие', /Изделий: 1/.test(чисто(await владелец.textContent('#rc-total'))),
      await владелец.textContent('#rc-total'));
    await владелец.keyboard.press('Escape');
  } else check('кнопка приёмки найдена', false);

  console.log('\n=== 6. Настройки: металл и проба видны и меняются ===');
  await владелец.goto(BASE + '/#/settings');
  await владелец.waitForSelector('#st-form [name=default_metal]');
  check('в настройках — «Белое золото» и «750»',
    await владелец.inputValue('#st-form [name=default_metal]') === 'Белое золото'
    && await владелец.inputValue('#st-form [name=default_fineness]') === '750');

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
