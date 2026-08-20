'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Два новых экрана глазами человека.
 *
 *   Приёмка от поставщика — владелец вбивает накладную одним экраном.
 *   Новый клиент прямо в кассе — продавец не бросает набранный чек.
 *
 * И то и другое сделано ради того, чтобы не бегать между разделами. Проверить
 * это по API нельзя: там-то всё и раньше было доступно — по одному запросу
 * на действие. Смысл ровно в том, сколько шагов делает человек.
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-приёмка';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 200)); }
};
const МЕТКА = 'UI' + Date.now().toString().slice(-6);

async function войти(page, логин, пароль) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('#login-username', логин);
  await page.fill('#login-password', пароль);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
}

(async () => {
  const browser = await chromium.launch();
  const ошибки = [];

  console.log('=== Владелец принимает накладную ===');
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 980 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => ошибки.push(e.message));
  await войти(page, 'admin', 'admin123');

  await page.goto(BASE + '/#/products');
  await page.waitForTimeout(1200);
  const кнопка = await page.$('#pf-receipt');
  check('кнопка приёмки есть в каталоге', Boolean(кнопка));
  await кнопка.click();
  await page.waitForTimeout(1200);

  check('поставщики подставились',
    (await page.$$eval('#rc-supplier option', o => o.length)) > 1);
  check('строки для изделий уже открыты',
    (await page.$$eval('#rc-rows tr[data-row]', r => r.length)) >= 5);
  check('дата накладной подставлена сама',
    Boolean(await page.inputValue('#rc-form [name=doc_date]')));

  // Выбираем поставщика и вбиваем две строки, как это делает человек.
  const пост = await page.$$eval('#rc-supplier option',
    o => o.filter(x => x.value).map(x => x.value));
  await page.selectOption('#rc-supplier', пост[0]);
  await page.fill('#rc-form [name=doc_number]', МЕТКА + '-НК');

  const строки = [
    { sku: МЕТКА + '-1', name: 'Кольцо с экрана', metal: 'Белое золото', purchase: '100000' },
    { sku: МЕТКА + '-2', name: 'Серьги с экрана', metal: 'Белое золото', purchase: '60000' },
  ];
  for (const [i, с] of строки.entries()) {
    const tr = `#rc-rows tr[data-row]:nth-child(${i + 1})`;
    await page.fill(`${tr} [name=sku]`, с.sku);
    await page.fill(`${tr} [name=name]`, с.name);
    await page.fill(`${tr} [name=metal]`, с.metal);
    await page.fill(`${tr} [name=purchase_price]`, с.purchase);
  }
  await page.waitForTimeout(300);

  // Наценка одной кнопкой: вбивать цену продажи руками двадцать раз — то,
  // от чего этот экран и должен избавлять.
  await page.fill('#rc-markup', '65');
  await page.click('#rc-apply-markup');
  await page.waitForTimeout(400);
  const цена1 = await page.inputValue('#rc-rows tr[data-row]:nth-child(1) [name=retail_price]');
  check('наценка проставила цену продажи', Number(цена1) === 165000, цена1);

  const итог = await page.textContent('#rc-total');
  check('итог накладной посчитан на экране', /160\s*000|160000/.test(итог.replace(/ /g, ' ')), итог);
  await снимок(page, { path: `${OUT}/приёмка-накладная.png` });

  await page.click('[data-act=ok]');
  await page.waitForTimeout(2000);
  check('окно приёмки закрылось', !(await page.$('#rc-rows')));

  await page.fill('#pf-search', МЕТКА);
  await page.waitForTimeout(1200);
  const нашлось = await page.$$eval('.pcard', c => c.length);
  check('принятые изделия сразу видны в каталоге', нашлось >= 2, нашлось);

  // Долг перед поставщиком должен появиться сам — это главное, ради чего всё.
  await page.goto(BASE + '/#/debts');
  await page.waitForTimeout(1600);
  const долги = await page.textContent('#app');
  check('раздел долгов открылся', долги.length > 100);
  await снимок(page, { path: `${OUT}/долг-после-приёмки.png` });

  console.log('\n=== Продавец заводит клиента, не бросая чек ===');
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  const page2 = await ctx2.newPage();
  page2.on('pageerror', e => ошибки.push(e.message));
  await войти(page2, 'anna', 'seller123');

  await page2.click('#btn-quick-sale');
  await page2.waitForSelector('#pos-search');
  await page2.fill('#pos-search', МЕТКА + '-1');
  await page2.waitForTimeout(1200);
  const найдено = await page2.$('.search-results .sr-item[data-i]');
  check('изделие из накладной находится в кассе', Boolean(найдено));
  if (найдено) { await найдено.dispatchEvent('mousedown'); await page2.waitForTimeout(500); }

  // Имя без цифр: с цифрами набранное считается номером телефона, и это
  // отдельно проверяется ниже.
  const имяКлиента = 'Айгуль Осмонова из проверки';
  await page2.fill('#pos-customer', имяКлиента);
  await page2.waitForTimeout(1200);
  const кнопкаНовый = await page2.$('.search-results .sr-item[data-new]');
  check('при промахе предлагается завести клиента', Boolean(кнопкаНовый));
  await снимок(page2, { path: `${OUT}/касса-новый-клиент.png` });

  await кнопкаНовый.dispatchEvent('mousedown');
  await page2.waitForTimeout(900);
  check('открылось окно нового клиента', Boolean(await page2.$('#nc-form')));
  check('набранное имя подставилось',
    (await page2.inputValue('#nc-form [name=name]')) === имяКлиента,
    await page2.inputValue('#nc-form [name=name]'));
  await page2.fill('#nc-form [name=phone]', '0700 495 253');
  await page2.click('[data-act=ok]');
  await page2.waitForTimeout(1500);

  check('окно клиента закрылось', !(await page2.$('#nc-form')));
  check('чек НЕ пропал — изделие на месте',
    (await page2.$$eval('.pos-item', r => r.length)) >= 1);
  /*
   * Проверяем не то, что осталось в поле поиска (там и так лежит набранное),
   * а то, что касса ПРИНЯЛА клиента: без этого продажа в долг не пройдёт,
   * и вся затея бессмысленна.
   */
  const подпись = await page2.textContent('#pos-cust-info');
  check('касса приняла нового клиента', /Клиент выбран|скидка/i.test(подпись), подпись);

  // Ради этого всё и делалось: продажа в долг новому покупателю без беготни.
  await page2.check('#pos-partial');
  await page2.fill('#pos-paid', '20000');
  await page2.fill('#pos-due', '2030-06-01');
  await page2.waitForTimeout(600);
  await page2.click('[data-act=submit]');
  await page2.waitForTimeout(2000);
  check('продажа в рассрочку новому клиенту прошла', !(await page2.$('#pos-search')));

  console.log('\n=== Искали по номеру — номер и подставился ===');
  /*
   * Половина продавцов ищет клиента по телефону, а не по имени. Набранный
   * номер должен попасть в поле телефона, а не в обязательное поле имени:
   * иначе окно молча не сохраняется, и человек не понимает почему.
   */
  await page2.keyboard.press('Escape');
  await page2.waitForTimeout(400);
  await page2.click('#btn-quick-sale');
  await page2.waitForSelector('#pos-search');
  await page2.fill('#pos-customer', '0555 123 456');
  await page2.waitForTimeout(1200);
  const поНомеру = await page2.$('.search-results .sr-item[data-new]');
  check('по номеру тоже предлагается завести', Boolean(поНомеру));
  await поНомеру.dispatchEvent('mousedown');
  await page2.waitForTimeout(800);
  check('номер попал в телефон',
    (await page2.inputValue('#nc-form [name=phone]')) === '0555 123 456',
    await page2.inputValue('#nc-form [name=phone]'));
  check('а имя осталось пустым и его ждут',
    (await page2.inputValue('#nc-form [name=name]')) === '',
    await page2.inputValue('#nc-form [name=name]'));
  await page2.keyboard.press('Escape');
  await page2.waitForTimeout(300);

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
