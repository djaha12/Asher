require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Ни одна страница не шире телефона.
 *
 * Когда что-то на странице шире экрана, телефон разрешает возить всю страницу
 * пальцем вбок — и часть кнопок оказывается за краем. В браузере на компьютере
 * этого не видно вовсе, поэтому ловить надо здесь. Так уже было: на «Ценниках
 * и бирках» поиск и таблица уезжали за край, в «Настройках» — вкладки, на
 * главной — график. Причина одна: ячейка сетки не сжимается уже своего
 * содержимого, пока ей это не разрешить.
 *
 * Ширина 375 — самый узкий из ходовых iPhone (SE, mini).
 */
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = path.join(__dirname, '.вывод', 'shots-phone');
fs.mkdirSync(OUT, { recursive: true });
let ok = 0, fail = 0;
const check = (n, c, e) => c ? (ok++, console.log('  ok  ' + n))
  : (fail++, console.log('  FAIL ' + n, e === undefined ? '' : String(JSON.stringify(e)).slice(0, 300)));

const СТРАНИЦЫ = ['dashboard', 'sales', 'products', 'customers', 'debts', 'orders', 'sets', 'inventory',
  'labels', 'finance', 'analytics', 'import', 'team', 'settings'];

// Что вылезло за правый край — кроме того, что лежит в своей прокрутке.
const вылезло = () => {
  const W = document.documentElement.clientWidth;
  const где = [];
  for (const el of document.querySelectorAll('#app *, .modal *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || r.right <= W + 1) continue;
    let s = el.parentElement, вПрокрутке = false;
    while (s && s !== document.body) {
      if (/(auto|scroll)/.test(getComputedStyle(s).overflowX) && s.getBoundingClientRect().right <= W + 1) { вПрокрутке = true; break; }
      s = s.parentElement;
    }
    if (!вПрокрутке) где.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + [...el.classList].join('.')) + ' до ' + Math.round(r.right));
  }
  return { ширина: document.documentElement.scrollWidth, экран: W, где: где.slice(0, 4) };
};

(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true })).newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));

  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.fill('#login-username', 'admin');
  await p.fill('#login-password', 'admin123');
  await p.click('#login-form button[type=submit]');
  await p.waitForSelector('#app:not(.hidden)');

  console.log('=== Страницы ===');
  for (const стр of СТРАНИЦЫ) {
    await p.evaluate(h => { location.hash = '#/' + h; }, стр);
    await p.waitForLoadState('networkidle');
    await p.waitForTimeout(900);
    const r = await p.evaluate(вылезло);
    check(`${стр}: не шире экрана`, r.ширина <= r.экран && !r.где.length, r);
    if (r.ширина > r.экран || r.где.length) await p.screenshot({ path: path.join(OUT, стр.replace('/', '-') + '.png') });
  }

  console.log('\n=== Вкладки настроек — каждая по очереди ===');
  await p.evaluate(() => { location.hash = '#/settings'; });
  await p.waitForTimeout(1200);
  const вкладки = await p.$$eval('.tab[data-tab]', els => els.map(e => e.dataset.tab));
  check('вкладок больше, чем помещается в строку, — все на месте', вкладки.length >= 6, вкладки);
  for (const в of вкладки) {
    await p.click(`.tab[data-tab="${в}"]`);
    await p.waitForLoadState('networkidle');
    await p.waitForTimeout(700);
    const r = await p.evaluate(вылезло);
    check(`настройки → ${в}: не шире экрана`, r.ширина <= r.экран && !r.где.length, r);
  }

  console.log('\n=== Каталог: фильтры свёрнуты ===');
  await p.evaluate(() => { location.hash = '#/products'; });
  await p.waitForTimeout(1500);
  check('списки фильтров на телефоне спрятаны', !(await p.isVisible('#pf-metal')) && !(await p.isVisible('#pf-sort')));
  const доИзделий = await p.$eval('#prod-list', el => Math.round(el.getBoundingClientRect().top));
  check('до изделий не надо листать — список начинается на первом экране', доИзделий < 812, доИзделий);
  await p.click('#pf-toggle');
  check('по кнопке «Фильтры» списки открываются', await p.isVisible('#pf-metal'));
  await p.selectOption('#pf-metal', { index: 1 });
  await p.waitForTimeout(300);
  check('на кнопке видно, сколько фильтров включено', /· 1$/.test(await p.textContent('#pf-toggle')), await p.textContent('#pf-toggle'));
  await p.click('#pf-toggle');
  check('свернуть можно обратно', !(await p.isVisible('#pf-metal')));

  console.log('\n=== Окна ===');
  await p.evaluate(() => { location.hash = '#/sales'; });
  await p.waitForTimeout(1300);
  await p.click('#sf-new');
  await p.waitForSelector('.modal');
  await p.waitForTimeout(600);
  let r = await p.evaluate(вылезло);
  check('новая продажа: не шире экрана', r.ширина <= r.экран && !r.где.length, r);
  await p.fill('#pos-search', 'Кольцо');
  await p.waitForSelector('.search-results .sr-item[data-i]', { timeout: 5000 });
  await p.dispatchEvent('.search-results .sr-item[data-i]', 'mousedown');
  await p.waitForTimeout(500);
  const крестик = await p.$eval('.pos-item [data-del]', el => {
    const r = el.getBoundingClientRect(), окно = el.closest('.modal').getBoundingClientRect();
    return { справа: Math.round(r.right), край: Math.round(окно.right) };
  });
  check('изделие в чеке: крестик «убрать» внутри окна, а не за краем', крестик.справа <= крестик.край, крестик);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(400);

  await p.evaluate(() => { location.hash = '#/products'; });
  await p.waitForTimeout(1500);
  await p.click('.pcard');
  await p.waitForSelector('.modal');
  await p.waitForTimeout(900);
  r = await p.evaluate(вылезло);
  check('карточка изделия: не шире экрана', r.ширина <= r.экран && !r.где.length, r);
  const кнопки = await p.$$eval('.modal-foot .btn', els => els
    .filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent.trim()));
  check('подписи на кнопках карточки не обрезаны', кнопки.length === 0, кнопки);
  await p.screenshot({ path: path.join(OUT, 'карточка.png') });
  await p.keyboard.press('Escape');

  check('на страницах не было ошибок', errs.length === 0, errs.slice(0, 3));
  await b.close();
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
