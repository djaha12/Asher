'use strict';
/*
 * Продавец не должен видеть внутреннюю кухню: закупочные цены, себестоимость,
 * прибыль, наценку, расчёты с поставщиками. При этом продавать, смотреть
 * каталог и вести клиентов он должен свободно.
 *
 * Проверка идёт «в лоб»: заходим продавцом, дёргаем всё, до чего он дотягивается,
 * и ищем в ответах запрещённые поля — на любой глубине.
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

function session() {
  let cookie = '';
  return {
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
  };
}

// Поля, которых продавец видеть не должен ни на какой глубине ответа.
const FORBIDDEN = [
  'purchase_price', 'purchase_price_orig', 'purchase_rate', 'purchase_currency',
  // Курс закупки: зная его и цену в валюте, закупочную считают в уме.
  'usd_rate',
  'cost', 'cost_total', 'cost_value', 'stock_cost', 'cogs', 'profit', 'margin',
  'missing_cost', 'we_owe', 'supplier_balance', 'balance',
];

// Обходим ответ целиком: объекты, массивы, вложенность любой глубины.
function findForbidden(value, path = '') {
  const hits = [];
  const walk = (v, p) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${p}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (FORBIDDEN.includes(k)) hits.push(`${p}.${k} = ${JSON.stringify(val)}`);
        walk(val, `${p}.${k}`);
      }
    }
  };
  walk(value, path);
  return hits;
}

const admin = session();
const seller = session();
const stamp = Date.now();

async function main() {
  check('вход администратора',
    (await admin.post('/api/login', { username: 'admin', password: 'admin123' })).status === 200);
  check('вход продавца',
    (await seller.post('/api/login', { username: 'anna', password: 'seller123' })).status === 200);

  // Готовим изделие с известной закупочной ценой
  const sku = `ROLE-${stamp}`;
  const made = await admin.post('/api/products', {
    sku, name: 'Кольцо для проверки ролей', retail_price: 300000, purchase_price: 170000,
    weight: 3, metal: 'Белое золото', fineness: '750', carat: 0.9, color: 'F', clarity: 'VS1',
    purchase_currency: 'USD', purchase_price_orig: 2000, purchase_rate: 85,
  });
  check('изделие создано', made.status === 200, made.data);
  const pid = made.data.id;

  // Продажа, чтобы в чеках была себестоимость
  const custId = (await admin.get('/api/customers?limit=1')).data.items[0].id;
  const sold = await admin.post('/api/products', {
    sku: `ROLE-${stamp}-S`, name: 'Проданное для проверки', retail_price: 100000, purchase_price: 60000,
  });
  const sale = await admin.post('/api/sales', {
    items: [{ product_id: sold.data.id }], customer_id: custId,
    payment_method: 'installment', paid: 40000, due_date: '2030-01-01',
  });
  check('продажа с долгом оформлена', sale.status === 200, sale.data);

  console.log('\n=== Что продавец видит в каталоге ===');
  const pl = await seller.get('/api/products?limit=50');
  check('каталог продавцу доступен', pl.status === 200);
  check('в списке нет закупочных полей', findForbidden(pl.data, 'список').length === 0,
    findForbidden(pl.data, 'список').slice(0, 5));

  const card = await seller.get('/api/products/' + pid);
  check('карточка изделия доступна', card.status === 200);
  check('в карточке нет закупочных полей', findForbidden(card.data, 'карточка').length === 0,
    findForbidden(card.data, 'карточка').slice(0, 5));
  check('розничная цена видна', card.data.retail_price === 300000, card.data.retail_price);
  check('характеристики бриллианта видны',
    card.data.carat === 0.9 && card.data.color === 'F' && card.data.clarity === 'VS1');

  console.log('\n=== Все разделы, куда продавец дотягивается ===');
  // Список собран по всем открытым продавцу GET-маршрутам сервера, а не наугад:
  // одна забытая ветка — и закупочная цена утечёт мимо всех проверок.
  const anyOrder = (await admin.get('/api/orders')).data.items[0];
  const anySet = (await admin.get('/api/sets')).data.items[0];
  const anyInv = (await admin.get('/api/inventory')).data.items[0];
  const endpoints = [
    '/api/me', '/api/dashboard?tz=360', '/api/products?limit=30', '/api/products/meta',
    '/api/products/' + pid, '/api/products/' + pid + '/certificates',
    '/api/products/' + pid + '/images', '/api/products/reserves-expiring',
    '/api/categories', '/api/suppliers', '/api/stores', '/api/transfers',
    '/api/customers?limit=20', '/api/customers/' + custId, '/api/customers/birthdays',
    '/api/sales?limit=20', '/api/sales/' + sale.data.id,
    '/api/orders', anyOrder ? '/api/orders/' + anyOrder.id : null,
    '/api/sets', anySet ? '/api/sets/' + anySet.id : null,
    '/api/debts/summary', '/api/debts/customers', '/api/debts/customers/' + custId,
    '/api/debts/payments',
    '/api/inventory', anyInv ? '/api/inventory/' + anyInv.id : null,
    '/api/settings', '/api/settings/countries',
  ].filter(Boolean);
  for (const url of endpoints) {
    const r = await seller.get(url);
    if (r.status === 403 || r.status === 404) continue;   // закрыто — и хорошо
    const hits = findForbidden(r.data, url);
    check(`${url} — без внутренних цифр`, hits.length === 0, hits.slice(0, 4));
  }

  console.log('\n=== Разделы, закрытые для продавца ===');
  for (const [url, what] of [
    ['/api/analytics/summary', 'аналитика'],
    ['/api/analytics/stock', 'склад в аналитике'],
    ['/api/finance', 'финансы'],
    ['/api/finance/pnl', 'прибыли и убытки'],
    ['/api/debts/consignment', 'товар на реализации'],
    ['/api/export/products', 'выгрузка изделий'],
    ['/api/audit', 'журнал операций'],
    ['/api/users', 'сотрудники'],
    ['/api/sync/status', 'автообмен'],
  ]) {
    const r = await seller.get(url);
    check(`${what} — закрыто`, r.status === 403, r.status);
  }

  console.log('\n=== Продавец не может испортить закупочную цену ===');
  // Самое опасное: продавец правит изделие, а закупочная обнуляется.
  const edit = await seller.put('/api/products/' + pid, {
    name: 'Кольцо для проверки ролей', retail_price: 310000,
    purchase_price: 0, purchase_price_orig: 0, purchase_rate: 0, purchase_currency: '',
  });
  check('продавец может править изделие', edit.status === 200, edit.data);
  const afterEdit = (await admin.get('/api/products/' + pid)).data;
  check('розничная цена изменилась', afterEdit.retail_price === 310000, afterEdit.retail_price);
  check('ЗАКУПОЧНАЯ НЕ ПОТЕРЯЛАСЬ', afterEdit.purchase_price === 170000, afterEdit.purchase_price);
  check('валютная закупка не потерялась',
    afterEdit.purchase_price_orig === 2000 && afterEdit.purchase_rate === 85,
    { orig: afterEdit.purchase_price_orig, rate: afterEdit.purchase_rate });

  // И при создании изделия продавцом закупочная не задаётся из воздуха
  const bySeller = await seller.post('/api/products', {
    sku: `ROLE-${stamp}-N`, name: 'Заведено продавцом', retail_price: 50000, purchase_price: 49000,
  });
  if (bySeller.status === 200) {
    const fresh = (await admin.get('/api/products/' + bySeller.data.id)).data;
    check('продавец не задаёт закупочную при создании', fresh.purchase_price === 0,
      fresh.purchase_price);
  } else {
    check('создание изделия продавцом закрыто', bySeller.status === 403, bySeller.status);
  }

  console.log('\n=== Работать продавцу ничего не мешает ===');
  const canSell = await seller.post('/api/sales', {
    items: [{ product_id: pid }], payment_method: 'cash',
  });
  check('продавец оформляет продажу', canSell.status === 200, canSell.data);
  const saleCard = await seller.get('/api/sales/' + canSell.data.id);
  check('чек продавцу виден', saleCard.status === 200);
  check('в чеке нет себестоимости', findForbidden(saleCard.data, 'чек').length === 0,
    findForbidden(saleCard.data, 'чек').slice(0, 4));
  check('сумма чека продавцу видна', saleCard.data.total === 310000, saleCard.data.total);

  const cust = await seller.post('/api/customers', {
    name: `Клиент продавца ${stamp}`, phone: `0555${String(stamp).slice(-6)}`,
  });
  check('продавец заводит клиента', cust.status === 200, cust.data);
  const pay = await seller.post('/api/debts/payments', { customer_id: custId, amount: 1000 });
  check('продавец принимает оплату долга', pay.status === 200, pay.data);

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (failures.length) console.log('Провалено:\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
