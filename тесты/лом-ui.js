'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Старое золото в зачёт глазами продавца.
 *
 * Клиентка принесла старое кольцо: Анна взвешивает, выбирает пробу — касса
 * сразу показывает оценку и «К доплате». Без клиента не оформить: имя
 * стоит в акте. После продажи — чек и акт приёма в двух экземплярах.
 * В разделе «Старое золото» видно, сколько граммов какой пробы накоплено.
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-лом';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 260)); }
};
const МЕТКА = 'ЛУИ' + process.pid;
const ВЕРХ = '#modal-root > .modal-overlay:last-child';
const чисто = t => String(t || '').replace(/[  ]/g, ' ').replace(/\s+/g, ' ');

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
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
}

(async () => {
  const вход = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  cookie = (вход.headers.get('set-cookie') || '').split(';')[0];
  await зов('PUT', '/api/settings', { scrap_price_585: '4000' });
  await зов('POST', '/api/products', {
    sku: `${МЕТКА}-1`, name: 'Кольцо взамен старого', metal: 'Золото', fineness: '585',
    retail_price: 50000, purchase_price: 20000,
  });
  await зов('POST', '/api/customers', { name: `Динара ${МЕТКА}` });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => { window.print = () => { window.__печать = (window.__печать || 0) + 1; }; });
  const ошибки = [];
  page.on('pageerror', e => ошибки.push(e.message));
  await войти(page, 'anna', 'seller123');
  // Точка отсчёта кассы — чтобы увидеть, сколько легло в ящик.
  await зов('POST', '/api/cash/count', { counted: (await зов('GET', '/api/cash/expected')).data.ожидается || 0 });
  const былоВЯщике = (await зов('GET', '/api/cash/expected')).data.ожидается;

  console.log('=== 1. Касса: кольцо в зачёт ===');
  await page.click('#btn-quick-sale');
  await page.waitForSelector('#pos-search');
  await page.fill('#pos-search', `${МЕТКА}-1`);
  await page.waitForTimeout(1200);
  const найдено = await page.$('.search-results .sr-item[data-i]');
  if (найдено) await найдено.dispatchEvent('mousedown');
  await page.waitForSelector('.pos-item');
  await page.click('#pos-scrap-add');
  await page.waitForSelector('#scrap-form');
  check('у продавца поля «цена грамма» нет — только из Настроек', !(await page.$('#scrap-form [name=price]')));
  await page.fill('#scrap-form [name=description]', 'старое кольцо');
  await page.fill('#scrap-form [name=weight]', '4,5');
  await page.waitForTimeout(200);
  check('оценка видна сразу: 4,5 г × 4 000 = 18 000', /4,5 г × 4 000 сом = 18 000 сом/.test(чисто(await page.textContent('#scrap-sum'))),
    чисто(await page.textContent('#scrap-sum')));
  await снимок(page, { path: `${OUT}/оценка.png` });
  await page.click(`${ВЕРХ} [data-act=ok]`);
  await page.waitForTimeout(300);
  const итоги = чисто(await page.textContent('#pos-summary'));
  check('в чеке: золото в зачёт −18 000, к доплате 32 000', /Старое золото в зачёт\s*−18 000/.test(итоги)
    && /К доплате\s*32 000/.test(итоги), итоги);
  check('без клиента не оформить — имя нужно в акте', await page.isDisabled('[data-act=submit]')
    && /старого золота выберите клиента/.test(await page.textContent('#pos-cust-info')));
  await page.fill('#pos-customer', `Динара ${МЕТКА}`);
  await page.waitForTimeout(1200);
  const клиентка = await page.$('.search-results .sr-item[data-i]');
  if (клиентка) await клиентка.dispatchEvent('mousedown');
  await page.waitForTimeout(400);
  check('клиентку выбрали — можно оформлять', !(await page.isDisabled('[data-act=submit]')));
  await снимок(page, { path: `${OUT}/касса.png` });
  await page.click('[data-act=submit]');
  await page.waitForSelector(`${ВЕРХ} [data-act=act]`, { timeout: 8000 }).catch(() => {});
  check('после продажи — предложены чек и акт', Boolean(await page.$(`${ВЕРХ} [data-act=act]`)));
  await page.click(`${ВЕРХ} [data-act=act]`);
  check('акт отправлен на печать', (await page.evaluate(() => window.__печать)) === 1);
  const акт = чисто(await page.textContent('#print-root'));
  check('в акте: два экземпляра, номер Л-…', (акт.match(/Акт приёма № Л-\d{6}/g) || []).length === 2, акт.slice(0, 160));
  check('в акте: вещь, проба, вес, цена грамма и сумма', /старое кольцо, проба 585/.test(акт)
    && /4,5 г × 4 000 сом\s*18 000 сом/.test(акт) && /Чистого золота\s*2,633 г/.test(акт), акт.slice(0, 500));
  check('в акте: подписи и клиентка', /Сдал \(клиент\)/.test(акт) && /Принял: Анна/.test(акт) && акт.includes(`Динара ${МЕТКА}`));
  await page.emulateMedia({ media: 'print' });
  await снимок(page, { path: `${OUT}/акт.png`, fullPage: true });
  await page.emulateMedia({ media: 'screen' });
  await page.click(`${ВЕРХ} [data-act=done]`);

  const продажи = (await зов('GET', '/api/sales?search=' + encodeURIComponent(`${МЕТКА}-1`))).data.items;
  const чек = продажи[0] ? (await зов('GET', '/api/sales/' + продажи[0].id)).data : {};
  check('на сервере: чек оплачен полностью, зачёт 18 000', чек.paid === 50000 && чек.debt === 0
    && чек.scrap && чек.scrap.amount === 18000, JSON.stringify({ paid: чек.paid, debt: чек.debt, scrap: чек.scrap && чек.scrap.amount }));
  check('в ящик легла только доплата — 32 000', (await зов('GET', '/api/cash/expected')).data.ожидается - былоВЯщике === 32000);

  console.log('\n=== 2. Чек и раздел «Старое золото» ===');
  await page.goto(BASE + '/#/sales/' + чек.id);
  await page.waitForSelector('.modal [data-act=scrap-act]');
  check('в карточке чека — зачёт золотом по акту', /Старое золото в зачёт по акту Л-/.test(чисто(await page.textContent('.modal-body'))));
  await page.click('.modal .modal-close');
  await page.goto(BASE + '/#/scrap');
  await page.waitForSelector('#scrap-list');
  await page.waitForTimeout(500);
  const раздел = чисто(await page.innerText('#page'));
  check('в разделе — 585-я проба и её граммы', /585 проба\s*4,5 г/.test(раздел), раздел.slice(0, 300));
  check('и акт в списке, с чеком', раздел.includes(чек.scrap.number) && раздел.includes(чек.number));
  await снимок(page, { path: `${OUT}/раздел.png`, fullPage: true });

  console.log('\n=== 3. Золото дороже покупки ===');
  await зов('POST', '/api/products', { sku: `${МЕТКА}-2`, name: 'Серьги недорогие', metal: 'Золото', retail_price: 10000, purchase_price: 4000 });
  await page.click('#btn-quick-sale');
  await page.waitForSelector('#pos-search');
  await page.fill('#pos-search', `${МЕТКА}-2`);
  await page.waitForTimeout(1200);
  const серьги = await page.$('.search-results .sr-item[data-i]');
  if (серьги) await серьги.dispatchEvent('mousedown');
  await page.waitForSelector('.pos-item');
  await page.click('#pos-scrap-add');
  await page.waitForSelector('#scrap-form');
  await page.fill('#scrap-form [name=weight]', '10');
  await page.click(`${ВЕРХ} [data-act=ok]`);
  await page.waitForTimeout(300);
  check('касса предупреждает: золото дороже покупки, разницу не выдаём',
    /больше покупки на 30 000/.test(чисто(await page.textContent('#pos-summary'))), чисто(await page.textContent('#pos-summary')));
  check('и оформить не даёт', await page.isDisabled('[data-act=submit]'));
  await page.click(`#pos-scrap [data-scrap-del="0"]`);
  await page.waitForTimeout(200);
  check('убрали лом — предупреждение ушло', !/больше покупки/.test(await page.textContent('#pos-summary')));

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
