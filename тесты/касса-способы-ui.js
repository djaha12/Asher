'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * «Чем платят» — в окнах заказа и в кассе, когда клиент платит не всю сумму.
 *
 * Раньше в окнах заказа способа оплаты не было вовсе, и любая оплата
 * записывалась наличными. Оплата картой вечером становилась недостачей
 * в сверке. Здесь продавец выбирает «Карта» или «Перевод» — и ящик от этого
 * не меняется. Рассрочки в магазине нет: часть суммы вносят выбранным
 * способом, остаток — долг клиента.
 */
const { chromium } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 260)); }
};
const МЕТКА = 'СУИ' + process.pid;
/*
 * Имя клиентки — без цифр. Поиск клиента сверяет цифры запроса с телефонами,
 * и «Айжан СУИ347» находил демо-клиентку с телефоном …513-47-23 и её личной
 * скидкой 5% — долг выходил не на ту сумму. Цифры номера процесса
 * заменяем буквами: имя остаётся своим для каждого прогона.
 */
const КЛИЕНТКА = 'Айжан СУИ' + String(process.pid).replace(/\d/g, ц => 'абвгдежзик'[ц]);
const ВЕРХ = '#modal-root > .modal-overlay:last-child';

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
const ящик = async () => (await зов('GET', '/api/cash/expected')).data.ожидается;

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
  await зов('POST', '/api/customers', { name: КЛИЕНТКА });
  await зов('POST', '/api/products', {
    sku: `${МЕТКА}-1`, name: 'Колье в долг', metal: 'Золото', retail_price: 30000, purchase_price: 10000,
  });
  const заказ = (await зов('POST', '/api/orders', { description: `Пайка цепи ${МЕТКА}`, estimate: 4000 })).data;
  await зов('POST', '/api/cash/count', { counted: await ящик() });   // точка отсчёта

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await ctx.newPage();
  const ошибки = [];
  page.on('pageerror', e => ошибки.push(e.message));
  await войти(page, 'anna', 'seller123');

  console.log('=== 1. Доплата по заказу картой ===');
  let было = await ящик();
  await page.goto(BASE + '/#/orders/' + заказ.id);
  await page.waitForSelector('.modal [data-act=pay]');
  await page.click('.modal [data-act=pay]');
  await page.waitForSelector('#pay-method');
  await page.fill('#pay-amount', '1500');
  await page.selectOption('#pay-method', 'card');
  await page.click(`${ВЕРХ} [data-act=ok]`);
  await page.waitForTimeout(1000);
  check('оплата принята', (await зов('GET', '/api/orders/' + заказ.id)).data.paid === 1500);
  check('картой — ящик не изменился', await ящик() === было, [было, await ящик()]);

  console.log('\n=== 2. Выдача с доплатой переводом ===');
  await зов('POST', `/api/orders/${заказ.id}/status`, { status: 'ready' });
  // Тот же адрес второй раз страницу не переоткрывает — уходим и возвращаемся.
  await page.goto(BASE + '/#/dashboard');
  await page.waitForTimeout(400);
  await page.goto(BASE + '/#/orders/' + заказ.id);
  await page.waitForSelector('.modal [data-next=delivered]');
  await page.click('.modal [data-next=delivered]');
  await page.waitForSelector('#dlv-method');
  await page.selectOption('#dlv-method', 'transfer');
  await page.click(`${ВЕРХ} [data-act=ok]`);
  await page.waitForTimeout(1500);
  const выдан = (await зов('GET', '/api/orders/' + заказ.id)).data;
  check('выдан, доплата 2 500 принята', выдан.status === 'delivered' && выдан.paid === 4000, `${выдан.status} ${выдан.paid}`);
  check('переводом — ящик не изменился', await ящик() === было, [было, await ящик()]);

  console.log('\n=== 3. Новый заказ: предоплата наличными ===');
  await page.goto(BASE + '/#/orders');
  await page.waitForSelector('#of-add');
  await page.click('#of-add');
  await page.waitForSelector('#order-form [name=method]');
  await page.fill('#order-form [name=description]', `Чистка ${МЕТКА}`);
  await page.fill('#order-form [name=prepayment]', '700');
  check('по умолчанию — наличные', (await page.inputValue('#order-form [name=method]')) === 'cash');
  await page.click('.modal [data-act=save]');
  await page.waitForTimeout(1500);
  if (await page.$(`${ВЕРХ} [data-act=done]`)) await page.click(`${ВЕРХ} [data-act=done]`);
  check('наличными — в ящик: +700', await ящик() - было === 700, [было, await ящик()]);

  console.log('\n=== 4. Касса: часть картой, остаток в долг; рассрочки нет ===');
  было = await ящик();
  await page.click('#btn-quick-sale');
  await page.waitForSelector('#pos-search');
  const способы = await page.$$eval('#pos-payment option', o => o.map(x => x.textContent.trim()));
  check('в кассе нет способа «Рассрочка»', !способы.some(т => /рассроч/i.test(т)) && способы.includes('Карта'), способы);
  check('и вопроса про первый взнос тоже', !(await page.$('#pos-first-wrap')));
  await page.fill('#pos-search', `${МЕТКА}-1`);
  await page.waitForTimeout(1200);
  const найдено = await page.$('.search-results .sr-item[data-i]');
  if (найдено) await найдено.dispatchEvent('mousedown');
  await page.waitForSelector('.pos-item');
  await page.selectOption('#pos-payment', 'card');
  await page.check('#pos-partial');
  await page.fill('#pos-paid', '10000');
  await page.fill('#pos-due', '2030-01-01');
  await page.fill('#pos-customer', КЛИЕНТКА);
  await page.waitForTimeout(1200);
  const клиентка = await page.$('.search-results .sr-item[data-i]');
  if (клиентка) await клиентка.dispatchEvent('mousedown');
  await page.waitForTimeout(400);
  await page.click('[data-act=submit]');
  await page.waitForTimeout(1500);
  const продажи = (await зов('GET', '/api/sales?search=' + encodeURIComponent(`${МЕТКА}-1`))).data.items;
  const чек = продажи[0] ? (await зов('GET', '/api/sales/' + продажи[0].id)).data : { payments: [] };
  check('продажа в долг оформлена: внесено 10 000, долг 20 000', чек.paid === 10000 && чек.debt === 20000, `${чек.paid} ${чек.debt}`);
  check('способ в чеке — карта, не рассрочка', чек.payment_method === 'card', чек.payment_method);
  check('внесённое записано картой', чек.payments.some(p => p.method === 'card' && p.amount === 10000), JSON.stringify(чек.payments));
  check('картой — ящик не изменился', await ящик() === было, [было, await ящик()]);

  await page.goto(BASE + '/#/sales');
  await page.waitForSelector('#sf-payment');
  const вФильтре = await page.$$eval('#sf-payment option', o => o.map(x => x.textContent.trim()));
  check('в фильтре продаж «Рассрочки» тоже нет', !вФильтре.some(т => /рассроч/i.test(т)) && вФильтре.includes('Карта'), вФильтре);

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
