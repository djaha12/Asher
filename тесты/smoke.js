'use strict';
// Сквозная проверка API: фото, долги клиентов, поставщики, реализация, точки, инвентаризация.
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
let cookie = '';
let failures = 0;

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

function check(name, cond, extra) {
  if (cond) { console.log('  ok  ' + name); }
  else { failures++; console.log('  FAIL ' + name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

// Минимальный валидный JPEG (1x1) — проверяем, что сервер принимает по сигнатуре.
const JPEG_1PX = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
const DATA_URL = 'data:image/jpeg;base64,' + JPEG_1PX.toString('base64');

(async () => {
  console.log('\n=== Вход ===');
  let r = await call('POST', '/api/login', { username: 'admin', password: 'admin123' });
  check('вход администратором', r.status === 200, r.body);

  console.log('\n=== Точки продаж ===');
  r = await call('GET', '/api/stores');
  const store1 = r.body.items[0];
  check('точка по умолчанию создана', r.body.items.length >= 1, r.body);
  r = await call('POST', '/api/stores', { name: 'Тестовая точка №2', address: 'ул. Пробная, 2' });
  const store2Id = r.body.id;
  check('вторая точка создана', r.status === 200 && store2Id > 0, r.body);

  console.log('\n=== Поставщик и товар ===');
  r = await call('POST', '/api/suppliers', { name: 'ТестПоставщик', phone: '+7 999 000-00-00' });
  const supplierId = r.body.id;
  check('поставщик создан', supplierId > 0, r.body);

  const sku = 'TST-' + Date.now();
  r = await call('POST', '/api/products', {
    sku, name: 'Кольцо тестовое', metal: 'Золото 585', weight: 3.2,
    purchase_price: 20000, retail_price: 45000, supplier_id: supplierId, store_id: store1.id,
  });
  const productId = r.body.id;
  check('изделие создано', productId > 0, r.body);

  const skuC = 'CNS-' + Date.now();
  r = await call('POST', '/api/products', {
    sku: skuC, name: 'Серьги на реализации', metal: 'Золото 585', weight: 2.1,
    purchase_price: 30000, retail_price: 55000, supplier_id: supplierId,
    ownership: 'consignment', store_id: store1.id,
  });
  const consignmentId = r.body.id;
  check('изделие на реализации создано', consignmentId > 0, r.body);

  r = await call('POST', '/api/products', {
    sku: 'BAD-' + Date.now(), name: 'Без владельца', ownership: 'consignment', supplier_id: null,
  });
  check('реализация без поставщика отклонена', r.status === 400, r.body);

  console.log('\n=== Фотографии ===');
  r = await call('POST', `/api/products/${productId}/images`, { data: DATA_URL, thumb: DATA_URL });
  const imageId = r.body.id;
  check('фото загружено', r.status === 200 && imageId > 0, r.body);
  check('первое фото стало главным', r.body.is_main === 1, r.body);

  r = await call('POST', `/api/products/${productId}/images`, { data: 'data:image/jpeg;base64,bm90YW5pbWFnZQ==' });
  check('не-изображение отклонено', r.status === 400, r.body);

  r = await call('POST', '/api/images/match', { names: [`${sku}.jpg`, `${sku}_2.jpg`, 'НЕТТАКОГО.jpg'] });
  check('поиск по имени файла нашёл артикул', r.body.matched[`${sku}.jpg`] === productId, r.body);
  check('суффикс _2 тоже сопоставился', r.body.matched[`${sku}_2.jpg`] === productId, r.body);
  check('лишний файл помечен как несопоставленный', r.body.unmatched.length === 1, r.body);

  r = await call('GET', `/api/products/${productId}`);
  check('фото отдаётся в карточке', r.body.images && r.body.images.length === 1, r.body.images);
  const thumbPath = r.body.images[0].thumb;

  const mediaRes = await fetch(`${BASE}/media/${thumbPath}`, { headers: { Cookie: cookie } });
  check('файл фото отдаётся по /media', mediaRes.status === 200 &&
    mediaRes.headers.get('content-type') === 'image/jpeg', mediaRes.status);
  const noAuth = await fetch(`${BASE}/media/${thumbPath}`);
  check('без входа фото недоступно', noAuth.status === 403, noAuth.status);
  const escape = await fetch(`${BASE}/media/..%2f..%2fserver.js`, { headers: { Cookie: cookie } });
  check('выход за папку изображений запрещён', escape.status === 403 || escape.status === 404, escape.status);

  r = await call('GET', '/api/products?has_photo=1');
  check('фильтр «есть фото» работает', r.body.items.some(p => p.id === productId), r.body.total);
  check('миниатюра приходит в списке', r.body.items.find(p => p.id === productId).thumb === thumbPath);

  console.log('\n=== Клиент и продажа в долг ===');
  r = await call('POST', '/api/customers', { name: 'Иванов Иван', phone: '+7 900 111-22-33' });
  const customerId = r.body.id;
  check('клиент создан', customerId > 0, r.body);

  r = await call('POST', '/api/sales', {
    customer_id: customerId, items: [{ product_id: productId }],
    payment_method: 'installment', paid: 15000, due_date: '2020-01-01',
  });
  const saleId = r.body.id;
  check('продажа в долг оформлена', r.status === 200, r.body);
  check('долг посчитан верно (45000 - 15000)', r.body.debt === 30000, r.body.debt);

  r = await call('POST', '/api/sales', {
    items: [{ product_id: consignmentId }], paid: 10000,
  });
  check('долг без клиента запрещён', r.status === 400, r.body);

  // База может быть с демо-данными, поэтому сверяем прирост, а не абсолютные суммы.
  r = await call('GET', '/api/debts/summary');
  const owedAfterSale = r.body.customers_owe;
  const overdueAfterSale = r.body.customers_overdue;
  check('долг клиента попал в сводку', owedAfterSale >= 30000, r.body);
  check('просроченный долг учтён', overdueAfterSale >= 30000, r.body);

  r = await call('GET', '/api/debts/customers');
  check('клиент попал в список должников',
    r.body.items.some(i => i.customer_id === customerId && i.debt === 30000), r.body.items);

  r = await call('POST', '/api/debts/payments', { customer_id: customerId, amount: 10000, method: 'cash' });
  check('приём платежа прошёл', r.status === 200, r.body);
  r = await call('GET', `/api/sales/${saleId}`);
  check('долг уменьшился до 20000', r.body.debt === 20000, r.body.debt);
  check('платежи записаны', r.body.payments.length === 2, r.body.payments);

  r = await call('POST', '/api/debts/payments', { customer_id: customerId, amount: 999999 });
  check('переплата отклонена', r.status === 400, r.body);
  r = await call('GET', `/api/sales/${saleId}`);
  check('после отклонённой переплаты долг не изменился', r.body.debt === 20000, r.body.debt);

  console.log('\n=== Продажа товара с реализации ===');
  r = await call('POST', '/api/sales', { items: [{ product_id: consignmentId }] });
  const cSaleId = r.body.id;
  check('продажа оформлена', r.status === 200, r.body);
  r = await call('GET', `/api/debts/suppliers/${supplierId}`);
  check('долг перед владельцем появился автоматически', r.body.balance === 30000, r.body.balance);

  r = await call('POST', `/api/debts/suppliers/${supplierId}/ops`, {
    type: 'invoice', amount: 100000, doc_number: 'НК-1', due_date: '2030-01-01',
  });
  check('поставка записана', r.status === 200, r.body);
  r = await call('POST', `/api/debts/suppliers/${supplierId}/ops`, {
    type: 'payment', amount: 50000, method: 'transfer',
  });
  check('оплата поставщику записана', r.status === 200, r.body);
  r = await call('GET', `/api/debts/suppliers/${supplierId}`);
  check('баланс поставщика 30000+100000-50000', r.body.balance === 80000, r.body.balance);

  console.log('\n=== Возврат ===');
  r = await call('GET', `/api/sales/${cSaleId}`);
  const cItemId = r.body.items[0].id;
  r = await call('POST', `/api/sales/${cSaleId}/return`, { item_ids: [cItemId] });
  check('возврат прошёл', r.status === 200, r.body);
  r = await call('GET', `/api/debts/suppliers/${supplierId}`);
  check('долг за реализацию снят возвратом', r.body.balance === 50000, r.body.balance);

  r = await call('GET', '/api/debts/summary');
  const owedBeforeReturn = r.body.customers_owe;
  r = await call('GET', `/api/sales/${saleId}`);
  const itemId = r.body.items[0].id;
  r = await call('POST', `/api/sales/${saleId}/return`, { item_ids: [itemId] });
  check('возврат по долговому чеку прошёл', r.status === 200, r.body);
  check('деньгами вернули только полученное (25000)', r.body.cash_refund === 25000, r.body.cash_refund);
  check('остаток долга списан (20000)', r.body.debt_written_off === 20000, r.body.debt_written_off);
  r = await call('GET', '/api/debts/summary');
  check('долг по возвращённому чеку снят',
    Math.round(owedBeforeReturn - r.body.customers_owe) === 20000, {
      before: owedBeforeReturn, after: r.body.customers_owe });

  console.log('\n=== Перемещение между точками ===');
  r = await call('POST', '/api/transfers', { product_ids: [productId], to_store_id: store2Id, note: 'тест' });
  check('изделие перемещено', r.body.moved === 1, r.body);
  r = await call('POST', '/api/transfers', { product_ids: [productId], to_store_id: store2Id });
  check('повторное перемещение отклонено', r.body.moved === 0 && r.body.skipped.length === 1, r.body);
  r = await call('DELETE', `/api/stores/${store2Id}`);
  check('точку с товаром удалить нельзя', r.status === 400, r.body);

  console.log('\n=== Инвентаризация ===');
  r = await call('POST', '/api/inventory', { store_id: store2Id });
  const invId = r.body.session.id;
  check('инвентаризация начата', r.status === 200, r.body.session);
  check('ожидается 1 изделие', r.body.counts.expected === 1, r.body.counts);
  r = await call('POST', '/api/inventory', { store_id: store2Id });
  check('вторая инвентаризация по точке отклонена', r.status === 400, r.body);

  r = await call('POST', `/api/inventory/${invId}/scan`, { code: sku });
  check('сканирование по артикулу нашло изделие', r.status === 200 && r.body.product.id === productId, r.body);
  r = await call('POST', `/api/inventory/${invId}/scan`, { code: sku });
  check('повтор помечен как дубль', r.body.duplicate === true, r.body);
  r = await call('POST', `/api/inventory/${invId}/scan`, { code: 'НЕСУЩЕСТВУЕТ' });
  check('неизвестный код отклонён', r.status === 404, r.body);

  r = await call('GET', `/api/inventory/${invId}`);
  check('прогресс 100%', r.body.progress === 100, r.body.counts);
  check('недостачи нет', r.body.counts.missing === 0, r.body.counts);
  r = await call('POST', `/api/inventory/${invId}/finish`, {});
  check('инвентаризация завершена', r.body.session.status === 'finished', r.body.session);

  console.log('\n=== Главная и права продавца ===');
  r = await call('GET', '/api/dashboard?tz=180');
  check('склад в граммах есть', typeof r.body.stock.weight === 'number', r.body.stock);
  check('разбивка по металлам есть', Array.isArray(r.body.stock.by_metal), r.body.stock);
  check('блок долгов есть', r.body.debts && typeof r.body.debts.customers_owe === 'number', r.body.debts);
  check('сумма нашего долга видна администратору', typeof r.body.debts.we_owe === 'number', r.body.debts);

  await call('POST', '/api/users', { username: 'testseller', name: 'Продавец', password: 'seller123', role: 'seller' });
  const adminCookie = cookie;
  await call('POST', '/api/login', { username: 'testseller', password: 'seller123' });
  r = await call('GET', '/api/dashboard?tz=180');
  check('продавцу не видна оценка склада', r.body.stock.retail_value === undefined, r.body.stock);
  check('продавцу не виден наш долг поставщикам', r.body.debts.we_owe === undefined, r.body.debts);
  r = await call('GET', '/api/debts/suppliers');
  check('продавцу закрыт раздел поставщиков', r.status === 403, r.body);
  r = await call('GET', '/api/debts/summary');
  check('продавец видит долги клиентов', typeof r.body.customers_owe === 'number', r.body);
  check('но не видит долги поставщикам', r.body.we_owe === undefined, r.body);
  r = await call('GET', `/api/products/${productId}`);
  check('продавцу не видна закупочная цена', r.body.purchase_price === undefined, r.body.purchase_price);
  cookie = adminCookie;

  console.log('\n=== Уборка ===');
  r = await call('DELETE', `/api/images/${imageId}`);
  check('фото удалено', r.status === 200, r.body);

  console.log(failures === 0 ? '\n✅ Все проверки пройдены\n' : `\n❌ Провалено проверок: ${failures}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('Сбой теста:', e); process.exit(2); });
