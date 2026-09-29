'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Поиск глазами продавца и владельца — в каждом разделе.
 *
 * Поле поиска теперь есть и в заказах, и в финансах. Везде одни правила: слова в любом порядке, «ё», окончания,
 * не та раскладка — с подписью «найдено по …». Найденное подсвечено.
 * Старый чек при периоде «30 дней» не теряется: система ищет за всё время
 * и говорит об этом. Касса понимает артикул, набранный в русской раскладке.
 */
const п = require('../src/поиск');
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-поиск';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 300)); }
};
const М = 'пуи' + process.pid;
const L = 'SU' + process.pid;
const хвост = String(process.pid).padStart(6, '0').slice(-6);
const ТЕЛЕФОН = `+996 708 ${хвост.slice(0, 2)}-${хвост.slice(2, 4)}-${хвост.slice(4)}`;
const чисто = t => String(t || '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ');

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

// Перейти в раздел: сначала на Главную — тот же адрес второй раз страницу не перерисовывает.
async function раздел(page, hash, селектор) {
  await page.goto(BASE + '/#/dashboard');
  await page.waitForTimeout(300);
  await page.goto(BASE + '/#/' + hash);
  await page.waitForSelector(селектор, { timeout: 15000 });
}

async function набрать(page, селектор, текст, ждать = 1100) {
  await page.fill(селектор, '');
  await page.fill(селектор, текст);
  await page.waitForTimeout(ждать);
}

(async () => {
  const вход = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  cookie = (вход.headers.get('set-cookie') || '').split(';')[0];

  // ---------- Данные ----------
  await зов('PUT', '/api/settings', { scrap_price_585: '4000' });
  const алёна = (await зов('POST', '/api/customers', { name: `Алёна Мамытова ${М}`, phone: ТЕЛЕФОН })).data;
  const гүлнара = (await зов('POST', '/api/customers', { name: `Гүлнара Асанова ${М}`, phone: `+996 557 ${хвост}` })).data;
  const изделие = async (sku, name, metal, fineness, price = 40000) => (await зов('POST', '/api/products', {
    sku, name, metal, fineness, retail_price: price, purchase_price: price / 3,
  })).data;
  const кольцо = await изделие(`${L}-1`, `Кольцо «Звезда» ${М}`, 'Жёлтое золото', '585');
  const серьги = await изделие(`${L}-2`, `Серьги «Весна» ${М}`, 'Белое золото', '750');
  const подвеска = await изделие(`${L}-3`, `Подвеска «Весна» ${М}`, 'Белое золото', '750');
  const цепь = await изделие(`${L}-4`, `Цепь «Якорная» ${М}`, 'Красное золото', '585', 25000);
  const дляКассы = await изделие(`${L}-5`, `Браслет «Касса» ${М}`, 'Жёлтое золото', '585', 20000);
  const мастерская = (await зов('POST', '/api/suppliers', { name: `Мастерская ${М}` })).data;
  await зов('POST', '/api/products', {
    sku: `${L}-6`, name: `Кулон «Реализация» ${М}`, metal: 'Белое золото', fineness: '750',
    retail_price: 30000, purchase_price: 20000, ownership: 'consignment', supplier_id: мастерская.id,
  });
  const заказ = (await зов('POST', '/api/orders', {
    type: 'repair', description: `Спаять порванную цепочку ${М}`, customer_id: алёна.id, estimate: 1500,
  })).data;
  const чек = (await зов('POST', '/api/sales', {
    items: [{ product_id: кольцо.id }], customer_id: алёна.id, payment_method: 'cash',
    scrap: [{ description: `старое кольцо ${М}`, fineness: 585, weight: '3' }],
  })).data;
  await зов('POST', '/api/sales', {
    items: [{ product_id: цепь.id }], customer_id: гүлнара.id, payment_method: 'installment', paid: 5000, due_date: '2030-01-01',
  });
  await зов('POST', '/api/finance', { type: 'expense', category: 'Реклама', amount: 76543, note: `Листовки ${М}` });
  const комплект = (await зов('POST', '/api/sets', {
    name: `Гарнитур «Весна» ${М}`, price: 70000, product_ids: [серьги.id, подвеска.id],
  })).data;
  check('подготовка: данные заведены', Boolean(алёна.id && чек.id && чек.scrap && комплект.id && заказ.id),
    JSON.stringify({ a: алёна.id, чек: чек.id, акт: чек.scrap && чек.scrap.number, комплект: комплект.id }));

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await ctx.newPage();
  const ошибки = [];
  page.on('pageerror', e => ошибки.push(e.message));
  await войти(page, 'admin', 'admin123');

  console.log('=== 1. Правила на экране — те же, что на сервере ===');
  const случаи = [
    ['алена', { поля: ['Алёна'] }], ['гулнара асанова', { поля: ['Гүлнара Асанова'] }],
    ['асанова гулнара', { поля: ['Гүлнара Асанова'] }], ['кольцо айжан', { поля: ['Айжан'] }],
    ['as00012', { поля: ['AS-00012'] }], ['0708 12 34 56', { телефон: '+996 708 12-34-56' }],
    ['айжан 3456', { поля: ['Айжан'], телефон: '0708 12-34-56' }], ['BULK-007', { телефон: '0555 007 111' }],
    ['3456', { телефон: '0708 12-34-56', минЦифр: 6 }],
  ];
  const наСервере = случаи.map(([q, где]) => п.совпадает(q, где));
  const наЭкране = await page.evaluate(с => с.map(([q, где]) => ui.поиск.совпадает(q, где)), случаи);
  check('совпадает: экран и сервер отвечают одинаково', JSON.stringify(наСервере) === JSON.stringify(наЭкране),
    JSON.stringify({ наСервере, наЭкране }));
  const запросы = ['rjkmwj', 'серёжки', 'цепь кольца', 'фы-00012', 'AS-00012', 'кулон'];
  const ходыСервер = запросы.map(q => п.запасныеХоды(q));
  const ходыЭкран = await page.evaluate(q => q.map(x => ui.поиск.запасныеХоды(x)), запросы);
  check('запасные ходы (окончания, раскладка) — те же', JSON.stringify(ходыСервер) === JSON.stringify(ходыЭкран));

  console.log('\n=== 2. Заказы: поиск над доской ===');
  await раздел(page, 'orders', '#of-search');
  await набрать(page, '#of-search', хвост.slice(-4));
  let доска = чисто(await page.innerText('#orders-kanban'));
  check('по хвосту телефона — заказ на доске', доска.includes(заказ.number), доска.slice(0, 200));
  await набрать(page, '#of-search', `цепь ${М}`);
  доска = чисто(await page.innerText('#orders-kanban'));
  check('«цепь» находит «цепочку», и только её', доска.includes(заказ.number) && (await page.$$('.kanban-card')).length === 1,
    (await page.$$('.kanban-card')).length);
  check('над доской — «Найдено заказов: 1»', /Найдено заказов: 1/.test(await page.innerText('#orders-note')));
  check('найденное подсвечено — «цеп» в «цепочку»', /^цеп$/i.test(await page.$eval('#orders-kanban mark', m => m.textContent).catch(() => '')));
  await снимок(page, { path: `${OUT}/заказы.png` });
  await набрать(page, '#of-search', `нет такого ${М}`);
  check('ничего — так и сказано', /заказов не нашлось/.test(await page.innerText('#orders-note')));
  await набрать(page, '#of-search', '');
  check('очистили — доска снова полная', (await page.$$('.kanban-card')).length > 1);

  console.log('\n=== 3. Финансы: поиск операций ===');
  await раздел(page, 'finance', '#ff-search');
  await набрать(page, '#ff-search', `листовки ${М}`);
  let финансы = чисто(await page.innerText('#fin-body'));
  check('нашли операцию, итог — по найденному', /Листовки/.test(финансы) && /Расход\s*76 543/.test(финансы), финансы.slice(0, 300));
  // Старая операция: её суммы нет за последние 30 дней.
  const месяцНазад = new Date(Date.now() - 32 * 86400000).toISOString();
  const старые = (await зов('GET', '/api/finance?to=' + encodeURIComponent(месяцНазад))).data.items || [];
  const свежие = (await зов('GET', '/api/finance?from=' + encodeURIComponent(new Date(Date.now() - 31 * 86400000).toISOString()))).data.items || [];
  const старая = старые.find(o => !свежие.some(x => Math.abs(x.amount - o.amount) < 0.01) && o.amount >= 1000);
  if (старая) {
    await набрать(page, '#ff-search', String(Math.round(старая.amount)));
    финансы = чисто(await page.innerText('#fin-body'));
    check('старая операция при «30 днях» — найдена за всё время, с пометкой',
      /показано за всё время/.test(финансы) && финансы.includes(старая.category), финансы.slice(0, 200));
  } else console.log('  (старых операций в демо-данных нет — проверку «за всё время» пропускаем)');
  await набрать(page, '#ff-search', '');

  console.log('\n=== 6. Долги ===');
  await раздел(page, 'debts', '#d-search');
  await набрать(page, '#d-search', `гулнара ${М}`, 600);
  check('«гулнара» находит «Гүлнару»', чисто(await page.innerText('#d-list')).includes(`Гүлнара Асанова ${М}`));
  await набрать(page, '#d-search', `0557 ${хвост.slice(0, 3)} ${хвост.slice(3)}`, 600);
  check('по телефону в другом виде', чисто(await page.innerText('#d-list')).includes(`Гүлнара Асанова ${М}`));

  console.log('\n=== 6а. Долги → «На реализации» ===');
  await page.click('.tab[data-tab=consignment]');
  await page.waitForSelector('#cn-search');
  await набрать(page, '#cn-search', `мастерская ${М}`, 500);
  let реализация = чисто(await page.innerText('#cn-body'));
  check('чужой товар по владельцу', реализация.includes(`${L}-6`), реализация.slice(0, 200));
  await набрать(page, '#cn-search', `${L}-6`.toLowerCase().replace('-', ''), 500);
  check('по артикулу без чёрточки', чисто(await page.innerText('#cn-body')).includes(`Кулон «Реализация» ${М}`));
  await набрать(page, '#cn-search', `нет такого ${М}`, 500);
  check('пусто — так и сказано', /на витрине ничего нет/.test(await page.innerText('#cn-body')));
  await набрать(page, '#cn-search', '', 300);

  console.log('\n=== 7. Продажи: клиент и старый чек ===');
  await раздел(page, 'sales', '#sf-search');
  await набрать(page, '#sf-search', `алена ${М}`);
  let продажи = чисто(await page.innerText('#sales-list'));
  check('чек по имени клиентки', продажи.includes(чек.number), продажи.slice(0, 200));
  check('имя в списке подсвечено', Boolean(await page.$('#sales-list mark')));
  const стариеЧеки = (await зов('GET', '/api/sales?limit=50&to=' + encodeURIComponent(месяцНазад))).data.items || [];
  if (стариеЧеки.length) {
    await набрать(page, '#sf-search', стариеЧеки[0].number);
    продажи = чисто(await page.innerText('#sales-list'));
    check(`старый чек ${стариеЧеки[0].number} при «30 днях» — найден, с пометкой`,
      продажи.includes(стариеЧеки[0].number) && /показано за всё время/.test(продажи), продажи.slice(0, 200));
  } else console.log('  (старых чеков в демо-данных нет — проверку «за всё время» пропускаем)');

  console.log('\n=== 8. Каталог: слова, подсветка, раскладка ===');
  await раздел(page, 'products', '#pf-search');
  await набрать(page, '#pf-search', `желтое 585 браслет ${М}`);
  let каталог = чисто(await page.innerText('#prod-list'));
  check('«желтое 585 браслет» — одно изделие', /Найдено: 1/.test(каталог) && каталог.includes('Браслет «Касса»'), каталог.slice(0, 200));
  await набрать(page, '#pf-search', п.другаяРаскладка(`браслет ${М}`));
  каталог = чисто(await page.innerText('#prod-list'));
  check('набрали латиницей — нашли и подписали у поля', каталог.includes('Браслет «Касса»')
    && /найдено по «браслет/.test(await page.textContent('.search-fix').catch(() => '')));
  check('подсвечено исправленное слово', /^браслет$/i.test(await page.$eval('#prod-list mark', m => m.textContent).catch(() => '')));
  await снимок(page, { path: `${OUT}/каталог-раскладка.png` });
  await набрать(page, '#pf-search', `нет такого ${М}`);
  check('пусто — сказано, по чему искали', /По запросу «нет такого/.test(await page.innerText('#prod-list')));

  console.log('\n=== 9. Общий поиск: акт старого золота и раскладка ===');
  await page.goto(BASE + '/#/dashboard');
  await page.waitForTimeout(300);
  await набрать(page, '#gs-input', чек.scrap.number, 1200);
  let общий = await page.innerText('#gs-results');
  check('группа «Старое золото» в общем поиске', /СТАРОЕ ЗОЛОТО/i.test(общий) && общий.includes(чек.scrap.number), общий.slice(0, 200));
  const строкаАкта = await page.$$eval('#gs-results .gs-item', (els, номер) =>
    els.findIndex(e => e.textContent.includes(номер) && /г ·|г$/.test(e.textContent)), чек.scrap.number);
  const акты = await page.$$('#gs-results .gs-item');
  if (строкаАкта >= 0) await акты[строкаАкта].dispatchEvent('mousedown');
  await page.waitForTimeout(1500);
  check('выбор акта открывает его чек', (await page.evaluate(() => location.hash)) === '#/sales/' + чек.id,
    await page.evaluate(() => location.hash));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await набрать(page, '#gs-input', п.другаяРаскладка(`звезда ${М}`), 1200);
  общий = await page.innerText('#gs-results');
  check('не та раскладка: «показано по …»', /показано по «звезда/.test(общий) && /ИЗДЕЛИЯ/i.test(общий), общий.slice(0, 200));
  await page.keyboard.press('Escape');

  console.log('\n=== 10. Касса: артикул в русской раскладке + Enter ===');
  await page.click('#btn-quick-sale');
  await page.waitForSelector('#pos-search');
  const поРусски = п.другаяРаскладка(`${L}-5`).toUpperCase();
  await page.fill('#pos-search', поРусски);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  check(`«${поРусски}» + Enter — браслет в чеке`, чисто(await page.innerText('#pos-items').catch(() => '')).includes('Браслет «Касса»'),
    чисто(await page.innerText('#pos-items').catch(() => '')).slice(0, 200));

  console.log('\n=== 11. На телефоне поле поиска не ломает раскладку ===');
  const тел = await (await browser.newContext({ viewport: { width: 375, height: 800 } })).newPage();
  тел.on('pageerror', e => ошибки.push(e.message));
  await войти(тел, 'admin', 'admin123');
  for (const [hash, сел] of [['orders', '#of-search'], ['finance', '#ff-search']]) {
    await раздел(тел, hash, сел);
    const ширина = await тел.evaluate(() => document.documentElement.scrollWidth);
    check(`#/${hash}: не шире экрана и поле видно`, ширина <= 375 && await тел.isVisible(сел), ширина);
  }
  await раздел(тел, 'orders', '#of-search');
  await снимок(тел, { path: `${OUT}/заказы-телефон.png` });

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
