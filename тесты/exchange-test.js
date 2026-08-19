'use strict';
// Обмен изделий: доплата, сдача, ровный обмен, обмен при долге, касса.
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
let cookie = '', failures = 0;
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j };
}
const check = (n, c, x) => { if (c) console.log('  ok  ' + n); else { failures++; console.log('  FAIL ' + n, JSON.stringify(x)); } };

// Чистая касса за окно теста: приходы минус расходы, привязанные к нашим чекам.
async function cashNet(saleIds) {
  const { items } = await call('GET', '/api/finance').then(r => r.body ? r : r).then(r => r.body);
  return items
    .filter(op => saleIds.includes(op.sale_id))
    .reduce((s, op) => s + (op.type === 'income' ? op.amount : -op.amount), 0);
}

async function makeProduct(name, price) {
  const r = await call('POST', '/api/products', {
    sku: 'EX-' + name + '-' + Date.now(), name: 'Обмен ' + name,
    metal: 'Золото 585', weight: 3, purchase_price: Math.round(price / 2), retail_price: price,
  });
  return r.body.id;
}

(async () => {
  await call('POST', '/api/login', { username: 'admin', password: 'admin123' });
  const cust = (await call('POST', '/api/customers', { name: 'Обменов Тест', phone: '0555 99-88-77' })).body.id;

  console.log('\n=== Обмен с доплатой (45 000 → 60 000) ===');
  let pOld = await makeProduct('А', 45000);
  let pNew = await makeProduct('Б', 60000);
  let sale = (await call('POST', '/api/sales', { customer_id: cust, items: [{ product_id: pOld }] })).body;
  let item = sale.items[0].id;
  let r = await call('POST', `/api/sales/${sale.id}/exchange`, {
    return_item_ids: [item], items: [{ product_id: pNew }], extra_paid: 15000,
  });
  check('обмен прошёл', r.status === 200, r.body);
  check('зачёт 45 000', r.body.credit_applied === 45000, r.body);
  check('доплата 15 000', r.body.extra_paid === 15000, r.body);
  check('сдачи нет', r.body.cash_back === 0, r.body);
  check('новый чек без долга', r.body.new.debt === 0, r.body.new);
  check('старое изделие вернулось на витрину',
    (await call('GET', '/api/products/' + pOld)).body.status === 'in_stock', '');
  check('новое продано', (await call('GET', '/api/products/' + pNew)).body.status === 'sold', '');
  let net = await cashNet([sale.id, r.body.new.id]);
  check('в кассе по обмену ровно доплата (15 000 + 45 000 изначальных)', Math.round(net) === 60000, net);

  console.log('\n=== Обмен со сдачей (60 000 → 45 000) ===');
  pNew = await makeProduct('В', 45000);
  sale = r.body.new; // продали за 60 000, теперь меняем на дешевле
  item = sale.items[0].id;
  r = await call('POST', `/api/sales/${sale.id}/exchange`, {
    return_item_ids: [item], items: [{ product_id: pNew }],
  });
  check('обмен прошёл', r.status === 200, r.body);
  check('зачёт 45 000', r.body.credit_applied === 45000, r.body);
  check('сдача клиенту 15 000', r.body.cash_back === 15000, r.body);
  check('новый чек оплачен полностью', r.body.new.debt === 0, r.body.new);

  console.log('\n=== Ровный обмен ===');
  const pEq = await makeProduct('Г', 45000);
  sale = r.body.new;
  item = sale.items[0].id;
  // Кассу меряем разницей до и после: у старого чека уже есть свои операции.
  const before = await cashNet([sale.id]);
  r = await call('POST', `/api/sales/${sale.id}/exchange`, {
    return_item_ids: [item], items: [{ product_id: pEq }],
  });
  check('обмен прошёл', r.status === 200, r.body);
  check('без доплаты и сдачи', r.body.extra_paid === 0 && r.body.cash_back === 0, r.body);
  net = await cashNet([sale.id, r.body.new.id]);
  check('касса по ровному обмену не изменилась', Math.round(net - before) === 0, { before, after: net });

  console.log('\n=== Обмен по чеку с долгом ===');
  pOld = await makeProduct('Д', 50000);
  pNew = await makeProduct('Е', 30000);
  sale = (await call('POST', '/api/sales', {
    customer_id: cust, items: [{ product_id: pOld }],
    payment_method: 'installment', paid: 20000,
  })).body;
  check('долг по чеку 30 000', sale.debt === 30000, sale.debt);
  item = sale.items[0].id;
  r = await call('POST', `/api/sales/${sale.id}/exchange`, {
    return_item_ids: [item], items: [{ product_id: pNew }], extra_paid: 10000,
  });
  check('обмен прошёл', r.status === 200, r.body);
  // Оплачено было 20 000, возврат гасит долг 30 000 → в зачёт идут только 20 000
  check('в зачёт пошло только оплаченное (20 000)', r.body.credit_applied === 20000, r.body);
  check('доплата 10 000', r.body.extra_paid === 10000, r.body);
  check('новый чек закрыт (20 000 + 10 000 = 30 000)', r.body.new.debt === 0, r.body.new);
  check('старый чек без долга после возврата', r.body.old.debt === 0, r.body.old);

  console.log('\n=== Обмен с новым долгом ===');
  pOld = await makeProduct('Ж', 30000);
  pNew = await makeProduct('З', 80000);
  sale = (await call('POST', '/api/sales', { customer_id: cust, items: [{ product_id: pOld }] })).body;
  item = sale.items[0].id;
  r = await call('POST', `/api/sales/${sale.id}/exchange`, {
    return_item_ids: [item], items: [{ product_id: pNew }],
    extra_paid: 20000, due_date: '2030-01-01',
  });
  check('обмен прошёл', r.status === 200, r.body);
  check('долг по новому чеку 30 000 (80 − 30 зачёт − 20 доплата)',
    r.body.new_debt === 30000 && r.body.new.debt === 30000, r.body);
  check('срок погашения записан', r.body.new.due_date === '2030-01-01', r.body.new.due_date);

  console.log('\n=== Ошибки ===');
  r = await call('POST', `/api/sales/${sale.id}/exchange`, { return_item_ids: [item], items: [] });
  check('без новых изделий отклонён', r.status === 400, r.status);
  r = await call('POST', `/api/sales/${sale.id}/exchange`, { return_item_ids: [item], items: [{ product_id: pNew }] });
  check('повторный обмен той же позиции отклонён', r.status === 400, r.status);

  console.log('\n=== Бонусов больше нет ===');
  r = await call('GET', '/api/customers/' + cust);
  check('клиент без сегмента в ответе профиля работает', r.status === 200, r.status);
  r = await call('PUT', '/api/customers/' + cust, { bonus_points: 500, segment: 'vip' });
  check('бонусы и сегмент игнорируются без ошибки', r.status === 200, r.body);
  r = await call('GET', '/api/settings');
  check('настройки без bonus_percent', r.body.bonus_percent === undefined, r.body.bonus_percent);

  console.log(failures === 0 ? '\n✅ Обмен работает' : `\n❌ Провалено: ${failures}`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
