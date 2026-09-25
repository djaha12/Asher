'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const path = require('node:path');
const os = require('node:os');
const ВЫВОД = path.join(__dirname, '.вывод');
/*
 * Приём в ремонт глазами продавца.
 *
 * Приняла цепь: вес, камни, дефекты, фото с телефона — и сразу квитанция
 * в двух экземплярах с местами для подписей (или в WhatsApp, если принтера
 * нет). Мастер вернул цепь — «Готов» одним нажатием прямо на карточке,
 * и тут же предложено написать клиенту. При выдаче — напоминание взвесить.
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-ремонт';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 220)); }
};
const МЕТКА = 'РУИ' + process.pid;
const хвост = String(process.pid).padStart(6, '0').slice(-6);
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
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
}

const заголовок = page => page.textContent(`${ВЕРХ} .modal-head h2`).catch(() => '');

(async () => {
  const вход = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  cookie = (вход.headers.get('set-cookie') || '').split(';')[0];
  await зов('POST', '/api/customers', { name: `Айгуль ${МЕТКА}`, phone: `0700 ${хвост}` });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await ctx.newPage();
  // WhatsApp открывается в новой вкладке — наружу не ходим, просто закрываем.
  ctx.on('page', p => { if (p !== page) p.close().catch(() => {}); });
  // Печать в проверке не нужна — запоминаем, что её вызвали.
  await page.addInitScript(() => { window.print = () => { window.__печать = (window.__печать || 0) + 1; }; });
  const ошибки = [];
  page.on('pageerror', e => ошибки.push(e.message));
  await войти(page, 'anna', 'seller123');
  // «Фото с телефона» — кусок экрана, сохранённый картинкой.
  const фотоФайл = path.join(os.tmpdir(), `remont-${process.pid}.png`);
  await page.screenshot({ path: фотоФайл, clip: { x: 0, y: 0, width: 320, height: 240 } });

  console.log('=== 1. Приём: изделие, вес, камни, фото ===');
  await page.goto(BASE + '/#/orders');
  await page.waitForSelector('#of-add');
  await page.click('#of-add');
  await page.waitForSelector('#order-form');
  const [выбор] = await Promise.all([page.waitForEvent('filechooser'), page.click('#ord-shot')]);
  await выбор.setFiles(фотоФайл);
  await page.waitForSelector('#ord-new-photos img');
  check('снимок виден в форме ещё до сохранения', (await page.$$('#ord-new-photos img')).length === 1);
  await page.mouse.click(8, 8);   // мимо окна
  await page.waitForTimeout(300);
  check('с одним только фото окно мимо не закрывается молча',
    /Введённое не сохранится/.test(await page.textContent(ВЕРХ).catch(() => '')));
  await page.click(`${ВЕРХ} [data-act=cancel]`);   // «Вернуться»
  await page.waitForTimeout(200);

  await page.fill('#ord-customer', `Айгуль ${МЕТКА}`);
  await page.waitForTimeout(1200);
  const найдена = await page.$('.search-results .sr-item[data-i]');
  if (найдена) await найдена.dispatchEvent('mousedown');
  await page.fill('#order-form [name=item]', 'Цепь, золото 585');
  await page.fill('#order-form [name=weight]', '4,52');
  await page.fill('#order-form [name=stones]', 'Без камней');
  await page.fill('#order-form [name=defects]', 'Царапины, сломан замок');
  await page.fill('#order-form [name=description]', 'Заменить замок, полировка');
  await page.fill('#order-form [name=estimate]', '1500');
  await page.fill('#order-form [name=prepayment]', '500');
  await снимок(page, { path: `${OUT}/приём.png` });
  await page.click('.modal [data-act=save]');
  const принят = await page.waitForFunction(() => [...document.querySelectorAll('.modal-head h2')]
    .some(h => /принят$/.test(h.textContent)), null, { timeout: 10000 }).then(() => true, () => false);
  check('заказ принят — сразу предложена квитанция', принят, await заголовок(page));
  const номер = ((await заголовок(page)).match(/З-\d+/) || [''])[0];

  const квитWa = decodeURIComponent(await page.getAttribute(`${ВЕРХ} [data-act=wa]`, 'href').catch(() => '') || '');
  check('квитанция в WhatsApp — ей, с номером заказа и весом',
    квитWa.includes('wa.me/996700' + хвост) && квитWa.includes(номер) && квитWa.includes('Вес при приёме: 4,52 г'), квитWa);
  await page.click(`${ВЕРХ} [data-act=print]`);
  check('печать вызвана', (await page.evaluate(() => window.__печать)) === 1);
  const квит = await page.textContent('#print-root');
  check('на листе два экземпляра: клиенту и магазину', (квит.match(/Квитанция №/g) || []).length === 2
    && /Экземпляр клиента/.test(квит) && /Экземпляр магазина/.test(квит), квит.slice(0, 200));
  check('в квитанции вес, камни, состояние и работа', /Вес при приёме:\s*4,52 г/.test(квит)
    && /Камни:\s*Без камней/.test(квит) && /сломан замок/.test(квит) && /Заменить замок/.test(квит));
  check('места для подписей клиента и приёмщицы', /Сдал \(клиент\)/.test(квит) && /Принял: Анна/.test(квит));
  await page.emulateMedia({ media: 'print' });
  await снимок(page, { path: `${OUT}/квитанция.png`, fullPage: true });
  await page.emulateMedia({ media: 'screen' });
  await page.click(`${ВЕРХ} [data-act=done]`);
  await page.waitForTimeout(400);

  const заказ = ((await зов('GET', '/api/orders?search=' + encodeURIComponent(номер))).data.items || [])[0] || {};
  check('на сервере: изделие, вес, фото, предоплата', заказ.item === 'Цепь, золото 585' && заказ.weight === 4.52
    && заказ.photo_count === 1 && заказ.paid === 500, JSON.stringify(заказ).slice(0, 200));

  console.log('\n=== 2. «Готов» одним нажатием на карточке ===');
  const карточка = page.locator('.kanban-card', { hasText: номер });
  await карточка.locator('[data-ready]').click();
  const предложено = await page.waitForFunction(() => [...document.querySelectorAll('.modal-head h2')]
    .some(h => /Написать клиенту/.test(h.textContent)), null, { timeout: 8000 }).then(() => true, () => false);
  check('сразу предложено написать клиенту', предложено);
  const готовWa = decodeURIComponent(await page.getAttribute(`${ВЕРХ} [data-act=wa]`, 'href').catch(() => '') || '');
  check('в сообщении — номер, изделие и сколько доплатить',
    готовWa.includes(`${номер} (Цепь, золото 585) готов`) && /К оплате: 1\D?000/.test(готовWa), готовWa);
  check('на сервере — готов', (await зов('GET', '/api/orders/' + заказ.id)).data.status === 'ready');
  await снимок(page, { path: `${OUT}/готов.png` });
  await page.click(`${ВЕРХ} [data-act=wa]`);
  await page.waitForTimeout(1000);
  check('написали — отмечено для всех', Boolean((await зов('GET', '/api/orders/' + заказ.id)).data.notified_at));
  check('на карточке — «клиенту написали»', /клиенту написали/.test(await карточка.textContent()));

  console.log('\n=== 3. Карточка и выдача ===');
  await карточка.click();
  await page.waitForSelector('#ord-photos');
  check('в карточке — фото при приёме', (await page.$$('#ord-photos img')).length === 1);
  check('у продавца нет кнопки «удалить фото»', (await page.$$('#ord-photos [data-del-photo]')).length === 0);
  check('в карточке — вес и дефекты', /4,52 г/.test(await page.textContent('.modal-body'))
    && /сломан замок/.test(await page.textContent('.modal-body')));
  await page.click('.modal [data-next=delivered]');
  await page.waitForSelector('#dlv-price');
  check('при выдаче — напоминание взвесить', /Вес при приёме:\s*4,52 г/.test(await page.textContent(`${ВЕРХ} .modal-body`)));
  await page.click(`${ВЕРХ} [data-act=ok]`);
  await page.waitForTimeout(1500);
  const выдан = (await зов('GET', '/api/orders/' + заказ.id)).data;
  check('выдан и доплачен', выдан.status === 'delivered' && выдан.paid === 1500, `${выдан.status} ${выдан.paid}`);

  console.log('\n=== 4. «Готов» из карточки заказа без клиента ===');
  const второй = (await зов('POST', '/api/orders', { description: `Гравировка ${МЕТКА}` })).data;
  await зов('POST', `/api/orders/${второй.id}/status`, { status: 'in_progress' });
  await page.goto(BASE + '/#/orders/' + второй.id);
  await page.waitForSelector('.modal [data-act=ready]');
  await page.click('.modal [data-act=ready]');
  await page.waitForTimeout(1200);
  check('из «В работе» — «Готов»', (await зов('GET', '/api/orders/' + второй.id)).data.status === 'ready');
  check('без телефона писать некому — окна нет', !/Написать клиенту/.test(await page.textContent('#modal-root')));
  await page.locator('.kanban-card', { hasText: второй.number }).click();
  await page.waitForSelector('.modal [data-next=in_progress]');
  await page.click('.modal [data-next=in_progress]');
  await page.waitForTimeout(1000);
  check('отмеченный по ошибке — возвращается в работу',
    (await зов('GET', '/api/orders/' + второй.id)).data.status === 'in_progress');

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  require('node:fs').rmSync(фотоФайл, { force: true });
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
