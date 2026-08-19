'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Сквозная согласованность системы.
 *
 * Смысл: любое действие должно отражаться СРАЗУ ВЕЗДЕ. Продали изделие —
 * оно исчезло с витрины, склад похудел в деньгах и в граммах, выручка и
 * прибыль выросли, деньги легли в кассу, долг встал клиенту, комплект стал
 * неполным, инвентаризация его больше не ждёт, в журнале появилась запись.
 * Возврат обязан откатить ровно то же самое.
 *
 * Отдельно: компьютер и телефон работают с одними данными, и одно изделие
 * нельзя продать дважды с двух устройств.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3122';

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else {
    failed++; failures.push(name);
    console.log('  FAIL ' + name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 240));
  }
}
/*
 * Деньги сравниваем с допуском в копейку. Обе стороны обязаны быть числами:
 * иначе сравнение «ничего с ничем» тихо проходит, и проверка врёт зелёным.
 */
const eq = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.009;

// Каждое «устройство» — своя сессия, как в жизни: компьютер и телефон.
function device(name) {
  let cookie = '';
  return {
    name,
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
    login(u, pw) { return this.post('/api/login', { username: u, password: pw }); },
  };
}

const pc = device('компьютер');
const phone = device('телефон');

// Полный срез системы: всё, где изделие или деньги должны быть видны.
async function snapshot(d) {
  const [dash, stock, summary, finance, debts, stores, catalog] = await Promise.all([
    d.get('/api/dashboard?tz=360'),
    d.get('/api/analytics/stock'),
    d.get('/api/analytics/summary'),
    d.get('/api/finance'),
    d.get('/api/debts/summary'),
    d.get('/api/stores'),
    d.get('/api/products?status=in_stock&limit=1'),
  ]);
  return {
    dash: dash.data,
    stockValue: (stock.data.by_category || []).reduce((s, r) => s + r.retail, 0),
    stockWeight: (stock.data.by_metal || []).reduce((s, r) => s + r.weight, 0),
    revenue: summary.data.revenue,
    profit: summary.data.profit,
    itemsSold: summary.data.items_sold,
    cashIn: (finance.data.items || []).filter(o => o.type === 'income')
      .reduce((s, o) => s + o.amount, 0),
    customersOwe: debts.data.customers_owe,
    stores: stores.data.items,
    inStockCount: catalog.data.total,
  };
}

async function main() {
  ok((await pc.login('admin', 'admin123')).status === 200, 'вход с компьютера');
  ok((await phone.login('admin', 'admin123')).status === 200, 'вход с телефона');

  const stamp = Date.now();
  // Готовим изделие с известными цифрами, чтобы сверять до копейки и до грамма.
  const mk = async (sku, retail, purchase, weight) =>
    (await pc.post('/api/products', {
      sku, name: 'Изделие ' + sku, retail_price: retail, purchase_price: purchase,
      weight, metal: 'Золото 585',
    })).data.id;

  const idMain = await mk(`CONS-${stamp}-1`, 80000, 50000, 4);
  const idPair = await mk(`CONS-${stamp}-2`, 40000, 25000, 2);
  const setRes = await pc.post('/api/sets', {
    name: 'Гарнитур согласованности', price: 110000, product_ids: [idMain, idPair],
  });
  ok(setRes.status === 200, 'комплект собран', setRes.data);

  const custId = (await pc.get('/api/customers?limit=1')).data.items[0].id;

  // Инвентаризация должна видеть изделие как «числится»
  // Пересчёт всегда идёт по конкретной точке — берём ту, где лежит изделие.
  const mainCard = (await pc.get('/api/products/' + idMain)).data;
  ok(Boolean(mainCard.store_id), 'новое изделие попало на точку продаж', mainCard.store_id);
  // По точке может уже идти пересчёт — система справедливо не даёт начать второй.
  let invStart = await pc.post('/api/inventory', { store_id: mainCard.store_id });
  if (invStart.status !== 200) {
    const open = (await pc.get('/api/inventory')).data.items.find(
      i => i.status === 'open' && i.store_id === mainCard.store_id);
    if (open) invStart = await pc.get('/api/inventory/' + open.id);
  }
  const invId = invStart.data.session ? invStart.data.session.id : invStart.data.id;
  ok(Boolean(invId), 'инвентаризация открыта', invStart.data);
  const invBefore = invStart.data;
  ok((invBefore.missing || []).some(p => p.id === idMain),
    'изделие числится в инвентаризации до продажи',
    (invBefore.missing || []).length);

  console.log('\n=== Снимок системы до продажи ===');
  const before = await snapshot(pc);
  // Страховка от сверки «ничего с ничем»: поля должны существовать.
  ok(typeof before.dash.stock.retail_value === 'number'
     && typeof before.dash.today.revenue === 'number'
     && typeof before.revenue === 'number',
    'снимок системы читается (поля на месте)', before.dash.stock);
  console.log(`  склад: ${before.stockValue} сом, ${before.stockWeight.toFixed(2)} г, ` +
    `в наличии ${before.inStockCount} шт`);
  console.log(`  выручка за всё время: ${before.revenue}, прибыль: ${before.profit}`);

  // ------------------------------------------------------------------
  console.log('\n=== Продажа в рассрочку: внесли 30 000 из 80 000 ===');
  const sale = await pc.post('/api/sales', {
    items: [{ product_id: idMain }], customer_id: custId,
    payment_method: 'installment', paid: 30000, due_date: '2030-01-01',
  });
  ok(sale.status === 200, 'продажа оформлена', sale.data);
  const after = await snapshot(pc);

  console.log('\n--- Каталог ---');
  const card = (await pc.get('/api/products/' + idMain)).data;
  ok(card.status === 'sold', 'изделие помечено проданным', card.status);
  ok(after.inStockCount === before.inStockCount - 1,
    'из «в наличии» пропало ровно одно', { was: before.inStockCount, now: after.inStockCount });
  const inPos = (await pc.get(`/api/products?search=CONS-${stamp}-1`)).data.items[0];
  ok(inPos && inPos.status === 'sold', 'в кассе изделие больше не доступно к продаже');

  console.log('\n--- Главная ---');
  ok(eq(after.dash.stock.retail_value, before.dash.stock.retail_value - 80000),
    'склад в деньгах уменьшился ровно на цену изделия',
    { was: before.dash.stock.retail_value, now: after.dash.stock.retail_value });
  ok(after.dash.stock.count === before.dash.stock.count - 1,
    'штук на складе стало на одну меньше', { was: before.dash.stock.count, now: after.dash.stock.count });
  ok(eq(after.dash.stock.weight, before.dash.stock.weight - 4),
    'граммы на складе уменьшились ровно на вес изделия',
    { was: before.dash.stock.weight, now: after.dash.stock.weight });
  ok(eq(after.dash.today.revenue, before.dash.today.revenue + 80000),
    'плитка «продали сегодня» выросла на сумму чека',
    { was: before.dash.today.revenue, now: after.dash.today.revenue });
  ok(eq(after.dash.debts.customers_owe, before.dash.debts.customers_owe + 50000),
    'плитка «должны нам» выросла на остаток долга',
    { was: before.dash.debts.customers_owe, now: after.dash.debts.customers_owe });

  console.log('\n--- Аналитика ---');
  ok(eq(after.revenue, before.revenue + 80000), 'выручка выросла на сумму чека',
    { was: before.revenue, now: after.revenue });
  ok(eq(after.profit, before.profit + 30000), 'прибыль выросла на разницу цены и закупки',
    { was: before.profit, now: after.profit });
  ok(after.itemsSold === before.itemsSold + 1, 'счётчик проданных изделий вырос на один');
  ok(eq(after.stockValue, before.stockValue - 80000), 'склад в аналитике уменьшился на ту же сумму',
    { was: before.stockValue, now: after.stockValue });
  ok(eq(after.stockWeight, before.stockWeight - 4), 'граммы в аналитике уменьшились на вес изделия',
    { was: before.stockWeight, now: after.stockWeight });

  console.log('\n--- Касса и финансы ---');
  ok(eq(after.cashIn, before.cashIn + 30000),
    'в кассу попало ровно внесённое, а не вся цена', { was: before.cashIn, now: after.cashIn });

  console.log('\n--- Долги ---');
  ok(eq(after.customersOwe, before.customersOwe + 50000), 'долг клиента вырос на остаток',
    { was: before.customersOwe, now: after.customersOwe });
  const debtor = (await pc.get('/api/debts/customers')).data.items.find(r => r.customer_id === custId);
  ok(debtor && debtor.debt >= 50000, 'клиент появился в списке должников', debtor && debtor.debt);

  console.log('\n--- Клиент ---');
  const cust = (await pc.get('/api/customers/' + custId)).data;
  const inHistory = (cust.sales || cust.purchases || []).some(s => s.id === sale.data.id);
  ok(inHistory, 'покупка попала в историю клиента');

  console.log('\n--- Точка продаж ---');
  const storeBefore = before.stores.find(s => s.id === card.store_id) || before.stores[0];
  const storeAfter = after.stores.find(s => s.id === (card.store_id || storeBefore.id));
  ok(storeAfter && storeBefore && storeAfter.in_stock === storeBefore.in_stock - 1,
    'остаток точки уменьшился на одно изделие',
    { was: storeBefore && storeBefore.in_stock, now: storeAfter && storeAfter.in_stock });

  console.log('\n--- Комплект ---');
  const setAfter = (await pc.get('/api/sets/' + setRes.data.id)).data;
  ok(setAfter.complete === false, 'комплект стал неполным');
  ok(setAfter.sold_count === 1, 'видно, что одно изделие комплекта продано', setAfter.sold_count);

  console.log('\n--- Инвентаризация ---');
  const scan = await pc.post(`/api/inventory/${invId}/scan`, { code: `CONS-${stamp}-1` });
  ok(scan.status !== 200 || (scan.data && scan.data.kind !== 'found'),
    'проданное изделие инвентаризация уже не засчитывает как найденное', scan.data);

  console.log('\n--- Журнал операций ---');
  const audit = (await pc.get('/api/audit?limit=50')).data.items || [];
  ok(audit.some(a => a.action === 'sale' || /продаж/i.test(a.details || '')),
    'продажа записана в журнал', audit.slice(0, 3));

  console.log('\n--- Бирки ---');
  const labels = (await pc.get('/api/products?status=in_stock&limit=2000')).data.items;
  ok(!labels.some(p => p.id === idMain), 'проданное изделие не предлагается для печати бирки');

  // ------------------------------------------------------------------
  console.log('\n=== Телефон видит то же самое ===');
  const phoneSnap = await snapshot(phone);
  ok(eq(phoneSnap.dash.stock.retail_value, after.dash.stock.retail_value), 'склад на телефоне совпадает с компьютером',
    { pc: after.dash.stock.retail_value, phone: phoneSnap.dash.stock.retail_value });
  ok(eq(phoneSnap.revenue, after.revenue), 'выручка на телефоне совпадает');
  ok(eq(phoneSnap.customersOwe, after.customersOwe), 'долги на телефоне совпадают');
  const phoneCard = (await phone.get('/api/products/' + idMain)).data;
  ok(phoneCard.status === 'sold', 'телефон видит изделие проданным');

  console.log('\n=== Одно изделие нельзя продать дважды с двух устройств ===');
  const idRace = await mk(`CONS-${stamp}-R`, 15000, 9000, 1);
  const [r1, r2] = await Promise.all([
    pc.post('/api/sales', { items: [{ product_id: idRace }], payment_method: 'cash' }),
    phone.post('/api/sales', { items: [{ product_id: idRace }], payment_method: 'cash' }),
  ]);
  const okCount = [r1, r2].filter(r => r.status === 200).length;
  ok(okCount === 1, 'ровно одна продажа прошла, вторая отбита',
    { pc: r1.status, phone: r2.status, err: (r1.data && r1.data.error) || (r2.data && r2.data.error) });
  const raceCard = (await pc.get('/api/products/' + idRace)).data;
  ok(raceCard.status === 'sold', 'изделие продано один раз');
  const raceSales = (await pc.get('/api/products/' + idRace)).data.history || [];
  ok(raceSales.filter(h => !h.returned).length === 1, 'в истории изделия ровно одна продажа',
    raceSales.length);
  // Дальше тест больше ничего не продаёт: откат сверяем от этой точки,
  // прибавив то, что должно вернуться возвратом.
  const beforeReturn = await snapshot(pc);

  // ------------------------------------------------------------------
  console.log('\n=== Возврат откатывает всё обратно ===');
  const saleFull = (await pc.get('/api/sales/' + sale.data.id)).data;
  const itemId = saleFull.items[0].id;
  const ret = await pc.post(`/api/sales/${sale.data.id}/return`, { item_ids: [itemId] });
  ok(ret.status === 200, 'возврат оформлен', ret.data);

  const back = await snapshot(pc);
  const cardBack = (await pc.get('/api/products/' + idMain)).data;
  ok(cardBack.status === 'in_stock', 'изделие вернулось на витрину', cardBack.status);
  ok(back.inStockCount === beforeReturn.inStockCount + 1, 'счётчик «в наличии» вырос обратно на одно',
    { was: beforeReturn.inStockCount, now: back.inStockCount });
  ok(eq(back.dash.stock.retail_value, beforeReturn.dash.stock.retail_value + 80000),
    'склад в деньгах вернулся ровно на цену изделия',
    { was: beforeReturn.dash.stock.retail_value, now: back.dash.stock.retail_value });
  ok(eq(back.dash.stock.weight, beforeReturn.dash.stock.weight + 4), 'граммы вернулись ровно на вес изделия',
    { was: beforeReturn.dash.stock.weight, now: back.dash.stock.weight });
  ok(eq(back.revenue, beforeReturn.revenue - 80000), 'выручка откатилась ровно на сумму возврата',
    { was: beforeReturn.revenue, now: back.revenue });
  ok(eq(back.profit, beforeReturn.profit - 30000), 'прибыль откатилась ровно на маржу возврата',
    { was: beforeReturn.profit, now: back.profit });
  ok(eq(back.customersOwe, beforeReturn.customersOwe - 50000), 'долг клиента снят полностью',
    { was: beforeReturn.customersOwe, now: back.customersOwe });

  const setBack = (await pc.get('/api/sets/' + setRes.data.id)).data;
  ok(setBack.complete === true, 'комплект снова целый и готов к продаже');

  const phoneBack = await snapshot(phone);
  ok(eq(phoneBack.dash.stock.retail_value, back.dash.stock.retail_value), 'телефон сразу видит откат');

  // ------------------------------------------------------------------
  console.log('\n=== Сходимость разделов между собой ===');
  const fin = await snapshot(pc);
  const storeSumValue = fin.stores.reduce((s, x) => s + x.stock_retail, 0);
  const storeSumCount = fin.stores.reduce((s, x) => s + x.in_stock, 0);
  const storeSumWeight = fin.stores.reduce((s, x) => s + x.stock_weight, 0);
  ok(eq(fin.dash.stock.retail_value, storeSumValue),
    'общий склад в деньгах = сумма остатков по точкам',
    { общий: fin.dash.stock.retail_value, поточкам: storeSumValue });
  ok(fin.dash.stock.count === storeSumCount,
    'общее число изделий = сумма по точкам', { общий: fin.dash.stock.count, поточкам: storeSumCount });
  ok(eq(fin.dash.stock.weight, storeSumWeight),
    'граммы на главной = сумма граммов по точкам',
    { общий: fin.dash.stock.weight, поточкам: storeSumWeight });
  ok(eq(fin.dash.stock.retail_value, fin.stockValue),
    'склад на главной = склад в аналитике',
    { главная: fin.dash.stock.retail_value, аналитика: fin.stockValue });
  ok(eq(fin.dash.debts.customers_owe, fin.customersOwe),
    'долги на главной = долги в разделе «Долги»',
    { главная: fin.dash.debts.customers_owe, раздел: fin.customersOwe });
  const debtorsSum = (await pc.get('/api/debts/customers')).data.items
    .reduce((s, r) => s + r.debt, 0);
  ok(eq(debtorsSum, fin.customersOwe),
    'сумма по должникам = итог в сводке долгов', { построчно: debtorsSum, сводка: fin.customersOwe });
  const noStore = (await pc.get('/api/products?status=in_stock&limit=2000')).data.items
    .filter(p => !p.store_id);
  ok(noStore.length === 0, 'нет изделий-невидимок без точки продаж',
    noStore.slice(0, 3).map(p => p.sku));

  console.log(`\nИтого: ${passed} ok, ${failed} fail`);
  if (failures.length) console.log('Провалено:\n  - ' + failures.join('\n  - '));
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
