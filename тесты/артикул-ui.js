'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Такой артикул уже есть — отдельное окно, а не красная строка.
 *
 * Раньше при занятом артикуле вверху мелькало «Артикул уже существует»,
 * изделие не сохранялось, и что делать дальше, было непонятно. Теперь
 * открывается окно: то изделие с фото, весом и ценой — узнать глазами — и три
 * дороги. «Это оно» — изделие уже заведено, открываем его. «Другое изделие» —
 * та же модель, ещё одна штука: записываем «К-12-2», и поиск по «К-12»
 * находит обе. «Исправить артикул» — опечатка, курсор в артикуле.
 * Артикулы сравниваются без учёта регистра: «к-12» и «К-12» — один.
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-артикул';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 300)); }
};
const ВЕРХ = '#modal-root > .modal-overlay:last-child';
const ТЕЛЕФОН = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
// Артикул из букв: цифры метки процесса не должны совпасть с чужими артикулами.
const АРТ = 'ДУБ-' + process.pid.toString(36).toUpperCase();
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
const сАртикулом = async sku => ((await зов('GET', '/api/products?limit=50&search=' + encodeURIComponent(sku))).data.items || [])
  .filter(x => x.sku.toLowerCase() === sku.toLowerCase());

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

const окноДубля = page => page.$(`${ВЕРХ} .dup-item`);
const кнопкиВнизу = page => page.$$eval(`${ВЕРХ} .modal-foot button`, b => b.map(x => x.textContent.trim()));

(async () => {
  const вход = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  cookie = (вход.headers.get('set-cookie') || '').split(';')[0];

  console.log('=== 1. Сервер: занятый артикул — кто его носит и что свободно ===');
  const первое = (await зов('POST', '/api/products', { sku: АРТ, name: 'Кольцо «Первое»', weight: 3.2, size: '17', retail_price: 45000 })).data.id;
  let r = await зов('POST', '/api/products', { sku: АРТ, name: 'Кольцо «Второе»' });
  check('тот же артикул — отказ 409', r.status === 409, r.status);
  check('в ответе — какое изделие его носит', r.data && r.data.existing && r.data.existing.id === первое
    && r.data.existing.name === 'Кольцо «Первое»' && r.data.existing.weight === 3.2, JSON.stringify(r.data));
  check('и свободный вариант того же артикула', r.data && r.data.вариант === АРТ + '-2', r.data && r.data.вариант);
  check('закупочная в ответ не попадает', r.data && r.data.existing && !('purchase_price' in r.data.existing));
  r = await зов('POST', '/api/products', { sku: АРТ.toLowerCase(), name: 'Кольцо «строчными»' });
  check('тот же артикул строчными — тоже занят', r.status === 409 && r.data.existing.id === первое, r.status);
  const второе = (await зов('POST', '/api/products', { sku: АРТ + '-2', name: 'Кольцо «Второе»', retail_price: 41000 })).data.id;
  r = await зов('POST', '/api/products', { sku: АРТ, name: 'Кольцо «Третье»' });
  check('«-2» занято — предлагаем «-3»', r.status === 409 && r.data.вариант === АРТ + '-3', r.data && r.data.вариант);
  r = await зов('PUT', '/api/products/' + второе, { sku: АРТ });
  check('правка: чужой артикул — тоже 409 с изделием', r.status === 409 && r.data.existing && r.data.existing.id === первое, r.status);
  r = await зов('PUT', '/api/products/' + первое, { sku: АРТ.toLowerCase() });
  check('свой артикул строчными — можно, это он же', r.status === 200, JSON.stringify(r.data));
  await зов('PUT', '/api/products/' + первое, { sku: АРТ });
  const поставщик = ((await зов('GET', '/api/suppliers')).data.items || [])[0];
  r = await зов('POST', '/api/receipts', { supplier_id: поставщик.id, items: [{ sku: АРТ, name: 'Из накладной' }] });
  check('накладная: сказано, какое изделие носит артикул и что вписать',
    r.status === 400 && r.data.error.includes('Кольцо «Первое»') && r.data.error.includes(`«${АРТ}-3»`), r.data && r.data.error);

  const browser = await chromium.launch();
  const ошибки = [];
  const ctx = await browser.newContext(ТЕЛЕФОН);
  const page = await ctx.newPage();
  page.on('pageerror', e => ошибки.push(e.message));
  await войти(page, 'admin', 'admin123');

  console.log('\n=== 2. Анкета: вместо красной строки — окно «Такой артикул уже есть» ===');
  await открытьАнкету(page);
  await page.fill('#prod-form [name=sku]', АРТ.toLowerCase());
  await page.selectOption('#prod-form [name=category_id]', { label: 'Кольца' });
  await page.fill('#prod-form [name=weight]', '3.4');
  await page.fill('#prod-form [name=retail_price]', '52000');
  await page.click(`${ВЕРХ} [data-act=save]`);
  await page.waitForSelector(`${ВЕРХ} .dup-item`, { timeout: 8000 }).catch(() => {});
  check('открылось окно', Boolean(await окноДубля(page)));
  const заголовок = чисто(await page.textContent(`${ВЕРХ} .modal-head`).catch(() => ''));
  check('в заголовке — занятый артикул, как он записан', заголовок.includes(`Артикул «${АРТ}» уже есть`), заголовок);
  const вОкне = чисто(await page.textContent(`${ВЕРХ} .modal-body`).catch(() => ''));
  check('в окне — то изделие: название, вес, размер, цена', /Кольцо «Первое»/.test(вОкне) && /3,2 г/.test(вОкне)
    && /размер 17/.test(вОкне) && /45 000/.test(вОкне), вОкне);
  // Набрали строчными — вариант всё равно от записанного: «-3» к артикулу модели.
  check('три дороги: это оно, другое изделие, исправить',
    JSON.stringify(await кнопкиВнизу(page)) === JSON.stringify(['Это оно — открыть', `Другое изделие: ${АРТ}-3`, 'Исправить артикул']),
    await кнопкиВнизу(page));
  const кнопки = await page.$$eval(`${ВЕРХ} .modal-foot button`, b => b.map(x => {
    const r = x.getBoundingClientRect();
    return { право: r.right, высота: r.height, ширина: r.width };
  }));
  check('на телефоне кнопки не уходят за край', кнопки.every(к => к.право <= 390), JSON.stringify(кнопки));
  check('каждая во всю ширину и одной строкой', кнопки.every(к => к.ширина > 300 && к.высота < 56), JSON.stringify(кнопки));
  check('красной строки «уже существует» нет', !/уже существует/.test(чисто(await page.textContent('#toast-root').catch(() => ''))));
  await page.waitForTimeout(500);   // окно проявляется плавно — снимаем, когда встало
  await снимок(page, { path: `${OUT}/окно.png` });

  console.log('\n=== 3. «Исправить артикул» — назад в анкету, всё набранное на месте ===');
  await page.click(`${ВЕРХ} [data-act=fix]`);
  await page.waitForTimeout(400);
  check('окно закрылось, анкета на месте', !(await окноДубля(page)) && Boolean(await page.$('#prod-form')));
  check('курсор в артикуле', await page.evaluate(() => document.activeElement && document.activeElement.name) === 'sku');
  check('набранное не пропало', await page.$eval('#prod-form [name=category_id]', s => s.options[s.selectedIndex].text) === 'Кольца'
    && await page.inputValue('#prod-form [name=weight]') === '3.4' && await page.inputValue('#prod-form [name=retail_price]') === '52000');

  console.log('\n=== 4. «Другое изделие» — записываем «-3», дальше фото и «Сохранить» ===');
  await page.click(`${ВЕРХ} [data-act=save]`);
  await page.waitForSelector(`${ВЕРХ} [data-act=variant]`, { timeout: 8000 });
  await page.click(`${ВЕРХ} [data-act=variant]`);
  await page.waitForSelector(`${ВЕРХ} #prod-gallery`, { timeout: 10000 }).catch(() => {});
  check('открылась карточка нового изделия с фото', Boolean(await page.$(`${ВЕРХ} #prod-gallery`)));
  const третье = (await сАртикулом(АРТ + '-3'))[0];
  check('записано с артикулом «-3» и всем набранным',
    третье && третье.name === 'Кольцо' && третье.weight === 3.4 && третье.retail_price === 52000,
    третье && [третье.sku, третье.name, третье.weight, третье.retail_price]);
  check('первое изделие не тронуто', (await зов('GET', '/api/products/' + первое)).data.name === 'Кольцо «Первое»');
  const поиск = ((await зов('GET', '/api/products?limit=50&search=' + encodeURIComponent(АРТ))).data.items || []).map(x => x.sku);
  check('поиск по артикулу находит все штуки модели', [АРТ, АРТ + '-2', АРТ + '-3'].every(s => поиск.includes(s)), поиск);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  console.log('\n=== 5. «Это оно — открыть» — ничего не заводим, открываем то изделие ===');
  await открытьАнкету(page);
  await page.fill('#prod-form [name=sku]', АРТ);
  await page.click(`${ВЕРХ} [data-act=save]`);
  await page.waitForSelector(`${ВЕРХ} [data-act=open]`, { timeout: 8000 });
  await page.click(`${ВЕРХ} [data-act=open]`);
  await page.waitForSelector(`${ВЕРХ} [data-act=done]`, { timeout: 10000 }).catch(() => {});
  check('открылась карточка того изделия', /Кольцо «Первое»/.test(чисто(await page.textContent(`${ВЕРХ} .modal-head`).catch(() => ''))));
  check('анкета закрылась', !(await page.$('#prod-form')));
  check('новое изделие не заведено', (await сАртикулом(АРТ + '-4')).length === 0 && (await сАртикулом(АРТ)).length === 1);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  console.log('\n=== 6. «Продать» с занятым артикулом — «Другое изделие» ведёт в кассу ===');
  await открытьАнкету(page);
  await page.fill('#prod-form [name=sku]', АРТ);
  await page.fill('#prod-form [name=retail_price]', '38000');
  await page.click(`${ВЕРХ} [data-act=save-sell]`);
  await page.waitForSelector(`${ВЕРХ} [data-act=variant]`, { timeout: 8000 });
  check('то же окно', /Другое изделие/.test(await page.textContent(`${ВЕРХ} [data-act=variant]`)));
  await page.click(`${ВЕРХ} [data-act=variant]`);
  await page.waitForSelector('.pos-item', { timeout: 8000 }).catch(() => {});
  check('касса с новым изделием в чеке', чисто(await page.textContent('#pos-items').catch(() => '')).includes(АРТ + '-4'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  console.log('\n=== 7. Правка: чужой артикул — «Исправить» или «Записать как» ===');
  await page.goto(BASE + '/#/dashboard');
  await page.waitForTimeout(300);
  await page.goto(BASE + '/#/products/' + второе);
  await page.waitForSelector(`${ВЕРХ} [data-act=edit]`);
  await page.click(`${ВЕРХ} [data-act=edit]`);
  await page.waitForSelector('#prod-form');
  await page.fill('#prod-form [name=sku]', АРТ);
  await page.click(`${ВЕРХ} [data-act=save]`);
  await page.waitForSelector(`${ВЕРХ} .dup-item`, { timeout: 8000 }).catch(() => {});
  check('при правке «Это оно» не предлагаем — это заведомо другое изделие',
    JSON.stringify(await кнопкиВнизу(page)) === JSON.stringify([`Записать как: ${АРТ}-5`, 'Исправить артикул']), await кнопкиВнизу(page));
  await page.click(`${ВЕРХ} [data-act=fix]`);
  await page.waitForTimeout(300);
  await page.fill('#prod-form [name=sku]', АРТ + '-2');
  await page.click(`${ВЕРХ} [data-act=save]`);
  await page.waitForTimeout(1000);
  check('вернули свой артикул — сохранилось без окна', !(await окноДубля(page)) && !(await page.$('#prod-form')));

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
