'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Поиск по всей системе — одни правила в каждом разделе.
 *
 * Раньше каждый раздел искал буквально: «Алена» не находила «Алёну»,
 * «Садыкова Айжан» — «Айжан Садыкову», чек не находился по клиенту, заказ —
 * по телефону, журнал не понимал «анна» вместо «Анна». Здесь проверяем, что
 * человек находит то, что имел в виду, как бы он это ни набрал:
 *
 *   — регистр, «ё», кыргызские буквы, слова в любом порядке;
 *   — телефон в любом виде, артикул без чёрточек;
 *   — пусто — без окончаний («цепь» → «цепочка») и в другой раскладке;
 *   — поиск есть в клиентах, каталоге, чеках, заказах, финансах, старом
 *     золоте, долгах, журнале, инвентаризации и в общем поиске;
 *   — странный ввод («%», кавычки, очень длинная строка) ничего не ломает.
 */
const п = require('../src/поиск');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else {
    fail++; провалы.push(имя);
    const текст = доп !== null && typeof доп === 'object' ? JSON.stringify(доп) : String(доп);
    console.log('  FAIL ' + имя, доп === undefined ? '' : текст.slice(0, 300));
  }
};
// Метка прогона — отдельным словом: по ней находим только своё.
const М = 'пск' + process.pid;
const L = 'SR' + process.pid;            // артикулы латиницей, как у сканера
const хвост = String(process.pid).padStart(6, '0').slice(-6);
const ТЕЛЕФОН = `+996 709 ${хвост.slice(0, 2)}-${хвост.slice(2, 4)}-${хвост.slice(4)}`;

function сеанс() {
  let cookie = '';
  return {
    async войти(логин, пароль) {
      const r = await fetch(BASE + '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: логин, password: пароль }),
      });
      cookie = (r.headers.get('set-cookie') || '').split(';')[0];
      return r.status === 200;
    },
    async зов(метод, путь, тело) {
      const opts = { method: метод, headers: { Cookie: cookie } };
      if (тело !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(тело); }
      const r = await fetch(BASE + путь, opts);
      let data = null;
      try { data = await r.json(); } catch { /* пусто */ }
      return { status: r.status, data };
    },
  };
}

function правила() {
  console.log('=== 0. Правила (src/поиск.js) ===');
  const случаи = [
    ['алена', { поля: ['Алёна'] }, true],
    ['гулнара омурбекова', { поля: ['Гүлнара Өмүрбекова'] }, true],
    ['садыкова айжан', { поля: ['Айжан Садыкова'] }, true],
    ['айжан кольцо', { поля: ['Айжан Садыкова'] }, false],
    ['as00012', { поля: ['AS-00012'] }, true],
    ['AS 00012', { поля: ['AS-00012'] }, true],
    ['0709 12 34 56', { телефон: '+996 709 12-34-56' }, true],
    ['+996709123456', { телефон: '0709 123 456' }, true],
    ['123456', { телефон: '0709 12-34-56' }, true],
    ['айжан 3456', { поля: ['Айжан'], телефон: '0709 12-34-56' }, true],
    ['айжан 9999', { поля: ['Айжан'], телефон: '0709 12-34-56' }, false],
    // Буквы с цифрами — не телефон: «BULK-007» не должен находить номер с «007».
    ['BULK-007', { телефон: '0555 007 111' }, false],
    // В чеках телефон — от шести цифр: «3456» там скорее номер документа.
    ['3456', { телефон: '0709 12-34-56', минЦифр: 6 }, false],
  ];
  for (const [q, где, ждём] of случаи) {
    check(`«${q}» ${ждём ? 'находит' : 'не находит'} ${JSON.stringify(где)}`, п.совпадает(q, где) === ждём);
  }
  check('раскладка: «rjkmwj» — это «кольцо»', п.другаяРаскладка('rjkmwj') === 'кольцо');
  check('раскладка: «фы-00012» — это «as-00012»', п.другаяРаскладка('фы-00012') === 'as-00012');
  check('смесь букв не «исправляем»', п.другаяРаскладка('AS кольцо') === '');
  check('без окончаний: «цепь» → «цеп», «кольца» → «кольц»', п.безОкончаний('цепь кольца') === 'цеп кольц');
  check('«серёжки» — это «серьги» (словарь)', п.безОкончаний('серёжки') === 'серьг');
  check('номер и латиницу не режем', п.безОкончаний('AS-00012 585') === '');
}

async function main() {
  правила();

  const админ = сеанс();
  if (!await админ.войти('admin', 'admin123')) { console.error('Не удалось войти'); process.exit(2); }
  const анна = сеанс();
  await анна.войти('anna', 'seller123');
  const искать = async (путь, q, кто = админ) => (await кто.зов('GET', путь + (путь.includes('?') ? '&' : '?') +
    'search=' + encodeURIComponent(q))).data;

  // ---------- Данные прогона ----------
  await админ.зов('PUT', '/api/settings', { scrap_price_585: '4000' });
  const алёна = (await админ.зов('POST', '/api/customers', { name: `Алёна Садыкова ${М}`, phone: ТЕЛЕФОН })).data;
  const гүлнара = (await админ.зов('POST', '/api/customers', {
    name: `Гүлнара Өмүрбекова ${М}`, phone: `+996 559 ${хвост.slice(0, 3)} ${хвост.slice(3)}`, allow_duplicate: true,
  })).data;
  const изделие = async (sku, name, metal, fineness, price = 50000) => (await админ.зов('POST', '/api/products', {
    sku, name, metal, fineness, retail_price: price, purchase_price: price / 3,
  })).data;
  const кольцо = await изделие(`${L}-1`, `Кольцо «Звезда» ${М}`, 'Жёлтое золото', '585');
  const серьги = await изделие(`${L}-10`, `Серьги «Луна» ${М}`, 'Белое золото', '750');
  const цепь = await изделие(`${L}-2`, `Цепь «Якорная» ${М}`, 'Красное золото', '585', 30000);
  const заказЦепь = (await админ.зов('POST', '/api/orders', {
    type: 'repair', description: `Спаять порванную цепочку ${М}`, customer_id: алёна.id, estimate: 1500,
  })).data;
  const заказГрав = (await админ.зов('POST', '/api/orders', {
    type: 'engraving', description: `Надпись «Навсегда» ${М}`, customer_id: гүлнара.id, estimate: 2500,
  })).data;
  const чек = (await админ.зов('POST', '/api/sales', {
    items: [{ product_id: кольцо.id }], customer_id: алёна.id, payment_method: 'cash',
    scrap: [{ description: `старое кольцо ${М}`, fineness: 585, weight: '2,5' }],
  })).data;
  const акт = чек.scrap || {};
  check('подготовка: чек со старым золотом оформлен', Boolean(чек.id && акт.number), чек);
  await админ.зов('POST', '/api/sales', {
    items: [{ product_id: цепь.id }], customer_id: гүлнара.id, payment_method: 'installment',
    paid: 10000, due_date: '2030-01-01',
  });
  await админ.зов('POST', '/api/finance', { type: 'expense', category: 'Реклама', amount: 87654, note: `Листовки ${М}` });

  const ids = r => (r && r.items ? r.items : []).map(x => x.id);

  console.log('\n=== 1. Клиенты ===');
  check('«алена садыкова» находит «Алёну Садыкову» (ё)', ids(await искать('/api/customers', `алена садыкова ${М}`)).includes(алёна.id));
  check('слова в другом порядке', ids(await искать('/api/customers', `${М} садыкова алёна`)).includes(алёна.id));
  check('«гулнара омурбекова» находит «Гүлнару Өмүрбекову»', ids(await искать('/api/customers', `гулнара омурбекова ${М}`)).includes(гүлнара.id));
  const цифры = ТЕЛЕФОН.replace(/\D/g, '');         // 996709……
  for (const вид of [`0709 ${хвост.slice(0, 3)} ${хвост.slice(3)}`, `+${цифры}`, цифры.slice(3), `(0709) ${хвост}`, хвост]) {
    check(`телефон как «${вид}»`, ids(await искать('/api/customers', вид)).includes(алёна.id));
  }
  check('имя и кусок номера вместе', ids(await искать('/api/customers', `алена ${хвост.slice(-4)}`)).includes(алёна.id));
  check('«садыковой» (другое окончание) — тоже находит', ids(await искать('/api/customers', `садыковой ${М}`)).includes(алёна.id));
  const латиницей = п.другаяРаскладка(`садыкова ${М}`);
  let r = await искать('/api/customers', латиницей);
  check(`набрали в английской раскладке («${латиницей}») — нашли и сказали, по чему`,
    ids(r).includes(алёна.id) && r.раскладка === `садыкова ${М}`, { раскладка: r.раскладка, n: ids(r).length });
  check('продавец ищет клиентов так же', ids(await искать('/api/customers', `алена ${М}`, анна)).includes(алёна.id));

  console.log('\n=== 2. Каталог ===');
  r = await искать('/api/products', `${L}-1`);
  check('точный артикул — первым, выше похожего «…-10»', r.items[0] && r.items[0].id === кольцо.id && ids(r).includes(серьги.id), ids(r));
  r = await искать('/api/products', `${L} 1`);
  check('артикул с пробелом вместо чёрточки — первым', r.items[0] && r.items[0].id === кольцо.id, r.items.map(x => x.sku));
  check('артикул без чёрточки', ids(await искать('/api/products', `${L}1`.toLowerCase())).includes(кольцо.id));
  check('«желтое 585» — по металлу и пробе', JSON.stringify(ids(await искать('/api/products', `желтое 585 ${М}`))) === JSON.stringify([кольцо.id]));
  check('«серьги белое»', JSON.stringify(ids(await искать('/api/products', `серьги белое ${М}`))) === JSON.stringify([серьги.id]));
  check('«кольца» находит «Кольцо» (без окончаний)', ids(await искать('/api/products', `кольца ${М}`)).includes(кольцо.id));
  check('«серёжки» находит «Серьги»', ids(await искать('/api/products', `серёжки ${М}`)).includes(серьги.id));
  const поРусски = п.другаяРаскладка(`${L}-1`);
  r = await искать('/api/products', поРусски);
  check(`артикул в русской раскладке («${поРусски}») — первым, с пометкой`,
    r.items[0] && r.items[0].id === кольцо.id && r.раскладка === `${L}-1`.toLowerCase(), { раскладка: r.раскладка });
  r = await искать('/api/products', `звезда ${М}`, анна);
  check('продавцу поиск — тоже, но без закупочной', ids(r).includes(кольцо.id) && r.items[0].purchase_price === undefined, r.items[0]);

  console.log('\n=== 3. Чеки ===');
  check('по имени клиента', ids(await искать('/api/sales', `алена ${М}`)).includes(чек.id));
  check('по телефону клиента', ids(await искать('/api/sales', `0709 ${хвост}`)).includes(чек.id));
  check('по номеру акта старого золота', ids(await искать('/api/sales', акт.number)).includes(чек.id));
  check('по изделию', ids(await искать('/api/sales', `звезда ${М}`)).includes(чек.id));
  check('по номеру чека', ids(await искать('/api/sales', чек.number)).includes(чек.id));

  console.log('\n=== 3б. Большие и маленькие буквы — всё равно ===');
  /*
   * Владелец: «чтобы было неважно, большая или маленькая буква в поиске».
   * Телефон сам ставит заглавную в начале, кто-то пишет капсом — поиск
   * одинаково находит в каждом разделе.
   */
  const мал = М.toLowerCase(), БОЛ = М.toUpperCase();
  for (const [где, путь, q, id] of [
    ['каталог', '/api/products', `ЗВЕЗДА ${БОЛ}`, кольцо.id],
    ['каталог', '/api/products', `звезда ${мал}`, кольцо.id],
    ['каталог', '/api/products', `Звезда ${М}`, кольцо.id],
    ['клиенты', '/api/customers', `АЛЁНА САДЫКОВА ${БОЛ}`, алёна.id],
    ['клиенты', '/api/customers', `алёна ${мал}`, алёна.id],
    ['чеки', '/api/sales', `АЛЕНА ${БОЛ}`, чек.id],
    ['заказы', '/api/orders', `ЦЕПОЧКУ ${БОЛ}`, заказЦепь.id],
  ]) {
    const найдено = ids(await искать(путь, q));
    check(`${где}: «${q}»`, найдено.includes(id), найдено.length);
  }
  const вОбщем = async q => JSON.stringify((await админ.зов('GET', '/api/search?q=' + encodeURIComponent(q))).data);
  check('общий поиск: «ЗВЕЗДА» и «звезда» находят одно и то же изделие',
    (await вОбщем(`ЗВЕЗДА ${БОЛ}`)).includes(`${L}-1`) && (await вОбщем(`звезда ${мал}`)).includes(`${L}-1`));

  console.log('\n=== 4. Заказы и ремонт ===');
  check('по хвосту телефона — «номер на 3456»', ids(await искать('/api/orders', хвост.slice(-4))).includes(заказЦепь.id));
  check('по виду работ: «гравировка»', ids(await искать('/api/orders', `гравировка ${М}`)).includes(заказГрав.id));
  check('«цепь» находит «цепочку»', ids(await искать('/api/orders', `цепь ${М}`)).includes(заказЦепь.id));
  check('по клиенту: «ремонт садыкова»', JSON.stringify(ids(await искать('/api/orders', `ремонт садыкова ${М}`))) === JSON.stringify([заказЦепь.id]));

  console.log('\n=== 5. Финансы ===');
  r = await искать('/api/finance', `листовки ${М}`);
  check('по описанию — и итог по найденному', r.items.length === 1 && r.totals.expense === 87654, r.totals);
  check('по сумме с пробелом: «87 654»', (await искать('/api/finance', '87 654')).items.some(x => x.note === `Листовки ${М}`));
  check('продавцу финансы закрыты и с поиском', (await анна.зов('GET', '/api/finance?search=' + encodeURIComponent(М))).status === 403);

  console.log('\n=== 6. Старое золото ===');
  const всё = (await админ.зов('GET', '/api/scrap')).data;
  r = await искать('/api/scrap', акт.number);
  check('по номеру акта', ids(r).length === 1 && r.items[0].number === акт.number, ids(r));
  check('склад по пробам от поиска не меняется', JSON.stringify(r.stock) === JSON.stringify(всё.stock));
  check('по клиенту', ids(await искать('/api/scrap', `алена ${М}`)).includes(акт.id));
  check('по тому, что принесли: «кольцо 585»', ids(await искать('/api/scrap', `кольцо 585 ${М}`)).includes(акт.id));
  check('по телефону клиента', ids(await искать('/api/scrap', `0709 ${хвост}`)).includes(акт.id));

  console.log('\n=== 7. Долги ===');
  const долги = async q => (await админ.зов('GET', '/api/debts/customers?search=' + encodeURIComponent(q))).data.items
    .map(i => i.customer_id);
  check('должник по имени без кыргызских букв', (await долги(`гулнара ${М}`)).includes(гүлнара.id));
  check('должник по телефону в другом виде', (await долги(`0559${хвост}`)).includes(гүлнара.id));
  check('должник, набранный в английской раскладке', (await долги(п.другаяРаскладка(`гулнара ${М}`))).includes(гүлнара.id));

  console.log('\n=== 8. Журнал действий ===');
  const журнал = async q => (await админ.зов('GET', '/api/audit?search=' + encodeURIComponent(q))).data.total;
  const сБольшой = await журнал('Администратор');
  check('«администратор» с маленькой находит то же, что с большой', сБольшой > 0 && await журнал('администратор') === сБольшой,
    [сБольшой, await журнал('администратор')]);
  check('по номеру чека', (await журнал(чек.number)) > 0);

  console.log('\n=== 9. Общий поиск ===');
  const общий = async q => (await админ.зов('GET', '/api/search?q=' + encodeURIComponent(q))).data;
  let g = await общий(`алена садыкова ${М}`);
  const группа = (d, k) => ((d.groups || []).find(x => x.key === k) || { items: [] }).items;
  check('клиентка, её чек, заказ и акт — всё сразу',
    группа(g, 'customers').some(x => x.id === алёна.id) && группа(g, 'sales').some(x => x.id === чек.id)
    && группа(g, 'orders').some(x => x.id === заказЦепь.id) && группа(g, 'scrap').some(x => x.id === акт.id),
    (g.groups || []).map(x => x.key + ':' + x.items.length));
  g = await общий(акт.number);
  const найденАкт = группа(g, 'scrap')[0];
  check('акт старого золота — отдельной строкой, ведёт в чек', найденАкт && найденАкт.sale_id === чек.id
    && /старое кольцо/.test(найденАкт.what), найденАкт);
  g = await общий(`0709 ${хвост}`);
  check('по телефону: и клиентка, и её заказ', группа(g, 'customers').some(x => x.id === алёна.id)
    && группа(g, 'orders').some(x => x.id === заказЦепь.id), (g.groups || []).map(x => x.key));
  g = await общий('BULK-007' + process.pid);
  check('буквы с цифрами не ищут по телефону', !группа(g, 'customers').length);
  g = await общий(п.другаяРаскладка(`звезда ${М}`));
  check('не та раскладка: нашли и сказали, по чему', группа(g, 'products').some(x => x.id === кольцо.id)
    && g.раскладка === `звезда ${М}`, { раскладка: g.раскладка });

  console.log('\n=== 10. Инвентаризация: сканер в русской раскладке ===');
  const точка = (await админ.зов('POST', '/api/stores', { name: `Точка ${М}` })).data;
  const пересчёт = (await админ.зов('POST', '/api/inventory', { store_id: точка.id })).data;
  const инв = пересчёт.session || пересчёт;
  r = await админ.зов('POST', `/api/inventory/${инв.id}/scan`, { code: п.другаяРаскладка(`${L}-2`).toUpperCase() });
  check(`«${п.другаяРаскладка(`${L}-2`).toUpperCase()}» — это ${L}-2`, r.status === 200 && r.data.product && r.data.product.id === цепь.id, r.data);
  await админ.зов('POST', `/api/inventory/${инв.id}/finish`, {});
  await админ.зов('DELETE', `/api/stores/${точка.id}`);

  console.log('\n=== 11. Странный ввод ничего не ломает ===');
  const странное = ['%', '_', "'", '"', '\\', '%%%', "'; DROP TABLE sales; --", '😀💍', 'а'.repeat(500), '   ', '+', '()-.'];
  const пути = ['/api/products', '/api/customers', '/api/sales', '/api/orders', '/api/finance', '/api/scrap', '/api/audit', '/api/debts/customers'];
  let всеЦелы = true;
  const сбои = [];
  for (const s of странное) {
    for (const путь of пути) {
      const x = await админ.зов('GET', путь + '?search=' + encodeURIComponent(s));
      if (x.status !== 200) { всеЦелы = false; сбои.push(`${путь} «${s.slice(0, 10)}» → ${x.status}`); }
    }
    const x = await админ.зов('GET', '/api/search?q=' + encodeURIComponent(s));
    if (x.status !== 200) { всеЦелы = false; сбои.push(`/api/search «${s.slice(0, 10)}» → ${x.status}`); }
  }
  check('«%», кавычки, смайлы, длинная строка — везде ответ, а не ошибка', всеЦелы, сбои.join('; '));
  check('«%» не находит всё подряд', ((await искать('/api/products', '%')).total || 0) === 0);
  check('таблица чеков на месте', (await админ.зов('GET', '/api/sales?limit=1')).status === 200);

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
