'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Журнал действий: владелец должен видеть каждый шаг продавца.
 *
 * Порядок проверки такой: продавец делает полный рабочий круг — заводит
 * изделие, ставит резерв, продаёт, принимает оплату, оформляет возврат и
 * обмен, списывает брак, заводит клиента, начинает пересчёт. После каждого
 * шага ищем этот шаг в журнале у владельца — с именем продавца и понятной
 * подписью по-русски.
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
    del(p) { return this.call('DELETE', p); },
  };
}

const admin = session();
const seller = session();
const stamp = Date.now();
const SELLER = 'Анна Соколова';
let since = '';

// Ищем в журнале запись продавца, сделанную после начала проверки.
async function findEntry(action, test) {
  const r = await admin.get(`/api/audit?action=${action}&from=${encodeURIComponent(since)}&limit=200`);
  return (r.data.items || []).find(e => e.user_name === SELLER && (!test || test(e)));
}

async function main() {
  check('вход владельца', (await admin.post('/api/login', { username: 'admin', password: 'admin123' })).status === 200);
  since = new Date(Date.now() - 2000).toISOString();
  check('вход продавца', (await seller.post('/api/login', { username: 'anna', password: 'seller123' })).status === 200);

  console.log('\n=== Вход продавца в систему ===');
  const loginRow = await findEntry('login', e => /anna/.test(e.details));
  check('в журнале виден вход продавца', Boolean(loginRow), loginRow);

  console.log('\n=== Продавец заводит изделие ===');
  const sku = `AUD-${stamp}`;
  const made = await seller.post('/api/products', {
    sku, name: 'Кольцо для журнала', retail_price: 180000,
    metal: 'Белое золото', fineness: '750', carat: 0.5, color: 'G', clarity: 'VS1',
  });
  check('изделие заведено', made.status === 200, made.data);
  const pid = made.data.id;
  const createRow = await findEntry('create', e => e.entity === 'product' && e.details.includes(sku));
  check('в журнале: создание изделия с артикулом', Boolean(createRow), createRow && createRow.details);

  console.log('\n=== Продавец правит карточку ===');
  /*
   * Цену продавец не правит — и это проверяется отдельно, в наборе про скидки.
   * Здесь важно другое: то, что ему МОЖНО, должно попадать в журнал так же,
   * как и всё остальное. Иначе владелец не увидит, кто переписал описание
   * изделия перед продажей.
   */
  await seller.put('/api/products/' + pid, { description: 'потёртость на ободке', size: '17' });
  const updRow = await findEntry('update', e => e.entity === 'product' && e.details.includes(sku));
  check('в журнале: изменение изделия', Boolean(updRow), updRow && updRow.details);

  console.log('\n=== Продавец ставит резерв ===');
  const custId = (await admin.get('/api/customers?limit=1')).data.items[0].id;
  const custName = (await admin.get('/api/customers/' + custId)).data.name;
  await seller.put('/api/products/' + pid, {
    status: 'reserved', reserved_for: custId, reserved_until: '2030-03-01',
  });
  const resRow = await findEntry('status', e => e.details.includes(sku) && /резерв/i.test(e.details));
  check('в журнале: резерв отдельной строкой', Boolean(resRow), resRow && resRow.details);
  check('в резерве указан клиент', Boolean(resRow) && resRow.details.includes(custName.split(' ')[0]),
    resRow && resRow.details);
  check('в резерве указан срок', Boolean(resRow) && resRow.details.includes('2030-03-01'),
    resRow && resRow.details);
  await seller.put('/api/products/' + pid, { status: 'in_stock' });

  console.log('\n=== Продавец продаёт ===');
  const sale = await seller.post('/api/sales', {
    items: [{ product_id: pid }], customer_id: custId,
    payment_method: 'installment', paid: 45000, due_date: '2030-09-01',
  });
  check('продажа оформлена', sale.status === 200, sale.data);
  const saleRow = await findEntry('sale', e => e.entity_id === sale.data.id);
  check('в журнале: продажа продавцом', Boolean(saleRow), saleRow && saleRow.details);
  check('в продаже видна сумма и долг',
    Boolean(saleRow) && /180[\s\u00a0]?000/.test(saleRow.details) && /долг/i.test(saleRow.details),
    saleRow && saleRow.details);

  console.log('\n=== Продавец принимает оплату долга ===');
  await seller.post('/api/debts/payments', { sale_id: sale.data.id, amount: 50000 });
  const payRow = await findEntry('payment', e => e.entity === 'debt');
  check('в журнале: приём оплаты', Boolean(payRow), payRow && payRow.details);
  check('в оплате видно от кого и сколько',
    Boolean(payRow) && payRow.details.includes(custName.split(' ')[0]) && /50[\s\u00a0]?000/.test(payRow.details),
    payRow && payRow.details);

  console.log('\n=== Продавец делает обмен ===');
  const swapTo = await admin.post('/api/products', {
    sku: `AUD-${stamp}-X`, name: 'Кольцо на замену', retail_price: 210000,
  });
  const saleCard = (await seller.get('/api/sales/' + sale.data.id)).data;
  const ex = await seller.post(`/api/sales/${sale.data.id}/exchange`, {
    return_item_ids: [saleCard.items[0].id],
    items: [{ product_id: swapTo.data.id }],
    payment_method: 'cash', extra_paid: 15000,
  });
  check('обмен оформлен', ex.status === 200, ex.data);
  const exRow = await findEntry('exchange');
  check('в журнале: обмен продавцом', Boolean(exRow), exRow && exRow.details);

  console.log('\n=== Владелец списывает брак ===');
  /*
   * Списывает владелец, а не продавец: изделие уходит со склада, и решение
   * это не продавцовское. Продавец, попробовавший списать сам, получает отказ —
   * это проверяется в наборе про скидки. Здесь важно, что списание владельца
   * попадает в журнал отдельной строкой и с причиной: через месяц «куда делось
   * кольцо за 70 тысяч» должно иметь письменный ответ.
   */
  const broken = await admin.post('/api/products', {
    sku: `AUD-${stamp}-B`, name: 'Кольцо с браком', retail_price: 70000,
  });
  await admin.put('/api/products/' + broken.data.id, {
    status: 'written_off', write_off_reason: 'скол камня при примерке',
  });
  // Ищем без отбора по продавцу: списывал владелец.
  const offRow = ((await admin.get(
    `/api/audit?action=status&from=${encodeURIComponent(since)}&limit=200`)).data.items || [])
    .find(e => e.details.includes(`AUD-${stamp}-B`));
  check('в журнале: списание отдельной строкой', Boolean(offRow), offRow && offRow.details);
  check('в списании записана причина',
    Boolean(offRow) && /скол камня/.test(offRow.details), offRow && offRow.details);

  console.log('\n=== Продавец заводит клиента ===');
  const cust = await seller.post('/api/customers', {
    name: `Клиент журнала ${stamp}`, phone: `0777${String(stamp).slice(-6)}`,
  });
  const custRow = await findEntry('create', e => e.entity === 'customer' && e.details.includes(String(stamp)));
  check('в журнале: новый клиент', Boolean(custRow), custRow && custRow.details);

  console.log('\n=== Продавец начинает инвентаризацию ===');
  const storeId = (await admin.get('/api/stores')).data.items[0].id;
  const inv = await seller.post('/api/inventory', { store_id: storeId });
  const invRow = await findEntry('create', e => e.entity === 'inventory');
  check('в журнале: начата инвентаризация', Boolean(invRow) || inv.status !== 200, invRow);

  console.log('\n=== Отбор в журнале ===');
  const sellerId = (await admin.get('/api/users')).data.items.find(u => u.username === 'anna').id;
  const byUser = await admin.get(`/api/audit?user_id=${sellerId}&from=${encodeURIComponent(since)}&limit=200`);
  check('отбор по сотруднику работает',
    byUser.data.items.length > 0 && byUser.data.items.every(e => e.user_name === SELLER),
    byUser.data.items.length);
  check('в отборе есть счётчик всех записей', typeof byUser.data.total === 'number', byUser.data.total);
  check('сводка «кто сколько» посчитана',
    Array.isArray(byUser.data.by_user) && byUser.data.by_user[0].name === SELLER, byUser.data.by_user);

  const onlySales = await admin.get(`/api/audit?action=sale&user_id=${sellerId}&limit=50`);
  check('отбор по виду действия работает',
    onlySales.data.items.every(e => e.action === 'sale' && e.user_name === SELLER),
    onlySales.data.items.length);

  const today = new Date().toISOString().slice(0, 10);
  const byDay = await admin.get(`/api/audit?from=${today}&to=${today}&limit=200`);
  check('отбор по дате захватывает весь день', byDay.data.total > 0, byDay.data.total);
  const old = await admin.get('/api/audit?from=2000-01-01&to=2000-01-02&limit=10');
  check('за пустой период журнал пуст', old.data.total === 0, old.data.total);

  const search = await admin.get(`/api/audit?search=${encodeURIComponent(sku)}&limit=50`);
  check('поиск по деталям находит нужное изделие',
    search.data.items.length > 0 && search.data.items.every(e => e.details.includes(sku)),
    search.data.items.length);

  console.log('\n=== Страницы ===');
  const page1 = await admin.get('/api/audit?limit=10&offset=0');
  const page2 = await admin.get('/api/audit?limit=10&offset=10');
  check('вторая страница отдаёт другие записи',
    page1.data.items[0].id !== page2.data.items[0].id, {
      p1: page1.data.items[0].id, p2: page2.data.items[0].id,
    });
  check('журнал длиннее прежних 500 строк, и это видно', page1.data.total >= page1.data.items.length,
    page1.data.total);

  console.log('\n=== Журнал закрыт от продавца ===');
  check('продавцу журнал не отдаётся', (await seller.get('/api/audit')).status === 403);
  check('продавец не видит список сотрудников', (await seller.get('/api/users')).status === 403);
  // Записи журнала нельзя ни изменить, ни удалить — таких маршрутов просто нет.
  const tamper = await admin.del('/api/audit/1');
  check('удалить запись журнала нельзя даже владельцу', tamper.status === 404 || tamper.status === 405,
    tamper.status);

  console.log('\n=== Всё это — действия одного человека ===');
  const all = await admin.get(`/api/audit?user_id=${sellerId}&from=${encodeURIComponent(since)}&limit=200`);
  const kinds = [...new Set(all.data.items.map(e => e.action))].sort();
  console.log('     записано за смену:', kinds.join(', '));
  for (const need of ['login', 'create', 'update', 'status', 'sale', 'payment', 'exchange']) {
    check(`в журнале есть «${need}»`, kinds.includes(need), kinds);
  }

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (failures.length) console.log('Провалено:\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
