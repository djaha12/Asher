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
  /*
   * Размер экрана телефона, без «мобильной эмуляции» браузера.
   *
   * С ней браузер сам решает, какой ширины сделать страницу, и получает 484
   * точки вместо 390: разметка живёт по одним размерам, а всё, что прибито
   * к экрану (position: fixed), — по другим. На настоящем телефоне они
   * совпадают, и проверка, поставленная на эмуляцию, мерила бы то, чего
   * у владельца в руках не бывает. Прикосновения при этом включены.
   */
  const телефон = await ctx.browser().newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true,
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

  /*
   * ---------- Выход есть с каждого экрана ----------
   *
   * В установленном приложении нет ни адресной строки, ни браузерной стрелки
   * «назад»: экран — это всё, что есть. Поиск при этом раскрывается во весь
   * экран, и выйти из него было нечем совсем — Esc на телефоне нет, а нажатие
   * «мимо» попадает в сам поиск, потому что он и есть весь экран. Владелец
   * упёрся в это в первый же день.
   */
  await снимокТелефона(t);

  await t.click('#btn-search-mobile');
  await t.waitForTimeout(400);
  check('поиск раскрылся во весь экран',
    await t.$eval('#gs-wrap', el => el.classList.contains('gs-mobile-open')));
  check('в раскрытом поиске есть кнопка выхода', await t.isVisible('#gs-back'));
  check('пустой экран поиска объясняет, что набирать',
    /Наберите артикул/.test(await t.textContent('.gs-idle')) && await t.isVisible('.gs-idle'));
  const кнопка = await (await t.$('#gs-back')).boundingBox();
  check('до кнопки выхода можно дотянуться пальцем', кнопка.height >= 44 && кнопка.y >= ЧЕЛКА,
    `высота ${Math.round(кнопка.height)}, верх ${Math.round(кнопка.y)}`);
  await t.click('#gs-back');
  await t.waitForTimeout(400);
  check('кнопка закрывает поиск',
    await t.$eval('#gs-wrap', el => !el.classList.contains('gs-mobile-open')));

  await t.click('#btn-search-mobile');
  await t.waitForTimeout(400);
  // Нажатие по пустому месту рядом с полем — так закрываются все окна системы.
  await t.mouse.click(200, 600);
  await t.waitForTimeout(400);
  check('нажатие мимо поля тоже закрывает',
    await t.$eval('#gs-wrap', el => !el.classList.contains('gs-mobile-open')));

  /*
   * Кнопка «назад» в шапке. Нижняя панель вмещает пять разделов из десяти;
   * в остальные попадают через «☰», и вернуться оттуда было нечем.
   */
  check('на Главной кнопки «назад» нет',
    await t.$eval('#btn-back', el => el.classList.contains('hidden')));
  await t.goto(`${BASE}/#/settings`);
  await t.waitForTimeout(1200);
  check('в разделе кнопка «назад» появилась', await t.isVisible('#btn-back'));
  await t.goto(`${BASE}/#/labels`);
  await t.waitForTimeout(1200);
  await t.click('#btn-back');
  await t.waitForTimeout(900);
  check('«назад» возвращает на предыдущий раздел', t.url().endsWith('#/settings'), t.url());
  await t.click('#btn-back');
  await t.waitForTimeout(900);
  check('и дальше — на Главную', t.url().endsWith('#/dashboard'), t.url());
  check('на Главной кнопка снова спряталась',
    await t.$eval('#btn-back', el => el.classList.contains('hidden')));

  /*
   * Заходы по прямой ссылке. Человек открывает систему значком, попадает
   * сразу в раздел, и списка пройденного ещё нет — кнопка обязана работать
   * и здесь, иначе она обманывает ровно в том случае, ради которого нужна.
   */
  await t.goto(`${BASE}/#/orders`);
  await t.waitForTimeout(1200);
  await t.click('#btn-back');
  await t.waitForTimeout(900);
  check('с прямого захода «назад» ведёт на Главную', t.url().endsWith('#/dashboard'), t.url());

  await b.close();
  if (errors.length) { console.log('Ошибки JS:'); [...new Set(errors)].forEach(e => console.log('  ' + e)); }
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  process.exit(fail || errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
