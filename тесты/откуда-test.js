'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Откуда пришёл клиент: Instagram, WhatsApp, сарафанное радио…
 *
 * Поле нужно владельцу для одного вопроса — какой путь приводит покупателей.
 * Значит, проверять надо не только «сохраняется», но и то, что ответ
 * на этот вопрос не врёт:
 *
 *   — в базу попадает только значение из списка. Слово, набранное как
 *     попало, рассыпало бы аналитику на «инста», «Инстаграм» и «Instagram»;
 *   — правка карточки без этого поля не стирает отмеченный источник;
 *   — продавец отмечает источник сам, заводя клиента в кассе;
 *   — аналитика считает новых клиентов и выручку ровно на сделанную продажу;
 *   — старая база, где поля ещё нет, получает его и ничего не теряет;
 *   — кнопки на странице и список на сервере — один и тот же список.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { SOURCES } = require('../src/customer-sources');

const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const ROOT = path.resolve(__dirname, '..');
const МЕТКА = 'Откуда' + process.pid;

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : JSON.stringify(доп).slice(0, 300)); }
};
const около = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

function сеанс() {
  let cookie = '';
  return {
    async войти(логин, пароль) {
      const r = await fetch(BASE + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: логин, password: пароль }),
      });
      cookie = (r.headers.get('set-cookie') || '').split(';')[0];
      return r.status === 200;
    },
    async зов(метод, путь, тело) {
      const opts = { method: метод, headers: { Cookie: cookie } };
      if (тело !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(тело);
      }
      const r = await fetch(BASE + путь, opts);
      let data = null;
      try { data = await r.json(); } catch { /* пусто */ }
      return { status: r.status, data };
    },
    async текст(путь) {
      const r = await fetch(BASE + путь, { headers: { Cookie: cookie } });
      return { status: r.status, text: await r.text() };
    },
  };
}

/*
 * Старая база: поля ещё нет. Воспроизводим её, убрав колонку из свежей,
 * и запускаем систему поверх — ровно то, что случится на сервере магазина
 * при обновлении.
 */
function стараяБаза() {
  const dir = path.join(__dirname, '.вывод', 'миграция-откуда');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'старая.db');
  const env = { ...process.env, ASHER_DB: file, ASHER_MEDIA: path.join(dir, 'images') };
  const запуск = () => spawnSync(process.execPath, ['-e', "require('./src/db')"],
    { cwd: ROOT, env, encoding: 'utf8' });

  let r = запуск();
  check('свежая база создаётся', r.status === 0, r.stderr.slice(-300));
  const db = new DatabaseSync(file);
  db.exec(`INSERT INTO customers (name, phone, notes, created_at)
           VALUES ('Давняя клиентка', '+996 700 111 222', 'покупает к 8 марта', '2025-03-01T10:00:00.000Z')`);
  db.exec('ALTER TABLE customers DROP COLUMN source');
  const колонкиДо = db.prepare('PRAGMA table_info(customers)').all().map(c => c.name);
  db.close();
  check('база старого образца воспроизведена: поля нет', !колонкиДо.includes('source'), колонкиДо);

  r = запуск();
  check('система поднимается на старой базе', r.status === 0, r.stderr.slice(-400));
  const db2 = new DatabaseSync(file);
  const колонки = db2.prepare('PRAGMA table_info(customers)').all().map(c => c.name);
  check('поле «откуда пришёл» появилось', колонки.includes('source'), колонки);
  const давняя = db2.prepare(`SELECT * FROM customers WHERE name = 'Давняя клиентка'`).get();
  check('прежний клиент на месте, источник у него пуст — не выдуман',
    давняя && давняя.source === '' && давняя.phone === '+996 700 111 222' && давняя.notes === 'покупает к 8 марта',
    давняя);
  db2.close();
  r = запуск();
  check('повторный запуск ничего не ломает', r.status === 0, r.stderr.slice(-300));
}

async function main() {
  const админ = сеанс();
  if (!await админ.войти('admin', 'admin123')) { console.error('Не удалось войти владельцем'); process.exit(2); }
  const продавец = сеанс();
  if (!await продавец.войти('anna', 'seller123')) { console.error('Не удалось войти продавцом'); process.exit(2); }

  const клиент = async id => (await админ.зов('GET', '/api/customers/' + id)).data;
  const поИмени = async имя => ((await админ.зов('GET',
    '/api/customers?search=' + encodeURIComponent(имя))).data.items || []);

  console.log('=== 1. Источник записывается ===');
  let r = await админ.зов('POST', '/api/customers',
    { name: МЕТКА + ' Инста', phone: '+996 700 000 001', source: 'instagram' });
  check('клиент с источником заводится', r.status === 200 && r.data.id, r.data);
  const инста = r.data.id;
  check('источник сохранился', (await клиент(инста)).source === 'instagram', await клиент(инста));

  r = await админ.зов('POST', '/api/customers', { name: МЕТКА + ' Без', phone: '+996 700 000 002' });
  check('без источника тоже заводится — поле не обязательное', r.status === 200, r.data);
  const без = r.data.id;
  check('у такого клиента источник пуст', (await клиент(без)).source === '', await клиент(без));

  console.log('\n=== 2. Слово не из списка не проходит ===');
  r = await админ.зов('POST', '/api/customers', { name: МЕТКА + ' Чужое', source: 'Инстаграм' });
  check('«Инстаграм» словами — отказ', r.status === 400, r.data);
  check('и понятно, что делать', /списк/i.test((r.data || {}).error || ''), r.data);
  check('клиент при отказе не заведён', (await поИмени(МЕТКА + ' Чужое')).length === 0);
  r = await админ.зов('POST', '/api/customers', { name: МЕТКА + ' Proto', source: '__proto__' });
  check('служебное слово вместо источника — отказ', r.status === 400, r.data);
  r = await админ.зов('PUT', '/api/customers/' + инста, { source: 'myspace' });
  check('правка на чужое слово — отказ', r.status === 400, r.data);
  check('источник после отказа прежний', (await клиент(инста)).source === 'instagram');

  console.log('\n=== 3. Поменять, снять, не задеть ===');
  r = await админ.зов('PUT', '/api/customers/' + инста, { source: 'referral' });
  check('источник меняется', r.status === 200 && (await клиент(инста)).source === 'referral', r.data);
  r = await админ.зов('PUT', '/api/customers/' + инста, { notes: 'любит серьги' });
  check('правка другого поля источник не стирает',
    r.status === 200 && (await клиент(инста)).source === 'referral', await клиент(инста));
  r = await админ.зов('PUT', '/api/customers/' + инста, { source: '' });
  check('источник можно снять — ошиблись', r.status === 200 && (await клиент(инста)).source === '');
  await админ.зов('PUT', '/api/customers/' + инста, { source: 'instagram' });

  console.log('\n=== 4. Продавец отмечает источник, заводя клиента в кассе ===');
  r = await продавец.зов('POST', '/api/customers',
    { name: МЕТКА + ' Ватсап', phone: '+996 700 000 003', source: 'whatsapp' });
  check('продавцу можно', r.status === 200, r.data);
  const ватсап = r.data.id;
  check('источник от продавца сохранился', (await клиент(ватсап)).source === 'whatsapp');

  console.log('\n=== 5. Список клиентов по источнику ===');
  let список = (await админ.зов('GET', '/api/customers?source=instagram')).data.items;
  check('фильтр «Instagram» показывает только их', список.length > 0 && список.every(c => c.source === 'instagram'),
    список.map(c => c.source));
  check('и наш клиент среди них', список.some(c => c.id === инста));
  список = (await админ.зов('GET', '/api/customers?source=none')).data.items;
  check('«Не отмечено» — только без источника', список.every(c => c.source === ''), список.map(c => c.source));
  check('и клиент без источника там есть', список.some(c => c.id === без));
  список = (await админ.зов('GET', '/api/customers?source=bogus')).data.items;
  check('непонятный фильтр не прячет клиентов', список.some(c => c.id === инста) && список.some(c => c.id === без));
  check('в списке видно, откуда клиент', список.find(c => c.id === инста).source === 'instagram');

  console.log('\n=== 6. Аналитика отвечает на вопрос «откуда приходят» ===');
  const строка = (items, ключ) => items.find(x => x.source === ключ)
    || { source: ключ, new_customers: 0, sales_count: 0, revenue: 0 };
  const до = (await админ.зов('GET', '/api/analytics/by-source')).data.items;

  r = await админ.зов('POST', '/api/customers', { name: МЕТКА + ' Тикток', source: 'tiktok' });
  const тикток = r.data.id;
  const изделие = await админ.зов('POST', '/api/products', {
    sku: `ОТКУДА-${process.pid}`, name: 'Серьги для проверки источников',
    metal: 'Золото', retail_price: 48000, purchase_price: 20000,
  });
  check('изделие для продажи заведено', изделие.status === 200 && изделие.data.id, изделие.data);
  const продажа = await админ.зов('POST', '/api/sales', {
    items: [{ product_id: изделие.data.id }], payment_method: 'cash', customer_id: тикток,
  });
  check('продажа клиенту из TikTok прошла', продажа.status === 200, продажа.data);

  const после = (await админ.зов('GET', '/api/analytics/by-source')).data.items;
  const т0 = строка(до, 'tiktok'), т1 = строка(после, 'tiktok');
  check('новых из TikTok стало ровно на одного больше', т1.new_customers === т0.new_customers + 1, [т0, т1]);
  check('продаж из TikTok — на одну больше', т1.sales_count === т0.sales_count + 1, [т0, т1]);
  check('выручка из TikTok выросла ровно на чек',
    около(т1.revenue, т0.revenue + продажа.data.total), [т0.revenue, т1.revenue, продажа.data.total]);
  const в0 = строка(до, 'whatsapp'), в1 = строка(после, 'whatsapp');
  check('чужая продажа не приписана WhatsApp', в1.sales_count === в0.sales_count && около(в1.revenue, в0.revenue));
  const пустая = после.findIndex(x => x.source === '');
  check('«не отмечено» стоит последним, а не выдаёт себя за источник',
    пустая === -1 || пустая === после.length - 1, после.map(x => x.source));

  const завтра = new Date(Date.now() + 86400000).toISOString();
  const пусто = (await админ.зов('GET', '/api/analytics/by-source?from=' + encodeURIComponent(завтра)
    + '&to=' + encodeURIComponent(завтра))).data.items;
  check('за период без событий — пусто', Array.isArray(пусто) && пусто.length === 0, пусто);
  check('продавцу аналитика по источникам закрыта',
    (await продавец.зов('GET', '/api/analytics/by-source')).status === 403);

  console.log('\n=== 7. Выгрузка клиентов ===');
  const csv = await админ.текст('/api/export/customers');
  check('выгрузка отдаётся', csv.status === 200);
  check('в ней есть колонка «Откуда пришёл»', /Откуда пришёл/.test(csv.text.split('\r\n')[0]), csv.text.slice(0, 200));
  const строкаCsv = csv.text.split('\r\n').find(l => l.startsWith(МЕТКА + ' Инста'));
  check('источник выгружен подписью, а не ключом', /;Instagram;/.test(строкаCsv || ''), строкаCsv);

  console.log('\n=== 8. Кнопки на странице — тот же список, что на сервере ===');
  const ui = await админ.текст('/js/ui.js');
  const найдено = ui.text.match(/\bsource:\s*(\{[^}]*\})/);
  let наСтранице = null;
  try { наСтранице = найдено && Function('"use strict"; return (' + найдено[1] + ')')(); } catch { /* ниже провалится */ }
  check('список на странице найден', Boolean(наСтранице), найдено && найдено[1]);
  check('ключи и подписи совпадают с сервером, в том же порядке',
    JSON.stringify(наСтранице) === JSON.stringify(SOURCES), { наСтранице, SOURCES });
  check('Instagram, WhatsApp и сарафанное радио — первыми, как просил владелец',
    JSON.stringify(Object.keys(SOURCES).slice(0, 3)) === JSON.stringify(['instagram', 'whatsapp', 'referral']));

  console.log('\n=== 9. Старая база ===');
  стараяБаза();

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
