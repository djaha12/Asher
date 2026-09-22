'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Потолок скидки глазами продавца.
 *
 * Сервер отказ выдаст в любом случае — это проверено отдельно. Но отказ
 * в момент «Оформить продажу», когда клиент уже достал деньги, — худший
 * момент из возможных: продавец при клиенте выясняет, что так нельзя,
 * и набирает чек заново.
 *
 * Поэтому касса обязана сказать про предел ЗАРАНЕЕ и не дать набрать
 * заведомо невозможное. Здесь проверяется именно это — то, чего не видно
 * из проверок по API.
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-скидки';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 200)); }
};

async function войти(page, логин, пароль) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('#login-username', логин);
  await page.fill('#login-password', пароль);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
}

/*
 * Изделие для проверки заводит владелец — через API, до того как продавец
 * откроет кассу. Раньше брали «любое в наличии», и это было ненадёжно:
 * в общем прогоне витрину раскупают соседние наборы, а среди оставшегося
 * попадались их изделия с закупочной, равной цене. У такого изделия предел
 * скидки честно равен нулю, и набор падал «поле скидки не ограничено»
 * при исправной кассе. Своё изделие — с известной ценой и наценкой.
 */
async function своёИзделие(номер) {
  const вход = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const cookie = (вход.headers.get('set-cookie') || '').split(';')[0];
  const артикул = `СКИДКИ-UI-${process.pid}-${номер}`;
  const r = await fetch(BASE + '/api/products', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ sku: артикул, name: 'Кольцо для проверки кассы', metal: 'Золото', retail_price: 52000, purchase_price: 20000 }),
  });
  if (!r.ok) throw new Error('не удалось завести изделие для проверки: ' + await r.text());
  return артикул;
}

async function вКассуИзделие(page, артикул) {
  await page.click('#btn-quick-sale');
  await page.waitForSelector('#pos-search');
  await page.fill('#pos-search', артикул);
  await page.waitForTimeout(900);
  const строка = await page.$('.search-results .sr-item[data-i]');
  if (!строка) return null;
  await строка.dispatchEvent('mousedown');
  await page.waitForTimeout(500);
  return page.$('.pos-item');
}

(async () => {
  const browser = await chromium.launch();
  const ошибки = [];

  console.log('=== Продавец: касса не даёт набрать лишнего ===');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => ошибки.push(e.message));
  await войти(page, 'anna', 'seller123');

  const артикул = await своёИзделие(1);
  check('на складе есть что продать', Boolean(артикул), артикул);
  const позиция = await вКассуИзделие(page, артикул);
  check('изделие добавлено в чек', Boolean(позиция));

  const подсказка = (await page.textContent('#pos-disc-hint') || '').trim();
  check('касса заранее говорит про предел', /проводит владелец/.test(подсказка), подсказка);
  check('и называет цифру', /\d/.test(подсказка), подсказка);

  const цена = Number(await page.getAttribute('.pos-item input[data-i="0"]', 'max'));
  const ценник = await page.textContent('.pos-item .num.money');
  const ценникЧисло = Number(String(ценник).replace(/[^\d]/g, ''));
  check('поле скидки ограничено сверху', цена > 0 && цена < ценникЧисло,
    `предел ${цена} при цене ${ценникЧисло}`);

  // Набираем скидку в размере всей цены — ровно то, чего система не должна
  // допускать. Поле обязано подрезать её само.
  await page.fill('.pos-item input[data-i="0"]', String(ценникЧисло));
  await page.waitForTimeout(500);
  const вПоле = Number(await page.inputValue('.pos-item input[data-i="0"]'));
  check('скидка «на всю цену» подрезана до предела', вПоле <= цена + 0.01,
    `в поле ${вПоле}, предел ${цена}`);

  const итог = await page.textContent('#pos-summary');
  const кОплате = Number((String(итог).match(/К оплате\s*([\d\s  ]+)/) || [])[1]
    ? (String(итог).match(/К оплате\s*([\d\s  ]+)/))[1].replace(/[^\d]/g, '') : NaN);
  check('к оплате осталась настоящая сумма, а не ноль', кОплате > 0, итог.replace(/\s+/g, ' '));

  await снимок(page, { path: `${OUT}/продавец-предел-скидки.png` });

  // Скидка на весь чек — второй путь к тому же самому.
  await page.fill('#pos-disc-pct', '90');
  await page.waitForTimeout(700);
  const процентВПоле = Number(await page.inputValue('#pos-disc-pct'));
  check('скидка на чек 90% тоже подрезана', процентВПоле < 90, процентВПоле);

  const итог2 = await page.textContent('#pos-summary');
  check('чек по-прежнему не обнулился', !/К оплате\s*0\s*(сом|⃀)/.test(итог2),
    итог2.replace(/\s+/g, ' '));

  // Продажа с подрезанной скидкой обязана пройти: ограничение не должно
  // превращаться в невозможность работать.
  await page.click('[data-act=submit]');
  await page.waitForTimeout(1500);
  const прошло = !(await page.$('#pos-search'));
  check('продажа с допустимой скидкой оформляется', прошло);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  console.log('\n=== Владелец: предел его не касается ===');
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  const page2 = await ctx2.newPage();
  page2.on('pageerror', e => ошибки.push(e.message));
  await войти(page2, 'admin', 'admin123');

  const артикул2 = await своёИзделие(2);
  const позиция2 = await вКассуИзделие(page2, артикул2);
  check('изделие добавлено в чек владельца', Boolean(позиция2));
  const подсказка2 = (await page2.textContent('#pos-disc-hint') || '').trim();
  check('владельцу про предел не говорят', подсказка2 === '', подсказка2);

  const ценник2 = Number(String(await page2.textContent('.pos-item .num.money')).replace(/[^\d]/g, ''));
  await page2.fill('.pos-item input[data-i="0"]', String(Math.round(ценник2 * 0.7)));
  await page2.waitForTimeout(500);
  const вПоле2 = Number(await page2.inputValue('.pos-item input[data-i="0"]'));
  check('владельцу скидку 70% не подрезали', вПоле2 >= Math.round(ценник2 * 0.7) - 1, вПоле2);

  // Продажа ниже закупочной — про неё владельцу сказать можно и нужно:
  // закупочную он и так видит, а продавцу это поле вообще не приходит.
  await page2.fill('.pos-item input[data-i="0"]', String(ценник2 - 1));
  await page2.waitForTimeout(500);
  const строкаТовара = await page2.textContent('.pos-item .pi-sub');
  check('владельца предупреждают: ниже закупочной',
    /ниже закупочной/.test(строкаТовара), строкаТовара);
  await снимок(page2, { path: `${OUT}/владелец-ниже-закупочной.png` });

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
