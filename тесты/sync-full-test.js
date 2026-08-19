'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Полная проверка синхронизации с 1С.
 *
 * Поднимает свой сервер на демо-базе (с продажами, долгами и консигнацией)
 * и прогоняет весь путь обмена так, как он идёт в жизни: первая выгрузка,
 * повторная выгрузка с новыми ценами, прайс-лист, контрагенты, папка
 * автообмена, кривые файлы, большой объём. Отдельно сверяет, что деньги
 * и вложенные данные (фото, сертификаты, комплекты, резервы) не поехали.
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = require('node:path').resolve(__dirname, '..');
const SC = ВЫВОД;
const WORK = path.join(SC, 'syncfull-work');
const SYNC = path.join(WORK, 'обмен');
const BACKUP = path.join(WORK, 'копии');
const PORT = Number(process.env.ASHER_TEST_PORT)
  || Number((process.env.BASE || '').match(/:(\d+)/)?.[1] || 3122) + 43;
const BASE = `http://localhost:${PORT}`;

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else {
    failed++; failures.push(name);
    console.log('  FAIL ' + name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 220));
  }
}

// 1С часто отдаёт Windows-1251 — в Node есть только декодер, кодировщик пишем сами.
function encode1251(str) {
  const bytes = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c >= 0x410 && c <= 0x44f) bytes.push(c - 0x410 + 0xc0);
    else if (c === 0x401) bytes.push(0xa8);
    else if (c === 0x451) bytes.push(0xb8);
    else if (c === 0x2116) bytes.push(0xb9);        // №
    else if (c === 0x00ab) bytes.push(0xab);        // «
    else if (c === 0x00bb) bytes.push(0xbb);        // »
    else bytes.push(0x3f);
  }
  return Buffer.from(bytes);
}

let cookie = '';
async function call(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setc = res.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  let data = null;
  try { data = await res.json(); } catch { /* не JSON — не беда */ }
  return { status: res.status, data };
}
const get = p => call('GET', p);
const post = (p, b) => call('POST', p, b);

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(200);
  }
  return false;
}

const bySku = async sku => ((await get('/api/products?limit=2000&search=' +
  encodeURIComponent(sku))).data.items || []).find(p => p.sku === sku);

// Снимок денег: по нему сверяем, что синхронизация ничего не сдвинула.
async function moneySnapshot() {
  const [debts, analytics] = await Promise.all([
    get('/api/debts/summary'),
    get('/api/analytics/summary'),
  ]);
  return { debts: debts.data, analytics: analytics.data };
}

let moneyAfterOwnSale = null;

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const DB = path.join(WORK, 'test.db');

  console.log('Готовлю демо-базу (продажи, долги, консигнация)…');
  execFileSync('node', ['src/seed.js'], {
    cwd: ROOT,
    env: { ...process.env, ASHER_DB: DB, ASHER_MEDIA: path.join(WORK, 'images') },
    stdio: 'ignore',
  });

  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ASHER_PORT: String(PORT), ASHER_DB: DB, ASHER_MEDIA: path.join(WORK, 'images'),
      ASHER_SYNC_DIR: SYNC, ASHER_BACKUP_DIR: BACKUP, ASHER_SYNC_INTERVAL: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });

  try {
    const up = await waitFor(async () => {
      try { return (await fetch(BASE + '/api/me')).status === 401; } catch { return false; }
    }, 15000);
    if (!up) throw new Error('Сервер не поднялся:\n' + log);
    ok((await post('/api/login', { username: 'admin', password: 'admin123' })).status === 200, 'вход');

    const before = await moneySnapshot();
    const stockBefore = (await get('/api/products?limit=2000')).data.total;

    // ---------------------------------------------------------------
    console.log('\n=== 1. Первая выгрузка номенклатуры из 1С ===');
    // Как её реально отдаёт 1С: Windows-1251, «;», CRLF, кавычки вокруг полей
    // с точкой с запятой внутри, суммы с неразрывными пробелами и запятой.
    const rows1 = [
      'Артикул;Наименование;Группа номенклатуры;Металл;Вес, г;Розничная цена;Закупочная цена',
      'СИНХ-001;Кольцо «Луна»;Кольца;Золото 585;3,21;45 000,00;27 000,00',
      'СИНХ-002;"Серьги «Роса», парные";Серьги;Золото 750;2,80;62 500,50;38 000,00',
      'СИНХ-003;Цепь якорная;Цепи;Серебро 925;12,05;8 900;5 100',
      '',                                   // пустая строка в середине — 1С так умеет
      'СИНХ-004;Подвеска «Капля»;Подвески;Золото 585;1,45;19 900;11 500',
    ];
    fs.writeFileSync(path.join(WORK, 'выгрузка1.csv'), encode1251(rows1.join('\r\n') + '\r\n'));
    const csv1 = fs.readFileSync(path.join(WORK, 'выгрузка1.csv'));

    // Через интерфейс браузер сам определяет кодировку; тут повторяем это вручную.
    const decoded1 = new TextDecoder('windows-1251').decode(csv1);
    const prev1 = await post('/api/import/preview', { csv: decoded1, entity: 'products' });
    ok(prev1.status === 200, 'предпросмотр принял выгрузку', prev1.data);
    const m1 = prev1.data.suggested_mapping;
    ok(m1.sku === 0 && m1.name === 1, 'артикул и наименование распознаны', m1);
    ok(m1.category === 2 && m1.metal === 3 && m1.weight === 4, 'группа, металл и вес распознаны', m1);
    ok(m1.retail_price === 5 && m1.purchase_price === 6, 'обе цены распознаны', m1);
    ok(prev1.data.delimiter === ';', 'разделитель «;» определён');

    const imp1 = await post('/api/import/commit',
      { csv: decoded1, entity: 'products', mapping: m1, delimiter: ';' });
    ok(imp1.data.created === 4, `создано 4 изделия (${imp1.data.created})`, imp1.data);

    const p1 = await bySku('СИНХ-001');
    ok(p1 && p1.name === 'Кольцо «Луна»', 'кириллица и кавычки-ёлочки не побились', p1 && p1.name);
    ok(p1 && p1.retail_price === 45000, 'сумма «45 000,00» прочитана верно', p1 && p1.retail_price);
    ok(p1 && p1.weight === 3.21, 'вес «3,21» прочитан верно', p1 && p1.weight);
    const p2 = await bySku('СИНХ-002');
    ok(p2 && p2.name === 'Серьги «Роса», парные', 'запятая внутри кавычек не разорвала строку', p2 && p2.name);
    ok(p2 && p2.retail_price === 62500.5, 'копейки сохранены', p2 && p2.retail_price);
    ok(p2 && p2.category_name === 'Серьги', 'категория подхвачена', p2 && p2.category_name);
    ok(p2 && p2.store_name, 'изделие легло на точку продаж', p2 && p2.store_name);

    // ---------------------------------------------------------------
    console.log('\n=== 2. К изделиям добавили своё: фото, сертификат, комплект, резерв ===');
    const JPG = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7), Buffer.from([0xff, 0xd9]),
    ]).toString('base64');
    await post(`/api/products/${p1.id}/images`, { data: 'data:image/jpeg;base64,' + JPG });
    await post(`/api/products/${p1.id}/certificates`,
      { data: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n%%EOF').toString('base64'),
        lab: 'GIA', number: 'SYNC12345' });
    await call('PUT', '/api/products/' + p1.id, {
      gems: [{ type: 'Бриллиант', carat: 0.5, count: 1, cert_lab: 'GIA', cert_number: 'SYNC12345' }],
      description: 'Правка руками под витрину',
    });
    const custId = (await get('/api/customers?limit=1')).data.items[0].id;
    const p3 = await bySku('СИНХ-003');
    await call('PUT', '/api/products/' + p3.id, {
      status: 'reserved', reserved_for: custId, reserved_until: '2030-01-01',
    });
    const p4 = await bySku('СИНХ-004');
    const setRes = await post('/api/sets', {
      name: 'Гарнитур синхронизации', price: 60000, product_ids: [p2.id, p4.id],
    });
    ok(setRes.status === 200, 'комплект собран из импортированных изделий', setRes.data);

    // ---------------------------------------------------------------
    console.log('\n=== 3. Повторная выгрузка: новые цены + новая позиция ===');
    const rows2 = [
      'Артикул;Наименование;Розничная цена;Закупочная цена',
      'СИНХ-001;Кольцо ЛУНА (переименовано в 1С);52 000;30 000',
      'СИНХ-002;Серьги Роса;68 000;40 000',
      'СИНХ-003;Цепь якорная;9 500;5 400',
      'СИНХ-004;Подвеска Капля;21 000;12 000',
      'СИНХ-005;Браслет «Волна»;33 000;19 000',
    ].join('\r\n');
    const prev2 = await post('/api/import/preview', { csv: rows2, entity: 'products' });
    const imp2 = await post('/api/import/commit', {
      csv: rows2, entity: 'products', mapping: prev2.data.suggested_mapping, delimiter: ';',
      update_existing: true, update_fields: ['retail_price', 'purchase_price'],
    });
    ok(imp2.data.updated === 4, `обновлено 4 позиции (${imp2.data.updated})`, imp2.data);
    ok(imp2.data.created === 1, `добавлена 1 новая позиция (${imp2.data.created})`, imp2.data);

    const p1b = await bySku('СИНХ-001');
    ok(p1b.retail_price === 52000, 'цена обновилась', p1b.retail_price);
    ok(p1b.name === 'Кольцо «Луна»', 'название, правленное руками, НЕ затёрлось', p1b.name);
    ok(p1b.description === 'Правка руками под витрину', 'описание не затёрлось', p1b.description);

    const card1 = (await get('/api/products/' + p1.id)).data;
    ok((card1.images || []).length === 1, 'фотография на месте после синхронизации');
    ok((card1.certificates || []).length === 1, 'сертификат на месте после синхронизации');
    ok(card1.gems[0] && card1.gems[0].cert_number === 'SYNC12345', 'номер сертификата у камня цел');
    ok((await get('/api/products?limit=2000&search=SYNC12345')).data.items.some(i => i.id === p1.id),
      'поиск по номеру сертификата работает после синхронизации');

    const p3b = await bySku('СИНХ-003');
    ok(p3b.status === 'reserved' && p3b.reserved_until === '2030-01-01', 'резерв со сроком уцелел', p3b.status);
    ok(p3b.retail_price === 9500, 'цена зарезервированного изделия обновилась', p3b.retail_price);

    const setAfter = (await get('/api/sets/' + setRes.data.id)).data;
    ok(setAfter.count === 2 && setAfter.complete, 'комплект не развалился после синхронизации');
    ok(setAfter.items_total === 68000 + 21000, 'комплект пересчитал сумму по новым ценам', setAfter.items_total);

    // ---------------------------------------------------------------
    console.log('\n=== 4. Синхронизация не трогает проданное и долги ===');
    const soldSku = 'СИНХ-006';
    const mkSold = await post('/api/products',
      { sku: soldSku, name: 'Продастся до синхронизации', retail_price: 70000, purchase_price: 40000 });
    const saleRes = await post('/api/sales', {
      items: [{ product_id: mkSold.data.id }], customer_id: custId,
      payment_method: 'installment', paid: 20000, due_date: '2030-01-01',
    });
    ok(saleRes.status === 200, 'продажа в долг оформлена', saleRes.data);
    const debtBefore = (await get('/api/debts/summary')).data;
    // С этого момента тест больше ничего не продаёт — от него и сверяем выручку.
    moneyAfterOwnSale = await moneySnapshot();

    const rows3 = `Артикул;Наименование;Розничная цена\n${soldSku};Продастся до синхронизации;1 000\n`;
    const prev3 = await post('/api/import/preview', { csv: rows3, entity: 'products' });
    const imp3 = await post('/api/import/commit', {
      csv: rows3, entity: 'products', mapping: prev3.data.suggested_mapping, delimiter: ';',
      update_existing: true, update_fields: ['retail_price'],
    });
    ok(imp3.data.updated === 0 && imp3.data.skipped === 1, 'проданное изделие не обновилось', imp3.data);
    ok(imp3.data.errors.some(e => /продано/.test(e)), 'в отчёте написано, почему пропущено', imp3.data.errors);
    const soldCard = await bySku(soldSku);
    ok(soldCard.retail_price === 70000, 'цена проданного не изменилась', soldCard.retail_price);
    const debtAfter = (await get('/api/debts/summary')).data;
    ok(debtBefore.customers_owe === debtAfter.customers_owe,
      'долг клиента не сдвинулся', { debtBefore, debtAfter });

    // ---------------------------------------------------------------
    console.log('\n=== 5. Консигнация переживает синхронизацию ===');
    const supId = (await get('/api/suppliers')).data.items[0].id;
    const consSku = 'СИНХ-007';
    await post('/api/products', {
      sku: consSku, name: 'Чужое на реализации', retail_price: 50000, purchase_price: 30000,
      supplier_id: supId, ownership: 'consignment',
    });
    const rowsC = `Артикул;Наименование;Розничная цена;Закупочная цена\n${consSku};Чужое на реализации;55 000;33 000\n`;
    const prevC = await post('/api/import/preview', { csv: rowsC, entity: 'products' });
    await post('/api/import/commit', {
      csv: rowsC, entity: 'products', mapping: prevC.data.suggested_mapping, delimiter: ';',
      update_existing: true, update_fields: ['retail_price', 'purchase_price'],
    });
    const consCard = await bySku(consSku);
    ok(consCard.ownership === 'consignment', 'признак «на реализации» не сбросился', consCard.ownership);
    ok(consCard.supplier_name, 'поставщик-владелец не потерялся', consCard.supplier_name);
    ok(consCard.retail_price === 55000, 'цена чужого изделия обновилась', consCard.retail_price);

    // ---------------------------------------------------------------
    console.log('\n=== 6. Выгрузка контрагентов ===');
    const custCsv = [
      'Наименование;Телефон;Дата рождения;Скидка',
      'Асанов Азамат Русланович;0555 12-34-56;15.03.1985;5',
      'Иванова Мария Петровна;+996 700 111222;01.12.1990;0',
    ].join('\r\n');
    const prevCu = await post('/api/import/preview', { csv: custCsv, entity: 'customers' });
    ok(prevCu.data.suggested_mapping.name === 0 && prevCu.data.suggested_mapping.phone === 1,
      'колонки контрагентов распознаны', prevCu.data.suggested_mapping);
    const impCu = await post('/api/import/commit',
      { csv: custCsv, entity: 'customers', mapping: prevCu.data.suggested_mapping, delimiter: ';' });
    ok(impCu.data.created === 2, 'два клиента добавлены', impCu.data);
    // Ищем точным ФИО: «Асанов» есть и в демо-данных, подстрока найдёт не того.
    const found = ((await get('/api/customers?limit=500&search=' +
      encodeURIComponent('Асанов Азамат'))).data.items || [])
      .find(c => c.name === 'Асанов Азамат Русланович');
    ok(found && /1985-03-15/.test(found.birthday || ''), 'дата 15.03.1985 разобрана', found && found.birthday);
    ok(found && found.discount === 5, 'скидка перенесена', found && found.discount);
    const impCu2 = await post('/api/import/commit',
      { csv: custCsv, entity: 'customers', mapping: prevCu.data.suggested_mapping, delimiter: ';' });
    ok(impCu2.data.created === 0 && impCu2.data.skipped === 2,
      'повтор выгрузки не задвоил клиентов', impCu2.data);

    // ---------------------------------------------------------------
    console.log('\n=== 7. Кривые файлы из жизни ===');
    // дубль артикула внутри одного файла
    const dupCsv = 'Артикул;Наименование;Цена\nСИНХ-DUP;Первая;100\nСИНХ-DUP;Вторая;200\n';
    const prevD = await post('/api/import/preview', { csv: dupCsv, entity: 'products' });
    const impD = await post('/api/import/commit',
      { csv: dupCsv, entity: 'products', mapping: prevD.data.suggested_mapping, delimiter: ';' });
    ok(impD.data.created === 1 && impD.data.skipped === 1, 'дубль артикула в файле не создал двойника', impD.data);

    // BOM в начале файла (Excel обожает его добавлять)
    const bomCsv = '﻿Артикул;Наименование;Цена\nСИНХ-BOM;С меткой BOM;700\n';
    const prevB = await post('/api/import/preview', { csv: bomCsv, entity: 'products' });
    ok(prevB.data.suggested_mapping.sku === 0, 'BOM не помешал распознать «Артикул»', prevB.data.suggested_mapping);
    const impB = await post('/api/import/commit',
      { csv: bomCsv, entity: 'products', mapping: prevB.data.suggested_mapping, delimiter: ';' });
    ok(impB.data.created === 1, 'файл с BOM импортирован', impB.data);
    ok((await bySku('СИНХ-BOM')) !== undefined, 'артикул из файла с BOM найден');

    // табуляция как разделитель
    const tabCsv = 'Артикул\tНаименование\tЦена\nСИНХ-TAB\tЧерез табуляцию\t1 500\n';
    const prevT = await post('/api/import/preview', { csv: tabCsv, entity: 'products' });
    ok(prevT.data.delimiter === '\t', 'табуляция определена как разделитель', prevT.data.delimiter);
    const impT = await post('/api/import/commit',
      { csv: tabCsv, entity: 'products', mapping: prevT.data.suggested_mapping, delimiter: '\t' });
    ok(impT.data.created === 1 && (await bySku('СИНХ-TAB')).retail_price === 1500,
      'файл с табуляцией импортирован', impT.data);

    // лишние и неизвестные колонки
    const extraCsv = 'Артикул;Наименование;Цена;Ответственный;Склад;Комментарий кладовщика\n' +
      'СИНХ-EXTRA;С лишними колонками;2 400;Иванов;Основной;срочно\n';
    const prevE = await post('/api/import/preview', { csv: extraCsv, entity: 'products' });
    const impE = await post('/api/import/commit',
      { csv: extraCsv, entity: 'products', mapping: prevE.data.suggested_mapping, delimiter: ';' });
    ok(impE.data.created === 1, 'незнакомые колонки не помешали импорту', impE.data);

    // пустой файл и файл из одних заголовков
    const emptyRes = await post('/api/import/commit',
      { csv: 'Артикул;Наименование\n', entity: 'products', mapping: { sku: 0, name: 1 }, delimiter: ';' });
    ok(emptyRes.status === 400, 'файл без строк отбит понятной ошибкой', emptyRes.data);

    // ---------------------------------------------------------------
    console.log('\n=== 8. Папка автообмена: как это делает владелец ===');
    // обычная выгрузка в 1251
    fs.writeFileSync(path.join(SYNC, 'номенклатура.csv'), encode1251(
      'Артикул;Наименование;Розничная цена\r\nСИНХ-001;Кольцо «Луна»;58 000\r\nСИНХ-100;Новое из папки;12 000\r\n'));
    ok(await waitFor(() => fs.existsSync(path.join(SYNC, 'обработано', 'номенклатура.отчёт.txt'))),
      'файл из папки обработан сам');
    ok((await bySku('СИНХ-001')).retail_price === 58000, 'цена обновилась через папку');
    ok((await bySku('СИНХ-100')) !== undefined, 'новая позиция добавлена через папку');

    // прайс-лист без наименований
    fs.writeFileSync(path.join(SYNC, 'прайс.csv'),
      'Артикул;Цена\nСИНХ-002;71 000\nСИНХ-НЕТ;1\n', 'utf8');
    ok(await waitFor(() => fs.existsSync(path.join(SYNC, 'обработано', 'прайс.отчёт.txt'))),
      'прайс-лист из папки обработан');
    ok((await bySku('СИНХ-002')).retail_price === 71000, 'цена из прайс-листа применилась');
    const priceRep = fs.readFileSync(path.join(SYNC, 'обработано', 'прайс.отчёт.txt'), 'utf8');
    ok(/не найден/.test(priceRep), 'ненайденный артикул попал в отчёт');

    // посторонние файлы в папке не трогаются
    fs.writeFileSync(path.join(SYNC, 'выгрузка.xlsx'), 'не csv');
    fs.mkdirSync(path.join(SYNC, 'старое'), { recursive: true });
    await sleep(1500);
    ok(fs.existsSync(path.join(SYNC, 'выгрузка.xlsx')), 'файл Excel не тронут (нужен CSV)');
    ok(fs.existsSync(path.join(SYNC, 'старое')), 'посторонняя подпапка не тронута');

    // файл, который ещё пишется, не берут в работу недописанным
    const partial = path.join(SYNC, 'долгая-выгрузка.csv');
    fs.writeFileSync(partial, 'Артикул;Наименование;Цена\nСИНХ-200;Дописывается;1 000\n');
    await sleep(400);
    fs.appendFileSync(partial, 'СИНХ-201;Дописан позже;2 000\n');
    ok(await waitFor(() => fs.existsSync(path.join(SYNC, 'обработано', 'долгая-выгрузка.отчёт.txt')), 10000),
      'дописанный файл обработан');
    ok((await bySku('СИНХ-201')) !== undefined, 'дописанная строка не потерялась');

    // ---------------------------------------------------------------
    console.log('\n=== 9. Объём: 10 000 строк ===');
    const bigRows = ['Артикул;Наименование;Розничная цена;Закупочная цена'];
    for (let i = 0; i < 10000; i++) {
      bigRows.push(`МАСС-${String(i).padStart(5, '0')};Изделие массовое ${i};${10000 + i};${6000 + i}`);
    }
    const bigCsv = bigRows.join('\n');
    const prevBig = await post('/api/import/preview', { csv: bigCsv, entity: 'products' });
    ok(prevBig.data.total_rows === 10000, 'предпросмотр посчитал 10 000 строк', prevBig.data.total_rows);
    let t0 = Date.now();
    const impBig = await post('/api/import/commit',
      { csv: bigCsv, entity: 'products', mapping: prevBig.data.suggested_mapping, delimiter: ';' });
    const tCreate = Date.now() - t0;
    ok(impBig.data.created === 10000, `создано 10 000 изделий (${impBig.data.created})`, impBig.data);
    ok(tCreate < 60000, `первая загрузка уложилась в минуту (${(tCreate / 1000).toFixed(1)} с)`);

    // повторная выгрузка того же объёма с новыми ценами
    const bigRows2 = ['Артикул;Наименование;Розничная цена'];
    for (let i = 0; i < 10000; i++) {
      bigRows2.push(`МАСС-${String(i).padStart(5, '0')};Изделие массовое ${i};${20000 + i}`);
    }
    t0 = Date.now();
    const impBig2 = await post('/api/import/commit', {
      csv: bigRows2.join('\n'), entity: 'products',
      mapping: { sku: 0, name: 1, retail_price: 2 }, delimiter: ';',
      update_existing: true, update_fields: ['retail_price'],
    });
    const tUpdate = Date.now() - t0;
    ok(impBig2.data.updated === 10000, `обновлено 10 000 цен (${impBig2.data.updated})`, impBig2.data);
    ok(tUpdate < 60000, `повторная выгрузка уложилась в минуту (${(tUpdate / 1000).toFixed(1)} с)`);
    ok((await bySku('МАСС-05000')).retail_price === 25000, 'выборочная проверка цены после массового обновления');

    // каталог остаётся отзывчивым
    t0 = Date.now();
    const listRes = await get('/api/products?limit=60');
    const tList = Date.now() - t0;
    ok(listRes.data.total >= 10000, 'каталог видит все изделия', listRes.data.total);
    ok(tList < 2000, `каталог открывается быстро (${tList} мс)`);
    t0 = Date.now();
    await get('/api/products?search=' + encodeURIComponent('МАСС-07777'));
    ok(Date.now() - t0 < 2000, `поиск по артикулу быстрый (${Date.now() - t0} мс)`);

    // ---------------------------------------------------------------
    console.log('\n=== 10. Сверка денег после всей синхронизации ===');
    const after = await moneySnapshot();
    ok(before.debts.we_owe === after.debts.we_owe,
      'долг поставщикам не сдвинулся', { was: before.debts.we_owe, now: after.debts.we_owe });
    const revBefore = moneyAfterOwnSale.analytics && moneyAfterOwnSale.analytics.revenue;
    const revAfter = after.analytics && after.analytics.revenue;
    ok(revBefore === revAfter, 'выручка за всё время не изменилась', { revBefore, revAfter });

    const stockAfter = (await get('/api/products?limit=1')).data.total;
    ok(stockAfter > stockBefore, 'склад вырос ровно за счёт импорта', { stockBefore, stockAfter });

    const st = (await get('/api/sync/status')).data;
    ok(st.log.length >= 3, 'журнал обменов ведётся', st.log.length);
    ok(st.log.every(r => r.status === 'ok'), 'все файлы из папки обработаны без ошибок',
      st.log.filter(r => r.status !== 'ok'));
    ok(st.backups_count >= 1, 'резервная копия базы сделана', st.backups_count);
  } finally {
    server.kill('SIGTERM');
  }

  console.log(`\nИтого: ${passed} ok, ${failed} fail`);
  if (failures.length) console.log('Провалено:\n  - ' + failures.join('\n  - '));
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
