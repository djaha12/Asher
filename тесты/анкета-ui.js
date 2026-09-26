'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Анкета изделия на телефоне: выбирают, а не вписывают.
 *
 * Металл у магазина почти всегда белое золото 750, цвет и чистота
 * бриллианта — почти всегда одни и те же. Поэтому они стоят кнопками, и
 * обычное значение уже выбрано; другое — касанием, своё — через «Другое».
 * Нажать выбранное ещё раз — ничего не меняет (жмут «для верности»);
 * снять цвет у изделия без камня — кнопка «Нет».
 * Поставщика, которого ещё нет в списке, владелец заводит прямо из анкеты.
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-анкета';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 300)); }
};
const ВЕРХ = '#modal-root > .modal-overlay:last-child';
const ТЕЛЕФОН = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const МЕТКА = 'АНК' + process.pid;

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

async function открытьАнкету(page) {
  await page.goto(BASE + '/#/dashboard');
  await page.waitForTimeout(300);
  await page.goto(BASE + '/#/products');
  await page.waitForSelector('#pf-add');
  await page.click('#pf-add');
  await page.waitForSelector('#prod-form');
  await page.waitForTimeout(500);
}

// Какая кнопка выбрана в блоке и что лежит в поле формы.
const выбрано = (page, поле) => page.$$eval(`#prod-form .pick[data-pick=${поле}] .chip.active`, b => b.map(x => x.textContent.trim()));
const значение = (page, поле) => page.inputValue(`#prod-form [name=${поле}]`);

(async () => {
  const вход = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  cookie = (вход.headers.get('set-cookie') || '').split(';')[0];
  const настройки = (await зов('GET', '/api/settings')).data;

  const browser = await chromium.launch();
  const ошибки = [];
  const ctx = await browser.newContext(ТЕЛЕФОН);
  const page = await ctx.newPage();
  page.on('pageerror', e => ошибки.push(e.message));
  await войти(page, 'admin', 'admin123');

  console.log('=== 1. Обычное уже выбрано ===');
  await открытьАнкету(page);
  check('металл: выбрано «Белое золото»', JSON.stringify(await выбрано(page, 'metal')) === '["Белое золото"]', await выбрано(page, 'metal'));
  check('проба: выбрано «750»', JSON.stringify(await выбрано(page, 'fineness')) === '["750"]', await выбрано(page, 'fineness'));
  check('поле для своего металла спрятано — печатать нечего', !(await page.isVisible('#prod-form [name=metal]')));
  if (настройки.default_color) {
    check(`цвет: выбрано обычное «${настройки.default_color}»`, (await выбрано(page, 'color')).join() === настройки.default_color, await выбрано(page, 'color'));
  }
  if (настройки.default_clarity) {
    check(`чистота: выбрано обычное «${настройки.default_clarity}»`, (await выбрано(page, 'clarity')).join() === настройки.default_clarity, await выбрано(page, 'clarity'));
  }
  const ширина = await page.evaluate(() => document.documentElement.scrollWidth);
  check('на телефоне анкета не шире экрана', ширина <= 390, ширина);
  await снимок(page, { path: `${OUT}/анкета.png` });

  console.log('\n=== 2. Другое — касанием; выбранное повторным касанием не снимается ===');
  await page.click('#prod-form .pick[data-pick=metal] [data-v="Жёлтое золото"]');
  check('нажали «Жёлтое золото» — оно в форме, выбрано одно', await значение(page, 'metal') === 'Жёлтое золото'
    && (await выбрано(page, 'metal')).length === 1);
  await page.click('#prod-form .pick[data-pick=metal] [data-v="Жёлтое золото"]');
  check('нажали ещё раз «для верности» — выбор остался', await значение(page, 'metal') === 'Жёлтое золото'
    && (await выбрано(page, 'metal')).join() === 'Жёлтое золото');
  await page.click('#prod-form .pick[data-pick=metal] [data-v="Белое золото"]');
  check('у металла кнопки «Нет» нет — металл есть всегда', !(await page.$('#prod-form .pick[data-pick=metal] [data-v=""]')));
  await page.click('#prod-form .pick[data-pick=color] [data-v=""]');
  check('у цвета «Нет» снимает цвет — изделие без камня', await значение(page, 'color') === ''
    && (await выбрано(page, 'color')).join() === 'Нет');
  await page.click('#prod-form .pick[data-pick=color] [data-v="G"]');
  await page.click('#prod-form .pick[data-pick=color] [data-v="G"]');
  check('цвет G — касанием, и второе касание его не снимает', await значение(page, 'color') === 'G');
  await page.click('#prod-form .pick[data-pick=clarity] [data-other]');
  check('«Другое» открывает поле для своего значения', await page.isVisible('#prod-form [name=clarity]')
    && await значение(page, 'clarity') === '');
  await page.fill('#prod-form [name=clarity]', 'SI3');

  console.log('\n=== 3. Новый поставщик — прямо из анкеты ===');
  const имяПоставщика = 'Поставщик ' + МЕТКА;
  await page.selectOption('#prod-form [name=supplier_id]', '__new');
  await page.waitForSelector('#sup-form');
  check('открылось окно нового поставщика поверх анкеты', Boolean(await page.$('#prod-form')));
  await page.fill('#sup-form [name=name]', имяПоставщика);
  await page.fill('#sup-form [name=phone]', '+996 555 000 111');
  await page.click(`${ВЕРХ} [data-act=ok]`);
  await page.waitForTimeout(1200);
  const выбранПоставщик = await page.$eval('#prod-form [name=supplier_id]', s => s.options[s.selectedIndex].textContent);
  check('новый поставщик сразу выбран в анкете', выбранПоставщик === имяПоставщика, выбранПоставщик);
  await page.fill('#prod-form [name=sku]', МЕТКА + '-1');
  await page.click(`${ВЕРХ} [data-act=save]`);
  await page.waitForTimeout(1500);
  const изделие = (await зов('GET', '/api/products?search=' + encodeURIComponent(МЕТКА + '-1'))).data.items[0];
  const поставщик = ((await зов('GET', '/api/suppliers')).data.items || []).find(x => x.name === имяПоставщика);
  check('изделие сохранилось с выбранным: белое золото 750, G, SI3',
    изделие && изделие.metal === 'Белое золото' && изделие.fineness === '750' && изделие.color === 'G' && изделие.clarity === 'SI3',
    изделие && [изделие.metal, изделие.fineness, изделие.color, изделие.clarity]);
  check('и с новым поставщиком', изделие && поставщик && изделие.supplier_id === поставщик.id, изделие && изделие.supplier_id);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  console.log('\n=== 4. Приёмка: новый поставщик — там же ===');
  await page.goto(BASE + '/#/products');
  await page.waitForSelector('#pf-receipt');
  await page.click('#pf-receipt');
  await page.waitForSelector('#rc-supplier option[value="__new"]', { state: 'attached', timeout: 8000 }).catch(() => {});
  check('в приёмке у поставщика есть «+ Новый поставщик»', Boolean(await page.$('#rc-supplier option[value="__new"]')));
  await page.keyboard.press('Escape');

  console.log('\n=== 5. Настройки: свой цвет и чистота по умолчанию ===');
  await зов('PUT', '/api/settings', { default_color: 'f', default_clarity: 'vs2' });
  await открытьАнкету(page);
  check('после настройки выбраны F и VS2',
    (await выбрано(page, 'color')).join() === 'F' && (await выбрано(page, 'clarity')).join() === 'VS2',
    [await выбрано(page, 'color'), await выбрано(page, 'clarity')]);
  await page.keyboard.press('Escape');
  await зов('PUT', '/api/settings', { default_color: настройки.default_color, default_clarity: настройки.default_clarity });
  await ctx.close();

  console.log('\n=== 6. Продавцу заводить поставщиков нельзя — и пункта нет ===');
  const ctxП = await browser.newContext(ТЕЛЕФОН);
  const продавец = await ctxП.newPage();
  продавец.on('pageerror', e => ошибки.push(e.message));
  await войти(продавец, 'anna', 'seller123');
  await открытьАнкету(продавец);
  check('у продавца в списке поставщиков нет «+ Новый поставщик»', !(await продавец.$('#prod-form [name=supplier_id] option[value="__new"]')));
  check('а кнопки металла у него те же', JSON.stringify(await выбрано(продавец, 'metal')) === '["Белое золото"]');
  await ctxП.close();

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
