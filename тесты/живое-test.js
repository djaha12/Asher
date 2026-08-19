'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Живое обновление экрана.
 *
 * Данные у всех устройств общие и были такими всегда. Здесь проверяется другое:
 * что ЭКРАН обновляется сам, без единого касания. Продавец держит открытым
 * каталог, коллега в этот момент продаёт кольцо — и через несколько секунд
 * кольцо у первого пропадает из наличия само.
 *
 * И вторая половина, без которой первая опасна: обновление НЕ ДОЛЖНО стирать
 * то, что человек печатает прямо сейчас. Продавец, набивающий карточку изделия
 * с весом, пробой и вставками, не должен обнаружить пустую форму из-за того,
 * что кто-то в соседнем зале принял оплату.
 */
const { chromium } = require('./браузер');
const fs = require('node:fs');
const OUT = ВЫВОД + '/снимки';
fs.mkdirSync(OUT, { recursive: true });

const BASE = process.env.BASE || 'http://127.0.0.1:3122';
let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 220)); }
};

// Опрос идёт раз в 5 секунд — ждём с запасом, но без лишнего.
const ЖДАТЬ = 9000;

async function войти(page, логин, пароль) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('#login-username', логин);
  await page.fill('#login-password', пароль);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not(.hidden)');
}

(async () => {
  const b = await chromium.launch();

  /*
   * Ноутбук владельца и телефон продавца — именно РАЗНЫЕ устройства, и это
   * здесь принципиально: половина проверки в том, что своё же действие не
   * вызывает лишней перерисовки. С одной отметкой на двоих сервер считал бы
   * продажу с ноутбука «своей» для телефона, и проверка потеряла бы смысл.
   *
   * Телефон при этом системе незнаком — он попадёт на экран ожидания. Ниже
   * владелец разрешает его, как разрешал бы в жизни.
   */
  const ноутбук = await (await b.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  const телефон = await (await b.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    устройство: 'seller-phone-live',
  })).newPage();

  const ошибки = [];
  for (const p of [ноутбук, телефон]) {
    p.on('pageerror', e => ошибки.push(e.message));
    p.on('console', m => {
      // ERR_FAILED — это наш же обрыв опроса в последней части проверки,
      // а не ошибка приложения: браузер сообщает о неудавшемся запросе.
      const t = m.text();
      if (m.type() === 'error' && !/status of 40[013]/.test(t) && !/ERR_FAILED|ERR_INTERNET/.test(t)) {
        ошибки.push(t);
      }
    });
  }

  await войти(ноутбук, 'admin', 'admin123');

  /*
   * Телефон продавца — новое устройство. Он не входит сразу, а показывает код
   * и ждёт. Владелец с ноутбука разрешает — и телефон входит сам, не спрашивая
   * пароль заново. Ровно так это и выглядит в магазине.
   */
  await телефон.goto(BASE, { waitUntil: 'networkidle' });
  await телефон.fill('#login-username', 'anna');
  await телефон.fill('#login-password', 'seller123');
  await телефон.click('#login-form button[type=submit]');
  await телефон.waitForSelector('#login-wait:not(.hidden)', { timeout: 15000 });
  const код = (await телефон.textContent('#login-wait-code')).trim();
  check('незнакомый телефон не пустили, показан код', /^[A-Z0-9]{4}$/.test(код), код);

  const разрешено = await ноутбук.evaluate(async (к) => {
    const r = await fetch('/api/devices', { credentials: 'include' });
    const j = await r.json();
    const d = (j.pending || []).find(x => x.code === к);
    if (!d) return { ok: false, ждут: (j.pending || []).map(x => x.code) };
    const a = await fetch(`/api/devices/${d.id}/approve`, { method: 'POST', credentials: 'include' });
    return { ok: a.status === 200, кто: d.username };
  }, код);
  check('владелец видит этот телефон в ожидающих и разрешает', разрешено.ok, разрешено);

  // Разрешили — приложение входит само, пароль повторно не спрашивая.
  await телефон.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
  check('телефон вошёл сам после разрешения', true);

  console.log('\n=== Каталог обновляется сам ===');
  // Телефон смотрит на изделия в наличии и НИЧЕГО не трогает дальше.
  await телефон.goto(`${BASE}/#/products`);
  await телефон.waitForTimeout(2500);
  await телефон.click('#pf-chips .chip[data-st=in_stock]');
  await телефон.waitForTimeout(2500);

  const артикул = await телефон.$eval('.pcard .pcard-sku', e => e.textContent.trim());
  const былоКарточек = (await телефон.$$('.pcard')).length;
  check('на телефоне открыт каталог «в наличии»', былоКарточек > 0, былоКарточек);
  console.log(`     телефон смотрит на каталог, первое изделие: ${артикул}`);

  // Ноутбук продаёт именно это изделие — через API, как если бы это делал
  // другой человек в другом окне.
  const продано = await ноутбук.evaluate(async (sku) => {
    const r = await fetch('/api/products?search=' + encodeURIComponent(sku) + '&limit=5',
      { credentials: 'include' });
    const j = await r.json();
    const p = (j.items || j).find(x => x.sku === sku);
    if (!p) return { ok: false, why: 'изделие не найдено' };
    const s = await fetch('/api/sales', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ product_id: p.id, discount: 0 }], payment_method: 'cash' }),
    });
    return { ok: s.status === 200, status: s.status, id: p.id };
  }, артикул);
  check('ноутбук продал изделие', продано.ok, продано);

  console.log(`     жду ${ЖДАТЬ / 1000} с, телефон никто не трогает…`);
  await телефон.waitForTimeout(ЖДАТЬ);

  const текстПосле = await телефон.$eval('#page', e => e.innerText);
  check('проданное изделие само пропало из наличия на телефоне',
    !текстПосле.includes(артикул), 'артикул ' + артикул + ' всё ещё на экране');
  await телефон.screenshot({ path: `${OUT}/живое-каталог.png`, fullPage: true });

  console.log('\n=== Форма не стирается на полуслове ===');
  /*
   * Самое опасное в живом обновлении. Продавец открыл форму нового изделия
   * и печатает. В этот момент на другом устройстве что-то происходит.
   * Форма обязана остаться нетронутой.
   */
  await телефон.goto(`${BASE}/#/products`);
  await телефон.waitForTimeout(2200);
  await телефон.click('#pf-add');
  await телефон.waitForTimeout(1200);
  await телефон.fill('[name=name]', 'Кольцо, которое я набираю');
  await телефон.fill('[name=weight]', '4.35');
  await телефон.fill('[name=retail_price]', '38500');
  check('форма открыта и заполняется', await телефон.isVisible('[name=name]'));

  // Пока форма открыта — ноутбук делает изменения одно за другим.
  for (let i = 0; i < 3; i++) {
    await ноутбук.evaluate(async () => {
      await fetch('/api/customers', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Клиент проверки ' + Math.random().toString(36).slice(2, 7) }),
      });
    });
    await телефон.waitForTimeout(3000);
  }

  const имяПосле = await телефон.inputValue('[name=name]');
  const весПосле = await телефон.inputValue('[name=weight]');
  const ценаПосле = await телефон.inputValue('[name=retail_price]');
  check('набранное название на месте', имяПосле === 'Кольцо, которое я набираю', имяПосле);
  check('набранный вес на месте', весПосле === '4.35', весПосле);
  check('набранная цена на месте', ценаПосле === '38500', ценаПосле);
  check('форма всё ещё открыта', await телефон.isVisible('.modal-overlay'));
  await телефон.screenshot({ path: `${OUT}/живое-форма-цела.png`, fullPage: true });

  console.log('\n=== После закрытия формы отложенное обновление доходит ===');
  const доЗакрытия = await ноутбук.evaluate(async () => {
    const r = await fetch('/api/customers?limit=1000', { credentials: 'include' });
    const j = await r.json();
    return (j.items || j).length;
  });
  await телефон.keyboard.press('Escape');
  await телефон.waitForTimeout(1200);
  // Уходим на клиентов: там видно то, что добавил ноутбук.
  await телефон.goto(`${BASE}/#/customers`);
  await телефон.waitForTimeout(2500);
  const виднеКлиенты = await телефон.$eval('#page', e => e.innerText);
  check('клиенты, заведённые с ноутбука, видны на телефоне',
    /Клиент проверки/.test(виднеКлиенты), виднеКлиенты.slice(0, 150));
  console.log(`     всего клиентов в базе: ${доЗакрытия}`);

  console.log('\n=== Свои действия не вызывают лишней перерисовки ===');
  /*
   * Если бы устройство обновлялось и на собственное действие, экран моргал бы
   * после каждого нажатия. Проверяем через то, что видит сам браузер: сколько
   * раз сменился корневой узел страницы.
   */
  await телефон.goto(`${BASE}/#/customers`);
  await телефон.waitForTimeout(2500);
  await телефон.evaluate(() => {
    window.__перерисовок = 0;
    const host = document.getElementById('page');
    new MutationObserver(() => { window.__перерисовок++; })
      .observe(host, { childList: true });
  });
  await телефон.evaluate(async () => {
    await fetch('/api/customers', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Asher-Device': localStorage.getItem('asher-устройство') || '' },
      body: JSON.stringify({ name: 'Свой клиент ' + Math.random().toString(36).slice(2, 7) }),
    });
  });
  await телефон.waitForTimeout(ЖДАТЬ);
  const перерисовок = await телефон.evaluate(() => window.__перерисовок);
  check('на собственное действие страница не перерисовывается сама', перерисовок === 0, перерисовок);

  console.log('\n=== Обрыв связи не ломает экран ===');
  /*
   * Опрос идёт постоянно, и если система выключится, он начнёт падать.
   * Ошибки от опроса не должны вылезать продавцу: он ничего не нажимал.
   */
  const ошибокДо = ошибки.length;
  await телефон.route('**/api/changes*', r => r.abort());
  await телефон.waitForTimeout(ЖДАТЬ + 3000);
  check('обрыв опроса не показывает ошибок на экране',
    !(await телефон.$eval('#page', e => e.innerText)).includes('Нет связи'));
  check('и не сыплет ошибками приложения в браузер', ошибки.length === ошибокДо,
    ошибки.slice(ошибокДо, ошибокДо + 3).join(' | '));
  await телефон.unroute('**/api/changes*');

  check('ошибок в браузере нет', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
