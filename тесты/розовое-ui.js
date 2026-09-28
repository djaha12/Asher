'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Розовое золото вместо красного.
 *
 * Владелец: «добавь вместо красного розовое золото». В анкете кнопки
 * металла — «Белое золото», «Жёлтое золото», «Розовое золото»; «Красного»
 * среди них нет, и в настройках его не предлагаем. Изделие, заведённое
 * раньше как «Красное золото», не теряет металл: в анкете он стоит под
 * «Другое», и в «Розовое» его переводят одним касанием.
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-розовое';
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
const МЕТКА = 'РОЗ' + process.pid.toString(36).toUpperCase();

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
const поАртикулу = async sku => ((await зов('GET', '/api/products?search=' + encodeURIComponent(sku))).data.items || [])
  .find(x => x.sku === sku);

async function войти(page, логин, пароль) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('#login-username', логин);
  await page.fill('#login-password', пароль);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
}

const кнопкиМеталла = page => page.$$eval('#prod-form .pick[data-pick=metal] .chip', b => b.map(x => x.textContent.trim()));
const выбранМеталл = page => page.$$eval('#prod-form .pick[data-pick=metal] .chip.active', b => b.map(x => x.textContent.trim()));

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

  console.log('=== 1. Анкета: розовое вместо красного ===');
  await page.goto(BASE + '/#/products');
  await page.waitForSelector('#pf-add');
  await page.click('#pf-add');
  await page.waitForSelector('#prod-form');
  await page.waitForTimeout(400);
  const кнопки = await кнопкиМеталла(page);
  check('кнопки: белое, жёлтое, розовое, другое',
    JSON.stringify(кнопки) === JSON.stringify(['Белое золото', 'Жёлтое золото', 'Розовое золото', 'Другое']), кнопки.join(', '));
  check('«Красного золота» среди кнопок нет', !кнопки.includes('Красное золото'));
  await page.fill('#prod-form [name=sku]', МЕТКА + '-1');
  await page.click('#prod-form .pick[data-pick=metal] [data-v="Розовое золото"]');
  await снимок(page, { path: `${OUT}/анкета.png` });
  await page.click(`${ВЕРХ} [data-act=save]`);
  await page.waitForSelector(`${ВЕРХ} #prod-gallery`, { timeout: 10000 }).catch(() => {});
  const новое = await поАртикулу(МЕТКА + '-1');
  check('сохранилось «Розовое золото» 750', новое && новое.metal === 'Розовое золото' && новое.fineness === '750',
    новое && [новое.metal, новое.fineness]);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  console.log('\n=== 2. Заведённое раньше «Красное золото» не теряется ===');
  const старое = (await зов('POST', '/api/products', { sku: МЕТКА + '-2', name: 'Серьги', metal: 'Красное золото',
    fineness: '750', retail_price: 50000 })).data.id;
  await page.goto(BASE + '/#/dashboard');
  await page.waitForTimeout(300);
  await page.goto(BASE + '/#/products/' + старое);
  await page.waitForSelector(`${ВЕРХ} [data-act=edit]`);
  await page.click(`${ВЕРХ} [data-act=edit]`);
  await page.waitForSelector('#prod-form');
  await page.waitForTimeout(300);
  check('в анкете — «Другое», и в нём «Красное золото»', (await выбранМеталл(page)).join() === 'Другое'
    && await page.inputValue('#prod-form [name=metal]') === 'Красное золото', await выбранМеталл(page));
  await page.click('#prod-form .pick[data-pick=metal] [data-v="Розовое золото"]');
  await page.click(`${ВЕРХ} [data-act=save]`);
  await page.waitForTimeout(1200);
  const стало = (await зов('GET', '/api/products/' + старое)).data;
  check('одно касание — и оно «Розовое золото»', стало.metal === 'Розовое золото', стало.metal);
  for (let i = 0; i < 3 && await page.$('#modal-root .modal-overlay'); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  console.log('\n=== 3. Настройки: металл по умолчанию — среди подсказок розовое ===');
  await page.goto(BASE + '/#/settings');
  await page.waitForSelector('#st-metal-list', { state: 'attached', timeout: 10000 }).catch(() => {});
  const подсказки = await page.$$eval('#st-metal-list option', o => o.map(x => x.value || x.textContent.trim())).catch(() => []);
  check('подсказки: белое, жёлтое, розовое', JSON.stringify(подсказки) === JSON.stringify(['Белое золото', 'Жёлтое золото', 'Розовое золото']),
    подсказки.join(', '));

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
