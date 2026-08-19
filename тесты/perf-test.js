'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
// Скорость на большом каталоге: добавляем изделий до 15 000 и меряем отклик.
const { execSync } = require('node:child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
let cookie = '';
async function call(method, path, body) {
  const t0 = process.hrtime.bigint();
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const json = await res.json();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { status: res.status, body: json, ms };
}
const fmt = ms => (ms < 1000 ? Math.round(ms) + ' мс' : (ms / 1000).toFixed(1) + ' с');

(async () => {
  await call('POST', '/api/login', { username: 'admin', password: 'admin123' });

  // Массовая заливка через CSV-импорт — заодно проверка импорта на большом файле.
  const have = (await call('GET', '/api/products?limit=1')).body.total;
  const need = 15000 - have;
  if (need > 0) {
    console.log(`Добавляю ${need} изделий через CSV-импорт…`);
    const rows = ['Артикул;Наименование;Металл;Вес, г;Закупочная цена;Розничная цена'];
    const metals = ['Золото 585', 'Золото 750', 'Серебро 925', 'Платина 950'];
    const names = ['Кольцо', 'Серьги', 'Подвеска', 'Цепь', 'Браслет'];
    for (let i = 0; i < need; i++) {
      rows.push(`BULK-${String(i).padStart(6, '0')};${names[i % 5]} «Партия ${Math.floor(i / 100)}»;` +
        `${metals[i % 4]};${(1 + (i % 80) / 10).toFixed(2).replace('.', ',')};` +
        `${10000 + (i % 400) * 100};${25000 + (i % 400) * 250}`);
    }
    const csv = rows.join('\r\n');
    console.log(`Размер файла: ${(csv.length / 1048576).toFixed(1)} МБ`);
    const prev = await call('POST', '/api/import/preview', { csv, entity: 'products' });
    const t0 = Date.now();
    const r = await call('POST', '/api/import/commit', {
      csv, entity: 'products', mapping: prev.body.suggested_mapping, delimiter: prev.body.delimiter,
    });
    console.log(`Импорт ${r.body.created} строк: ${fmt(Date.now() - t0)}`);
  }

  const total = (await call('GET', '/api/products?limit=1')).body.total;
  console.log(`\nВ каталоге ${total} изделий. Отклик:`);

  const tests = [
    ['Каталог, первая страница (500 плиток)', '/api/products'],
    ['Поиск по названию («Кольцо»)', '/api/products?search=' + encodeURIComponent('Кольцо')],
    ['Поиск по артикулу (BULK-007)', '/api/products?search=BULK-007'],
    ['Фильтр по металлу', '/api/products?metal=' + encodeURIComponent('Золото 585')],
    ['Только без фото', '/api/products?has_photo=0'],
    ['Главная страница (сводка)', '/api/dashboard?tz=360'],
    ['Сводка долгов', '/api/debts/summary'],
    ['Список должников', '/api/debts/customers'],
    ['Аналитика: выручка по месяцам', '/api/analytics/revenue?group=month&tz=360'],
    ['P&L за год', '/api/finance/pnl?year=2026&tz=360'],
  ];
  let slow = 0;
  for (const [name, path] of tests) {
    // два прогона, берём второй — первый прогревает кэш SQLite
    await call('GET', path);
    const r = await call('GET', path);
    const mark = r.ms > 1000 ? ' ⚠ МЕДЛЕННО' : '';
    if (r.ms > 1000) slow++;
    console.log(`  ${name.padEnd(42)} ${fmt(r.ms)}${mark}`);
  }

  // Продажа на большом каталоге
  const p = (await call('GET', '/api/products?search=BULK-000001')).body.items[0];
  const r = await call('POST', '/api/sales', { items: [{ product_id: p.id }] });
  console.log(`  ${'Оформление продажи'.padEnd(42)} ${fmt(r.ms)}`);

  console.log(slow ? `\n⚠ Медленных запросов: ${slow}` : '\n✅ Всё быстрее секунды');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(2); });
