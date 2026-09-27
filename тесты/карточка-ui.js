'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Анкета и карточка изделия: «Добавить» или «Продать», дальше — фото и «Сохранить».
 *
 * Анкету заканчивают одной из двух кнопок. «Добавить» записывает изделие и
 * открывает карточку: там снимают фото и нажимают «Сохранить» — теперь это
 * большая кнопка. «Продать» записывает изделие и сразу открывает кассу с ним
 * в чеке: покупатель ждёт у прилавка, а изделие ещё не заведено. Без цены
 * «Продать» ничего не записывает, а ставит курсор в цену.
 *
 * В карточке из каталога внизу по-прежнему «Сохранить», «Редактировать»,
 * «Продать», и большая — «Продать». Раньше внизу было до десяти кнопок: на
 * телефоне они закрывали полэкрана, «Редактировать» пряталась под
 * всплывающее сообщение. Остальные действия — в самой карточке, сообщения
 * при открытом окне — сверху.
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
const чисто = t => String(t || '').replace(/[  ]/g, ' ').replace(/\s+/g, ' ');

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
const найти = async sku => ((await зов('GET', '/api/products?search=' + encodeURIComponent(sku))).data.items || [])
  .find(x => x.sku === sku);

async function войти(page, логин, пароль) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('#login-username', логин);
  await page.fill('#login-password', пароль);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
}

const кнопкиВнизу = page => page.$$eval(`${ВЕРХ} .modal-foot button`, b => b.map(x => x.textContent.trim()));
const большая = page => page.$eval(`${ВЕРХ} .modal-foot .btn-primary`, b => b.textContent.trim()).catch(() => '');
const сообщение = async page => чисто(await page.textContent('#toast-root').catch(() => ''));

async function открытьКарточку(page, id) {
  await page.goto(BASE + '/#/dashboard');
  await page.waitForTimeout(300);
  await page.goto(BASE + '/#/products/' + id);
  await page.waitForSelector(`${ВЕРХ} [data-act=done]`, { timeout: 10000 });
  await page.waitForTimeout(300);
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

// Касса открылась с изделием в чеке — закрываем её, продажу не проводим.
async function кассаСИзделием(page, sku) {
  await page.waitForSelector('.pos-item', { timeout: 8000 }).catch(() => {});
  const чек = чисто(await page.textContent('#pos-items').catch(() => ''));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  return чек.includes(sku);
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

  console.log('=== 1. Анкета: «Отмена», «Продать» и большая «Добавить» ===');
  await открытьАнкету(page);
  check('внизу анкеты — «Отмена», «Продать», «Добавить»',
    JSON.stringify(await кнопкиВнизу(page)) === JSON.stringify(['Отмена', 'Продать', 'Добавить']), await кнопкиВнизу(page));
  check('большая кнопка — «Добавить»', await большая(page) === 'Добавить', await большая(page));
  const низАнкеты = await page.$eval(`${ВЕРХ} .modal-foot`, el => {
    const r = el.getBoundingClientRect();
    return { высота: r.height, край: Math.max(...[...el.querySelectorAll('button')].map(b => b.getBoundingClientRect().right)) };
  });
  check('три кнопки — в две строки, как было две', низАнкеты.высота < 844 * 0.2, низАнкеты.высота);
  check('и ни одна не уходит за край экрана', низАнкеты.край <= 390, низАнкеты.край);
  await снимок(page, { path: `${OUT}/анкета-низ.png` });
  await page.fill('#prod-form [name=sku]', МЕТКА + '-1');
  await page.fill('#prod-form [name=name]', 'Кольцо «Три кнопки»');
  await page.click(`${ВЕРХ} [data-act=save]`);
  await page.waitForSelector(`${ВЕРХ} #prod-gallery`, { timeout: 10000 });
  await page.waitForTimeout(800);

  console.log('\n=== 2. После «Добавить» — фото и большая «Сохранить» ===');
  check('внизу — «Редактировать», «Продать» и «Сохранить»',
    JSON.stringify(await кнопкиВнизу(page)) === JSON.stringify(['Редактировать', 'Продать', 'Сохранить']), await кнопкиВнизу(page));
  check('большая кнопка — «Сохранить»', await большая(page) === 'Сохранить', await большая(page));
  const низ = await page.$eval(`${ВЕРХ} .modal-foot`, el => el.getBoundingClientRect());
  check('низ карточки не закрывает полэкрана', низ.height < 844 * 0.3, низ.height);
  const фото = await page.$eval(`${ВЕРХ} #prod-gallery [data-act=camera]`, el => el.getBoundingClientRect()).catch(() => null);
  check('«Снять камерой» — на экране сразу, над кнопками', фото && фото.top >= 0 && фото.bottom <= низ.top, фото && [фото.top, фото.bottom, низ.top]);
  const тост = await page.$eval('#toast-root', el => el.getBoundingClientRect()).catch(() => null);
  check('сообщение «Изделие добавлено» — сверху, не на кнопках', тост && тост.bottom <= низ.top, тост && [тост.top, тост.bottom, низ.top]);
  for (const [act, что] of [['label', 'Бирка'], ['passport', 'Паспорт'], ['share', 'Клиенту'], ['reserve', 'В резерв']]) {
    check(`«${что}» — в карточке, а не внизу`, Boolean(await page.$(`${ВЕРХ} .modal-body .card-actions [data-act=${act}]`)));
  }
  check('подсказка зовёт ту же кнопку, что есть: «Редактировать»', /кнопка «Редактировать»/.test(чисто(await page.textContent(`${ВЕРХ} .modal-body`))));
  await снимок(page, { path: `${OUT}/после-добавления.png` });

  console.log('\n=== 3. «Продать» без цены — к цене, и оттуда сразу в кассу ===');
  await page.click(`${ВЕРХ} [data-act=sell]`);
  await page.waitForSelector('#prod-form', { timeout: 8000 }).catch(() => {});
  check('без цены «Продать» открывает анкету', Boolean(await page.$('#prod-form')));
  check('и ставит курсор в розничную цену', await page.evaluate(() => document.activeElement && document.activeElement.name) === 'retail_price');
  check('и говорит, почему', /впишите цену/.test(await сообщение(page)));
  check('в анкете изделия — «Отмена», «Продать», «Сохранить»',
    JSON.stringify(await кнопкиВнизу(page)) === JSON.stringify(['Отмена', 'Продать', 'Сохранить']), await кнопкиВнизу(page));
  await page.fill('#prod-form [name=retail_price]', '45000');
  await page.click(`${ВЕРХ} [data-act=save-sell]`);
  check('вписали цену, «Продать» — касса с изделием в чеке', await кассаСИзделием(page, МЕТКА + '-1'));
  const изделие = await найти(МЕТКА + '-1');
  check('цена записалась', изделие && изделие.retail_price === 45000, изделие && изделие.retail_price);

  console.log('\n=== 4. «Продать» прямо из анкеты ===');
  await открытьАнкету(page);
  await page.fill('#prod-form [name=sku]', МЕТКА + '-3');
  await page.fill('#prod-form [name=name]', 'Серьги «С прилавка»');
  await page.click(`${ВЕРХ} [data-act=save-sell]`);
  await page.waitForTimeout(800);
  check('без цены — анкета не закрылась', Boolean(await page.$('#prod-form')));
  check('курсор в розничной цене', await page.evaluate(() => document.activeElement && document.activeElement.name) === 'retail_price');
  check('и сказано: впишите розничную цену', /впишите розничную цену/.test(await сообщение(page)), await сообщение(page));
  check('изделие без цены не записано', !(await найти(МЕТКА + '-3')));
  await page.fill('#prod-form [name=retail_price]', '30000');
  await page.click(`${ВЕРХ} [data-act=save-sell]`);
  await page.waitForSelector('.pos-item', { timeout: 8000 }).catch(() => {});
  check('карточка с фото не встала на пути — сразу касса', !(await page.$('#prod-gallery')));
  await снимок(page, { path: `${OUT}/продать-из-анкеты.png` });
  check('в чеке — новое изделие', await кассаСИзделием(page, МЕТКА + '-3'));
  const сПрилавка = await найти(МЕТКА + '-3');
  check('изделие записано с ценой и ждёт продажи на витрине',
    сПрилавка && сПрилавка.retail_price === 30000 && сПрилавка.status === 'in_stock',
    сПрилавка && [сПрилавка.retail_price, сПрилавка.status]);
  check('записано один раз', ((await зов('GET', '/api/products?search=' + encodeURIComponent(МЕТКА + '-3'))).data.items || [])
    .filter(x => x.sku === МЕТКА + '-3').length === 1);

  console.log('\n=== 5. Карточка из каталога: «Сохранить» закрывает, большая — «Продать» ===');
  await открытьКарточку(page, изделие.id);
  check('внизу — «Сохранить», «Редактировать», «Продать»',
    JSON.stringify(await кнопкиВнизу(page)) === JSON.stringify(['Сохранить', 'Редактировать', 'Продать']), await кнопкиВнизу(page));
  check('большая — «Продать»', await большая(page) === 'Продать', await большая(page));
  await page.click(`${ВЕРХ} [data-act=done]`);
  await page.waitForTimeout(600);
  check('«Сохранить» закрывает карточку', !(await page.$(`${ВЕРХ} [data-act=done]`)));
  check('и сказано «Сохранено»', /Сохранено/.test(await сообщение(page)));

  console.log('\n=== 6. «Редактировать» и «Продать» с ценой ===');
  await открытьКарточку(page, изделие.id);
  await page.click(`${ВЕРХ} [data-act=edit]`);
  await page.waitForSelector('#prod-form', { timeout: 8000 }).catch(() => {});
  check('«Редактировать» открывает анкету изделия', Boolean(await page.$('#prod-form'))
    && await page.inputValue('#prod-form [name=sku]') === МЕТКА + '-1');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await открытьКарточку(page, изделие.id);
  await page.click(`${ВЕРХ} [data-act=sell]`);
  check('«Продать» с ценой — сразу касса с изделием в чеке', await кассаСИзделием(page, МЕТКА + '-1'));
  await ctx.close();

  console.log('\n=== 7. Продавец ===');
  const безЦены = (await зов('POST', '/api/products', { sku: МЕТКА + '-2', name: 'Серьги без цены' })).data.id;
  const ctxП = await browser.newContext(ТЕЛЕФОН);
  const продавец = await ctxП.newPage();
  продавец.on('pageerror', e => ошибки.push(e.message));
  await войти(продавец, 'anna', 'seller123');
  await открытьКарточку(продавец, безЦены);
  check('у продавца в карточке те же три кнопки', JSON.stringify(await кнопкиВнизу(продавец)) === JSON.stringify(['Сохранить', 'Редактировать', 'Продать']));
  check('удалить и списать продавцу не предлагаются', !(await продавец.$(`${ВЕРХ} [data-act=delete]`)) && !(await продавец.$(`${ВЕРХ} [data-act=writeoff]`)));
  await продавец.click(`${ВЕРХ} [data-act=sell]`);
  await продавец.waitForTimeout(600);
  check('«Продать» без цены: касса не открылась', !(await продавец.$('.pos-item')) && !(await продавец.$('#pos-search')));
  check('сказано: цену вписывает владелец', /вписывает владелец/.test(await сообщение(продавец)));
  await продавец.click(`${ВЕРХ} [data-act=edit]`);
  await продавец.waitForSelector('#prod-form', { timeout: 8000 }).catch(() => {});
  await продавец.click(`${ВЕРХ} [data-act=save-sell]`);
  await продавец.waitForTimeout(600);
  check('и из анкеты заведённого изделия — то же объяснение, касса закрыта',
    /вписывает владелец/.test(await сообщение(продавец)) && !(await продавец.$('.pos-item')));
  await продавец.keyboard.press('Escape');
  await продавец.waitForTimeout(400);
  // Новое изделие продавец заводит с ценой сам — и может сразу продать.
  await открытьАнкету(продавец);
  await продавец.fill('#prod-form [name=sku]', МЕТКА + '-4');
  await продавец.fill('#prod-form [name=retail_price]', '12000');
  await продавец.click(`${ВЕРХ} [data-act=save-sell]`);
  check('продавец: новое изделие с ценой — «Продать» ведёт в кассу', await кассаСИзделием(продавец, МЕТКА + '-4'));
  await ctxП.close();

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
