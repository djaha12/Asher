'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Карточка клиента глазами продавца.
 *
 * Из самой карточки: написать в WhatsApp, позвонить, принять оплату долга,
 * записать, чего человек хочет. В кассе второй клиент с тем же номером не
 * заводится молча — касса предлагает выбрать того, кто уже есть. На главной —
 * поводы связаться с готовым сообщением; кому написали, пропадает.
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-клиент';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 220)); }
};
const МЕТКА = 'КУИ' + process.pid;
const хвост = String(process.pid).padStart(6, '0').slice(-6);
const НОМЕР = `+996 700 ${хвост.slice(0, 3)}-${хвост.slice(3)}`;   // 996700XXXXXX
const МЕСТНЫЙ = `0700 ${хвост.slice(0, 3)} ${хвост.slice(3)}`;

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

  const жылдыз = (await зов('POST', '/api/customers', { name: `Жылдыз ${МЕТКА}`, phone: НОМЕР })).data.id;
  const изделие = (await зов('POST', '/api/products', {
    sku: `${МЕТКА}-1`, name: 'Браслет для проверки долга', metal: 'Золото', retail_price: 30000, purchase_price: 10000,
  })).data;
  const долг = await зов('POST', '/api/sales', {
    items: [{ product_id: изделие.id }], payment_method: 'cash', customer_id: жылдыз, paid: 10000, due_date: '2030-01-01',
  });
  check('продажа в долг заведена', долг.status === 200, JSON.stringify(долг.data));
  const сегодня = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const именинник = (await зов('POST', '/api/customers', {
    name: `Именинник ${МЕТКА}`, phone: '+996 555 000-111', birthday: `1985-${сегодня.slice(5)}`,
  })).data.id;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  // Ссылки WhatsApp открываются в новой вкладке — наружу не ходим, просто закрываем.
  const page = await ctx.newPage();
  ctx.on('page', p => { if (p !== page) p.close().catch(() => {}); });
  const ошибки = [];
  page.on('pageerror', e => ошибки.push(e.message));
  await войти(page, 'anna', 'seller123');

  console.log('=== 1. Связаться прямо из карточки ===');
  await page.goto(BASE + '/#/customers/' + жылдыз);
  await page.waitForSelector('.modal');
  const wa = await page.getAttribute('.modal a[href*="wa.me"]', 'href').catch(() => null);
  check('WhatsApp — на её номер, с приветствием', Boolean(wa) && wa.includes('wa.me/996700' + хвост) && /text=/.test(wa), wa);
  const тел = await page.getAttribute('.modal a[href^="tel:"]', 'href').catch(() => null);
  check('«Позвонить» — на её номер', Boolean(тел) && тел.replace(/\D/g, '').endsWith(хвост), тел);

  console.log('\n=== 2. Долг и оплата из карточки ===');
  const текст = await page.textContent('.modal-body');
  check('в карточке видно долг', /Долг:\s*20\s?000/.test(текст.replace(/[\u00a0\u202f]/g, ' ')), текст.slice(0, 300));
  await снимок(page, { path: `${OUT}/карточка-долг.png` });
  await page.click('.modal [data-act=pay]');
  await page.waitForSelector('#pay-form');
  await page.click('#modal-root > .modal-overlay:last-child [data-act=ok]');
  await page.waitForTimeout(1500);
  check('после оплаты карточка открылась снова', Boolean(await page.$('.modal [data-act=edit]')));
  check('и долга в ней больше нет', !/Долг:/.test(await page.textContent('.modal-body')));
  check('на сервере долг закрыт', (await зов('GET', '/api/debts/customers/' + жылдыз)).data.total_debt === 0);

  console.log('\n=== 3. Желания ===');
  await page.fill('#wish-text', 'Кольцо с изумрудом, 17-й размер');
  await page.click('.modal [data-act=wish-add]');
  await page.waitForTimeout(1200);
  check('желание записано и видно', /изумрудом/.test(await page.textContent('#cust-wishes')));
  await page.click('#cust-wishes [data-wish-del]');
  await page.waitForTimeout(1200);
  check('снятое — пропало', !/изумрудом/.test(await page.textContent('#cust-wishes')));
  await page.click('.modal .modal-close');
  await page.waitForTimeout(300);

  console.log('\n=== 4. Касса: тот же номер — выбрать того, кто есть ===');
  await page.click('#btn-quick-sale');
  await page.waitForSelector('#pos-customer');
  await page.fill('#pos-customer', МЕСТНЫЙ);
  await page.waitForTimeout(1300);
  check('по номеру в другом написании касса её находит',
    (await page.textContent('.search-results')).includes(`Жылдыз ${МЕТКА}`), await page.textContent('.search-results'));
  await page.locator('.search-results .sr-item[data-new]').dispatchEvent('mousedown');
  await page.waitForSelector('#nc-form');
  await page.fill('#nc-form [name=name]', 'Жыка');
  await page.click('#modal-root > .modal-overlay:last-child [data-act=ok]');
  await page.waitForTimeout(900);
  check('касса говорит, что номер уже есть', /уже записан/.test(await page.textContent('#modal-root')));
  await снимок(page, { path: `${OUT}/касса-дубль.png` });
  await page.click('#modal-root > .modal-overlay:last-child [data-act=existing]');
  await page.waitForTimeout(900);
  check('выбрана та, что уже была', (await page.inputValue('#pos-customer')) === `Жылдыз ${МЕТКА}`);
  check('второй карточки не появилось',
    (await зов('GET', '/api/customers?search=' + encodeURIComponent('Жыка'))).data.items.length === 0);
  await page.click('.modal .modal-close');
  await page.waitForTimeout(300);

  console.log('\n=== 5. Раздел «Клиенты»: тот же номер — открыть его карточку ===');
  await page.goto(BASE + '/#/customers');
  await page.waitForSelector('#cf-add');
  await page.click('#cf-add');
  await page.waitForSelector('#cust-form');
  await page.fill('#cust-form [name=name]', 'Жылдыз ещё раз');
  await page.fill('#cust-form [name=phone]', МЕСТНЫЙ);
  await page.click('.modal [data-act=save]');
  await page.waitForTimeout(900);
  await page.click('#modal-root > .modal-overlay:last-child [data-act=existing]');
  await page.waitForTimeout(1200);
  check('открылась её карточка', (await page.textContent('.modal-head h2')) === `Жылдыз ${МЕТКА}`,
    await page.textContent('.modal-head h2'));
  await page.click('.modal .modal-close');
  await page.waitForTimeout(300);

  console.log('\n=== 6. Поводы связаться на главной ===');
  await page.goto(BASE + '/#/dashboard');
  await page.waitForSelector('#dash-bd');
  await page.waitForTimeout(600);
  const строка = page.locator('#dash-bd > div', { hasText: `Именинник ${МЕТКА}` });
  check('именинник в поводах', (await строка.count()) === 1);
  const ссылка = await строка.locator('a[href*="wa.me"]').getAttribute('href').catch(() => '');
  check('у него WhatsApp с поздравлением', /wa\.me\/996555000111/.test(ссылка) && /%D0%B4%D0%BD%D1%91%D0%BC/.test(ссылка), ссылка);
  await снимок(page, { path: `${OUT}/поводы.png` });
  await строка.locator('a[href*="wa.me"]').click();
  await page.waitForTimeout(800);
  check('написали — строка пропала', (await строка.count()) === 0);
  const поводы = (await зов('GET', `/api/customers/occasions?days=14&today=${сегодня}`)).data.items;
  check('и на сервере отмечено — у других продавцов тоже пропадёт',
    !поводы.some(x => x.id === именинник && x.kind === 'birthday'));

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
