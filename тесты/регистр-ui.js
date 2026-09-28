'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Большие и маленькие буквы — без разницы везде: в поиске, при заполнении
 * и при проверке повторов.
 *
 * Владелец: «когда добавляешь изделия с маленькой буквы, потом он не ищет
 * или не находит дубли». Поиск и повтор артикула в анкете регистр уже не
 * различали, а в других местах различали: комплект мог взять артикул
 * изделия, если набрать его кириллицей в другом регистре; новая выгрузка
 * прайса с «as-00120» заводила двойника «AS-00120»; сканер инвентаризации
 * не узнавал штрихкод строчными; «кольца» становились второй категорией
 * рядом с «Кольца»; поставщиков на повтор не проверял никто — «азия голд»
 * и «Азия Голд» заводились дважды, и долг расползался по двум карточкам;
 * так же с точками продаж.
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-регистр';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 300)); }
};
const ВЕРХ = '#modal-root > .modal-overlay:last-child';
const ТЕЛЕФОН = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
// Метка из букв: цифры метки процесса не должны совпасть с чужими артикулами.
const М = process.pid.toString(36).toUpperCase();
const КИР = 'рег' + М.toLowerCase();          // «регabc» — набрано строчными
const ЛАТ = 'reg' + М.toLowerCase();

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
const найдено = async (запрос, sku) => ((await зов('GET', '/api/products?search=' + encodeURIComponent(запрос))).data.items || [])
  .some(x => x.sku === sku);

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

  console.log('=== 1. Завели строчными — находится и заглавными, и как угодно ===');
  const аб = КИР + '-аб';
  const cd = ЛАТ + '-cd';
  const первое = (await зов('POST', '/api/products', { sku: аб, name: 'Кольцо', retail_price: 40000 })).data.id;
  const второе = (await зов('POST', '/api/products', { sku: cd, name: 'Серьги', retail_price: 30000 })).data.id;
  check('каталог: «' + аб.toUpperCase() + '» находит «' + аб + '»', await найдено(аб.toUpperCase(), аб));
  check('каталог: с заглавной первой — тоже', await найдено(аб[0].toUpperCase() + аб.slice(1), аб));
  check('каталог: латиница заглавными находит строчную', await найдено(cd.toUpperCase(), cd));
  const общий = (await зов('GET', '/api/search?q=' + encodeURIComponent(аб.toUpperCase()))).data;
  check('общий поиск — тоже', (общий.groups || []).some(г => г.items.some(x => String(x.title || x.name || x.label || '').includes(аб)
    || JSON.stringify(x).includes(аб))), JSON.stringify(общий).slice(0, 200));

  console.log('\n=== 2. Повтор артикула — где бы его ни набрали ===');
  let r = await зов('POST', '/api/products', { sku: аб.toUpperCase(), name: 'Кольцо' });
  check('анкета: заглавными — «такой артикул уже есть»', r.status === 409 && r.data.existing && r.data.existing.id === первое, r.status);
  const поставщик = ((await зов('GET', '/api/suppliers')).data.items || [])[0];
  r = await зов('POST', '/api/receipts', { supplier_id: поставщик.id, items: [{ sku: аб.toUpperCase(), purchase_price: 1000 }] });
  check('накладная: заглавными — «уже есть в каталоге»', r.status === 400 && /уже есть в каталоге/.test(r.data.error), r.data && r.data.error);
  const третье = (await зов('POST', '/api/products', { sku: КИР + '-вг', name: 'Подвеска', retail_price: 20000 })).data.id;
  r = await зов('POST', '/api/sets', { name: 'Гарнитур ' + М, sku: аб.toUpperCase(), price: 45000, product_ids: [второе, третье] });
  check('комплект не берёт артикул изделия, набранный заглавными', r.status === 400 && /занят изделием/.test(r.data.error), r.data && r.data.error);
  r = await зов('POST', '/api/sets', { name: 'Гарнитур ' + М, sku: КИР + '-комп', price: 45000, product_ids: [второе, третье] });
  check('комплект со своим артикулом заведён', r.status === 200, JSON.stringify(r.data));
  r = await зов('POST', '/api/products', { sku: (КИР + '-комп').toUpperCase(), name: 'Кольцо' });
  check('изделие не берёт артикул комплекта, набранный заглавными', r.status === 400 && /занят комплектом/.test(r.data.error), r.data && r.data.error);

  console.log('\n=== 3. Выгрузка прайса: «AS-…» и «as-…» — одно изделие, не двойник ===');
  const csv = `Артикул;Наименование;Розничная цена\n${аб.toUpperCase()};Кольцо;45 500,00`;
  const разбор = (await зов('POST', '/api/import/preview', { csv, entity: 'products' })).data;
  r = await зов('POST', '/api/import/commit', { csv, entity: 'products', mapping: разбор.suggested_mapping, delimiter: разбор.delimiter,
    update_existing: true, update_fields: ['retail_price'] });
  check('обновилось заведённое, нового не заведено', r.status === 200 && r.data.updated === 1 && r.data.created === 0, JSON.stringify(r.data));
  check('цена у «' + аб + '» — 45 500', (await зов('GET', '/api/products/' + первое)).data.retail_price === 45500);

  console.log('\n=== 4. Инвентаризация: код строчными находит изделие ===');
  const точка = (await зов('POST', '/api/stores', { name: 'Пересчёт ' + М })).data.id;
  const пересчёт = (await зов('POST', '/api/inventory', { store_id: точка })).data.session;
  r = await зов('POST', `/api/inventory/${пересчёт.id}/scan`, { code: cd.toUpperCase() });
  check('сканер: «' + cd.toUpperCase() + '» — это «' + cd + '»', r.status === 200 && r.data.product && r.data.product.id === второе, JSON.stringify(r.data).slice(0, 150));
  await зов('DELETE', '/api/inventory/' + пересчёт.id);

  console.log('\n=== 5. Категории, поставщики, точки — без двойников ===');
  r = await зов('POST', '/api/categories', { name: 'кольца' });
  check('«кольца» — это «Кольца»: второй категории нет', r.status === 400 && /уже есть/.test(r.data.error), JSON.stringify(r.data));
  const азия = (await зов('POST', '/api/suppliers', { name: 'Азия Голд ' + М })).data.id;
  r = await зов('POST', '/api/suppliers', { name: ('азия голд ' + М).toLowerCase() });
  check('поставщик строчными — «уже есть», и видно какой', r.status === 409 && r.data.existing && r.data.existing.id === азия, JSON.stringify(r.data));
  const другой = (await зов('POST', '/api/suppliers', { name: 'Другой поставщик ' + М })).data.id;
  r = await зов('PUT', '/api/suppliers/' + другой, { name: ('АЗИЯ ГОЛД ' + М).toUpperCase() });
  check('переименовать в занятое (другими буквами) нельзя', r.status === 400 && /уже есть/.test(r.data.error), JSON.stringify(r.data));
  r = await зов('POST', '/api/stores', { name: ('пересчёт ' + М).toLowerCase() });
  check('точка строчными — «уже есть»', r.status === 400 && /уже есть/.test(r.data.error), JSON.stringify(r.data));
  await зов('DELETE', '/api/stores/' + точка);

  console.log('\n=== 6. Анкета: «+ Новый поставщик» другими буквами выбирает заведённого ===');
  const browser = await chromium.launch();
  const ошибки = [];
  const page = await (await browser.newContext(ТЕЛЕФОН)).newPage();
  page.on('pageerror', e => ошибки.push(e.message));
  await войти(page, 'admin', 'admin123');
  await page.goto(BASE + '/#/products');
  await page.waitForSelector('#pf-add');
  await page.click('#pf-add');
  await page.waitForSelector('#prod-form');
  await page.waitForTimeout(400);
  await page.selectOption('#prod-form [name=supplier_id]', '__new');
  await page.waitForSelector('#sup-form');
  await page.fill('#sup-form [name=name]', ('азия голд ' + М).toLowerCase());
  await page.click(`${ВЕРХ} [data-act=ok]`);
  await page.waitForTimeout(1200);
  const выбран = await page.$eval('#prod-form [name=supplier_id]', s => ({
    value: s.value, text: s.options[s.selectedIndex].textContent,
    одинаковых: [...s.options].filter(o => o.textContent.toLowerCase() === s.options[s.selectedIndex].textContent.toLowerCase()).length,
  }));
  check('выбран заведённый «Азия Голд», а не новый', выбран.value === String(азия) && выбран.text === 'Азия Голд ' + М, JSON.stringify(выбран));
  check('в списке он один', выбран.одинаковых === 1, выбран.одинаковых);
  check('сказано, что такой уже есть', /уже есть/.test(await page.textContent('#toast-root').catch(() => '')));
  const всего = ((await зов('GET', '/api/suppliers')).data.items || []).filter(s => s.name.toLowerCase() === ('азия голд ' + М).toLowerCase());
  check('в базе — одна запись', всего.length === 1, всего.map(s => s.name));
  await снимок(page, { path: `${OUT}/поставщик.png` });
  await page.keyboard.press('Escape');

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
