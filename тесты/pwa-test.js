require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
require('node:fs').mkdirSync(ВЫВОД + '/shots-jewelry', { recursive: true });
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
let ok = 0, fail = 0;
const check = (n, c, e) => c ? (ok++, console.log('  ok  ' + n))
  : (fail++, console.log('  FAIL ' + n, e === undefined ? '' : String(e).slice(0, 200)));
// Снимок «как это выглядит на телефоне» — человеку, а не проверке.
const снимокТелефона = стр =>
  снимок(стр, { path: ВЫВОД + '/shots-jewelry/14-телефон-с-чёлкой.png' });

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(BASE, { waitUntil: 'networkidle' });

  // Метки, по которым телефон понимает, что это приложение
  check('манифест подключён', await p.$('link[rel=manifest]') !== null);
  check('значок для iPhone подключён', await p.$('link[rel=apple-touch-icon]') !== null);
  check('iPhone откроет на весь экран',
    await p.$('meta[name="apple-mobile-web-app-capable"][content=yes]') !== null);
  check('имя приложения задано', await p.$('meta[name="apple-mobile-web-app-title"]') !== null);

  const man = await p.evaluate(async () => (await fetch('/manifest.webmanifest')).json());
  check('манифест читается как JSON', Boolean(man && man.name), man && man.name);
  check('режим — отдельное окно', man.display === 'standalone', man.display);
  check('значки в манифесте', (man.icons || []).length >= 2, (man.icons || []).length);
  check('есть значок 512 для Android', (man.icons || []).some(i => i.sizes === '512x512'));
  check('есть maskable-значок (круглая иконка Android)',
    (man.icons || []).some(i => (i.purpose || '').includes('maskable')));
  const iconOk = await p.evaluate(async () => {
    const r = await fetch('/icons/icon-512.png');
    return r.ok && (await r.blob()).size > 1000;
  });
  check('значок 512 скачивается и не пустой', iconOk);

  // QR для подключения телефона в настройках
  await p.fill('#login-username', 'admin');
  await p.fill('#login-password', 'admin123');
  await p.click('#login-form button[type=submit]');
  await p.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
  await p.goto(`${BASE}/#/settings`);
  await p.waitForTimeout(1800);
  const qr = await p.$('.phone-qr svg');
  check('QR для телефона нарисован', Boolean(qr));
  const box = qr ? await qr.boundingBox() : null;
  check('QR достаточно крупный, чтобы навести камеру', box && box.width > 150, box && box.width);
  const txt = await p.textContent('#page');
  check('объяснено, как поставить значок на телефон', /На экран|Установить приложение/.test(txt));
  await p.screenshot({ path: ВЫВОД + '/shots-jewelry/13-телефон-qr.png', fullPage: true });

  /*
   * ---------- Приложение на телефоне: часы и «чёлка» ----------
   *
   * Установленное на телефон приложение открывается во весь экран вместе
   * с полосой часов и батареи, и первые сорок точек экрана принадлежат ей.
   * Владелец поставил значок на экран «Домой» — и увидел название магазина
   * ровно под часами, одно поверх другого. В браузере при этом всё было
   * хорошо, поэтому и не замечалось: беда живёт только в установленном виде.
   *
   * Браузер умеет притвориться телефоном с «чёлкой», поэтому проверяем не
   * «написано ли в стилях нужное слово», а то, что видит человек: где
   * оказалось название и не залезло ли оно под часы.
   */
  const телефон = await ctx.browser().newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  const t = await телефон.newPage();
  t.on('pageerror', e => errors.push(e.message));
  const cdp = await телефон.newCDPSession(t);
  const ЧЕЛКА = 47, ПОЛОСКА = 34;   // высоты часов и «домашней полоски» у iPhone

  await t.goto(BASE, { waitUntil: 'networkidle' });
  await t.fill('#login-username', 'admin');
  await t.fill('#login-password', 'admin123');
  await t.click('#login-form button[type=submit]');
  await t.waitForSelector('#app:not(.hidden)', { timeout: 15000 });

  const стиль = (sel, свойство) => t.$eval(sel, (el, с) => getComputedStyle(el)[с], свойство);
  const верх = async sel => (await (await t.$(sel)).boundingBox()).y;

  // Сначала — обычный браузер: там полосы часов нет, и вид меняться не должен.
  check('в браузере шапка стоит как стояла', await стиль('.mobile-head', 'paddingTop') === '12px',
    await стиль('.mobile-head', 'paddingTop'));
  const дозаголовка = await верх('#brand-name-mobile');

  await cdp.send('Emulation.setSafeAreaInsetsOverride',
    { insets: { top: ЧЕЛКА, bottom: ПОЛОСКА } });
  await t.waitForTimeout(300);

  const послеЗаголовка = await верх('#brand-name-mobile');
  check('название магазина опустилось ниже часов', послеЗаголовка >= ЧЕЛКА,
    `было ${Math.round(дозаголовка)}, стало ${Math.round(послеЗаголовка)}, часы занимают ${ЧЕЛКА}`);
  check('шапка выросла ровно на высоту часов',
    await стиль('.mobile-head', 'paddingTop') === `${12 + ЧЕЛКА}px`,
    await стиль('.mobile-head', 'paddingTop'));
  check('кнопки в шапке тоже опустились', await верх('#btn-more') >= ЧЕЛКА,
    Math.round(await верх('#btn-more')));

  check('нижняя панель поднялась над «домашней полоской»',
    await стиль('.mobile-nav', 'paddingBottom') === `${ПОЛОСКА}px`,
    await стиль('.mobile-nav', 'paddingBottom'));
  check('конец страницы не прячется под нижней панелью',
    await стиль('#page', 'paddingBottom') === `${96 + ПОЛОСКА}px`,
    await стиль('#page', 'paddingBottom'));

  /*
   * Полоса часов красится в цвет, указанный в разметке. Он должен совпадать
   * с цветом шапки, иначе в светлой теме над белой шапкой висит чёрная
   * полоса — экран выглядит недогруженным.
   */
  const цветПолосы = () => t.$eval('meta[name="theme-color"]', el => el.content.toLowerCase());
  const цветШапки = () => t.$eval('.mobile-head', el => getComputedStyle(el).backgroundColor);
  check('цвет полосы часов совпадает со светлой шапкой',
    await цветПолосы() === '#ffffff' && await цветШапки() === 'rgb(255, 255, 255)',
    await цветПолосы() + ' / ' + await цветШапки());
  await t.evaluate(() => ui.applyTheme('dark'));
  await t.waitForTimeout(200);
  check('и с тёмной тоже',
    await цветПолосы() === '#191917' && await цветШапки() === 'rgb(25, 25, 23)',
    await цветПолосы() + ' / ' + await цветШапки());
  await t.evaluate(() => ui.applyTheme('light'));

  await снимокТелефона(t);

  await b.close();
  if (errors.length) { console.log('Ошибки JS:'); [...new Set(errors)].forEach(e => console.log('  ' + e)); }
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  process.exit(fail || errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
