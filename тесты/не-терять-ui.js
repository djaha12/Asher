'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Работа не теряется.
 *
 * Два способа потерять сделанное, оба — без единого нарочного действия:
 *
 *   1. Коллега что-то сохранил — экран обновился сам и сбросил поиск,
 *      фильтры, вкладку и отмеченные бирки. А если в адресе остался номер
 *      карточки, уже закрытая карточка открывалась снова.
 *   2. Случайное касание мимо окна закрывало его молча — вместе с набранным
 *      чеком или накладной.
 *
 * «Коллега» здесь — запрос с другой отметкой устройства: своё же действие
 * экран не перерисовывает, чужое — перерисовывает.
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-не-терять';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 220)); }
};
const МЕТКА = 'НеТерять' + Date.now().toString().slice(-5);
// Вопрос «Закрыть?» — всегда верхнее окно: у формы под ним есть своя «Отмена».
const ВОПРОС = '#modal-root > .modal-overlay:last-child';

// Сеанс «коллеги»: тот же владелец, но с другого устройства.
let cookie = '';
async function коллега(метод, путь, тело) {
  const r = await fetch(BASE + путь, {
    method: метод,
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Asher-Device': 'colleague-phone' },
    body: тело === undefined ? undefined : JSON.stringify(тело),
  });
  let data = null;
  try { data = await r.json(); } catch { /* пусто */ }
  return { status: r.status, data };
}
let номер = 0;
const чужоеИзменение = () => коллега('POST', '/api/customers', { name: `${МЕТКА} коллега ${++номер}` });

async function войти(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('#login-username', 'admin');
  await page.fill('#login-password', 'admin123');
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
}

// Ждём, пока условие на странице станет верным: опрос идёт раз в 5 секунд.
async function дождаться(page, условие, арг, мс = 14000) {
  try { await page.waitForFunction(условие, арг, { timeout: мс }); return true; } catch { return false; }
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
  await войти(page);

  console.log('=== 1. Клиенты: поиск и фильтр переживают чужое изменение ===');
  await коллега('POST', '/api/customers', { name: `${МЕТКА} Первая`, source: 'instagram' });
  await page.goto(BASE + '/#/customers');
  await page.waitForSelector('#cf-search');
  await page.fill('#cf-search', МЕТКА);
  await page.selectOption('#cf-source', 'instagram');
  await page.waitForTimeout(900);
  await page.locator('#page-title').click();   // уводим фокус из поля: иначе обновление ждёт
  await коллега('POST', '/api/customers', { name: `${МЕТКА} Вторая`, source: 'instagram' });
  const вторая = await дождаться(page, м => document.querySelector('#cust-list').textContent.includes(м), `${МЕТКА} Вторая`);
  check('список обновился сам — новая клиентка из Instagram появилась', вторая);
  check('поиск на месте', (await page.inputValue('#cf-search')) === МЕТКА, await page.inputValue('#cf-search'));
  check('фильтр «Instagram» на месте', (await page.inputValue('#cf-source')) === 'instagram');
  check('в списке по-прежнему только отобранные',
    !(await page.textContent('#cust-list')).includes('коллега'), await page.textContent('#cust-list'));

  console.log('\n=== 2. Каталог: поиск и отбор по статусу на месте ===');
  const sku = `${МЕТКА}-А`;
  await коллега('POST', '/api/products', { sku, name: 'Кольцо для проверки', metal: 'Золото', retail_price: 30000, purchase_price: 10000 });
  await page.goto(BASE + '/#/products');
  await page.waitForSelector('#pf-search');
  await page.fill('#pf-search', МЕТКА);
  await page.click('#pf-chips .chip[data-st="in_stock"]');
  await page.waitForTimeout(900);
  await page.locator('#page-title').click();
  await коллега('POST', '/api/products', { sku: `${МЕТКА}-Б`, name: 'Серьги для проверки', metal: 'Золото', retail_price: 30000, purchase_price: 10000 });
  const есть = await дождаться(page, м => document.querySelector('#prod-list').textContent.includes(м), `${МЕТКА}-Б`);
  check('каталог обновился сам — новое изделие появилось', есть);
  check('поиск в каталоге на месте', (await page.inputValue('#pf-search')) === МЕТКА);
  check('отбор «В наличии» на месте',
    await page.locator('#pf-chips .chip[data-st="in_stock"]').evaluate(b => b.classList.contains('active')));

  console.log('\n=== 3. Бирки: отмеченное не пропадает ===');
  await page.goto(BASE + '/#/labels');
  await page.waitForSelector('#lb-search');
  await page.fill('#lb-search', МЕТКА);
  await page.waitForTimeout(1200);
  const галочки = page.locator('#lb-list input[data-pick]');
  const сколько = await галочки.count();
  check('изделия для бирок нашлись', сколько >= 2, сколько);
  if (сколько >= 2) { await галочки.nth(0).check(); await галочки.nth(1).check(); }
  await page.locator('#page-title').click();
  const счётДо = await page.textContent('#lb-count');
  await чужоеИзменение();
  await page.waitForTimeout(9000);
  check('отмеченные бирки остались отмеченными',
    (await page.locator('#lb-list input[data-pick]:checked').count()) === 2,
    await page.locator('#lb-list input[data-pick]:checked').count());
  check('и счётчик выбранного тот же', (await page.textContent('#lb-count')) === счётДо, await page.textContent('#lb-count'));

  console.log('\n=== 4. Закрытая карточка не открывается снова ===');
  const id = (await коллега('POST', '/api/customers', { name: `${МЕТКА} Карточка` })).data.id;
  await page.goto(BASE + '/#/customers/' + id);
  await page.waitForSelector('.modal');
  check('по ссылке карточка открылась', Boolean(await page.$('.modal')));
  await page.click('.modal .modal-close');
  await page.waitForTimeout(400);
  await чужоеИзменение();
  await page.waitForTimeout(9000);
  check('после чужого изменения карточка не выскочила снова', !(await page.$('.modal')));

  console.log('\n=== 5. Вкладки остаются открытыми ===');
  await page.goto(BASE + '/#/settings');
  await page.waitForSelector('.tab[data-tab="security"]');
  await page.click('.tab[data-tab="security"]');
  await page.waitForTimeout(1200);
  await чужоеИзменение();
  await page.waitForTimeout(9000);
  check('«Безопасность» по-прежнему открыта',
    await page.locator('.tab[data-tab="security"]').evaluate(b => b.classList.contains('active')));
  await page.goto(BASE + '/#/finance');
  await page.waitForSelector('.tab[data-tab="cash"]');
  await page.click('.tab[data-tab="cash"]');
  await page.waitForTimeout(1200);
  await чужоеИзменение();
  await page.waitForTimeout(9000);
  check('в «Финансах» по-прежнему «Сверка кассы»',
    await page.locator('.tab[data-tab="cash"]').evaluate(b => b.classList.contains('active')));

  console.log('\n=== 6. Касание мимо окна ===');
  await page.goto(BASE + '/#/customers');
  await page.waitForSelector('#cf-add');
  await page.click('#cf-add');
  await page.waitForSelector('#cust-form');
  await page.mouse.click(8, 8);
  await page.waitForTimeout(400);
  check('пустое окно закрывается сразу, как раньше', !(await page.$('#cust-form')));

  await page.click('#cf-add');
  await page.waitForSelector('#cust-form');
  await page.fill('#cust-form [name=name]', 'Айжан Недописанная');
  await page.mouse.click(8, 8);
  await page.waitForTimeout(400);
  check('заполненное — спрашивает', /Введённое не сохранится/.test(await page.textContent('#modal-root')));
  await page.click(`${ВОПРОС} [data-act=cancel]`);
  await page.waitForTimeout(300);
  check('«Вернуться» — окно на месте, имя не пропало',
    Boolean(await page.$('#cust-form')) && (await page.inputValue('#cust-form [name=name]')) === 'Айжан Недописанная');
  await page.mouse.click(8, 8);
  await page.waitForTimeout(400);
  await page.click(`${ВОПРОС} [data-act=ok]`);
  await page.waitForTimeout(400);
  check('«Закрыть» — закрывается', !(await page.$('#cust-form')));

  console.log('\n=== 7. Чек в кассе не пропадает от касания мимо ===');
  await page.click('#btn-quick-sale');
  await page.waitForSelector('#pos-search');
  await page.fill('#pos-search', `${МЕТКА}-А`);
  await page.waitForTimeout(1200);
  const найдено = await page.$('.search-results .sr-item[data-i]');
  check('изделие нашлось в кассе', Boolean(найдено));
  if (найдено) { await найдено.dispatchEvent('mousedown'); await page.waitForTimeout(500); }
  await page.mouse.click(8, 8);
  await page.waitForTimeout(400);
  check('касса спрашивает, прежде чем закрыть набранный чек',
    /Введённое не сохранится/.test(await page.textContent('#modal-root')));
  await снимок(page, { path: `${OUT}/касса-вопрос.png` });
  await page.click(`${ВОПРОС} [data-act=cancel]`);
  await page.waitForTimeout(300);
  check('чек на месте', (await page.$$eval('.pos-item', r => r.length)) >= 1);
  await page.click('.modal .modal-close');
  await page.waitForTimeout(300);
  check('крестик закрывает без вопросов — это нарочное действие', !(await page.$('#pos-search')));

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
