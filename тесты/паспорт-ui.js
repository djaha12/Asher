'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const ВЫВОД = path.join(__dirname, '.вывод');
/*
 * Паспорт изделия: лист, который покупатель уносит с украшением.
 *
 * В нём металл с пробой, вес, камни с характеристиками, сертификат и где его
 * проверить. QR кода изделия читается камерой кассы, как бирка; QR сертификата
 * GIA ведёт на страницу проверки лаборатории. Цена по умолчанию не печатается —
 * паспорт часто уходит с подарком. Печать, отправка в WhatsApp, паспорта
 * всех изделий прямо из чека; на телефоне лист не шире экрана.
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-паспорт';
fs.mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 260)); }
};
const МЕТКА = String(process.pid);
const АРТИКУЛ = 'ПАС-' + МЕТКА;          // с кириллицей — QR должен её сохранить
const СЕРТ = '2141438171';
const хвост = МЕТКА.padStart(6, '0').slice(-6);
const ВЕРХ = '#modal-root > .modal-overlay:last-child';

let cookie = '';
async function зов(метод, путь, тело) {
  const r = await fetch(BASE + путь, {
    method: метод, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: тело === undefined ? undefined : JSON.stringify(тело),
  });
  let data = null;
  try { data = await r.json(); } catch { /* пусто */ }
  return { status: r.status, data };
}

async function войти(page, логин, пароль) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('#login-username', логин);
  await page.fill('#login-password', пароль);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20000 }).catch(async e => {
    console.log('  Экран при входе:', (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ').slice(0, 300));
    throw e;
  });
}

// QR на листе — картинка SVG. Рисуем её на холсте и читаем тем же jsQR,
// что и касса: так проверяется не разметка, а то, что код правда читается.
function прочитатьQR(page, селектор) {
  return page.evaluate(async sel => {
    const svg = document.querySelector(sel);
    if (!svg) return null;
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = 400;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 400, 400);
    ctx.drawImage(img, 40, 40, 320, 320);
    const d = ctx.getImageData(0, 0, 400, 400);
    const r = jsQR(d.data, 400, 400);
    return r ? r.data : '';
  }, селектор);
}

(async () => {
  const вход = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  cookie = (вход.headers.get('set-cookie') || '').split(';')[0];

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await ctx.newPage();
  ctx.on('page', p => { if (p !== page) p.close().catch(() => {}); });
  await page.addInitScript(() => {
    window.print = () => { window.__печать = (window.__печать || 0) + 1; };
    window.open = u => { window.__открыто = u; return null; };
    // Делиться файлом умеет не каждый браузер; проверяем путь «переписка с текстом».
    Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
  });
  const ошибки = [];
  page.on('pageerror', e => ошибки.push(e.message));

  // Настоящая картинка для фото изделия — кусок экрана входа.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const фото = path.join(os.tmpdir(), `pasport-${process.pid}.png`);
  await page.screenshot({ path: фото, clip: { x: 0, y: 0, width: 400, height: 400 } });

  const клиентка = (await зов('POST', '/api/customers', { name: `Динара ${МЕТКА}`, phone: `0700 ${хвост}` })).data.id;
  const изделие = (await зов('POST', '/api/products', {
    sku: АРТИКУЛ, name: 'Кольцо «Солитер»', metal: 'Белое золото', fineness: '750', weight: 3.42, size: '17',
    carat: 0.5, color: 'G', clarity: 'VS1', retail_price: 250000, purchase_price: 120000,
    gems: [
      { type: 'Бриллиант', count: 1, carat: 0.5, color: 'G', clarity: 'VS1', cut: 'Кр-57',
        cert_lab: 'GIA', cert_number: СЕРТ, cert_date: '2025-03-14' },
      { type: 'Бриллиант', count: 12, carat: 0.12, color: 'H', clarity: 'SI1', cut: 'Кр-57' },
    ],
  })).data;
  const загрузка = await зов('POST', `/api/products/${изделие.id}/images`,
    { data: 'data:image/png;base64,' + fs.readFileSync(фото).toString('base64') });
  check('фото изделия загружено', загрузка.status === 200, JSON.stringify(загрузка.data));
  const продажа = (await зов('POST', '/api/sales', {
    items: [{ product_id: изделие.id, discount: 10000 }], payment_method: 'cash', customer_id: клиентка,
  })).data;
  check('изделие продано', Boolean(продажа && продажа.number), JSON.stringify(продажа));

  await войти(page, 'anna', 'seller123');

  console.log('=== 1. Паспорт из карточки изделия ===');
  await page.goto(BASE + '/#/products/' + изделие.id);
  await page.waitForSelector('.modal [data-act=passport]');
  await page.click('.modal [data-act=passport]');
  await page.waitForSelector('#pp-preview .passport');
  // innerText, а не textContent: он разделяет «Размер» и «17», как их видит глаз.
  const лист = (await page.innerText('#pp-preview')).replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ');
  check('название и артикул', лист.includes('Кольцо «Солитер»') && лист.includes('Артикул ' + АРТИКУЛ), лист.slice(0, 200));
  check('металл с пробой, вес, размер', лист.includes('Белое золото 750') && лист.includes('3,42 г') && лист.includes('Размер 17'), лист);
  check('характеристика бриллианта', лист.includes('0,5 ct · G · VS1'), лист);
  check('все вставки — строками таблицы', (await page.$$('#pp-preview .pp-gems tbody tr')).length === 2);
  check('сертификат с номером и датой', лист.includes(`Сертификат GIA № ${СЕРТ} от 14.03.2025`), лист);
  check('о продаже: дата и чек', лист.includes('чек ' + продажа.number), лист);
  check('покупатель указан', лист.includes(`Покупатель Динара ${МЕТКА}`), лист);
  check('цена по умолчанию не печатается — вдруг подарок', !/Цена/.test(лист.replace('Цена (не ставьте', '')));
  const фотоНаЛисте = await page.$eval('#pp-preview .pp-photo', img => img.complete && img.naturalWidth > 0).catch(() => false);
  check('фото изделия на листе', фотоНаЛисте);

  const кодИзделия = await прочитатьQR(page, '#pp-preview .pp-foot .pp-qr svg');
  check('QR внизу читается и даёт артикул — касса найдёт изделие', кодИзделия === АРТИКУЛ, кодИзделия);
  const кодСерт = await прочитатьQR(page, '#pp-preview .pp-cert .pp-qr svg');
  check('QR сертификата ведёт на проверку GIA с этим номером',
    кодСерт === `https://www.gia.edu/report-check?reportno=${СЕРТ}`, кодСерт);

  await page.check('#pp-price');
  await page.uncheck('#pp-buyer');
  const сЦеной = (await page.innerText('#pp-preview')).replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ');
  check('галочка «Цена» — цена продажи со скидкой', /Цена\s*240 000/.test(сЦеной), сЦеной.slice(-200));
  check('без галочки «Имя покупателя» — имени нет', !сЦеной.includes(`Динара ${МЕТКА}`));
  await снимок(page, { path: `${OUT}/окно.png` });

  await page.click(`${ВЕРХ} [data-act=print]`);
  await page.waitForFunction(() => window.__печать === 1, null, { timeout: 8000 }).catch(() => {});
  check('печать вызвана', (await page.evaluate(() => window.__печать)) === 1);
  check('на печать ушёл один лист', (await page.$$('#print-root .passport')).length === 1);
  check('фото на листе для печати успело загрузиться',
    await page.$eval('#print-root .pp-photo', img => img.complete && img.naturalWidth > 0).catch(() => false));
  await page.emulateMedia({ media: 'print' });
  await снимок(page, { path: `${OUT}/печать.png`, fullPage: true });
  await page.emulateMedia({ media: 'screen' });

  await page.click(`${ВЕРХ} [data-act=send]`);
  await page.waitForTimeout(400);
  const ушло = decodeURIComponent(await page.evaluate(() => window.__открыто || ''));
  check('отправка — в переписку с покупательницей', ушло.startsWith('https://wa.me/996700' + хвост), ушло.slice(0, 80));
  check('в сообщении паспорт и ссылка проверки сертификата', ушло.includes('Паспорт изделия')
    && ушло.includes('Артикул: ' + АРТИКУЛ)
    && ушло.includes(`Сертификат GIA № ${СЕРТ} — проверить: https://www.gia.edu/report-check?reportno=${СЕРТ}`), ушло);
  await page.click(`${ВЕРХ} [data-act=close]`);
  await page.click('.modal .modal-close');
  await page.waitForTimeout(300);

  console.log('\n=== 2. Паспорта из чека ===');
  await page.goto(BASE + '/#/sales/' + продажа.id);
  await page.waitForSelector('.modal [data-act=passports]');
  await page.click('.modal [data-act=passports]');
  await page.waitForSelector('#pp-preview .passport');
  const изЧека = (await page.innerText('#pp-preview')).replace(/\s+/g, ' ');
  check('из чека — паспорт проданного изделия', изЧека.includes(АРТИКУЛ) && изЧека.includes('чек ' + продажа.number), изЧека.slice(0, 200));
  await page.click(`${ВЕРХ} [data-act=close]`);
  await page.click('.modal .modal-close');

  console.log('\n=== 3. На телефоне ===');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(BASE + '/#/products/' + изделие.id);
  await page.waitForSelector('.modal [data-act=passport]');
  await page.click('.modal [data-act=passport]');
  await page.waitForSelector('#pp-preview .passport');
  await page.waitForTimeout(300);
  const ширина = await page.evaluate(() => {
    const лист = document.querySelector('#pp-preview .passport').getBoundingClientRect();
    return { право: Math.round(лист.right), экран: window.innerWidth, прокрутка: document.documentElement.scrollWidth };
  });
  check('лист не шире экрана телефона', ширина.право <= ширина.экран && ширина.прокрутка <= ширина.экран, JSON.stringify(ширина));
  await снимок(page, { path: `${OUT}/телефон.png` });

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  fs.rmSync(фото, { force: true });
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
