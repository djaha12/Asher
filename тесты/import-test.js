'use strict';
// Проверка повторного импорта из 1С: первая загрузка, затем обновление цен.
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

const tag = 'IMP' + Date.now();
const csv1 = `Артикул;Наименование;Розничная цена;Закупочная цена;Вес, г;Металл
${tag}-1;Кольцо «Заря»;50 000,00;30 000,00;3,15;Золото 585
${tag}-2;Серьги «Роса»;75 000,00;44 000,00;4,20;Золото 585
${tag}-3;Цепь «Нить»;22 000,00;13 000,00;8,00;Серебро 925`;

// Повторная выгрузка: у первой позиции выросла цена, вторая без изменений,
// третьей нет вовсе, зато появилась четвёртая.
const csv2 = `Артикул;Наименование;Розничная цена;Закупочная цена;Вес, г;Металл
${tag}-1;Кольцо «Заря» обновлённое;59 900,00;33 000,00;3,15;Золото 585
${tag}-2;Серьги «Роса»;75 000,00;44 000,00;4,20;Золото 585
${tag}-4;Браслет «Волна»;39 000,00;21 000,00;6,10;Золото 585`;

(async () => {
  await call('POST', '/api/login', { username: 'admin', password: 'admin123' });

  console.log('\n=== Первая загрузка ===');
  let r = await call('POST', '/api/import/preview', { csv: csv1, entity: 'products' });
  check('колонки распознаны автоматически',
    r.body.suggested_mapping.sku === 0 && r.body.suggested_mapping.name === 1 &&
    r.body.suggested_mapping.retail_price === 2, r.body.suggested_mapping);
  const mapping = r.body.suggested_mapping;
  const delimiter = r.body.delimiter;

  r = await call('POST', '/api/import/commit', { csv: csv1, entity: 'products', mapping, delimiter });
  check('создано 3 изделия', r.body.created === 3, r.body);

  r = await call('GET', '/api/products?search=' + encodeURIComponent(tag + '-1'));
  const p1 = r.body.items[0];
  check('русский формат цены разобран (50 000,00 → 50000)', p1.retail_price === 50000, p1.retail_price);
  check('вес с запятой разобран (3,15)', p1.weight === 3.15, p1.weight);
  check('изделие привязано к точке продаж', p1.store_id > 0, p1.store_id);

  console.log('\n=== Повторная загрузка без обновления ===');
  r = await call('POST', '/api/import/commit', { csv: csv2, entity: 'products', mapping, delimiter });
  check('существующие пропущены, новое добавлено', r.body.created === 1 && r.body.skipped === 2, r.body);

  console.log('\n=== Повторная загрузка с обновлением цен ===');
  const csv3 = csv2.replace('59 900,00', '61 500,00');
  r = await call('POST', '/api/import/commit', {
    csv: csv3, entity: 'products', mapping, delimiter,
    update_existing: true, update_fields: ['retail_price', 'purchase_price'],
  });
  check('одна позиция обновлена', r.body.updated === 1, r.body);
  check('две без изменений', r.body.unchanged === 2, r.body);
  check('ничего лишнего не создано', r.body.created === 0, r.body);

  r = await call('GET', '/api/products?search=' + encodeURIComponent(tag + '-1'));
  const p1b = r.body.items[0];
  check('цена обновилась до 61500', p1b.retail_price === 61500, p1b.retail_price);
  check('наименование НЕ тронуто (его не отмечали)', p1b.name === 'Кольцо «Заря»', p1b.name);

  console.log('\n=== Обновление с наименованием ===');
  r = await call('POST', '/api/import/commit', {
    csv: csv3, entity: 'products', mapping, delimiter,
    update_existing: true, update_fields: ['name'],
  });
  r = await call('GET', '/api/products?search=' + encodeURIComponent(tag + '-1'));
  check('наименование обновилось, когда его отметили',
    r.body.items[0].name === 'Кольцо «Заря» обновлённое', r.body.items[0].name);

  console.log('\n=== Проданное не трогаем ===');
  r = await call('GET', '/api/products?search=' + encodeURIComponent(tag + '-2'));
  const p2 = r.body.items[0];
  await call('POST', '/api/sales', { items: [{ product_id: p2.id }] });
  const csv4 = csv2.replace('75 000,00', '99 000,00');
  r = await call('POST', '/api/import/commit', {
    csv: csv4, entity: 'products', mapping, delimiter,
    update_existing: true, update_fields: ['retail_price'],
  });
  const after = await call('GET', '/api/products/' + p2.id);
  check('цена проданного изделия не изменилась', after.body.retail_price === 75000, after.body.retail_price);

  console.log(failures === 0 ? '\n✅ Импорт работает\n' : `\n❌ Провалено: ${failures}\n`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
