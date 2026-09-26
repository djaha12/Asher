'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Изделие можно завести, не заполнив ничего, и дописать потом.
 *
 * Товар пришёл — его надо положить на витрину сейчас, а вес, камни и цену
 * дописать, когда будет время. Раньше без артикула и названия карточка не
 * сохранялась. Теперь:
 *   — пустая карточка сохраняется; артикул выдаётся следующий по порядку,
 *     название — «Без названия»;
 *   — такие изделия собирает фильтр «Не заполнены»; заполнили — ушли из него;
 *   — без цены изделие не продаётся: за ноль оно из кассы не уйдёт;
 *   — стереть артикул у заведённого изделия нельзя;
 *   — в приёмке тоже ничего не обязательно; долг поставщику складывается
 *     из указанных закупочных, строка без закупки в него не входит;
 *   — изделие без закупки владелец находит в «Не заполнены».
 */
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

async function main() {
  const админ = сеанс();
  if (!await админ.войти('admin', 'admin123')) { console.error('Не удалось войти'); process.exit(2); }
  const анна = сеанс();
  await анна.войти('anna', 'seller123');
  const незаполненные = async () => ((await админ.зов('GET', '/api/products?incomplete=1&limit=2000')).data.items || [])
    .map(p => p.id);

  console.log('=== 1. Пустая карточка сохраняется ===');
  const подсказка = (await админ.зов('GET', '/api/products/next-sku')).data.sku;
  check('сервер подсказывает следующий артикул', typeof подсказка === 'string' && подсказка.length > 0, подсказка);
  let r = await админ.зов('POST', '/api/products', {});
  check('изделие без единого поля заведено', r.status === 200 && r.data.id, r.data);
  const первое = (await админ.зов('GET', '/api/products/' + r.data.id)).data;
  check('артикул — тот, что подсказывали', первое.sku === подсказка, [первое.sku, подсказка]);
  check('название — «Без названия», цена 0, на витрине', первое.name === 'Без названия'
    && первое.retail_price === 0 && первое.status === 'in_stock', первое);
  r = await админ.зов('POST', '/api/products', { name: '  ', sku: '' });
  const второе = (await админ.зов('GET', '/api/products/' + r.data.id)).data;
  check('следующее пустое — следующий артикул, не тот же', r.status === 200 && второе.sku !== первое.sku
    && /\d+$/.test(второе.sku), [первое.sku, второе.sku]);
  r = await анна.зов('POST', '/api/products', { metal: 'Золото' });
  check('продавец тоже может завести, не заполняя', r.status === 200 && r.data.id, r.data);
  const отАнны = r.data.id;

  console.log('\n=== 2. «Не заполнены» ===');
  let список = await незаполненные();
  check('все три — в «Не заполнены»', [первое.id, второе.id, отАнны].every(id => список.includes(id)), список.length);
  r = await админ.зов('PUT', '/api/products/' + первое.id, {
    name: 'Кольцо «Дописали потом»', retail_price: 45000, purchase_price: 30000, metal: 'Белое золото', weight: 3.2,
  });
  check('дописали название, цены, металл и вес', r.status === 200, r.data);
  список = await незаполненные();
  check('заполненное ушло из «Не заполнены»', !список.includes(первое.id) && список.includes(второе.id));
  r = await админ.зов('PUT', '/api/products/' + второе.id, { sku: '' });
  check('стереть артикул нельзя — понятный отказ', r.status === 400 && /стереть/.test(r.data.error), r.data);
  r = await админ.зов('PUT', '/api/products/' + первое.id, { name: '' });
  check('стёртое название снова «Без названия»',
    (await админ.зов('GET', '/api/products/' + первое.id)).data.name === 'Без названия');
  await админ.зов('PUT', '/api/products/' + первое.id, { name: 'Кольцо «Дописали потом»' });
  const поАртикулу = (await админ.зов('GET', '/api/products?search=' + encodeURIComponent(второе.sku))).data.items;
  check('выданный артикул ищется, как обычный', поАртикулу.length && поАртикулу[0].id === второе.id);

  console.log('\n=== 3. Без цены не продаётся ===');
  r = await анна.зов('POST', '/api/sales', { items: [{ product_id: второе.id }], payment_method: 'cash' });
  check('продажа изделия без цены — отказ с объяснением', r.status === 400 && /не указана цена/.test(r.data.error), r.data);
  check('и оно по-прежнему на витрине', (await админ.зов('GET', '/api/products/' + второе.id)).data.status === 'in_stock');
  r = await анна.зов('POST', '/api/sales', { items: [{ product_id: первое.id }], payment_method: 'cash' });
  check('с ценой — продаётся как обычно', r.status === 200 && r.data.total === 45000, r.data);

  console.log('\n=== 4. Приёмка: обязательных полей нет ===');
  const поставщик = (await админ.зов('POST', '/api/suppliers', { name: 'Поставщик черновиков ' + process.pid })).data.id;
  const долг = async () => ((await админ.зов('GET', '/api/debts/suppliers')).data.items || [])
    .find(s => s.id === поставщик) || { balance: 0 };
  r = await админ.зов('POST', '/api/receipts', {
    supplier_id: поставщик,
    items: [{ purchase_price: 10000 }, { purchase_price: 5000, name: 'Серьги' }, { purchase_price: 2500, metal: 'Золото' }],
  });
  check('накладная без артикулов, названий и цен продажи принята', r.status === 200, r.data);
  const нашиАртикулы = (await админ.зов('GET', '/api/products?incomplete=1&limit=2000')).data.items
    .filter(p => p.supplier_id === поставщик);
  check('заведено три изделия с разными артикулами',
    нашиАртикулы.length === 3 && new Set(нашиАртикулы.map(p => p.sku)).size === 3, нашиАртикулы.map(p => p.sku));
  check('безымянные — «Без названия», названное — как названо',
    нашиАртикулы.filter(p => p.name === 'Без названия').length === 2 && нашиАртикулы.some(p => p.name === 'Серьги'),
    нашиАртикулы.map(p => p.name));
  check('долг поставщику — ровно закупка: 17 500', Math.abs((await долг()).balance - 17500) < 0.01, (await долг()).balance);
  r = await админ.зов('POST', '/api/receipts', {
    supplier_id: поставщик, items: [{ name: 'Без закупки' }, { purchase_price: 1000 }],
  });
  check('строка без закупки и цены продажи принята', r.status === 200, r.data);
  check('в долг вошла только указанная закупка: 18 500', Math.abs((await долг()).balance - 18500) < 0.01, (await долг()).balance);
  const безЗакупки = (await админ.зов('GET', '/api/products?search=' + encodeURIComponent('Без закупки'))).data.items
    .find(p => p.supplier_id === поставщик);
  check('закупка у неё — ноль', безЗакупки && безЗакупки.purchase_price === 0, безЗакупки);
  check('владелец видит её в «Не заполнены»', (await незаполненные()).includes(безЗакупки && безЗакупки.id));
  r = await админ.зов('POST', '/api/receipts', { supplier_id: поставщик, items: [{ name: 'Совсем без закупки' }] });
  check('накладная вовсе без закупок принята, долг не вырос', r.status === 200
    && Math.abs((await долг()).balance - 18500) < 0.01, [r.data, (await долг()).balance]);
  r = await админ.зов('POST', '/api/receipts', { supplier_id: поставщик, items: [{ purchase_price: -10 }] });
  check('отрицательная закупка — отказ', r.status === 400 && /отрицательной/.test(r.data.error), r.data);

  console.log('\n=== 4б. Продавец: закупку не видит — и в «Не заполнены» из-за неё не попадает ===');
  await админ.зов('PUT', '/api/products/' + безЗакупки.id, { retail_price: 9000, metal: 'Золото', weight: 2 });
  const уАнны = ((await анна.зов('GET', '/api/products?incomplete=1&limit=2000')).data.items || []).map(p => p.id);
  check('у продавца заполненное по его полям изделие не числится незаполненным', !уАнны.includes(безЗакупки.id));
  check('а у владельца — числится, пока нет закупки', (await незаполненные()).includes(безЗакупки.id));

  console.log('\n=== 5. Явный артикул — как раньше ===');
  r = await админ.зов('POST', '/api/products', { sku: второе.sku });
  check('занятый артикул по-прежнему не дают', r.status === 400 && /уже существует/.test(r.data.error), r.data);

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
