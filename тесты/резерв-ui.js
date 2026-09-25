'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Продажа отложенного изделия.
 *
 * Раньше «Продать» на отложенном изделии открывал кассу без клиента, и при
 * оплате сервер отвечал «в резерве за другим клиентом» — хотя клиента никто
 * и не выбирал. Продавец искал клиентку заново, набирал чек заново — при ней
 * самой у прилавка.
 *
 * Теперь клиент резерва подставляется сам — откуда бы изделие ни пришло
 * в чек. А в карточке клиента есть «Продать отложенное»: все её отложенные
 * изделия сразу в чеке.
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-резерв';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 220)); }
};
const МЕТКА = 'РЕЗ' + process.pid;

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

async function отложить(суффикс, клиент) {
  const p = await зов('POST', '/api/products', {
    sku: `${МЕТКА}-${суффикс}`, name: `Серьги ${суффикс} для проверки резерва`,
    metal: 'Золото', retail_price: 40000, purchase_price: 15000,
  });
  await зов('PUT', '/api/products/' + p.data.id, { status: 'reserved', reserved_for: клиент, reserved_until: '2099-01-01' });
  return p.data.id;
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
  const гуля = (await зов('POST', '/api/customers', { name: `Гульнара ${МЕТКА}`, phone: '0700 111 222', discount: 5 })).data.id;
  const другая = (await зов('POST', '/api/customers', { name: `Айпери ${МЕТКА}`, phone: '0700 333 444' })).data.id;
  const первое = await отложить('1', гуля);
  await отложить('2', гуля);
  await отложить('3', гуля);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await ctx.newPage();
  const ошибки = [];
  page.on('pageerror', e => ошибки.push(e.message));
  await войти(page, 'anna', 'seller123');

  console.log('=== 1. «Продать» на отложенном изделии ===');
  await page.goto(BASE + '/#/products/' + первое);
  await page.waitForSelector('.modal [data-act=sell]');
  await page.click('.modal [data-act=sell]');
  await page.waitForSelector('#pos-search');
  const подставлен = await page.waitForFunction(
    имя => (document.querySelector('#pos-customer') || {}).value === имя, `Гульнара ${МЕТКА}`, { timeout: 8000 })
    .then(() => true, () => false);
  check('клиентка резерва подставилась в кассу сама', подставлен, await page.inputValue('#pos-customer'));
  check('и её личная скидка применена', /Личная скидка 5%/.test(await page.textContent('#pos-cust-info')),
    await page.textContent('#pos-cust-info'));
  await page.click('[data-act=submit]');
  await page.waitForTimeout(1500);
  const отказ = await page.$('.toast.err');
  check('продажа прошла — без «в резерве за другим клиентом»', !(await page.$('#pos-search')),
    отказ ? await отказ.textContent() : '');
  if (await page.$('#modal-root .modal-overlay')) {
    await page.keyboard.press('Escape');   // «Напечатать чек?» — нет
    await page.waitForTimeout(300);
  }

  console.log('\n=== 2. Отложенное из поиска в кассе ===');
  await page.click('#btn-quick-sale');
  await page.waitForSelector('#pos-search');
  await page.fill('#pos-search', `${МЕТКА}-2`);
  await page.waitForTimeout(1200);
  const найдено = await page.$('.search-results .sr-item[data-i]');
  if (найдено) { await найдено.dispatchEvent('mousedown'); }
  const изПоиска = await page.waitForFunction(
    имя => (document.querySelector('#pos-customer') || {}).value === имя, `Гульнара ${МЕТКА}`, { timeout: 8000 })
    .then(() => true, () => false);
  check('из поиска — клиентка тоже подставилась', изПоиска);
  await page.click('.modal .modal-close');
  await page.waitForTimeout(300);

  console.log('\n=== 3. В чеке другой клиент — говорим сразу ===');
  await page.click('#btn-quick-sale');
  await page.waitForSelector('#pos-customer');
  await page.fill('#pos-customer', `Айпери ${МЕТКА}`);
  await page.waitForTimeout(1200);
  const айпери = await page.$('.search-results .sr-item[data-i]');
  if (айпери) await айпери.dispatchEvent('mousedown');
  await page.waitForTimeout(400);
  await page.fill('#pos-search', `${МЕТКА}-2`);
  await page.waitForTimeout(1200);
  const чужое = await page.$('.search-results .sr-item[data-i]');
  if (чужое) await чужое.dispatchEvent('mousedown');
  await page.waitForTimeout(500);
  check('чужой резерв в чек не лёг', (await page.$$eval('.pos-item', r => r.length)) === 0);
  check('и сказано, за кем он отложен', /отложено за Гульнара/.test(await page.textContent('#toast-root')),
    await page.textContent('#toast-root'));
  await page.click('.modal .modal-close');
  await page.waitForTimeout(300);

  console.log('\n=== 4. «Продать отложенное» в карточке клиента ===');
  await page.goto(BASE + '/#/customers/' + гуля);
  await page.waitForSelector('.modal [data-act=sell-reserved]');
  await снимок(page, { path: `${OUT}/карточка.png` });
  await page.click('.modal [data-act=sell-reserved]');
  await page.waitForSelector('#pos-search');
  await page.waitForTimeout(600);
  const позиций = await page.$$eval('.pos-item', r => r.length);
  check('всё отложенное — сразу в чеке', позиций === 2, позиций);
  check('клиентка выбрана', (await page.inputValue('#pos-customer')) === `Гульнара ${МЕТКА}`);
  await page.click('[data-act=submit]');
  await page.waitForTimeout(1500);
  check('продажа отложенного прошла', !(await page.$('#pos-search')));
  if (await page.$('#modal-root .modal-overlay')) await page.keyboard.press('Escape');

  const осталось = (await зов('GET', '/api/customers/' + гуля)).data.reserved.length;
  check('резервов за клиенткой больше нет', осталось === 0, осталось);
  check('другая клиентка ни при чём', (await зов('GET', '/api/customers/' + другая)).data.stats.purchases === 0);

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
