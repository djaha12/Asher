'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Владелец и продавец на двух телефонах.
 *
 * Анна в кассе просит скидку сверх предела. Владелец видит запрос у себя
 * на Главной и нажимает «Разрешить» — у Анны скидка сама встаёт в чек,
 * и продажа проходит. Новое устройство Михаила разрешается одним нажатием
 * прямо с Главной. Сводка за день — вчера или сегодня, и в WhatsApp.
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-владелец';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 260)); }
};
const МЕТКА = 'ВУИ' + process.pid;
const ВЕРХ = '#modal-root > .modal-overlay:last-child';
const чисто = t => String(t || '').replace(/[  ]/g, ' ').replace(/\s+/g, ' ');

let cookie = '';
async function зов(метод, путь, тело, устройство) {
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
  if (устройство) headers['X-Asher-Device'] = устройство;
  const r = await fetch(BASE + путь, { method: метод, headers, body: тело === undefined ? undefined : JSON.stringify(тело) });
  let data = null;
  try { data = await r.json(); } catch { /* пусто */ }
  return { status: r.status, data };
}

async function войти(page, логин, пароль) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('#login-username', логин);
  await page.fill('#login-password', пароль);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20000 }).catch(async e => {
    console.log('  Экран при входе:', чисто(await page.innerText('body').catch(() => '')).slice(0, 400));
    throw e;
  });
}

(async () => {
  const вход = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  cookie = (вход.headers.get('set-cookie') || '').split(';')[0];
  const предел = Number((await зов('GET', '/api/settings')).data.max_discount_percent) || 15;
  const кольцо = (await зов('POST', '/api/products', {
    sku: `${МЕТКА}-1`, name: 'Кольцо для разрешения', metal: 'Золото', retail_price: 100000, purchase_price: 30000,
  })).data;
  const хочет = (предел + 15) * 1000;   // сом скидки на 100 000 — заведомо сверх предела

  const browser = await chromium.launch();
  const ошибки = [];
  const окно = async (ширина = 1400) => {
    const ctx = await browser.newContext({ viewport: { width: ширина, height: 950 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => ошибки.push(e.message));
    return page;
  };

  console.log('=== 1. Анна просит скидку из кассы ===');
  const анна = await окно();
  await войти(анна, 'anna', 'seller123');
  await анна.click('#btn-quick-sale');
  await анна.waitForSelector('#pos-search');
  await анна.fill('#pos-search', `${МЕТКА}-1`);
  await анна.waitForTimeout(1200);
  const найдено = await анна.$('.search-results .sr-item[data-i]');
  if (найдено) await найдено.dispatchEvent('mousedown');
  await анна.waitForSelector('.pos-item input[data-i]');
  await анна.fill('.pos-item input[data-i="0"]', String(хочет));
  await анна.waitForTimeout(400);
  check('касса не дала поставить сверх предела', Number(await анна.inputValue('.pos-item input[data-i="0"]')) === предел * 1000,
    await анна.inputValue('.pos-item input[data-i="0"]'));
  await анна.click('#pos-disc-hint [data-act=ask-owner]');
  await анна.waitForSelector(`${ВЕРХ} [data-k="0"]`);
  check('в запросе — та скидка, что хотели', Number(await анна.inputValue(`${ВЕРХ} [data-k="0"]`)) === хочет);
  await анна.fill('#dr-note', 'постоянная клиентка');
  await анна.click(`${ВЕРХ} [data-act=send]`);
  await анна.waitForSelector('#pos-approval:not(.hidden)');
  check('касса ждёт ответа', /ждём ответа/.test(await анна.textContent('#pos-approval')));
  await снимок(анна, { path: `${OUT}/касса-ждёт.png` });

  console.log('\n=== 2. Владелец разрешает с Главной ===');
  const владелец = await окно();
  await войти(владелец, 'admin', 'admin123');
  const запрос = владелец.locator('[data-dr]', { hasText: 'Анна Соколова' });
  await запрос.first().waitFor({ timeout: 10000 }).catch(() => {});
  const текстЗапроса = чисто(await запрос.first().innerText().catch(() => ''));
  check('на Главной: Анна просит, сколько и почему', /Анна Соколова просит скидку/.test(текстЗапроса)
    && текстЗапроса.includes(`(${предел + 15}%)`) && /постоянная клиентка/.test(текстЗапроса), текстЗапроса);
  await снимок(владелец, { path: `${OUT}/главная-запрос.png` });
  await запрос.first().locator('[data-dr-ok]').click();
  await владелец.waitForTimeout(700);
  check('строка ушла', (await запрос.count()) === 0);

  console.log('\n=== 3. У Анны скидка встала сама ===');
  const разрешено = await анна.waitForFunction(() => /Скидка разрешена/.test(
    (document.querySelector('#pos-approval') || {}).textContent || ''), null, { timeout: 10000 }).then(() => true, () => false);
  check('касса узнала о разрешении сама', разрешено, await анна.textContent('#pos-approval'));
  check('скидка в чеке — разрешённая', Number(await анна.inputValue('.pos-item input[data-i="0"]')) === хочет);
  check('к оплате — с этой скидкой', чисто(await анна.textContent('#pos-summary')).includes(
    `К оплате${(100000 - хочет).toLocaleString('ru-RU').replace(/[  ]/g, ' ')}`), чисто(await анна.textContent('#pos-summary')));
  await снимок(анна, { path: `${OUT}/касса-разрешено.png` });
  await анна.click('[data-act=submit]');
  await анна.waitForTimeout(1500);
  check('продажа прошла', !(await анна.$('#pos-search')), await анна.textContent('#toast-root').catch(() => ''));
  const продано = (await зов('GET', '/api/products/' + кольцо.id)).data;
  check('на сервере: продано со скидкой по разрешению', продано.status === 'sold'
    && продано.history[0] && продано.history[0].discount === хочет, JSON.stringify(продано.history && продано.history[0]));

  console.log('\n=== 4. Новое устройство — одним нажатием ===');
  // Первое устройство сотрудника доверяется само — пусть Михаил сначала
  // войдёт со своего обычного, а новый телефон будет уже вторым.
  await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'mikhail', password: 'seller123' }) });
  const ключ = 'mikhail-phone-' + process.pid;
  const попытка = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Asher-Device': ключ },
    body: JSON.stringify({ username: 'mikhail', password: 'seller123' }),
  }).then(r => r.json());
  await владелец.goto(BASE + '/#/dashboard');
  await владелец.reload();
  await владелец.waitForSelector('#app:not(.hidden)');
  const строка = владелец.locator('[data-dev]', { hasText: 'Михаил Орлов' });
  await строка.first().waitFor({ timeout: 10000 }).catch(() => {});
  check('на Главной: Михаил просится войти, с кодом', чисто(await строка.first().innerText().catch(() => ''))
    .includes(попытка.code), await строка.first().innerText().catch(() => ''));
  await строка.first().locator('[data-dev-ok]').click();
  await владелец.waitForTimeout(700);
  const вошёл = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Asher-Device': ключ },
    body: JSON.stringify({ username: 'mikhail', password: 'seller123' }),
  });
  check('разрешено — Михаил входит с нового телефона', вошёл.status === 200, вошёл.status);

  console.log('\n=== 5. Сводка ===');
  await владелец.waitForSelector('#dash-summary');
  check('сводка за вчера — по умолчанию', /Сводка за вчера/.test(await владелец.textContent('#dash-summary h3')));
  await владелец.click('#dash-summary [data-sum=today]');
  await владелец.waitForFunction(() => /Сводка за сегодня/.test((document.querySelector('#dash-summary h3') || {}).textContent || ''),
    null, { timeout: 8000 }).catch(() => {});
  const сводка = чисто(await владелец.innerText('#dash-summary'));
  check('«Сегодня»: продажа Анны в сводке', /Продали/.test(сводка) && /Анна Соколова/.test(сводка), сводка.slice(0, 300));
  check('скидка по разрешению посчитана', /по разрешению: 1/.test(сводка), сводка);
  await владелец.evaluate(() => { window.open = u => { window.__открыто = u; return null; }; });
  await владелец.click('#dash-summary [data-sum-wa]');
  const сообщение = decodeURIComponent(await владелец.evaluate(() => window.__открыто || ''));
  check('«Отправить» — сводка в WhatsApp', сообщение.startsWith('https://wa.me/?text=') && /сводка за/.test(сообщение)
    && /Продали:/.test(сообщение), сообщение.slice(0, 200));
  await снимок(владелец, { path: `${OUT}/сводка.png` });

  console.log('\n=== 6. На телефоне ===');
  const телефон = await окно(375);
  await войти(телефон, 'admin', 'admin123');
  await телефон.waitForSelector('#dash-summary');
  const ширина = await телефон.evaluate(() => document.documentElement.scrollWidth);
  check('Главная со сводкой не шире телефона', ширина <= 375, ширина);
  await снимок(телефон, { path: `${OUT}/телефон.png` });

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
