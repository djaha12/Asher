'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Анкета без «Наименования» и «Чей товар»: название — по категории.
 *
 * Владелец: «можно убрать наименование и чей товар». Изделие узнают по
 * артикулу, фото и весу, а каталогу, чеку и бирке нужно имя — его ставит
 * категория: «Кольцо», «Серьги», «Буквенная подвеска»; без категории —
 * «Изделие». Сменили категорию — сменилось и такое название. Название,
 * вписанное раньше руками, не трогаем. «Чей товар» в анкете не спрашиваем:
 * новое изделие — наше, а принятое на реализацию таким и остаётся.
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-название';
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
const МЕТКА = 'НАЗ' + process.pid.toString(36).toUpperCase();

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
const изделие = async id => (await зов('GET', '/api/products/' + id)).data;
const поАртикулу = async sku => ((await зов('GET', '/api/products?search=' + encodeURIComponent(sku))).data.items || [])
  .find(x => x.sku === sku);

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
  const категории = (await зов('GET', '/api/categories')).data.items;
  const кат = имя => категории.find(к => к.name === имя);

  const browser = await chromium.launch();
  const ошибки = [];
  const page = await (await browser.newContext(ТЕЛЕФОН)).newPage();
  page.on('pageerror', e => ошибки.push(e.message));
  await войти(page, 'admin', 'admin123');

  const открытьАнкету = async () => {
    await page.goto(BASE + '/#/dashboard');
    await page.waitForTimeout(300);
    await page.goto(BASE + '/#/products');
    await page.waitForSelector('#pf-add');
    await page.click('#pf-add');
    await page.waitForSelector('#prod-form');
    await page.waitForTimeout(400);
  };
  // Завести через анкету: артикул и категория — больше ничего.
  const завести = async (хвост, категория) => {
    await открытьАнкету();
    await page.fill('#prod-form [name=sku]', `${МЕТКА}-${хвост}`);
    if (категория) await page.selectOption('#prod-form [name=category_id]', String(кат(категория).id));
    await page.click(`${ВЕРХ} [data-act=save]`);
    await page.waitForSelector(`${ВЕРХ} #prod-gallery`, { timeout: 10000 }).catch(() => {});
    const заголовок = (await page.textContent(`${ВЕРХ} .modal-head h2`).catch(() => '')).trim();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    return { p: await поАртикулу(`${МЕТКА}-${хвост}`), заголовок };
  };
  const правка = async (id, что) => {
    await page.goto(BASE + '/#/dashboard');
    await page.waitForTimeout(300);
    await page.goto(BASE + '/#/products/' + id);
    await page.waitForSelector(`${ВЕРХ} [data-act=edit]`);
    await page.click(`${ВЕРХ} [data-act=edit]`);
    await page.waitForSelector('#prod-form');
    await что();
    await page.click(`${ВЕРХ} [data-act=save]`);
    await page.waitForTimeout(1200);
    return изделие(id);
  };

  console.log('=== 1. В анкете нет «Наименования» и «Чей товар» ===');
  await открытьАнкету();
  check('поля «Наименование» нет', !(await page.$('#prod-form [name=name]')) && !/Наименование/.test(await page.textContent('#prod-form')));
  check('поля «Чей товар» нет', !(await page.$('#prod-form [name=ownership]')) && !/Чей товар/.test(await page.textContent('#prod-form')));
  check('подсказка говорит, откуда название', /Название — по категории/.test(await page.textContent('#prod-form .form-hint')));
  await снимок(page, { path: `${OUT}/анкета.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  console.log('\n=== 2. Название — по категории ===');
  const кольцо = await завести('К', 'Кольца');
  check('«Кольца» → «Кольцо», и в заголовке карточки', кольцо.p && кольцо.p.name === 'Кольцо' && кольцо.заголовок === 'Кольцо',
    кольцо.p && [кольцо.p.name, кольцо.заголовок]);
  check('новое изделие — наше', кольцо.p && кольцо.p.ownership === 'own', кольцо.p && кольцо.p.ownership);
  const серьги = await завести('С', 'Серьги');
  check('«Серьги» → «Серьги»', серьги.p && серьги.p.name === 'Серьги', серьги.p && серьги.p.name);
  if (кат('Буквенные подвески')) {
    const буква = await завести('Б', 'Буквенные подвески');
    check('«Буквенные подвески» → «Буквенная подвеска»', буква.p && буква.p.name === 'Буквенная подвеска', буква.p && буква.p.name);
  }
  const безКатегории = await завести('Н', null);
  check('без категории — «Изделие», не «Без названия»', безКатегории.p && безКатегории.p.name === 'Изделие',
    безКатегории.p && безКатегории.p.name);

  console.log('\n=== 3. Сменили категорию — название за ней; своё — не трогаем ===');
  const подвеска = await правка(кольцо.p.id, () => page.selectOption('#prod-form [name=category_id]', String(кат('Подвески').id)));
  check('«Кольцо» перевели в «Подвески» — стало «Подвеска»', подвеска.name === 'Подвеска', подвеска.name);
  const своё = (await зов('POST', '/api/products',
    { sku: МЕТКА + '-СВ', name: 'Кольцо «Сияние»', category_id: кат('Кольца').id, retail_price: 50000 })).data.id;
  const послеСвоего = await правка(своё, () => page.selectOption('#prod-form [name=category_id]', String(кат('Серьги').id)));
  check('вписанное раньше название осталось, категория сменилась',
    послеСвоего.name === 'Кольцо «Сияние»' && послеСвоего.category_id === кат('Серьги').id, [послеСвоего.name, послеСвоего.category_id]);
  const безНазвания = (await зов('POST', '/api/products', { sku: МЕТКА + '-БН' })).data.id;
  check('заведённое без названия (не из анкеты) — «Без названия»', (await изделие(безНазвания)).name === 'Без названия');
  const названо = await правка(безНазвания, () => page.selectOption('#prod-form [name=category_id]', String(кат('Кольца').id)));
  check('выбрали категорию в анкете — стало «Кольцо»', названо.name === 'Кольцо', названо.name);

  console.log('\n=== 4. Принятое на реализацию так и остаётся ===');
  const поставщик = ((await зов('GET', '/api/suppliers')).data.items || [])[0];
  const чужое = (await зов('POST', '/api/products', { sku: МЕТКА + '-Р', name: 'Серьги «Чужие»',
    ownership: 'consignment', supplier_id: поставщик.id, retail_price: 70000 })).data.id;
  const послеПравки = await правка(чужое, () => page.fill('#prod-form [name=weight]', '2.5'));
  check('поправили вес — товар по-прежнему на реализации и с тем же названием',
    послеПравки.ownership === 'consignment' && послеПравки.weight === 2.5 && послеПравки.name === 'Серьги «Чужие»',
    [послеПравки.ownership, послеПравки.weight, послеПравки.name]);

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
