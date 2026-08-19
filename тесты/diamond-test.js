'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
// Проба, каратность, цвет и чистота как поля изделия; ассортимент — только 750 и бриллианты.
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
let cookie = '';
let ok = 0, fail = 0;
const check = (n, c, e) => c ? (ok++, console.log('  ok  ' + n))
  : (fail++, console.log('  FAIL ' + n, e === undefined ? '' : JSON.stringify(e).slice(0, 220)));

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  let json; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}
const get = p => call('GET', p);
const post = (p, b) => call('POST', p, b);
const put = (p, b) => call('PUT', p, b);
const stamp = Date.now();

async function main() {
  check('вход', (await post('/api/login', { username: 'admin', password: 'admin123' })).status === 200);

  console.log('\n=== Поля изделия ===');
  const sku = `BR-${stamp}`;
  const created = await post('/api/products', {
    sku, name: 'Кольцо с бриллиантом', retail_price: 450000, purchase_price: 260000, weight: 3.4,
    metal: 'Белое золото', fineness: '750', carat: 0.75, color: 'g', clarity: 'vs1',
  });
  check('изделие создано', created.status === 200, created.body);
  const p = (await get('/api/products/' + created.body.id)).body;
  check('проба сохранена отдельным полем', p.fineness === '750', p.fineness);
  check('металл без пробы', p.metal === 'Белое золото', p.metal);
  check('каратность сохранена', p.carat === 0.75, p.carat);
  check('цвет приведён к верхнему регистру', p.color === 'G', p.color);
  check('чистота приведена к верхнему регистру', p.clarity === 'VS1', p.clarity);

  const neg = await put('/api/products/' + created.body.id, { carat: -1 });
  check('отрицательная каратность отбита', neg.status === 400, neg.body);

  console.log('\n=== Фильтры и сортировка ===');
  await post('/api/products', {
    sku: `BR-${stamp}-2`, name: 'Серьги с бриллиантами', retail_price: 120000,
    metal: 'Белое золото', fineness: '750', carat: 0.20, color: 'H', clarity: 'SI1',
  });
  const byColor = await get('/api/products?color=G&limit=500');
  check('фильтр по цвету работает', byColor.body.items.some(i => i.sku === sku)
    && byColor.body.items.every(i => i.color === 'G'), byColor.body.items.length);
  const byClarity = await get('/api/products?clarity=VS1&limit=500');
  check('фильтр по чистоте работает', byClarity.body.items.every(i => i.clarity === 'VS1'));
  const byFineness = await get('/api/products?fineness=750&limit=2000');
  check('фильтр по пробе работает', byFineness.body.items.every(i => i.fineness === '750'),
    byFineness.body.total);
  const byCarat = await get('/api/products?carat_min=0.5&limit=500');
  check('отбор по каратности от 0,5', byCarat.body.items.every(i => i.carat >= 0.5));
  const sorted = await get('/api/products?sort=carat_desc&limit=20');
  const carats = sorted.body.items.map(i => i.carat);
  check('сортировка по каратам от крупных',
    carats.every((v, i) => i === 0 || carats[i - 1] >= v), carats.slice(0, 5));

  console.log('\n=== Справочники для фильтров ===');
  const meta = (await get('/api/products/meta')).body;
  check('пробы перечислены', (meta.fineness || []).includes('750'), meta.fineness);
  check('цвета перечислены', (meta.colors || []).includes('G'), meta.colors);
  check('чистота перечислена', (meta.clarities || []).includes('VS1'), meta.clarities);
  const ci = (meta.colors || []).indexOf('D'), cj = (meta.colors || []).indexOf('H');
  check('цвета идут по шкале, а не по алфавиту', ci === -1 || cj === -1 || ci < cj, meta.colors);
  const k1 = (meta.clarities || []).indexOf('IF'), k2 = (meta.clarities || []).indexOf('SI1');
  check('чистота идёт по шкале', k1 === -1 || k2 === -1 || k1 < k2, meta.clarities);

  console.log('\n=== Ассортимент демо-данных ===');
  // Спрашиваем именно демо-ассортимент: в базе после нагрузочных проверок
  // лежат десятки тысяч изделий, и «первые 2000» до демо уже не доходят.
  const all = (await get('/api/products?search=AS-&limit=2000')).body.items;
  const demo = all.filter(i => /^AS-/.test(i.sku));
  check('в демо только 750 проба', demo.every(i => i.fineness === '750'),
    [...new Set(demo.map(i => i.fineness))]);
  check('в демо только золото', demo.every(i => /золото/i.test(i.metal || '')),
    [...new Set(demo.map(i => i.metal))]);
  check('белое золото преобладает',
    demo.filter(i => i.metal === 'Белое золото').length > demo.length / 2);
  check('в демо только бриллианты',
    demo.every(i => !i.gem_summary || /Бриллиант/.test(i.gem_summary)),
    [...new Set(demo.map(i => (i.gem_summary || '').split(' ')[1]))].slice(0, 6));
  check('у большинства проставлена каратность',
    demo.filter(i => i.carat > 0).length > demo.length * 0.8);

  console.log('\n=== Аналитика: металл вместе с пробой ===');
  const stock = (await get('/api/analytics/stock')).body;
  const metals = (stock.by_metal || []).map(m => m.name);
  check('в отчёте склада проба рядом с металлом',
    metals.some(n => /750/.test(n)), metals);
  const dash = (await get('/api/dashboard?tz=360')).body;
  check('на главной металл тоже с пробой',
    (dash.stock.by_metal || []).some(m => /750/.test(m.metal)),
    (dash.stock.by_metal || []).map(m => m.metal));

  console.log('\n=== Импорт из 1С ===');
  const csv = [
    'Артикул;Наименование;Металл;Проба;Караты;Цвет;Чистота;Розничная цена',
    `IMP-${stamp};Кольцо из выгрузки;Белое золото;750;1,25;F;VVS2;900 000`,
  ].join('\n');
  const prev = await post('/api/import/preview', { csv, entity: 'products' });
  const m = prev.body.suggested_mapping;
  check('колонка «Проба» распознана', m.fineness !== undefined, m);
  check('колонка «Караты» распознана', m.carat !== undefined, m);
  check('колонка «Цвет» распознана', m.color !== undefined, m);
  check('колонка «Чистота» распознана', m.clarity !== undefined, m);
  const imp = await post('/api/import/commit', { csv, entity: 'products', mapping: m, delimiter: ';' });
  check('изделие импортировано', imp.body.created === 1, imp.body);
  const impItem = (await get('/api/products?search=IMP-' + stamp)).body.items[0];
  check('проба из файла', impItem.fineness === '750', impItem.fineness);
  check('караты из файла («1,25»)', impItem.carat === 1.25, impItem.carat);
  check('цвет из файла', impItem.color === 'F', impItem.color);
  check('чистота из файла', impItem.clarity === 'VVS2', impItem.clarity);

  console.log('\n=== Экспорт ===');
  const csvOut = await fetch(BASE + '/api/export/products', { headers: { Cookie: cookie } });
  const text = await csvOut.text();
  check('в выгрузке есть колонки пробы и камня',
    /Проба/.test(text) && /Караты/.test(text) && /Чистота/.test(text));
  check('значения попали в выгрузку', text.includes('750'));

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
