'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Карточка изделия после сохранения: «Сохранить», «Редактировать», «Продать».
 *
 * Заполнили анкету, нажали «Сохранить» — открывается карточка, где
 * добавляют фото. Дальше человек ищет, как закончить: сохранить, поправить
 * или продать. Раньше внизу было до десяти кнопок: на телефоне они
 * закрывали полэкрана, «Редактировать» пряталась под всплывающее
 * сообщение, а «Сохранить» не было вовсе. Теперь внизу три главные кнопки,
 * остальные действия — в самой карточке, сообщения при открытом окне —
 * сверху.
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-карточка';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 300)); }
};
const ВЕРХ = '#modal-root > .modal-overlay:last-child';
const ТЕЛЕФОН = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const МЕТКА = 'КРТ' + process.pid;
const чисто = t => String(t || '').replace(/[  ]/g, ' ').replace(/\s+/g, ' ');

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

const кнопкиВнизу = page => page.$$eval(`${ВЕРХ} .modal-foot button`, b => b.map(x => x.textContent.trim()));

async function открытьКарточку(page, id) {
  await page.goto(BASE + '/#/dashboard');
  await page.waitForTimeout(300);
  await page.goto(BASE + '/#/products/' + id);
  await page.waitForSelector(`${ВЕРХ} [data-act=done]`, { timeout: 10000 });
  await page.waitForTimeout(300);
}

(async () => {
  const вход = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  cookie = (вход.headers.get('set-cookie') || '').split(';')[0];

  const browser = await chromium.launch();
  const ошибки = [];
  const ctx = await browser.newContext(ТЕЛЕФОН);
  const page = await ctx.newPage();
  page.on('pageerror', e => ошибки.push(e.message));
  await войти(page, 'admin', 'admin123');

  console.log('=== 1. Сохранили анкету — внизу три главные кнопки ===');
  await page.goto(BASE + '/#/products');
  await page.waitForSelector('#pf-add');
  await page.click('#pf-add');
  await page.waitForSelector('#prod-form');
  await page.waitForTimeout(500);
  await page.fill('#prod-form [name=sku]', МЕТКА + '-1');
  await page.fill('#prod-form [name=name]', 'Кольцо «Три кнопки»');
  await page.click(`${ВЕРХ} [data-act=save]`);
  await page.waitForSelector(`${ВЕРХ} #prod-gallery`, { timeout: 10000 });
  await page.waitForTimeout(800);
  check('внизу — «Сохранить», «Редактировать», «Продать»',
    JSON.stringify(await кнопкиВнизу(page)) === JSON.stringify(['Сохранить', 'Редактировать', 'Продать']), await кнопкиВнизу(page));
  const низ = await page.$eval(`${ВЕРХ} .modal-foot`, el => el.getBoundingClientRect());
  check('низ карточки не закрывает полэкрана', низ.height < 844 * 0.3, низ.height);
  check('кнопки фото на виду', await page.isVisible(`${ВЕРХ} #prod-gallery`));
  const тост = await page.$eval('#toast-root', el => el.getBoundingClientRect()).catch(() => null);
  check('сообщение «Изделие добавлено» — сверху, не на кнопках', тост && тост.bottom <= низ.top, тост && [тост.top, тост.bottom, низ.top]);
  for (const [act, что] of [['label', 'Бирка'], ['passport', 'Паспорт'], ['share', 'Клиенту'], ['reserve', 'В резерв']]) {
    check(`«${что}» — в карточке, а не внизу`, Boolean(await page.$(`${ВЕРХ} .modal-body .card-actions [data-act=${act}]`)));
  }
  check('подсказка зовёт ту же кнопку, что есть: «Редактировать»', /кнопка «Редактировать»/.test(чисто(await page.textContent(`${ВЕРХ} .modal-body`))));
  await снимок(page, { path: `${OUT}/после-сохранения.png` });

  console.log('\n=== 2. «Продать» без цены — сразу к цене ===');
  await page.click(`${ВЕРХ} [data-act=sell]`);
  await page.waitForSelector('#prod-form', { timeout: 8000 }).catch(() => {});
  check('без цены «Продать» открывает анкету', Boolean(await page.$('#prod-form')));
  check('и ставит курсор в розничную цену', await page.evaluate(() => document.activeElement && document.activeElement.name) === 'retail_price');
  check('и говорит, почему', /впишите цену/.test(чисто(await page.textContent('#toast-root').catch(() => ''))));
  await page.fill('#prod-form [name=retail_price]', '45000');
  await page.click(`${ВЕРХ} [data-act=save]`);
  await page.waitForTimeout(1200);

  console.log('\n=== 3. «Сохранить» закрывает карточку ===');
  const изделие = (await зов('GET', '/api/products?search=' + encodeURIComponent(МЕТКА + '-1'))).data.items[0];
  check('цена записалась', изделие && изделие.retail_price === 45000, изделие && изделие.retail_price);
  await открытьКарточку(page, изделие.id);
  await page.click(`${ВЕРХ} [data-act=done]`);
  await page.waitForTimeout(600);
  check('карточка закрылась', !(await page.$(`${ВЕРХ} [data-act=done]`)));
  check('и сказано «Сохранено»', /Сохранено/.test(чисто(await page.textContent('#toast-root').catch(() => ''))));

  console.log('\n=== 4. «Редактировать» и «Продать» с ценой ===');
  await открытьКарточку(page, изделие.id);
  await page.click(`${ВЕРХ} [data-act=edit]`);
  await page.waitForSelector('#prod-form', { timeout: 8000 }).catch(() => {});
  check('«Редактировать» открывает анкету изделия', Boolean(await page.$('#prod-form'))
    && await page.inputValue('#prod-form [name=sku]') === МЕТКА + '-1');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await открытьКарточку(page, изделие.id);
  await page.click(`${ВЕРХ} [data-act=sell]`);
  await page.waitForSelector('.pos-item', { timeout: 8000 }).catch(() => {});
  check('«Продать» с ценой — сразу касса с изделием в чеке', Boolean(await page.$('.pos-item')));
  await ctx.close();

  console.log('\n=== 5. Продавец: «Продать» без цены — объяснение ===');
  const безЦены = (await зов('POST', '/api/products', { sku: МЕТКА + '-2', name: 'Серьги без цены' })).data.id;
  const ctxП = await browser.newContext(ТЕЛЕФОН);
  const продавец = await ctxП.newPage();
  продавец.on('pageerror', e => ошибки.push(e.message));
  await войти(продавец, 'anna', 'seller123');
  await открытьКарточку(продавец, безЦены);
  check('у продавца те же три кнопки', JSON.stringify(await кнопкиВнизу(продавец)) === JSON.stringify(['Сохранить', 'Редактировать', 'Продать']));
  check('удалить и списать продавцу не предлагаются', !(await продавец.$(`${ВЕРХ} [data-act=delete]`)) && !(await продавец.$(`${ВЕРХ} [data-act=writeoff]`)));
  await продавец.click(`${ВЕРХ} [data-act=sell]`);
  await продавец.waitForTimeout(600);
  check('касса не открылась', !(await продавец.$('.pos-item')) && !(await продавец.$('#pos-search')));
  check('сказано: цену вписывает владелец', /вписывает владелец/.test(чисто(await продавец.textContent('#toast-root').catch(() => ''))));
  await ctxП.close();

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
