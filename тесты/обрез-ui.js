'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * На телефоне ничего не обрезано: ни в одном разделе, ни в основных окнах.
 *
 * Владелец: «такое ощущение, что обрезают многие, во многих разделах». Так
 * и было: таблица «Продаж» показывала 390 точек из 964 — ни суммы, ни
 * статуса чека; от названий в каталоге оставалось «Серьги с бриллиантом…»,
 * вкладки «Настроек» уезжали за край, окно приёмки было шире экрана.
 * Здесь каждый раздел и основные окна открываются на экране iPhone
 * (390×844), и набор падает на всём, что:
 *   — торчит за край экрана;
 *   — прячется за прокруткой вбок (таблица, вкладки);
 *   — обрезано многоточием или по высоте;
 *   — у окна кнопка ушла ниже экрана.
 * Снимки экранов с замечаниями — в тесты/.вывод/shots-обрез.
 */
const { chromium } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-обрез';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 400)); }
};

function найти() {
  const W = innerWidth, H = innerHeight;
  const итог = [];
  const имя = el => {
    const текст = (el.innerText || el.value || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 45);
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls + (текст ? ` «${текст}»` : '');
  };
  const вПрокрутке = el => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && p.scrollWidth > p.clientWidth + 1) return p;
    }
    return null;
  };
  const виден = el => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
    }
    return true;
  };
  const уже = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (['SCRIPT', 'STYLE', 'OPTION', 'DATALIST', 'svg', 'path', 'BR'].includes(el.tagName)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (!виден(el)) continue;
    const cs = getComputedStyle(el);
    // 1) торчит за край экрана — и это не таблица в своей полосе прокрутки
    if ((r.right > W + 1 || r.left < -1)) {
      const полоса = вПрокрутке(el);
      if (!полоса) итог.push({ вид: 'за край экрана', что: имя(el), где: [Math.round(r.left), Math.round(r.right)] });
      else if (!уже.has(полоса)) {
        уже.add(полоса);
        итог.push({ вид: 'листается вбок', что: имя(полоса), ширина: [полоса.clientWidth, полоса.scrollWidth] });
      }
    }
    // 2) текст обрезан по ширине (многоточие или скрытый избыток)
    const режет = cs.textOverflow === 'ellipsis' || cs.overflowX === 'hidden' || cs.overflow === 'hidden';
    const естьТекст = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (режет && естьТекст && el.scrollWidth > el.clientWidth + 2 && !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
      итог.push({ вид: 'обрезан текст', что: имя(el), ширина: [el.clientWidth, el.scrollWidth] });
    }
    // 3) текст обрезан по высоте (несколько строк спрятаны)
    if ((cs.overflowY === 'hidden' || cs.overflow === 'hidden') && естьТекст && el.scrollHeight > el.clientHeight + 4) {
      итог.push({ вид: 'обрезан по высоте', что: имя(el), высота: [el.clientHeight, el.scrollHeight] });
    }
    // 4) кнопка залезает под другую кнопку/за край по высоте окна
    if (el.tagName === 'BUTTON' && (r.bottom > H + 1) && el.closest('.modal-foot')) {
      итог.push({ вид: 'кнопка окна ниже экрана', что: имя(el), низ: Math.round(r.bottom) });
    }
  }
  return итог;
}


(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const ошибки = [];
  p.on('pageerror', e => ошибки.push(e.message));
  await p.goto(BASE); await p.fill('#login-username', 'admin'); await p.fill('#login-password', 'admin123');
  await p.click('#login-form button[type=submit]'); await p.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
  const проверить = async (имя) => {
    await p.waitForTimeout(900);
    const беды = await p.evaluate(найти);
    const коротко = [...new Set(беды.map(б => б.вид + ': ' + б.что))].slice(0, 6).join(' | ');
    check(`${имя}: ничего не обрезано`, беды.length === 0, коротко);
    if (беды.length) await p.screenshot({ path: `${OUT}/${имя}.png` }).catch(() => {});
  };
  const закрыть = async () => {
    for (let i = 0; i < 4 && await p.$('#modal-root .modal-overlay'); i++) { await p.keyboard.press('Escape'); await p.waitForTimeout(250); }
  };
  console.log('=== Разделы ===');
  for (const стр of ['dashboard', 'products', 'sales', 'debts', 'customers', 'orders', 'analytics', 'finance',
    'inventory', 'labels', 'scrap', 'sets', 'team', 'import']) {
    await закрыть();
    await p.goto(BASE + '/#/' + стр);
    await проверить('раздел ' + стр);
  }
  console.log('\n=== Настройки ===');
  await p.goto(BASE + '/#/settings');
  await p.waitForSelector('.tab[data-tab]');
  for (const вкладка of await p.$$eval('.tab[data-tab]', t => t.map(x => x.dataset.tab))) {
    await p.click(`.tab[data-tab=${вкладка}]`);
    await проверить('настройки ' + вкладка);
  }
  console.log('\n=== Окна ===');
  const окно = async (имя, как) => {
    try { await закрыть(); await как(); await проверить('окно ' + имя); }
    catch (e) { check(`окно ${имя} открылось`, false, e.message); }
  };
  const idИзделия = await p.evaluate(() => api.get('/api/products?status=in_stock&limit=5').then(r => r.items[0].id));
  const idКлиента = await p.evaluate(() => api.get('/api/customers?limit=5').then(r => (r.items || r)[0].id));
  await окно('новое изделие', async () => { await p.goto(BASE + '/#/products'); await p.click('#pf-add'); await p.waitForSelector('#prod-form'); });
  await окно('карточка изделия', async () => { await p.goto(BASE + '/#/dashboard'); await p.goto(BASE + '/#/products/' + idИзделия); await p.waitForSelector('.modal-foot'); });
  await окно('приёмка', async () => { await p.goto(BASE + '/#/products'); await p.click('#pf-receipt'); await p.waitForSelector('#rc-rows'); });
  await окно('касса', async () => {
    await p.goto(BASE + '/#/dashboard'); await p.click('#btn-quick-sale'); await p.waitForSelector('#pos-search');
    await p.fill('#pos-search', 'AS-'); await p.waitForTimeout(1200);
    const в = await p.$('.search-results .sr-item[data-i]'); if (в) await в.dispatchEvent('mousedown');
  });
  await окно('новый клиент', async () => { await p.goto(BASE + '/#/customers'); await p.click('#cf-add'); await p.waitForSelector('#cust-form'); });
  await окно('карточка клиента', async () => { await p.goto(BASE + '/#/dashboard'); await p.goto(BASE + '/#/customers/' + idКлиента); await p.waitForSelector('.modal'); });
  await окно('новый заказ', async () => { await p.goto(BASE + '/#/orders'); await p.click('#of-add'); await p.waitForSelector('#order-form'); });
  await окно('сверка кассы', async () => { await p.goto(BASE + '/#/dashboard'); await p.click('#qa-cash'); await p.waitForSelector('.modal'); });

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
