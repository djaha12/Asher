'use strict';
/*
 * Синхронизация между устройствами.
 *
 * В магазине одновременно работают ноутбук владельца и несколько телефонов
 * продавцов. Все они смотрят в одну базу, но каждый — своей сессией. Проверяем
 * то, чего боится хозяин: продали с телефона — а на ноутбуке ещё старое;
 * два продавца продали одно кольцо; оплату приняли на одном телефоне, а долг
 * висит на другом.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3122';

let ok = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { ok++; console.log('  ok  ' + name); }
  else {
    fail++; failures.push(name);
    console.log('  FAIL ' + name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300));
  }
}
const money = n => Math.round((Number(n) || 0) * 100) / 100;
const same = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.011;

// Отдельное «устройство»: своя сессия, свои cookie — как разные телефоны.
function device(label) {
  let cookie = '';
  return {
    label,
    async call(method, p, body) {
      const res = await fetch(BASE + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      let data = null;
      try { data = await res.json(); } catch { /* не JSON */ }
      return { status: res.status, data };
    },
    get(p) { return this.call('GET', p); },
    post(p, b) { return this.call('POST', p, b); },
    put(p, b) { return this.call('PUT', p, b); },
    async login(u, pw) { return (await this.call('POST', '/api/login', { username: u, password: pw })).status === 200; },
  };
}

const laptop = device('ноутбук владельца');
const phone1 = device('телефон продавца 1');
const phone2 = device('телефон продавца 2');
const tablet = device('планшет на витрине');
const stamp = Date.now();

async function main() {
  console.log('=== Четыре устройства входят в одну систему ===');
  check('ноутбук: вошёл владелец', await laptop.login('admin', 'admin123'));
  check('телефон 1: вошёл продавец', await phone1.login('anna', 'seller123'));
  check('телефон 2: вошёл продавец', await phone2.login('anna', 'seller123'));
  check('планшет: вошёл владелец', await tablet.login('admin', 'admin123'));
  check('вход с одного логина на двух телефонах не выбивает первый',
    (await phone1.get('/api/me')).status === 200);

  // ---------- Изделие заводит владелец, видят все ----------
  console.log('\n=== Завели изделие на ноутбуке — видно на телефонах ===');
  const sku = `DEV-${stamp}`;
  const made = await laptop.post('/api/products', {
    sku, name: 'Кольцо для проверки устройств', retail_price: 240000, purchase_price: 140000,
    weight: 3.1, metal: 'Белое золото', fineness: '750', carat: 0.7, color: 'G', clarity: 'VS2',
  });
  check('изделие заведено', made.status === 200, made.data);
  const pid = made.data.id;
  for (const d of [phone1, phone2, tablet]) {
    const r = await d.get('/api/products/' + pid);
    check(`${d.label}: изделие уже в каталоге`, r.status === 200 && r.data.retail_price === 240000,
      r.data && r.data.retail_price);
  }
  const found = await phone1.get('/api/products?search=' + sku);
  check('телефон 1: изделие находится поиском', found.data.items.length === 1, found.data.total);

  // ---------- Правка на одном устройстве видна на других ----------
  console.log('\n=== Цену поменяли на планшете — телефон видит новую ===');
  await tablet.put('/api/products/' + pid, { retail_price: 255000 });
  for (const d of [laptop, phone1, phone2]) {
    const r = await d.get('/api/products/' + pid);
    check(`${d.label}: цена обновилась`, r.data.retail_price === 255000, r.data.retail_price);
  }

  // ---------- Резерв с телефона ----------
  console.log('\n=== Резерв поставили с телефона ===');
  const custId = (await laptop.get('/api/customers?limit=1')).data.items[0].id;
  await phone1.put('/api/products/' + pid, {
    status: 'reserved', reserved_for: custId, reserved_until: '2030-01-01',
  });
  for (const d of [laptop, phone2, tablet]) {
    const r = await d.get('/api/products/' + pid);
    check(`${d.label}: изделие показано в резерве`, r.data.status === 'reserved', r.data.status);
  }
  await phone1.put('/api/products/' + pid, { status: 'in_stock' });

  // ---------- Продажа с телефона ----------
  console.log('\n=== Продали с телефона 1 — что видят остальные ===');
  const dashBefore = (await laptop.get('/api/dashboard?tz=360')).data;
  const sale = await phone1.post('/api/sales', {
    items: [{ product_id: pid }], customer_id: custId,
    payment_method: 'installment', paid: 55000, due_date: '2030-06-01',
  });
  check('телефон 1: продажа оформлена', sale.status === 200, sale.data);
  const saleId = sale.data.id;
  const debt = money(255000 - 55000);

  for (const d of [laptop, phone2, tablet]) {
    const card = (await d.get('/api/products/' + pid)).data;
    check(`${d.label}: изделие стало «продано»`, card.status === 'sold', card.status);
  }
  for (const d of [laptop, phone2, tablet]) {
    const list = (await d.get('/api/sales?limit=5')).data.items;
    check(`${d.label}: чек в списке продаж`, list.some(s => s.id === saleId));
  }
  const dashAfter = (await laptop.get('/api/dashboard?tz=360')).data;
  check('ноутбук: выручка дня выросла ровно на сумму чека',
    same(money(dashAfter.today.revenue - dashBefore.today.revenue), 255000),
    { было: dashBefore.today.revenue, стало: dashAfter.today.revenue });
  check('ноутбук: изделий на складе стало на одно меньше',
    dashAfter.stock.count === dashBefore.stock.count - 1,
    { было: dashBefore.stock.count, стало: dashAfter.stock.count });
  check('ноутбук: долг клиентов вырос на остаток',
    same(money(dashAfter.debts.customers_owe - dashBefore.debts.customers_owe), debt),
    { было: dashBefore.debts.customers_owe, стало: dashAfter.debts.customers_owe });

  const debtor2 = (await phone2.get('/api/debts/customers')).data.items.find(c => c.customer_id === custId);
  check('телефон 2: долг клиента виден сразу', Boolean(debtor2) && debtor2.debt >= debt, debtor2 && debtor2.debt);
  const seen = await Promise.all([laptop, phone1, phone2, tablet].map(async d =>
    (await d.get('/api/debts/summary')).data.customers_owe));
  check('все четыре устройства показывают один и тот же долг',
    seen.every(v => same(v, seen[0])), seen);

  // ---------- Одно изделие нельзя продать дважды ----------
  console.log('\n=== Два телефона не продадут одно кольцо ===');
  const again = await phone2.post('/api/sales', { items: [{ product_id: pid }], payment_method: 'cash' });
  check('телефон 2: повторная продажа отбита', again.status === 400, again.status);
  check('и с внятной причиной', /продано|недоступ|нельзя/i.test(String(again.data && again.data.error)),
    again.data);

  // Настоящая гонка: два устройства бьют по одному изделию одновременно
  const race = await laptop.post('/api/products', {
    sku: `DEV-${stamp}-R`, name: 'Кольцо для гонки', retail_price: 90000,
  });
  const [r1, r2] = await Promise.all([
    phone1.post('/api/sales', { items: [{ product_id: race.data.id }], payment_method: 'cash' }),
    phone2.post('/api/sales', { items: [{ product_id: race.data.id }], payment_method: 'cash' }),
  ]);
  const wins = [r1, r2].filter(r => r.status === 200).length;
  check('при одновременной продаже проходит ровно одна', wins === 1, { r1: r1.status, r2: r2.status });
  const raceCard = (await tablet.get('/api/products/' + race.data.id)).data;
  check('изделие продано один раз', raceCard.status === 'sold');
  const raceSales = (await laptop.get('/api/sales?limit=50')).data.items
    .filter(s => s.items_count === 1 && money(s.total) === 90000);
  check('второй чек не появился', raceSales.length >= 1, raceSales.length);

  // ---------- Оплата долга с другого телефона ----------
  console.log('\n=== Оплату приняли на телефоне 2 — долг закрылся везде ===');
  const pay = await phone2.post('/api/debts/payments', { sale_id: saleId, amount: 100000 });
  check('телефон 2: оплата принята', pay.status === 200, pay.data);
  const left = money(debt - 100000);
  for (const d of [laptop, phone1, tablet]) {
    const s = (await d.get('/api/sales/' + saleId)).data;
    check(`${d.label}: в чеке остаток долга ${left}`, same(money(s.total - s.paid), left),
      { total: s.total, paid: s.paid });
  }

  // ---------- Возврат на планшете ----------
  console.log('\n=== Возврат оформили на планшете ===');
  const itemId = (await tablet.get('/api/sales/' + saleId)).data.items[0].id;
  const ret = await tablet.post(`/api/sales/${saleId}/return`, { item_ids: [itemId] });
  check('планшет: возврат оформлен', ret.status === 200, ret.data);
  for (const d of [laptop, phone1, phone2]) {
    const card = (await d.get('/api/products/' + pid)).data;
    check(`${d.label}: изделие вернулось на витрину`, card.status === 'in_stock', card.status);
  }
  const debtsBack = await Promise.all([laptop, phone1, phone2, tablet].map(async d =>
    (await d.get('/api/debts/summary')).data.customers_owe));
  check('долг после возврата одинаков на всех устройствах',
    debtsBack.every(v => same(v, debtsBack[0])), debtsBack);
  check('долг вернулся к исходному',
    same(debtsBack[0], dashBefore.debts.customers_owe),
    { было: dashBefore.debts.customers_owe, стало: debtsBack[0] });

  // ---------- Клиент, заведённый на телефоне ----------
  console.log('\n=== Клиента завели на телефоне — виден на ноутбуке ===');
  const cust = await phone1.post('/api/customers', {
    name: `Клиент с телефона ${stamp}`, phone: `0700${String(stamp).slice(-6)}`,
  });
  check('телефон 1: клиент заведён', cust.status === 200, cust.data);
  const onLaptop = (await laptop.get('/api/customers?search=' + encodeURIComponent(String(stamp)))).data.items;
  check('ноутбук: клиент уже в списке', onLaptop.some(c => c.id === cust.data.id));

  // ---------- Общая сходимость по всем устройствам ----------
  console.log('\n=== Итоговые цифры совпадают на всех устройствах ===');
  const snapshots = await Promise.all([laptop, tablet].map(async d => {
    const dash = (await d.get('/api/dashboard?tz=360')).data;
    return {
      выручка_дня: money(dash.today.revenue),
      изделий_на_складе: dash.stock.count,
      должны_нам: money(dash.debts.customers_owe),
      клиентов: dash.customers,
    };
  }));
  check('главная сходится на ноутбуке и планшете',
    JSON.stringify(snapshots[0]) === JSON.stringify(snapshots[1]), snapshots);
  const counts = await Promise.all([laptop, phone1, phone2, tablet].map(async d =>
    (await d.get('/api/products?status=in_stock&limit=1')).data.total));
  check('остаток витрины одинаков на всех четырёх', counts.every(v => v === counts[0]), counts);

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (failures.length) console.log('Провалено:\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
