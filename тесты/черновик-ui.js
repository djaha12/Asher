'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Завести изделие второпях и дописать потом — глазами продавца.
 *
 * В форме нет обязательных полей: «Сохранить» с пустой формой заводит
 * изделие, артикул выдаётся следующий по порядку (он виден в поле заранее).
 * В карточке написано, чего не хватает; кнопка «Не заполнены» в каталоге их
 * собирает; касса изделие без цены в чек не берёт и объясняет почему.
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-черновик';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 300)); }
};
const ВЕРХ = '#modal-root > .modal-overlay:last-child';
const чисто = t => String(t || '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ');

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
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await ctx.newPage();
  const ошибки = [];
  page.on('pageerror', e => ошибки.push(e.message));
  await войти(page, 'anna', 'seller123');

  console.log('=== 1. Пустая форма сохраняется ===');
  await page.goto(BASE + '/#/products');
  await page.waitForSelector('#pf-add');
  await page.click('#pf-add');
  await page.waitForSelector('#prod-form');
  await page.waitForTimeout(800);
  const обязательные = await page.$$eval('#prod-form [required]', els => els.map(e => e.name));
  check('в форме нет обязательных полей', обязательные.length === 0, обязательные.join(', '));
  const подсказка = await page.getAttribute('#prod-form [name=sku]', 'placeholder');
  const будет = (await зов('GET', '/api/products/next-sku')).data.sku;
  check('в поле артикула видно, какой выдадим', подсказка.includes(будет) && /выдадим сами/.test(подсказка), подсказка);
  check('подсказка: можно дописать потом, без цены не продаётся',
    /Обязательных полей нет/.test(чисто(await page.textContent('#prod-form'))));
  await снимок(page, { path: `${OUT}/форма.png` });
  await page.click(`${ВЕРХ} [data-act=save]`);
  await page.waitForTimeout(1500);
  const карточка = чисто(await page.textContent(`${ВЕРХ} .modal-body`).catch(() => ''));
  check('сохранилось и открылась карточка «Без названия»',
    /Без названия/.test(await page.textContent(`${ВЕРХ} .modal-head`).catch(() => '')), await page.textContent(`${ВЕРХ} .modal-head`).catch(() => ''));
  check('в карточке — чего не хватает', /Не заполнено: название, цена, металл, вес/.test(карточка), карточка.slice(0, 200));
  check('и что без цены касса не продаст', /касса его не продаст/.test(карточка));
  await снимок(page, { path: `${OUT}/карточка.png` });
  const заведено = (await зов('GET', '/api/products?search=' + encodeURIComponent(будет))).data.items[0];
  check('на сервере: артикул тот, что обещали', заведено && заведено.sku === будет, заведено && заведено.sku);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  console.log('\n=== 2. «Не заполнены» в каталоге ===');
  await page.goto(BASE + '/#/dashboard');
  await page.waitForTimeout(300);
  await page.goto(BASE + '/#/products');
  await page.waitForSelector('[data-incomplete]');
  await page.click('[data-incomplete]');
  await page.waitForTimeout(1200);
  const каталог = чисто(await page.innerText('#prod-list'));
  check('кнопка «Не заполнены» показывает заведённое', каталог.includes(будет), каталог.slice(0, 200));
  check('на плитке — «не заполнено» и «цена не указана»', /не заполнено/.test(каталог) && /цена не указана/.test(каталог));
  await снимок(page, { path: `${OUT}/каталог.png` });

  console.log('\n=== 3. Касса не берёт изделие без цены ===');
  await page.click('#btn-quick-sale');
  await page.waitForSelector('#pos-search');
  await page.fill('#pos-search', будет);
  await page.waitForTimeout(1200);
  check('в поиске кассы видно «без цены»', /без цены/.test(чисто(await page.textContent('.search-results').catch(() => ''))));
  const строка = await page.$('.search-results .sr-item[data-i]');
  if (строка) await строка.dispatchEvent('mousedown');
  await page.waitForTimeout(600);
  check('в чек не легло', !(await page.$('.pos-item')));
  check('касса объяснила почему', /не указана цена/.test(await page.textContent('#toast-root').catch(() => '')),
    await page.textContent('#toast-root').catch(() => ''));
  await page.click(`${ВЕРХ} .modal-close`).catch(() => {});
  await page.waitForTimeout(300);

  console.log('\n=== 4. Дописали цену — продаётся ===');
  await зов('PUT', '/api/products/' + заведено.id, { name: 'Подвеска «Дописали»', retail_price: 12000, metal: 'Золото', weight: 1.5 });
  const после = (await зов('GET', '/api/products?incomplete=1&limit=2000')).data.items.map(p => p.id);
  check('заполненное ушло из «Не заполнены»', !после.includes(заведено.id));
  await page.goto(BASE + '/#/dashboard');
  await page.waitForTimeout(400);
  await page.click('#btn-quick-sale');
  await page.waitForSelector('#pos-search');
  await page.fill('#pos-search', будет);
  await page.waitForTimeout(1200);
  const снова = await page.$('.search-results .sr-item[data-i]');
  if (снова) await снова.dispatchEvent('mousedown');
  await page.waitForSelector('.pos-item', { timeout: 5000 }).catch(() => {});
  check('теперь ложится в чек', Boolean(await page.$('.pos-item')));

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
