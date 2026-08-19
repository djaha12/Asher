'use strict';
/*
 * Пять новых ювелирных возможностей:
 *   7  сертификаты на камни
 *   8  комплекты (гарнитуры)
 *   9  возврат поставщику и брак
 *   10 закупка в долларах
 *   13 резерв со сроком
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
let cookie = '';
let ok = 0, fail = 0;

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const get = p => call('GET', p);
const post = (p, b) => call('POST', p, b);
const put = (p, b) => call('PUT', p, b);
const del = p => call('DELETE', p);

function check(name, cond, extra) {
  if (cond) { ok++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); }
}
const stamp = Date.now();
const dayOffset = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function mkProduct(extra = {}) {
  const r = await post('/api/products', {
    sku: `JW-${stamp}-${Math.random().toString(36).slice(2, 7)}`,
    name: 'Тестовое изделие', retail_price: 10000, purchase_price: 6000, weight: 2, ...extra,
  });
  if (r.status !== 200) throw new Error('не создалось изделие: ' + JSON.stringify(r.body));
  return r.body.id;
}

async function main() {
  const login = await post('/api/login', { username: 'admin', password: 'admin123' });
  check('вход администратора', login.status === 200);

  // ---------------------------------------------------------------- 7
  console.log('\n=== 7. Сертификаты на камни ===');
  const certNumber = `GIA${stamp}`;
  const pid = await mkProduct({
    name: 'Кольцо с сертифицированным бриллиантом',
    gems: [
      { type: 'Бриллиант', carat: 1.02, color: 'G', clarity: 'VS1', cut: 'Кр-57', count: 1,
        cert_lab: 'GIA', cert_number: certNumber, cert_date: '2025-04-01' },
      { type: 'Фианит', carat: 0.05, count: 12 },
    ],
  });
  const p1 = await get('/api/products/' + pid);
  check('поля сертификата сохранились', p1.body.gems[0].cert_number === certNumber, p1.body.gems[0]);
  check('лаборатория сохранилась', p1.body.gems[0].cert_lab === 'GIA');
  check('дата сертификата сохранилась', p1.body.gems[0].cert_date === '2025-04-01');
  check('камень без сертификата не получил номер', !p1.body.gems[1].cert_number);

  const byCert = await get('/api/products?search=' + certNumber);
  check('изделие находится по номеру сертификата',
    byCert.body.items.some(i => i.id === pid), byCert.body.items.map(i => i.sku));
  const byPart = await get('/api/products?search=' + certNumber.slice(3, 10));
  check('находится по части номера', byPart.body.items.some(i => i.id === pid));
  const byCut = await get('/api/products?search=' + encodeURIComponent('Кр-57'));
  check('огранка НЕ попадает в поиск как сертификат',
    !byCut.body.items.some(i => i.id === pid && i.cert_index.includes('Кр-57')));

  // номер стёрли — поиск больше не находит
  await put('/api/products/' + pid, { gems: [{ type: 'Бриллиант', carat: 1.02, count: 1 }] });
  const afterWipe = await get('/api/products?search=' + certNumber);
  check('после удаления номера поиск не находит', !afterWipe.body.items.some(i => i.id === pid));
  // вернули обратно
  await put('/api/products/' + pid, {
    gems: [{ type: 'Бриллиант', carat: 1.02, count: 1, cert_lab: 'GIA', cert_number: certNumber }],
  });
  // частичное обновление не затирает индекс
  await put('/api/products/' + pid, { retail_price: 11000 });
  const afterPartial = await get('/api/products?search=' + certNumber);
  check('частичное обновление не стирает индекс', afterPartial.body.items.some(i => i.id === pid));

  // Файлы сертификатов
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
  const JPG = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7), Buffer.from([0xff, 0xd9]),
  ]).toString('base64');

  const upPdf = await post(`/api/products/${pid}/certificates`,
    { data: 'data:application/pdf;base64,' + PDF, lab: 'GIA', number: certNumber });
  check('PDF-сертификат загружается', upPdf.status === 200, upPdf.body);
  check('у PDF нет миниатюры', upPdf.body.thumb === '');
  check('mime у PDF верный', upPdf.body.mime === 'application/pdf');

  const upJpg = await post(`/api/products/${pid}/certificates`, { data: 'data:image/jpeg;base64,' + JPG });
  check('фото сертификата тоже загружается', upJpg.status === 200, upJpg.body);

  const pdfOnPhotos = await post(`/api/products/${pid}/images`, { data: 'data:image/jpeg;base64,' + PDF });
  check('PDF НЕ принимается как фотография изделия', pdfOnPhotos.status === 400, pdfOnPhotos.body);

  const junk = await post(`/api/products/${pid}/certificates`,
    { data: 'data:application/pdf;base64,' + Buffer.from('notapdf').toString('base64') });
  check('подделка типа файла отбивается', junk.status === 400, junk.body);

  const withCerts = await get('/api/products/' + pid);
  check('карточка отдаёт сертификаты', (withCerts.body.certificates || []).length === 2);

  const media = await fetch(BASE + '/media/' + upPdf.body.file, { headers: { Cookie: cookie } });
  check('PDF отдаётся с типом application/pdf', media.headers.get('content-type') === 'application/pdf');
  check('PDF отдаётся в песочнице', (media.headers.get('content-security-policy') || '').includes('sandbox'));
  check('nosniff проставлен', media.headers.get('x-content-type-options') === 'nosniff');
  const noAuth = await fetch(BASE + '/media/' + upPdf.body.file);
  check('без входа сертификат недоступен', noAuth.status === 403);

  // главное: сертификат не считается фотографией
  const noPhoto = await get('/api/products?has_photo=0&limit=2000');
  check('изделие только с сертификатом остаётся «без фото»',
    noPhoto.body.items.some(i => i.id === pid));
  const listed = (await get('/api/products?search=' + p1.body.sku)).body.items[0];
  check('счётчик фото не учитывает сертификаты', listed.photo_count === 0, listed.photo_count);
  check('обложкой изделия сертификат не стал', !listed.thumb, listed.thumb);

  // ---------------------------------------------------------------- 8
  console.log('\n=== 8. Комплекты (гарнитуры) ===');
  const ring = await mkProduct({ name: 'Кольцо «Гарнитур»', retail_price: 50000, purchase_price: 30000 });
  const earrings = await mkProduct({ name: 'Серьги «Гарнитур»', retail_price: 30000, purchase_price: 18000 });
  const pendant = await mkProduct({ name: 'Подвеска «Гарнитур»', retail_price: 20000, purchase_price: 12000 });

  const one = await post('/api/sets', { name: 'Только одно', product_ids: [ring] });
  check('комплект из одного изделия не создаётся', one.status === 400, one.body);

  const tooDear = await post('/api/sets', {
    name: 'Дорогой', price: 200000, product_ids: [ring, earrings, pendant],
  });
  check('цена выше суммы изделий отклоняется', tooDear.status === 400, tooDear.body);

  const setRes = await post('/api/sets', {
    name: 'Гарнитур «Сияние»', sku: `SET-${stamp}`, price: 90000,
    product_ids: [ring, earrings, pendant],
  });
  check('комплект создан', setRes.status === 200, setRes.body);
  const set = setRes.body;
  check('сумма цен изделий посчитана', set.items_total === 100000, set.items_total);
  check('цена комплекта применилась', set.price === 90000);
  check('вес комплекта суммирован', set.weight_total === 6, set.weight_total);
  check('комплект целый', set.complete === true);
  const sumDisc = set.items.reduce((s, i) => s + i.sale_discount, 0);
  check('скидка разложена без остатка', Math.abs(sumDisc - 10000) < 0.005, sumDisc);
  const sumSale = set.items.reduce((s, i) => s + i.sale_price, 0);
  check('сумма позиций равна цене комплекта', Math.abs(sumSale - 90000) < 0.005, sumSale);

  const dupSku = await post('/api/products', {
    sku: `SET-${stamp}`, name: 'Подделка артикула', retail_price: 1,
  });
  check('артикул комплекта нельзя занять изделием', dupSku.status === 400, dupSku.body);

  const busy = await post('/api/sets', { name: 'Второй', product_ids: [ring, earrings] });
  check('изделие нельзя вложить в два комплекта', busy.status === 400, busy.body);

  // продажа комплекта: позиции со скидками, как их отдаёт сервер
  const saleRes = await post('/api/sales', {
    items: set.items.map(i => ({ product_id: i.id, discount: i.sale_discount, set_id: set.id })),
    payment_method: 'cash',
  });
  check('комплект продан', saleRes.status === 200, saleRes.body);
  check('сумма чека равна цене комплекта', saleRes.body.total === 90000, saleRes.body.total);
  const saleFull = await get('/api/sales/' + saleRes.body.id);
  check('в чеке три отдельные позиции', saleFull.body.items.length === 3);
  check('позиции помечены комплектом', saleFull.body.items.every(i => i.set_id === set.id));
  check('себестоимость сложилась по изделиям', saleFull.body.cost_total === 60000, saleFull.body.cost_total);

  const setAfter = await get('/api/sets/' + set.id);
  check('после продажи комплект уже не целый', setAfter.body.complete === false);
  check('видно, сколько изделий продано', setAfter.body.sold_count === 3);

  const disband = await del('/api/sets/' + set.id);
  check('комплект разбирается', disband.status === 200);
  const ringAfter = await get('/api/products/' + ring);
  check('изделия после разбора остались', ringAfter.status === 200 && !ringAfter.body.set_id);
  check('статус изделий разбор не тронул', ringAfter.body.status === 'sold');

  // ---------------------------------------------------------------- 9
  console.log('\n=== 9. Возврат поставщику и брак ===');
  const suppliers = await get('/api/suppliers');
  const supId = suppliers.body.items[0].id;
  const before = (await get('/api/debts/suppliers/' + supId)).body.balance;

  const defect = await mkProduct({ name: 'Бракованное кольцо', purchase_price: 25000, supplier_id: supId });
  const retRes = await post(`/api/products/${defect}/return-to-supplier`, { reason: 'брак', note: 'скол камня' });
  check('возврат поставщику оформлен', retRes.status === 200, retRes.body);
  check('долг уменьшен на закупочную', retRes.body.debt_reduced === 25000, retRes.body);

  const after = (await get('/api/debts/suppliers/' + supId)).body.balance;
  check('баланс поставщика уменьшился ровно на закупочную',
    Math.abs((before - after) - 25000) < 0.005, { before, after });

  const defectCard = await get('/api/products/' + defect);
  check('изделие ушло со склада', defectCard.body.status === 'written_off');
  check('причина записана', /брак/.test(defectCard.body.write_off_reason), defectCard.body.write_off_reason);

  const ops = (await get('/api/debts/suppliers/' + supId)).body.ops;
  const retOp = ops.find(o => o.kind === 'return' && o.product_id === defect);
  check('строка возврата видна в расчётах', Boolean(retOp));
  check('сумма строки отрицательная', retOp && retOp.amount === -25000, retOp && retOp.amount);
  const delOp = await del('/api/debts/supplier-ops/' + retOp.id);
  check('строку возврата нельзя удалить вручную', delOp.status === 400, delOp.body);

  // вернули изделие на витрину — долг должен восстановиться
  await put('/api/products/' + defect, { status: 'in_stock' });
  const restored = (await get('/api/debts/suppliers/' + supId)).body.balance;
  check('возврат изделия на витрину восстановил долг',
    Math.abs(restored - before) < 0.005, { before, restored });
  const restoredCard = await get('/api/products/' + defect);
  check('причина списания очищена', restoredCard.body.write_off_reason === '');

  const noSupplier = await mkProduct({ name: 'Без поставщика' });
  const noSupRet = await post(`/api/products/${noSupplier}/return-to-supplier`, { reason: 'брак' });
  check('без поставщика возврат невозможен', noSupRet.status === 400, noSupRet.body);

  const soldRet = await post(`/api/products/${ring}/return-to-supplier`, { reason: 'брак' });
  check('проданное изделие вернуть поставщику нельзя', soldRet.status === 400, soldRet.body);

  // консигнация: денег не двигаем, след остаётся
  const consBefore = (await get('/api/debts/suppliers/' + supId)).body.balance;
  const cons = await mkProduct({
    name: 'Чужое на реализации', purchase_price: 40000, supplier_id: supId, ownership: 'consignment',
  });
  const consRet = await post(`/api/products/${cons}/return-to-supplier`, { reason: 'не продалось' });
  check('чужое изделие возвращается', consRet.status === 200, consRet.body);
  check('за чужое изделие долг не меняется', consRet.body.debt_reduced === 0);
  const consAfter = (await get('/api/debts/suppliers/' + supId)).body.balance;
  check('баланс по консигнации не сдвинулся', Math.abs(consAfter - consBefore) < 0.005);

  // ---------------------------------------------------------------- 10
  console.log('\n=== 10. Закупка в долларах ===');
  await put('/api/settings', { usd_rate: '87.5' });
  const st = await get('/api/settings');
  check('курс доллара сохраняется в настройках', st.body.usd_rate === '87.5', st.body.usd_rate);

  const usdId = await mkProduct({
    name: 'Кольцо, закупка в долларах',
    purchase_currency: 'USD', purchase_price_orig: 200, purchase_rate: 87.5,
    purchase_price: 999,  // намеренно неверно — сервер обязан пересчитать
    retail_price: 30000,
  });
  const usd = await get('/api/products/' + usdId);
  check('закупочная пересчитана по курсу', usd.body.purchase_price === 17500, usd.body.purchase_price);
  check('валюта закупки сохранена', usd.body.purchase_currency === 'USD');
  check('цена в валюте сохранена', usd.body.purchase_price_orig === 200);
  check('курс закупки зафиксирован', usd.body.purchase_rate === 87.5);

  // курс вырос — прошлая закупка не пересчитывается задним числом
  await put('/api/settings', { usd_rate: '95' });
  const usdLater = await get('/api/products/' + usdId);
  check('смена курса не меняет прошлую закупку', usdLater.body.purchase_price === 17500);

  // маржа считается от пересчитанной закупочной
  const usdSale = await post('/api/sales', { items: [{ product_id: usdId }], payment_method: 'cash' });
  check('изделие с валютной закупкой продаётся', usdSale.status === 200, usdSale.body);
  check('себестоимость взята в сомах', usdSale.body.cost_total === 17500, usdSale.body.cost_total);

  // частичная правка: меняем ТОЛЬКО курс — сумма обязана пересчитаться
  const partialId = await mkProduct({
    purchase_currency: 'USD', purchase_price_orig: 100, purchase_rate: 80, retail_price: 20000,
  });
  check('исходный пересчёт', (await get('/api/products/' + partialId)).body.purchase_price === 8000);
  await put('/api/products/' + partialId, { purchase_rate: 90 });
  const onlyRate = await get('/api/products/' + partialId);
  check('правка одного курса пересчитывает сумму', onlyRate.body.purchase_price === 9000,
    onlyRate.body.purchase_price);
  await put('/api/products/' + partialId, { purchase_price_orig: 200 });
  const onlyOrig = await get('/api/products/' + partialId);
  check('правка одной валютной цены пересчитывает сумму', onlyOrig.body.purchase_price === 18000,
    onlyOrig.body.purchase_price);

  // ручная правка закупочной при заполненной валюте — ручной ввод главнее
  await put('/api/products/' + partialId, { purchase_price: 12345 });
  const manual = await get('/api/products/' + partialId);
  check('ручная закупочная сохраняется как есть', manual.body.purchase_price === 12345);
  check('справка о валюте при этом убрана', manual.body.purchase_currency === ''
    && manual.body.purchase_rate === 0 && manual.body.purchase_price_orig === 0, manual.body);

  // продавец не должен восстановить закупку умножением
  const sellerCookie = cookie;
  cookie = '';
  const sl = await post('/api/login', { username: 'anna', password: 'seller123' });
  check('вход продавца', sl.status === 200);
  const asSeller = await get('/api/products/' + usdId);
  check('продавцу не видна закупочная', asSeller.body.purchase_price === undefined);
  check('продавцу не видна цена в валюте', asSeller.body.purchase_price_orig === undefined, asSeller.body);
  check('продавцу не виден курс закупки', asSeller.body.purchase_rate === undefined);
  const sellerList = await get('/api/products?search=' + asSeller.body.sku);
  check('в списке продавцу тоже не видна валютная закупка',
    sellerList.body.items.every(i => i.purchase_rate === undefined && i.purchase_price_orig === undefined));
  cookie = sellerCookie;

  const plainId = await mkProduct({ purchase_price: 5000, retail_price: 9000 });
  const plain = await get('/api/products/' + plainId);
  check('обычная закупка без валюты работает как раньше', plain.body.purchase_price === 5000);
  check('поля валюты пустые', plain.body.purchase_currency === '' && plain.body.purchase_rate === 0);

  // ---------------------------------------------------------------- 13
  console.log('\n=== 13. Резерв со сроком ===');
  const custs = await get('/api/customers?limit=1');
  const custId = custs.body.items[0].id;

  const rsvId = await mkProduct({ name: 'Изделие под резерв' });
  await put('/api/products/' + rsvId, {
    status: 'reserved', reserved_for: custId, reserved_until: dayOffset(3),
  });
  const rsv = await get('/api/products/' + rsvId);
  check('резерв со сроком поставлен', rsv.body.status === 'reserved' && rsv.body.reserved_until === dayOffset(3));

  const badDate = await put('/api/products/' + rsvId, { reserved_until: '03.08.2026' });
  check('кривая дата отбивается', badDate.status === 400, badDate.body);

  // резерв без срока — как раньше, бессрочный
  const foreverId = await mkProduct({ name: 'Бессрочный резерв' });
  await put('/api/products/' + foreverId, { status: 'reserved', reserved_for: custId });
  const forever = await get('/api/products/' + foreverId);
  check('резерв без срока остаётся бессрочным', forever.body.reserved_until === '');

  // просроченный резерв
  const expId = await mkProduct({ name: 'Просроченный резерв' });
  await put('/api/products/' + expId, {
    status: 'reserved', reserved_for: custId, reserved_until: dayOffset(-1),
  });
  const released = await post('/api/products/release-expired-reserves', {});
  check('ручной прогон снятия доступен', released.status === 200, released.body);
  const expAfter = await get('/api/products/' + expId);
  check('просроченный резерв снят', expAfter.body.status === 'in_stock', expAfter.body.status);
  check('клиент резерва очищен', !expAfter.body.reserved_for);
  check('срок очищен', expAfter.body.reserved_until === '');

  const stillRsv = await get('/api/products/' + rsvId);
  check('не истёкший резерв не тронут', stillRsv.body.status === 'reserved');
  const stillForever = await get('/api/products/' + foreverId);
  check('бессрочный резерв не тронут', stillForever.body.status === 'reserved');

  // снятие резерва вручную чистит срок
  await put('/api/products/' + rsvId, { status: 'in_stock', reserved_for: null });
  const cleared = await get('/api/products/' + rsvId);
  check('снятие резерва очищает срок', cleared.body.reserved_until === '');

  const audit = await get('/api/audit?limit=200');
  check('снятие по сроку попало в журнал',
    (audit.body.items || []).some(a => a.action === 'reserve_expired'));

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
